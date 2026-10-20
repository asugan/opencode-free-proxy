import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareRequest, sessionId } from '../src/compat.js';
import { collectCompletion, streamCompletion } from '../src/sse.js';

function source(events: unknown[], bytewise = false, done = true) {
  const text = events.map((event) => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\r\n\r\n`).join('')
    + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
      controller.close();
    },
  });
}

const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };

test('session IDs: canonical, unique, stable mapping and no raw downstream identifiers', () => {
  const id = sessionId();
  assert.match(id, /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.notEqual(id, sessionId());
  assert.equal(sessionId(id), id);
  assert.equal(sessionId('some-client-session'), sessionId('some-client-session'));
  assert.notEqual(sessionId('a'), sessionId('b'));
  assert.match(sessionId('some-client-session'), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test('plain chat declares four tools but disables execution', () => {
  const request = prepareRequest({ model: 'big-pickle', messages: [], stream: false });
  assert.equal(request.body.stream, true);
  assert.equal(request.body.tool_choice, 'none');
  assert.equal(request.allowedTools.size, 0);
  assert.deepEqual(request.body.tools.map((tool) => tool.function.name), ['bash', 'glob', 'grep', 'read']);
});

test('caller tools and tool_choice preserved without duplicate tool declarations', () => {
  const read = { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } };
  const body = { tools: [read], tool_choice: { type: 'function', function: { name: 'read' } }, stream_options: { include_obfuscation: true } };
  const original = JSON.stringify(body);
  const request = prepareRequest(body);
  assert.deepEqual(request.body.tools[0], read);
  assert.equal(request.body.tools.length, 4);
  assert.deepEqual(request.body.tool_choice, body.tool_choice);
  assert(request.allowedTools.has('read'));
  assert(!request.allowedTools.has('bash'));
  assert.equal(JSON.stringify(body), original);
  assert.deepEqual(request.body.stream_options, { include_obfuscation: true, include_usage: true });
  assert.equal(prepareRequest({ ...body, tool_choice: 'none' }).allowedTools.size, 0);
});

test('SSE aggregation handles CRLF, split UTF-8, reasoning, usage and metadata', async () => {
  const result = await collectCompletion(source([
    ': heartbeat\r\n\r\n',
    { id: 'chat1', created: 42, model: 'big-pickle', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Düşün' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'ce', content: 'Mer' } }] },
    { choices: [{ index: 0, delta: { content: 'haba 🌍' } }] },
    finish,
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
  ], true), new Set());
  assert.equal(result.object, 'chat.completion');
  assert.equal(result.id, 'chat1');
  assert.equal(result.created, 42);
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  assert.deepEqual(result.choices, [{ index: 0, message: { role: 'assistant', content: 'Merhaba 🌍', reasoning_content: 'Düşünce' }, finish_reason: 'stop', logprobs: null }]);
});

function toolEvents(name = 'lookup') {
  return [
    { id: 'chat2', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: name.slice(0, 2), arguments: '{"q":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: name.slice(2), arguments: '"test"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

test('fragmented tool names and arguments aggregate with no index in JSON message', async () => {
  const result = await collectCompletion(source(toolEvents()), new Set(['lookup']));
  const choices = result.choices as { message: { tool_calls: unknown[] }; finish_reason: string }[];
  assert.equal(choices[0]!.finish_reason, 'tool_calls');
  assert.deepEqual(choices[0]!.message.tool_calls, [{ id: 'call1', type: 'function', function: { name: 'lookup', arguments: '{"q":"test"}' } }]);
});

test('compatibility-only tools never leak to streaming clients or JSON responses', async () => {
  await assert.rejects(collectCompletion(source(toolEvents('bash')), new Set(['lookup'])), /not supplied/);
  let emitted = '';
  await assert.rejects(async () => {
    for await (const event of streamCompletion(source(toolEvents('bash')), new Set(['lookup']))) emitted += event;
  }, /not supplied/);
  assert(!emitted.includes('bash'));
  assert(!emitted.includes('call1'));
  assert(!emitted.includes('[DONE]'));
});

test('supported tool calls are released only once complete in SSE', async () => {
  let emitted = '';
  for await (const event of streamCompletion(source(toolEvents()), new Set(['lookup']))) emitted += event;
  assert(emitted.includes('"name":"lookup"'));
  assert(!emitted.includes('"name":"lo"'));
  assert(emitted.endsWith('data: [DONE]\n\n'));
});

test('truncated and error streams never turn into successful JSON', async () => {
  await assert.rejects(collectCompletion(source([{ choices: [{ index: 0, delta: { content: 'partial' } }] }]), new Set()), /finish_reason/);
  await assert.rejects(collectCompletion(source([finish], false, false), new Set()), /without \[DONE\]/);
  await assert.rejects(collectCompletion(source(['data: {bad}\n\n']), new Set()));
  await assert.rejects(collectCompletion(source([{ error: { message: 'failure' } }]), new Set()), /Invalid upstream/);
  await assert.rejects(collectCompletion(source(['data: {"choices": []}'], false, false), new Set()), /truncated/);
});

test('multiple choices and fragmented logprobs retain order', async () => {
  const result = await collectCompletion(source([
    { choices: [
      { index: 1, delta: { content: 'B' }, logprobs: { content: [{ token: 'B' }] } },
      { index: 0, delta: { content: 'A' } },
    ] },
    { choices: [
      { index: 1, delta: { content: 'C' }, logprobs: { content: [{ token: 'C' }] }, finish_reason: 'stop' },
      { index: 0, delta: {}, finish_reason: 'length' },
    ] },
  ]), new Set());
  assert.deepEqual(result.choices, [
    { index: 0, message: { role: 'assistant', content: 'A' }, finish_reason: 'length', logprobs: null },
    { index: 1, message: { role: 'assistant', content: 'BC' }, finish_reason: 'stop', logprobs: { content: [{ token: 'B' }, { token: 'C' }] } },
  ]);
});

test('oversized SSE events are rejected', async () => {
  await assert.rejects(collectCompletion(source(['data: ' + 'x'.repeat(1024 * 1024 + 1)]), new Set()), /exceeds 1 MiB/);
});
