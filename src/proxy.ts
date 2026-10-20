import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prepareRequest } from './compat.js';
import { collectCompletion, streamCompletion } from './sse.js';

// shortcut: curated free chat models, recheck pricing before adding or enabling model IDs.
export const DEFAULT_MODELS = [
  'big-pickle',
  'beam-free',
  'mimo-v2.6-flash-free',
  'nemotron-3.5-super-vl-free',
  'nemotron-3.5-lightning-free',
  'longcat-2.5-preview-free',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'minimax-m3.1-flash-free',
];

export interface Config {
  apiKey: string;
  upstreamKey?: string;
  baseUrl: string;
  models: string[];
  timeoutMs: number;
  maxBodyBytes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.PROXY_API_KEY?.trim();
  if (!apiKey || apiKey.length < 24) {
    throw new Error('PROXY_API_KEY must contain at least 24 characters.');
  }
  const url = new URL(env.OPENCODE_BASE_URL || 'https://opencode.ai/inference/openai/v1');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OPENCODE_BASE_URL must be an HTTP(S) URL without credentials, query or fragment.');
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote upstream must use HTTPS to protect prompts and API keys.');
  }
  const models = env.ALLOWED_MODELS === undefined
    ? DEFAULT_MODELS
    : env.ALLOWED_MODELS.split(',').map((model) => model.trim()).filter(Boolean);
  if (!models.length || models.some((model) => !/^[a-zA-Z0-9._-]+$/.test(model))) {
    throw new Error('ALLOWED_MODELS must contain comma-separated model IDs.');
  }
  const timeoutMs = Number(env.REQUEST_TIMEOUT_MS || 300_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('REQUEST_TIMEOUT_MS must be between 1 and 2147483647.');
  }
  return {
    apiKey,
    upstreamKey: env.OPENCODE_API_KEY?.trim() || undefined,
    baseUrl: url.toString().replace(/\/$/, ''),
    models: [...new Set(models)],
    timeoutMs,
    maxBodyBytes: 4 * 1024 * 1024,
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, 'Request body exceeds 4 MiB.');
    }
    chunks.push(bytes);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function createProxy(config: Config) {
  const expectedKey = createHash('sha256').update(`Bearer ${config.apiKey}`).digest();
  return createServer(async (req, res) => {
    const disconnected = new AbortController();
    res.on('close', () => disconnected.abort());
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = AbortSignal.any([disconnected.signal, timeout]);
    try {
      const path = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        json(res, 200, { status: 'ok' });
        return;
      }
      const key = createHash('sha256').update(req.headers.authorization || '').digest();
      if (!timingSafeEqual(key, expectedKey)) {
        res.setHeader('www-authenticate', 'Bearer');
        throw new HttpError(401, 'Invalid proxy API key.');
      }
      if (req.method === 'GET' && path === '/v1/models') {
        json(res, 200, {
          object: 'list',
          data: config.models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
        });
        return;
      }
      if (path !== '/v1/chat/completions') throw new HttpError(404, 'Endpoint not found.');
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw new HttpError(405, 'Use POST for chat completions.');
      }
      if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
        throw new HttpError(415, 'Content-Type must be application/json.');
      }
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
        throw new HttpError(415, 'Compressed request bodies are not supported.');
      }
      const body = await readBody(req, config.maxBodyBytes);
      if (typeof body.model !== 'string' || !config.models.includes(body.model)) {
        throw new HttpError(400, 'Model is not in ALLOWED_MODELS. See /v1/models.');
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.some(
        (message) => !message || typeof message !== 'object' || typeof message.role !== 'string',
      )) {
        throw new HttpError(400, 'messages must be a non-empty array of objects with a role.');
      }
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw new HttpError(400, 'stream must be a boolean.');
      }
      const session = [req.headers['x-opencode-session'], req.headers['x-session-id'], req.headers['x-opencode-session-id']]
        .find((value): value is string => typeof value === 'string');
      let prepared: ReturnType<typeof prepareRequest>;
      try {
        prepared = prepareRequest(body, session);
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'Invalid tools.');
      }
      const headers: Record<string, string> = {
        ...prepared.headers,
        'content-type': 'application/json',
        authorization: `Bearer ${config.upstreamKey || 'public'}`,
      };
      const upstream = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(prepared.body),
        signal,
        redirect: 'error',
      });
      for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-opencode-log-id']) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-accel-buffering', 'no');
      if (upstream.ok) {
        if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
          await upstream.body?.cancel();
          throw new HttpError(502, 'Expected an OpenCode SSE response.');
        }
        if (body.stream !== true) {
          const result = await collectCompletion(upstream.body, prepared.allowedTools);
          json(res, upstream.status, result);
          return;
        }
        res.writeHead(upstream.status);
        res.flushHeaders();
        await pipeline(Readable.from(streamCompletion(upstream.body, prepared.allowedTools)), res, { signal });
      } else {
        res.writeHead(upstream.status);
        res.flushHeaders();
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res, { signal });
        else res.end();
      }
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : timeout.aborted ? 504 : 502;
      const message = error instanceof HttpError
        ? error.message
        : timeout.aborted ? 'OpenCode request timed out.' : 'OpenCode request failed or returned an invalid stream.';
      json(res, status, { error: { message, type: 'proxy_error', code: status } });
    }
  });
}
