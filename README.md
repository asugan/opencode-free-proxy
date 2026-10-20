# OpenCode → CLIProxyAPI Proxy

A small Node.js + TypeScript gateway that exposes OpenCode models through an OpenAI-compatible API for CLIProxyAPI. No runtime dependencies: the server uses Node HTTP, fetch, and streams.

```text
Client → CLIProxyAPI → this proxy → OpenCode
```

## Quick start with Docker Compose

Requires Docker Engine and Docker Compose v2.

```bash
git clone https://github.com/asugan/opencode-free-proxy.git
cd opencode-free-proxy
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Set `PROXY_API_KEY` in `.env` to the generated key. If Node.js is unavailable on the host, generate a random key with `openssl rand -hex 32` instead. An existing local `.env` can be reused without changing its key. Never commit real credentials.

```bash
docker compose up -d --build --wait
curl --fail http://127.0.0.1:3005/health
docker compose ps
```

**Docker base URL: `http://127.0.0.1:3005/v1`**

- The multi-stage build runs type checks, automated tests, and TypeScript compilation.
- The final application directory contains only compiled code. Source files, tests, and development dependencies are not copied into the runtime image.
- `.dockerignore` restricts the build context to required inputs. Credentials and Git history stay outside the image.
- Compose loads `.env` at runtime; the file is not copied or mounted into the container. Container settings `HOST=0.0.0.0` and `PORT=3005` override the native development values in `.env`.
- The container runs as a non-root user with a read-only filesystem, dropped Linux capabilities, and privilege escalation disabled.
- A healthcheck is enabled. `restart: unless-stopped` restarts the service after process failures or Docker restarts; an unhealthy status alone does not trigger a restart.
- The published port binds to **127.0.0.1 only**, not the public network.

```bash
docker compose logs -f proxy          # Follow logs
docker compose up -d --build --wait   # Rebuild/recreate after code or configuration changes
docker compose down                  # Stop and remove containers; keep the local configuration file
```

### Verification status

Verified on **2026-10-20**:

| Check | Result |
| --- | --- |
| Docker build, type checks, and 21 automated tests | Passed |
| Host health endpoint on port 3005 | HTTP 200 |
| Model discovery without a proxy key | HTTP 401 |
| Authenticated model discovery inside the container | HTTP 200, 9 configured models |
| Non-root runtime and application directory contents | Verified |
| Native compiled proxy: JSON chat, SSE chat, and caller-defined `lookup` tool with `big-pickle` | HTTP 200 for all three |
| Latest Docker live chat smoke test with `big-pickle` | Client timed out after 60 seconds; successful container inference has not been verified |

A healthy container proves local service availability, **not** upstream inference availability. The Docker timeout remains unresolved; its cause has not been established. The successful native tests do not prove that the container's outbound inference path works. Other models have not all been tested with live inference.

## Native development

Requires **Node.js 22.19+**.

```bash
npm ci
# Create and configure the local environment file as described above, if needed.
npm run dev
```

For a compiled native build:

```bash
npm run build
npm start
```

**Native base URL: `http://127.0.0.1:8787/v1`** by default. Native startup does not install a background service; closing the process stops the server.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PROXY_API_KEY` | Required | Local Bearer key, at least 24 characters; used by CLIProxyAPI to access this proxy. |
| `OPENCODE_API_KEY` | Empty | Optional upstream credential. If empty, the proxy uses `Bearer public`. |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/openai/v1` | Upstream base URL; `/chat/completions` is appended. |
| `HOST` | `127.0.0.1` | Native bind address; overridden to `0.0.0.0` inside Compose. |
| `PORT` | `8787` | Native port; overridden to `3005` inside Compose. |
| `REQUEST_TIMEOUT_MS` | `300000` | Total request/stream deadline in milliseconds. |
| `ALLOWED_MODELS` | Curated list of 9 chat models | Comma-separated replacement for the entire default allowlist. |

The local proxy key and the optional OpenCode key serve different purposes. The local key is never forwarded upstream. Prompts and credentials are not logged.

Only configure trusted upstream URLs: prompts and any upstream key are sent to that address. Remote upstreams must use HTTPS. Redirects are not followed.

## CLIProxyAPI integration

Merge the appropriate example into your existing CLIProxyAPI configuration:

