# ConnectAI Proxy Usage Guidelines

`proxy.js` is the local compatibility proxy used by Connect AI to route model
requests to Ollama or OpenRouter while preserving the Ollama-compatible API
shape expected by the extension.

## When To Run

Run the proxy before using Connect AI with the `openrouter-cloud` model or any
setup that points `connectAiLab.ollamaUrl` to `http://127.0.0.1:4000`.

After a system restart, verify the proxy first because it is a local Node
process and may not be running automatically.

```powershell
Invoke-RestMethod http://127.0.0.1:4000/health
```

If the command fails, start the proxy from the repository root:

```powershell
.\start-proxy.bat
```

The batch file is idempotent: if the proxy is already healthy on the configured
port, it exits without starting a duplicate Node process.

Manual foreground start:

```powershell
cd E:\my-connect-ai
node proxy.js
```

For a hidden background process:

```powershell
cd E:\my-connect-ai
Start-Process -FilePath node -ArgumentList 'proxy.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden
```

## Health Response

A healthy proxy returns JSON like:

```json
{
  "ok": true,
  "mode": "auto",
  "cloudAlias": "openrouter-cloud",
  "pathGuard": {
    "brainDir": "g:\\내 드라이브\\Solu-ConnectAI-KM",
    "companyDir": "g:\\내 드라이브\\Solu-ConnectAI-KM\\_company",
    "sessionsDir": "g:\\내 드라이브\\Solu-ConnectAI-KM\\_company\\sessions"
  }
}
```

The important fields are:

- `ok`: proxy is responding.
- `mode`: routing mode, usually `auto`.
- `cloudConfigured`: OpenRouter credentials and model are configured.
- `pathGuard.companyDir`: exact current Connect AI company folder.
- `pathGuard.sessionsDir`: exact current company session folder.

## Path Guard

The proxy adds a lightweight path guard to relevant model requests. This helps
avoid stale model-generated file action paths such as:

```text
~/Downloads/지식메모리/_company/_agents/developer/sessions/...
```

The valid session root is:

```text
<companyDir>\sessions
```

The proxy also rewrites known stale action-tag paths in model responses before
they reach the extension. For example:

```xml
<list_files path="~/Downloads/지식메모리/_company/_agents/developer/sessions/2026-05-13T06-02"/>
```

is rewritten to:

```xml
<list_files path="g:\내 드라이브\Solu-ConnectAI-KM\_company\sessions\2026-05-13T06-02"/>
```

## Path Resolution Order

The proxy resolves Connect AI storage paths in this order:

1. Environment variables:
   - `CONNECTAI_LOCAL_BRAIN_PATH`
   - `CONNECTAI_KNOWLEDGE_ROOT`
   - `CONNECTAI_BRAIN_DIR`
   - `CONNECTAI_COMPANY_DIR`
2. User settings files, including:
   - `%APPDATA%\Antigravity\User\settings.json`
   - `%APPDATA%\Code\User\settings.json`
   - `%APPDATA%\Cursor\User\settings.json`
3. Default fallback:
   - brain root: `%USERPROFILE%\.connect-ai-brain`
   - company root: `<brain root>\_company`

## Useful Environment Variables

```text
CONNECTAI_PROXY_MODE=auto
CONNECTAI_PROXY_HOST=127.0.0.1
CONNECTAI_PROXY_PORT=4000
CONNECTAI_PROXY_OLLAMA_URL=http://127.0.0.1:11434
CONNECTAI_PROXY_CLOUD_ALIAS=openrouter-cloud
CONNECTAI_PROXY_CLOUD_MODEL=<openrouter-model-id>
OPENROUTER_API_KEY=<token>
```

To disable path guard behavior temporarily:

```text
CONNECTAI_PROXY_PATH_GUARD=0
```

## Troubleshooting

If Connect AI cannot reach the proxy:

1. Check that `connectAiLab.ollamaUrl` is `http://127.0.0.1:4000`.
2. Run `Invoke-RestMethod http://127.0.0.1:4000/health`.
3. If health fails, start `node proxy.js` from the repository root.
4. If health works but model calls fail, check `.env` for OpenRouter settings.
5. If file actions use stale paths, confirm `pathGuard.companyDir` and
   `pathGuard.sessionsDir` in `/health`.
