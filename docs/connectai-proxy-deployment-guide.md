# ConnectAI proxy deployment guide

This guide explains how to run ConnectAI through the local `proxy.js` router so the installed extension can use cloud models without changing the extension package.

## Recommended operating model

For machines with limited memory headroom, prefer full cloud routing:

```env
CONNECTAI_PROXY_MODE=cloud
```

Keeping even one local model available means Ollama may keep that model loaded in unified memory. On Apple Silicon this memory is shared by CPU, GPU, Electron apps, browsers, Docker, and the LLM runtime. A "mostly cloud, light local" setup can still feel slow if the local model remains loaded.

Use selective local routing only when you explicitly need offline behavior or want to avoid cloud calls for low-value tasks.

## Architecture

```text
ConnectAI extension
  -> http://127.0.0.1:4000
     -> CONNECTAI_PROXY_MODE=cloud: OpenRouter for every chat request
     -> CONNECTAI_PROXY_MODE=auto: OpenRouter only for the configured cloud alias
     -> CONNECTAI_PROXY_MODE=ollama: local Ollama only
```

The proxy also listens on an optional LM Studio compatibility port:

```env
CONNECTAI_PROXY_COMPAT_PORT=1234
```

This catches extension fallback calls that assume LM Studio is running at `127.0.0.1:1234`.

## Files required on another machine

Minimum files:

- `proxy.js`
- `.env`, copied from `.env.example`

You do not need the full Git repository just to use the proxy. You do need the repository if you want to change extension source code, rebuild the VSIX, or keep these files under version control.

## Prerequisites

Install:

- Node.js 18 or newer
- ConnectAI extension in Antigravity or VS Code
- OpenRouter API key for cloud routing
- Ollama only if using `auto` or `ollama` modes

## Install the proxy

Create a small runtime directory:

```bash
mkdir -p ~/connect-ai-proxy
cd ~/connect-ai-proxy
```

Copy `proxy.js` into that directory and create `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
CONNECTAI_PROXY_MODE=cloud
CONNECTAI_PROXY_HOST=127.0.0.1
CONNECTAI_PROXY_PORT=4000
CONNECTAI_PROXY_COMPAT_PORT=1234
CONNECTAI_PROXY_OLLAMA_URL=http://127.0.0.1:11434

CONNECTAI_PROXY_CLOUD_ALIAS=openrouter-cloud
CONNECTAI_PROXY_CLOUD_MODEL=moonshotai/kimi-k2.6
OPENROUTER_API_KEY=replace-with-your-key

OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=ConnectAI
```

Start it:

```bash
node proxy.js
```

Health check:

```bash
curl http://127.0.0.1:4000/health
```

Expected result:

```json
{
  "ok": true,
  "mode": "cloud",
  "ollamaBaseUrl": "http://127.0.0.1:11434",
  "cloudConfigured": true,
  "cloudAlias": "openrouter-cloud",
  "cloudModel": "moonshotai/kimi-k2.6"
}
```

## Configure Antigravity or VS Code

Set ConnectAI to use the proxy as its Ollama endpoint:

```json
{
  "connectAiLab.ollamaUrl": "http://127.0.0.1:4000",
  "connectAiLab.defaultModel": "gemma4-agent:e4b"
}
```

In `cloud` mode, the default model name can remain a local-looking name because the proxy routes all chat requests to the cloud provider.

If using Google Drive as the ConnectAI knowledge store, also set:

```json
{
  "connectAiLab.localBrainPath": "/absolute/path/to/ConnectAI-KM"
}
```

## Full cloud mode

Use this when system performance is the priority:

```env
CONNECTAI_PROXY_MODE=cloud
```

Then unload any currently loaded Ollama model:

```bash
ollama stop gemma4-agent:e4b
```

If Ollama is not needed for embeddings or other local workflows, stop the server too:

```bash
pkill -f "ollama serve"
```