- **v8:** [`examples/cliproxyapi.v8.yaml`](examples/cliproxyapi.v8.yaml), under `api-keys.openai-compatibility`.
- **Legacy:** [`examples/cliproxyapi.legacy.yaml`](examples/cliproxyapi.legacy.yaml), under the top-level `openai-compatibility` key.

Replace `PASTE_PROXY_API_KEY_FROM_ENV` with your local `PROXY_API_KEY`. Do not overwrite your entire configuration or introduce duplicate YAML keys. Reload or restart CLIProxyAPI as appropriate for your installation.

The examples use the native port, **8787**. For this Docker deployment, change their `base-url` to **`http://127.0.0.1:3005/v1`** when CLIProxyAPI runs on the same host.

Example client model: **`opencode-big-pickle`**. CLIProxyAPI maps this alias to upstream model `big-pickle`. Clients connecting to CLIProxyAPI use **CLIProxyAPI's own client key**, not this proxy's key.

### Container networking and remote access

`127.0.0.1` always refers to the current network namespace. A separate CLIProxyAPI container cannot use its own localhost to reach this proxy. Attach both containers to a shared Docker network and use **`http://proxy:3005/v1`**, assuming the service name is unambiguous on that network.

For a native proxy running on the Docker host, `host.docker.internal` may be used with an appropriate host bind address; Linux generally requires a `host-gateway` mapping. This does not make a host-loopback-only listener reachable from another network namespace.

Publishing on all interfaces requires an explicit port-binding change in `compose.yaml`. Restrict access with a firewall. Public deployment requires TLS and rate limiting, neither of which is provisioned here.

## Request verification

For Docker, run this from the project directory. It uses the container's environment without printing credentials:

```bash
curl --fail http://127.0.0.1:3005/health

docker compose exec -T proxy node --input-type=module <<'JS'
const headers = {
  authorization: `Bearer ${process.env.PROXY_API_KEY}`,
  'content-type': 'application/json',
};
const base = 'http://127.0.0.1:3005/v1';
console.log(await (await fetch(`${base}/models`, { headers })).json());
const response = await fetch(`${base}/chat/completions`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    model: 'big-pickle',
    messages: [{ role: 'user', content: 'Reply only hello.' }],
    stream: true,
    max_tokens: 64,
  }),
  signal: AbortSignal.timeout(60000),
});
console.log('HTTP', response.status);
for await (const chunk of response.body) process.stdout.write(chunk);
JS
```

For native development, run the JavaScript block with `node --env-file=.env --input-type=module` instead, and change the port to `8787`.

`/health` is a liveness check. `/v1/models` returns the **local configured allowlist**, not an upstream availability check. A `403 FreeTierError` comes from OpenCode's access checks; `429` indicates a quota or rate limit, and `Retry-After` is preserved. There are no automatic retries.

## OpenCode compatibility and the original 403

Ordinary Chat Completions requests, and requests with only a changed User-Agent, returned `403 FreeTierError`. The installed OpenCode **2.0.32** client's request was inspected in an isolated environment. The following combination produced a native **HTTP 200 / OK** response from `big-pickle` and is implemented in the proxy:

- `Authorization: Bearer public` when no personal upstream key is configured.
- `User-Agent: opencode/latest/2.0.32/cli` and OpenCode session headers.
- A canonical session ID: `ses_` + 12 hexadecimal characters + 14 Base62 characters.
- Upstream requests always use `stream: true`.
- Tool declarations for `bash`, `glob`, `grep`, and `read`; missing declarations are added for compatibility only.

An earlier native-client test disabled all tool permissions, so its failure was not a conclusive test of a normal OpenCode request. Including tool declarations and streaming produced the successful requests described above.

This compatibility behavior is not a guarantee of future access or permission under the provider's terms. Follow the current service terms. The proxy does not rotate accounts, quotas, or IP addresses; remaining upstream access errors are forwarded.

## API behavior and limits

