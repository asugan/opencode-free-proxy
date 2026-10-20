import { createHash, randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const sessionPattern = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

export function sessionId(value?: string): string {
  if (value && sessionPattern.test(value)) return value;
  const bytes = value ? createHash('sha256').update(value).digest() : randomBytes(20);
  const time = value
    ? bytes.subarray(0, 6).toString('hex')
    : BigInt.asUintN(48, ~(BigInt(Date.now()) * 4096n + 1n)).toString(16).padStart(12, '0');
  return `ses_${time}${[...bytes.subarray(6, 20)].map((byte) => alphabet[byte % 62]).join('')}`;
}

const requiredTools = [
  { name: 'bash', description: 'Execute a shell command', properties: { command: { type: 'string' } }, required: ['command'] },
  { name: 'glob', description: 'Find files by glob pattern', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  { name: 'grep', description: 'Search file contents', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  { name: 'read', description: 'Read a file', properties: { filePath: { type: 'string' } }, required: ['filePath'] },
].map(({ name, description, properties, required }) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
}));

export function prepareRequest(body: Record<string, unknown>, session?: string) {
  if (body.functions !== undefined || body.function_call !== undefined) {
    throw new Error('Legacy functions/function_call are unsupported; use tools/tool_choice.');
  }
  if (body.stream_options !== undefined && (!body.stream_options || typeof body.stream_options !== 'object' || Array.isArray(body.stream_options))) {
    throw new Error('stream_options must be an object.');
  }
  const tools = body.tools ?? [];
  if (!Array.isArray(tools) || tools.some((tool) =>
    !tool || tool.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name,
  )) throw new Error('tools must be an array of named OpenAI function tools.');
  const allowedTools = new Set<string>(tools.map((tool) => tool.function.name));
  const id = sessionId(session || (typeof body.prompt_cache_key === 'string' ? body.prompt_cache_key : undefined));
  return {
    headers: {
      'user-agent': 'opencode/latest/2.0.32/cli',
      'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-session': id,
      'x-opencode-session-id': id,
      'x-session-affinity': id,
      'x-session-id': id,
    },
    allowedTools: body.tool_choice === 'none' ? new Set<string>() : allowedTools,
    body: {
      ...body,
      stream: true,
      stream_options: { ...(body.stream_options as Record<string, unknown> | undefined), include_usage: true },
      tools: [...tools, ...requiredTools.filter((tool) => !allowedTools.has(tool.function.name))],
      // Compatibility declarations are not executable tools; plain chat must never call them.
      tool_choice: body.tool_choice ?? (tools.length ? 'auto' : 'none'),
    },
  };
}