Do this only when no other local app depends on Ollama.

## Selective cloud mode

Use this when only specific agents should use cloud models:

```env
CONNECTAI_PROXY_MODE=auto
CONNECTAI_PROXY_CLOUD_ALIAS=openrouter-cloud
```

Then configure the agent model map in the ConnectAI knowledge store:

```json
{
  "ceo": "openrouter-cloud",
  "developer": "gemma4-agent:e4b",
  "researcher": "gemma4-agent:e4b"
}
```

File location:

```text
<localBrainPath>/_company/_shared/agent_models.json
```

Important: selective mode does not eliminate local model memory pressure if any local agent call loads an Ollama model.

## JSON planning reliability

ConnectAI expects the CEO planning step to return a JSON object with `brief` and `tasks`.

Some cloud models can intermittently return an empty JSON object or an empty message when strict JSON response mode is enabled. The proxy handles this by:

- detecting JSON-like planning requests
- buffering the cloud response instead of streaming partial JSON
- retrying once without `response_format` when the first result is empty, `{}`, or `[]`
- strengthening the retry prompt to require a non-empty JSON object

This is why the proxy is preferred over pointing ConnectAI directly at an OpenAI-compatible endpoint.

## Start automatically on macOS

Create `~/Library/LaunchAgents/com.connectai.proxy.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.connectai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOUR_USER/connect-ai-proxy/proxy.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/connect-ai-proxy</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/connect-ai-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/connect-ai-proxy.err</string>
</dict>
</plist>
```

On Homebrew Node installations, check the Node path first:

```bash
which node
```

Load the service:

```bash
launchctl load ~/Library/LaunchAgents/com.connectai.proxy.plist
```

Restart after `.env` changes:

```bash
launchctl unload ~/Library/LaunchAgents/com.connectai.proxy.plist
launchctl load ~/Library/LaunchAgents/com.connectai.proxy.plist
```

## Verification checklist

Check listeners:

```bash
lsof -nP -iTCP:4000 -sTCP:LISTEN
lsof -nP -iTCP:1234 -sTCP:LISTEN
```

Check cloud route:

```bash
curl -sS http://127.0.0.1:4000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "openrouter-cloud",
    "stream": true,
    "messages": [
      {"role": "system", "content": "Return only JSON."},
      {"role": "user", "content": "Create {\"brief\":\"ok\",\"tasks\":[{\"agent\":\"developer\",\"task\":\"test\"}]}"}
    ]
  }'
```

Check the proxy log:

```bash
tail -80 /tmp/connect-ai-proxy.log
```

Expected cloud route log:

```text
model=openrouter-cloud route=cloud stream=true inferredJson=true
buffered-json contentLength=...
```

## Troubleshooting

### ConnectAI still uses local model

Confirm:

```json
"connectAiLab.ollamaUrl": "http://127.0.0.1:4000"
```

Then reload the Antigravity or VS Code window.

### CEO JSON planning fails

Check:

```bash
tail -120 /tmp/connect-ai-proxy.log
```

If content length is repeatedly `0` or `{}`, change the cloud model to one with stronger JSON behavior, or keep the retry-enabled proxy version from this repository.

### System remains slow after cloud mode

Check whether Ollama still has a model loaded:

```bash
ollama ps
```

Unload it:

```bash
ollama stop gemma4-agent:e4b
```

Also check memory pressure:

```bash
top -l 1 -s 0 -n 0 | sed -n '1,20p'
vm_stat
```

### Port 1234 conflict

If LM Studio is already running on `1234`, either stop LM Studio or disable compatibility mode:

```env
CONNECTAI_PROXY_COMPAT_PORT=0
```

Then restart the proxy.

## Security notes

- Never commit `.env`.
- Keep `OPENROUTER_API_KEY` out of documentation, screenshots, and logs.
- Use a separate OpenRouter key per machine if possible.
- If a key was exposed, revoke it and create a new one.