- `GET /health`: unauthenticated liveness check.
- `GET /v1/models`: authenticated local model allowlist.
- `POST /v1/chat/completions`: SSE when the client requests `stream: true`; otherwise the upstream stream is aggregated into an OpenAI-compatible JSON response. Text, reasoning, multiple choices, tool calls, finish reasons, logprobs, and usage are retained.
- Caller tool schemas and explicitly supplied `tool_choice` values are preserved. Missing compatibility declarations are added. Plain chat defaults to `tool_choice: none`.
- **The proxy never executes tools, opens a shell, or reads files on behalf of the model.** Calls to tools the client did not declare are blocked. Tool fragments are held until complete so compatibility-only calls never reach the client; text streams immediately.
- Session mapping uses `x-opencode-session`, `x-session-id`, `x-opencode-session-id`, or the request's `prompt_cache_key`. Canonical IDs are preserved, other values are mapped deterministically, and requests without a session receive a new ID.
- Client disconnection cancels the upstream request; stream backpressure is respected.
- Limits: **4 MiB request body**, **1 MiB SSE event**, **32 MiB upstream response**, and a default **300-second total deadline**.
- Incomplete streams or undeclared tool calls produce a 502 for non-streaming clients. If SSE headers have already been sent, the connection is terminated instead; its HTTP status can no longer be changed.
- Not implemented: `/responses`, `/messages`, embeddings, image generation, audio output, or browser CORS support. Use `tools/tool_choice` rather than legacy `functions/function_call`. CLIProxyAPI must handle any required client-protocol conversion.

## Current free model catalog

Checked **2026-10-20 at 19:10 UTC** against the [live model catalog](https://opencode.ai/inference/v1/models) and [official pricing/endpoint documentation](https://opencode.ai/docs/zen/). The following 10 models were both present in the live catalog and documented as free:

| Model | Upstream ID | Included in this proxy by default |
| --- | --- | --- |
| Big Pickle | `big-pickle` | Yes — Chat Completions |
| Beam Free | `beam-free` | Yes — Chat Completions |
| MiMo-V2.6-Flash Free | `mimo-v2.6-flash-free` | Yes — Chat Completions |
| Nemotron 3.5 Super VL Free | `nemotron-3.5-super-vl-free` | Yes — Chat Completions |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | Yes — Chat Completions |
| LongCat 2.5 Preview Free | `longcat-2.5-preview-free` | Yes — Chat Completions |
| DeepSeek V4.1 Flash Free | `deepseek-v4.1-flash-free` | Yes — Chat Completions |
| GLM-5.3-Flash Free | `glm-5.3-flash-free` | Yes — Chat Completions |
| MiniMax M3.1 Flash Free | `minimax-m3.1-flash-free` | Yes — Chat Completions |
| Jev 1.13 Free | `jev-1.13-free` | No — uses System One, not Chat Completions |

The documentation also lists `ll-alpha-free`, `exo-free`, `mimo-v2.5-free`, and `nemotron-3-ultra-free`, but those IDs were absent from the live catalog at the check above. They are not enabled here. Catalog presence is not proof of successful inference or access from your account/network.

The default allowlist in `src/proxy.ts` is curated and **does not update automatically**. Override it with:

```dotenv
ALLOWED_MODELS=big-pickle,glm-5.3-flash-free
REQUEST_TIMEOUT_MS=300000
```

This **replaces the entire default list**. Update your CLIProxyAPI model configuration to match. Requests for models outside the allowlist are rejected before reaching OpenCode.

### Pricing and privacy risks

An allowlist is **not a live pricing check**. Free promotions can end, and access can be removed. Check current pricing before enabling models. If you supply a personal OpenCode key, review workspace spending limits and automatic balance reload settings.

Some free models have different data-retention or training terms. Do not submit confidential or personal data without reviewing the provider's current privacy terms.

## Tests

```bash
npm run check
npm test
npm run build
```

The 21 automated tests use a local mock upstream; they do not contact external services or incur inference charges. Coverage includes authentication, model restrictions, request validation and size limits, canonical session IDs, compatibility declarations, fragmented UTF-8/CRLF SSE, reasoning/usage/logprobs aggregation, tool-call safety, incomplete streams, cancellation, timeouts, and upstream error forwarding.

## References

- [OpenCode models, endpoints, pricing, and privacy](https://opencode.ai/docs/zen/)
- [Live OpenCode model catalog](https://opencode.ai/inference/v1/models)
- [Official CLIProxyAPI configuration example](https://github.com/router-for-me/CLIProxyAPI/blob/main/config.example.yaml)
- [OpenCode session ID generation](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/identifier.ts)
- [Community findings on headers, sessions, tools, and streaming](https://github.com/decolua/9router/issues/4101)
- [Official-client FreeTierError reports and tool permissions](https://github.com/anomalyco/opencode/issues/49680)
