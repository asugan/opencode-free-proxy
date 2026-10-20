import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createProxy, DEFAULT_MODELS, loadConfig } from '../src/proxy.js';

const apiKey = 'local-test-key-at-least-24-characters';

function reply(res: ServerResponse, content = 'OK') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([
    { id: 'chat-test', created: 123, model: 'big-pickle', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
}

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

test('configuration rejects unsafe values', () => {
  const env = { PROXY_API_KEY: apiKey };
  assert.throws(() => loadConfig({}), /PROXY_API_KEY/);
  assert.throws(() => loadConfig({ ...env, OPENCODE_BASE_URL: 'http://example.com/v1' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...env, OPENCODE_BASE_URL: 'https://user:pass@example.com' }), /credentials/);
  assert.throws(() => loadConfig({ ...env, ALLOWED_MODELS: '' }), /ALLOWED_MODELS/);
  assert.throws(() => loadConfig({ ...env, REQUEST_TIMEOUT_MS: '-1' }), /REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadConfig({ ...env, REQUEST_TIMEOUT_MS: '2147483648' }), /REQUEST_TIMEOUT_MS/);
  assert(!DEFAULT_MODELS.includes('jev-1.13-free'), 'System One model is not chat-compatible');
  assert.deepEqual(loadConfig({ ...env, ALLOWED_MODELS: 'big-pickle, big-pickle' }).models, ['big-pickle']);
});

test('HTTP proxy integration', async (t) => {
  let handler = (_req: IncomingMessage, res: ServerResponse) => { res.end('{}'); };
  let calls = 0;
  const upstream = createServer((req, res) => { calls++; handler(req, res); });
  const upstreamUrl = await listen(upstream);
  const config = {
    ...loadConfig({ PROXY_API_KEY: apiKey }),
    baseUrl: `${upstreamUrl}/v1`,
    upstreamKey: 'upstream-secret',
  };
  const proxy = createProxy(config);
  const baseUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const payload = { model: 'big-pickle', messages: [{ role: 'user', content: 'hello' }] };
  const chat = (body: unknown, extra: Record<string, string> = {}) => fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body),
  });

  await t.test('health needs no key; model discovery needs correct key', async () => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    const response = await fetch(`${baseUrl}/v1/models`, { headers });
    const body = await response.json() as { data: { id: string }[] };
    assert.deepEqual(body.data.map((model: { id: string }) => model.id), config.models);
    assert.equal(calls, 0);
  });

  await t.test('bad input and paid model never reach upstream', async () => {
    const before = calls;
    for (const body of [null, [], {}, { ...payload, model: 'gpt-5' }, { ...payload, messages: [] },
      { ...payload, messages: [null] }, { ...payload, stream: 'true' },
      { ...payload, tools: [{ type: 'function', function: {} }] },
      { ...payload, stream_options: [] }, { ...payload, functions: [] }]) {
      assert.equal((await chat(body)).status, 400);
    }
    assert.equal((await chat(payload, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await chat(payload, { 'content-encoding': 'gzip' })).status, 415);
    assert.equal((await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST', headers, body: '{broken',
    })).status, 400);
    assert.equal((await chat({ ...payload, padding: 'x'.repeat(config.maxBodyBytes) })).status, 413);
    assert.equal(calls, before);
  });

  await t.test('unknown routes and wrong method', async () => {
    assert.equal((await fetch(`${baseUrl}/v1/responses`, { headers })).status, 404);
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { headers });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });

  await t.test('compatibility headers and tools, forced SSE and JSON aggregation', async () => {
    const body = { ...payload, tools: [{ type: 'function', function: { name: 'lookup' } }], temperature: 0.2 };
    let received: Record<string, unknown> = {};
    let auth: unknown;
    let path: unknown;
    let session: unknown;
    let userAgent: unknown;
    handler = (req, res) => {
      auth = req.headers.authorization;
      path = req.url;
      session = req.headers['x-opencode-session'];
      userAgent = req.headers['user-agent'];
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received = JSON.parse(Buffer.concat(chunks).toString());
        reply(res);
      });
    };
    const response = await chat(body);
    assert.equal(response.status, 200);
    const result = await response.json() as { choices: { message: { content: string } }[] };
    assert.equal(result.choices[0]!.message.content, 'OK');
    assert.deepEqual(received.messages, body.messages);
    assert.equal(received.temperature, body.temperature);
    const tools = received.tools as { function: { name: string } }[];
    assert.deepEqual(tools[0], body.tools[0]);
    assert.deepEqual(tools.map((tool) => tool.function.name), ['lookup', 'bash', 'glob', 'grep', 'read']);
    assert.equal(received.stream, true);
    assert.equal(received.tool_choice, 'auto');
    assert.deepEqual(received.stream_options, { include_usage: true });
    assert.match(String(session), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assert.equal(userAgent, 'opencode/latest/2.0.32/cli');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(auth, 'Bearer upstream-secret');
    assert.equal(path, '/v1/chat/completions');
  });

  await t.test('SSE arrives before upstream finishes; bytes preserved', async () => {
    const first = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n';
    const last = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    let finish: (() => void) | undefined;
    handler = (_req, res) => {
      res.setHeader('content-type', 'text/event-stream');
      res.write(first);
      finish = () => res.end(last);
    };
    const response = await chat({ ...payload, stream: true });
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    assert.equal(Buffer.from(chunk.value!).toString(), first);
    assert(finish);
    finish();
    let rest = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += Buffer.from(chunk.value).toString();
    }
    assert.equal(rest, last);
  });

  await t.test('OpenCode restriction and rate-limit errors pass through unchanged', async () => {
    for (const status of [403, 429]) {
      const body = '{"error":{"type":"FreeTierError","message":"OpenCode only"}}';
      handler = (_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '30' });
        res.end(body);
      };
      const response = await chat(payload);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), '30');
      assert.equal(await response.text(), body);
    }
  });

  await t.test('client disconnect cancels upstream', async () => {
    let closed!: Promise<void>;
    handler = (_req, res) => {
      closed = new Promise<void>((resolve) => res.on('close', resolve));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    };
    const response = await chat({ ...payload, stream: true });
    await response.body!.cancel();
    await Promise.race([closed, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Upstream not cancelled')), 2_000);
      timer.unref();
    })]);
  });

  await t.test('upstream timeout returns 504', async () => {
    handler = () => {};
    const short = createProxy({ ...config, timeoutMs: 50 });
    const url = await listen(short);
    try {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 504);
      const result = await response.json() as { error: { message: string } };
      assert.match(result.error.message, /timed out/);
    } finally { await close(short); }
  });

  await t.test('no upstream key uses public, never the local key', async () => {
    let authorization: unknown = 'not-called';
    handler = (req, res) => { authorization = req.headers.authorization; reply(res); };
    const anonymous = createProxy({ ...config, upstreamKey: undefined });
    const url = await listen(anonymous);
    try {
      const response = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      await response.text();
      assert.equal(authorization, 'Bearer public');
    } finally { await close(anonymous); }
  });
});
