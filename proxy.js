const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  host: process.env.CONNECTAI_PROXY_HOST || '127.0.0.1',
  port: Number(process.env.CONNECTAI_PROXY_PORT || 4000),
  mode: (process.env.CONNECTAI_PROXY_MODE || 'ollama').toLowerCase(),
  ollamaBaseUrl: trimSlash(process.env.CONNECTAI_PROXY_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434'),
  cloudBaseUrl: trimSlash(process.env.CONNECTAI_PROXY_CLOUD_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
  cloudApiKey: process.env.CONNECTAI_PROXY_CLOUD_API_KEY || process.env.OPENROUTER_API_KEY || '',
  cloudModel: normalizeCloudModel(process.env.CONNECTAI_PROXY_CLOUD_MODEL || process.env.OPENROUTER_MODEL || ''),
  cloudAlias: process.env.CONNECTAI_PROXY_CLOUD_ALIAS || 'openrouter-cloud',
  requestTimeoutMs: Number(process.env.CONNECTAI_PROXY_TIMEOUT_MS || 600000),
};

const server = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        mode: CONFIG.mode,
        ollamaBaseUrl: CONFIG.ollamaBaseUrl,
        cloudConfigured: Boolean(CONFIG.cloudApiKey && CONFIG.cloudModel),
        cloudAlias: CONFIG.cloudAlias,
        cloudModel: CONFIG.cloudModel || null,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/tags') {
      await handleTags(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/chat') {
      await handleOllamaChat(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      await handleOpenAIModels(res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      await handleOpenAIChat(req, res);
      return;
    }

    await pipeToOllama(req, res, url.pathname + url.search);
  } catch (error) {
    sendError(res, 500, error);
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[connect-ai-proxy] listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[connect-ai-proxy] mode=${CONFIG.mode} ollama=${CONFIG.ollamaBaseUrl}`);
  if (CONFIG.cloudApiKey && CONFIG.cloudModel) {
    console.log(`[connect-ai-proxy] cloud alias=${CONFIG.cloudAlias} model=${CONFIG.cloudModel}`);
  } else {
    console.log('[connect-ai-proxy] cloud disabled; set OPENROUTER_API_KEY and CONNECTAI_PROXY_CLOUD_MODEL to enable it');
  }
});

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeCloudModel(value) {
  const model = String(value || '').trim();
  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);
  return model;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function handleTags(res) {
  let upstream;
  try {
    upstream = await requestJson('GET', `${CONFIG.ollamaBaseUrl}/api/tags`);
  } catch (error) {
    upstream = { models: [] };
  }

  const models = Array.isArray(upstream.models) ? upstream.models.slice() : [];
  if (isCloudConfigured() && CONFIG.mode !== 'ollama') {
    models.push({
      name: CONFIG.cloudAlias,
      model: CONFIG.cloudAlias,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: `cloud:${CONFIG.cloudModel}`,
      details: {
        parent_model: CONFIG.cloudModel,
        format: 'openai-compatible',
        family: 'openrouter',
        families: ['openrouter'],
        parameter_size: 'cloud',
        quantization_level: 'remote',
      },
    });
  }

  sendJson(res, 200, { models });
}

async function handleOllamaChat(req, res) {
  const body = await readJson(req);
  if (shouldUseCloud(body.model)) {
    await sendCloudAsOllama(body, res);
    return;
  }
  await requestAndPipe({
    method: 'POST',
    targetUrl: `${CONFIG.ollamaBaseUrl}/api/chat`,
    body,
    res,
  });
}

async function handleOpenAIModels(res) {
  let data = [];
  try {
    const upstream = await requestJson('GET', `${CONFIG.ollamaBaseUrl}/v1/models`);
    data = Array.isArray(upstream.data) ? upstream.data : [];
  } catch {}

  if (isCloudConfigured() && CONFIG.mode !== 'ollama') {
    data.push({ id: CONFIG.cloudAlias, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openrouter' });
  }

  sendJson(res, 200, { object: 'list', data });
}

async function handleOpenAIChat(req, res) {
  const body = await readJson(req);
  if (shouldUseCloud(body.model)) {
    await requestAndPipe({
      method: 'POST',
      targetUrl: `${CONFIG.cloudBaseUrl}/chat/completions`,
      body: openAICloudBody(body),
      headers: cloudHeaders(),
      res,
    });
    return;
  }
  await requestAndPipe({
    method: 'POST',
    targetUrl: `${CONFIG.ollamaBaseUrl}/v1/chat/completions`,
    body,
    res,
  });
}

function shouldUseCloud(requestedModel) {
  if (!isCloudConfigured()) return false;
  if (CONFIG.mode === 'cloud') return true;
  if (CONFIG.mode !== 'auto') return false;

  const model = String(requestedModel || '').trim();
  return model === CONFIG.cloudAlias || model === CONFIG.cloudModel || model.startsWith('openrouter/') || model.startsWith('cloud:');
}

function isCloudConfigured() {
  return Boolean(CONFIG.cloudApiKey && CONFIG.cloudModel);
}

async function sendCloudAsOllama(ollamaBody, res) {
  const stream = ollamaBody.stream !== false;
  const cloudBody = {
    model: CONFIG.cloudModel,
    messages: Array.isArray(ollamaBody.messages) ? ollamaBody.messages : [],
    stream,
    temperature: ollamaBody.options?.temperature,
    top_p: ollamaBody.options?.top_p,
    max_tokens: ollamaBody.options?.num_predict,
  };

  for (const key of Object.keys(cloudBody)) {
    if (cloudBody[key] === undefined) delete cloudBody[key];
  }

  if (!stream) {
    const data = await requestJson('POST', `${CONFIG.cloudBaseUrl}/chat/completions`, cloudBody, cloudHeaders());
    sendJson(res, 200, toOllamaNonStream(data, ollamaBody.model || CONFIG.cloudAlias));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  await requestOpenAIStream(`${CONFIG.cloudBaseUrl}/chat/completions`, cloudBody, cloudHeaders(), chunk => {
    res.write(JSON.stringify({
      model: ollamaBody.model || CONFIG.cloudAlias,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: chunk },
      done: false,
    }) + '\n');
  });
  res.write(JSON.stringify({
    model: ollamaBody.model || CONFIG.cloudAlias,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content: '' },
    done: true,
  }) + '\n');
  res.end();
}

function openAICloudBody(body) {
  return {
    ...body,
    model: CONFIG.cloudModel,
  };
}

function toOllamaNonStream(data, model) {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: data?.choices?.[0]?.message?.content || '',
    },
    done: true,
  };
}

function cloudHeaders() {
  const headers = {
    Authorization: `Bearer ${CONFIG.cloudApiKey}`,
    'Content-Type': 'application/json',
  };
  if (process.env.OPENROUTER_HTTP_REFERER) headers['HTTP-Referer'] = process.env.OPENROUTER_HTTP_REFERER;
  if (process.env.OPENROUTER_APP_TITLE) headers['X-Title'] = process.env.OPENROUTER_APP_TITLE;
  return headers;
}

async function pipeToOllama(req, res, targetPath) {
  const body = await readRaw(req);
  await requestAndPipe({
    method: req.method,
    targetUrl: `${CONFIG.ollamaBaseUrl}${targetPath}`,
    body: body.length ? body : undefined,
    rawBody: true,
    headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
    res,
  });
}

function readJson(req) {
  return readRaw(req).then(raw => {
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
  });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function requestJson(method, targetUrl, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: CONFIG.requestTimeoutMs,
      headers: {
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestAndPipe({ method, targetUrl, body, rawBody = false, headers = {}, res }) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const payload = body === undefined ? undefined : (rawBody ? body : JSON.stringify(body));
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: CONFIG.requestTimeoutMs,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, response => {
      res.writeHead(response.statusCode || 502, {
        ...response.headers,
        'Access-Control-Allow-Origin': '*',
      });
      response.pipe(res);
      response.on('end', resolve);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestOpenAIStream(targetUrl, body, headers, onToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const payload = JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: CONFIG.requestTimeoutMs,
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, response => {
      if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
        let errorBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => errorBody += chunk);
        response.on('end', () => reject(new Error(`HTTP ${response.statusCode}: ${errorBody}`)));
        return;
      }

      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const json = JSON.parse(data);
            const token = json.choices?.[0]?.delta?.content || '';
            if (token) onToken(token);
          } catch {}
        }
      });
      response.on('end', resolve);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res, fallbackStatusCode, error) {
  const statusCode = error.statusCode || fallbackStatusCode;
  sendJson(res, statusCode, {
    error: {
      message: error.message || String(error),
      type: statusCode >= 500 ? 'proxy_error' : 'bad_request',
    },
  });
}
