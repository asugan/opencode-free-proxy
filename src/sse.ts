interface ToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}
interface Choice {
  index?: number;
  delta?: Record<string, unknown> & { tool_calls?: ToolCall[] | null };
  finish_reason?: string | null;
  logprobs?: unknown;
}
interface Chunk extends Record<string, unknown> {
  choices?: Choice[];
  usage?: unknown;
}

async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let eventBytes = 0;
  let totalBytes = 0;
  for await (const bytes of body) {
    totalBytes += bytes.length;
    if (totalBytes > 32 * 1024 * 1024) throw new Error('Upstream response exceeds 32 MiB.');
    buffer += decoder.decode(bytes, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      eventBytes += line.length;
      if (eventBytes > 1024 * 1024) throw new Error('Upstream SSE event exceeds 1 MiB.');
      if (!line) {
        yield data.join('\n');
        data = [];
        eventBytes = 0;
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.length > 1024 * 1024) throw new Error('Upstream SSE line exceeds 1 MiB.');
  }
  if (buffer.trim() || data.length) throw new Error('Upstream SSE event was truncated.');
}

// Hold tool fragments until finish_reason so compatibility-only tool names never reach clients.
async function* checkedEvents(body: ReadableStream<Uint8Array>, allowedTools: Set<string>) {
  const tools = new Map<number, Map<number, ToolCall>>();
  const active = new Set<number>();
  let finished = false;
  for await (const data of events(body)) {
    if (!data) { yield { raw: ': keepalive\n\n' }; continue; }
    if (data === '[DONE]') {
      if (active.size || !finished) throw new Error('Upstream completion ended without finish_reason.');
      yield { raw: 'data: [DONE]\n\n' };
      return;
    }
    const chunk = JSON.parse(data) as Chunk;
    if (!chunk || typeof chunk !== 'object' || chunk.error || !Array.isArray(chunk.choices)) {
      throw new Error('Invalid upstream completion chunk.');
    }
    for (const choice of chunk.choices) {
      const index = choice.index ?? 0;
      if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid upstream choice index.');
      active.add(index);
      if (choice.delta?.tool_calls) {
        let calls = tools.get(index);
        if (!calls) { calls = new Map(); tools.set(index, calls); }
        for (const delta of choice.delta.tool_calls) {
          const toolIndex = delta.index ?? 0;
          if (!Number.isSafeInteger(toolIndex) || toolIndex < 0) throw new Error('Invalid upstream tool index.');
          let call = calls.get(toolIndex);
          if (!call) { call = { index: toolIndex, function: { name: '', arguments: '' } }; calls.set(toolIndex, call); }
          if (delta.id) call.id = delta.id;
          if (delta.type) call.type = delta.type;
          if (delta.function?.name) call.function!.name += delta.function.name;
          if (delta.function?.arguments) call.function!.arguments += delta.function.arguments;
        }
        delete choice.delta.tool_calls;
      }
      if (choice.finish_reason) {
        const calls = [...(tools.get(index)?.values() ?? [])].sort((a, b) => a.index! - b.index!);
        for (const call of calls) {
          if (!call.id || !allowedTools.has(call.function?.name || '')) {
            throw new Error('Upstream requested a tool not supplied by the client.');
          }
        }
        if (calls.length) choice.delta = { ...choice.delta, tool_calls: calls };
        tools.delete(index);
        active.delete(index);
        finished = true;
      }
    }
    yield { raw: `data: ${JSON.stringify(chunk)}\n\n`, chunk };
  }
  throw new Error('Upstream SSE ended without [DONE].');
}

export async function* streamCompletion(body: ReadableStream<Uint8Array>, allowedTools: Set<string>) {
  for await (const event of checkedEvents(body, allowedTools)) yield event.raw;
}

export async function collectCompletion(body: ReadableStream<Uint8Array>, allowedTools: Set<string>) {
  const result: Record<string, unknown> = { object: 'chat.completion' };
  const choices = new Map<number, {
    index: number;
    message: Record<string, unknown>;
    finish_reason: string | null;
    logprobs: unknown;
  }>();
  for await (const { chunk } of checkedEvents(body, allowedTools)) {
    if (!chunk) continue;
    for (const key of ['id', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage']) {
      if (chunk[key] !== undefined) result[key] = chunk[key];
    }
    for (const delta of chunk.choices!) {
      const index = delta.index ?? 0;
      let choice = choices.get(index);
      if (!choice) {
        choice = { index, message: { role: 'assistant', content: null }, finish_reason: null, logprobs: null };
        choices.set(index, choice);
      }
      for (const [key, value] of Object.entries(delta.delta ?? {})) {
        if (key === 'tool_calls' && Array.isArray(value)) {
          choice.message.tool_calls = value.map(({ index: _index, ...call }: ToolCall) => call);
        } else if (typeof value === 'string') {
          choice.message[key] = key === 'role' ? value : `${choice.message[key] ?? ''}${value}`;
        }
      }
      if (delta.logprobs && typeof delta.logprobs === 'object') {
        const logprobs = (choice.logprobs ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(delta.logprobs)) {
          const previous = logprobs[key];
          logprobs[key] = Array.isArray(value) ? [...(Array.isArray(previous) ? previous : []), ...value] : value;
        }
        choice.logprobs = logprobs;
      }
      if (delta.finish_reason) choice.finish_reason = delta.finish_reason;
    }
  }
  result.choices = [...choices.values()].sort((a, b) => a.index - b.index);
  return result;
}
