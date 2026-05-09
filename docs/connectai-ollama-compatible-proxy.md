# ConnectAI Ollama-compatible proxy

This proxy lets the installed ConnectAI extension keep using an Ollama-compatible endpoint while requests are routed locally or to an OpenAI-compatible cloud provider.

Default behavior is local-only:

```env
CONNECTAI_PROXY_MODE=ollama
CONNECTAI_PROXY_PORT=4000
CONNECTAI_PROXY_OLLAMA_URL=http://127.0.0.1:11434
```

Point ConnectAI at the proxy:

```json
"connectAiLab.ollamaUrl": "http://127.0.0.1:4000"
```

## Modes

- `ollama`: every request is forwarded to local Ollama.
- `cloud`: every chat request is sent to the configured cloud model.
- `auto`: local models go to Ollama, and the cloud alias goes to the cloud provider.

For selective cloud routing:

```env
CONNECTAI_PROXY_MODE=auto
CONNECTAI_PROXY_CLOUD_ALIAS=openrouter-cloud
CONNECTAI_PROXY_CLOUD_MODEL=moonshotai/kimi-k2.6
OPENROUTER_API_KEY=replace-me
```

Then use `openrouter-cloud` as the model name in ConnectAI. Other model names such as `gemma4-agent:e4b` continue to use Ollama.

## Run

```bash
node proxy.js
```

The proxy implements:

- `GET /api/tags`
- `POST /api/chat`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `GET /health`

Do not commit `.env`; use `.env.example` as the template.
