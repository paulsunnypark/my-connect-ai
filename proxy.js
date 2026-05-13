const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

loadDotEnv(path.join(__dirname, '.env'));

const CONFIG = {
  host: process.env.CONNECTAI_PROXY_HOST || '127.0.0.1',
  port: Number(process.env.CONNECTAI_PROXY_PORT || 4000),
  compatPort: Number(process.env.CONNECTAI_PROXY_COMPAT_PORT || 0),
  mode: (process.env.CONNECTAI_PROXY_MODE || 'ollama').toLowerCase(),
  ollamaBaseUrl: trimSlash(process.env.CONNECTAI_PROXY_OLLAMA_URL || process.env.OLLAMA_URL || 'http://127.0.0.1:11434'),
  cloudBaseUrl: trimSlash(process.env.CONNECTAI_PROXY_CLOUD_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
  cloudApiKey: process.env.CONNECTAI_PROXY_CLOUD_API_KEY || process.env.OPENROUTER_API_KEY || '',
  cloudModel: normalizeCloudModel(process.env.CONNECTAI_PROXY_CLOUD_MODEL || process.env.OPENROUTER_MODEL || ''),
  fallbackCloudModel: normalizeCloudModel(process.env.CONNECTAI_PROXY_FALLBACK_CLOUD_MODEL || ''),
  cloudAlias: process.env.CONNECTAI_PROXY_CLOUD_ALIAS || 'openrouter-cloud',
  requestTimeoutMs: Number(process.env.CONNECTAI_PROXY_TIMEOUT_MS || 600000),
  upstreamRetries: Math.max(1, Number(process.env.CONNECTAI_PROXY_UPSTREAM_RETRIES || 3)),
  retryBaseDelayMs: Math.max(100, Number(process.env.CONNECTAI_PROXY_RETRY_BASE_DELAY_MS || 750)),
  pathGuardEnabled: process.env.CONNECTAI_PROXY_PATH_GUARD !== '0',
};

const server = createProxyServer();
const compatServer = CONFIG.compatPort && CONFIG.compatPort !== CONFIG.port ? createProxyServer() : null;

function createProxyServer() {
  return http.createServer(async (req, res) => {
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
        fallbackCloudModel: CONFIG.fallbackCloudModel || null,
        pathGuard: CONFIG.pathGuardEnabled ? resolveConnectAiPaths() : null,
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
}

server.on('error', error => {
  console.error(`[connect-ai-proxy] server error: ${error.message || error}`);
  process.exitCode = 1;
});

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`[connect-ai-proxy] listening on http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`[connect-ai-proxy] mode=${CONFIG.mode} ollama=${CONFIG.ollamaBaseUrl}`);
  if (CONFIG.pathGuardEnabled) {
    const guardPaths = resolveConnectAiPaths();
    console.log(`[connect-ai-proxy] path guard company=${guardPaths.companyDir}`);
  }
  if (CONFIG.cloudApiKey && CONFIG.cloudModel) {
    console.log(`[connect-ai-proxy] cloud alias=${CONFIG.cloudAlias} model=${CONFIG.cloudModel}`);
  } else {
    console.log('[connect-ai-proxy] cloud disabled; set OPENROUTER_API_KEY and CONNECTAI_PROXY_CLOUD_MODEL to enable it');
  }
});

if (compatServer) {
  compatServer.on('error', error => {
    console.error(`[connect-ai-proxy] compat server error: ${error.message || error}`);
  });
  compatServer.listen(CONFIG.compatPort, CONFIG.host, () => {
    console.log(`[connect-ai-proxy] LM Studio compatibility listener on http://${CONFIG.host}:${CONFIG.compatPort}`);
  });
}

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
    upstream = await requestJson('GET', `${CONFIG.ollamaBaseUrl}/api/tags`, undefined, {}, { timeoutMs: 300, retries: 1 });
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
    if (CONFIG.fallbackCloudModel) {
      models.push({
        name: `openrouter/${CONFIG.fallbackCloudModel}`,
        model: `openrouter/${CONFIG.fallbackCloudModel}`,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: `cloud:${CONFIG.fallbackCloudModel}`,
        details: {
          parent_model: CONFIG.fallbackCloudModel,
          format: 'openai-compatible',
          family: 'openrouter',
          families: ['openrouter'],
          parameter_size: 'cloud',
          quantization_level: 'remote',
        },
      });
    }
  }

  sendJson(res, 200, { models });
}

async function handleOllamaChat(req, res) {
  const body = applyConnectAiPathGuard(await readJson(req));
  if (shouldUseCloud(body.model)) {
    logRoute('ollama-chat', body.model, 'cloud', body);
    await sendCloudAsOllama(body, res);
    return;
  }
  logRoute('ollama-chat', body.model, 'ollama', body);
  await requestAndPipe({
    method: 'POST',
    targetUrl: `${CONFIG.ollamaBaseUrl}/api/chat`,
    body: stripProxyOnlyFields(body),
    res,
  });
}

async function handleOpenAIModels(res) {
  let data = [];
  try {
    const upstream = await requestJson('GET', `${CONFIG.ollamaBaseUrl}/v1/models`, undefined, {}, { timeoutMs: 300, retries: 1 });
    data = Array.isArray(upstream.data) ? upstream.data : [];
  } catch {}

  if (isCloudConfigured() && CONFIG.mode !== 'ollama') {
    data.push({ id: CONFIG.cloudAlias, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'openrouter' });
  }

  sendJson(res, 200, { object: 'list', data });
}

async function handleOpenAIChat(req, res) {
  const body = applyConnectAiPathGuard(await readJson(req));
  if (shouldUseCloud(body.model)) {
    logRoute('openai-chat', body.model, 'cloud', body);
    await requestAndPipe({
      method: 'POST',
      targetUrl: `${CONFIG.cloudBaseUrl}/chat/completions`,
      body: openAICloudBody(body),
      headers: cloudHeaders(),
      res,
    });
    return;
  }
  logRoute('openai-chat', body.model, 'ollama', body);
  await requestAndPipe({
    method: 'POST',
    targetUrl: `${CONFIG.ollamaBaseUrl}/v1/chat/completions`,
    body: stripProxyOnlyFields(body),
    res,
  });
}

function shouldUseCloud(requestedModel) {
  if (!isCloudConfigured()) return false;
  if (CONFIG.mode === 'cloud') return true;
  if (CONFIG.mode !== 'auto') return false;
  if (CONFIG.fallbackCloudModel) return true;

  const model = String(requestedModel || '').trim();
  return model === CONFIG.cloudAlias || model === CONFIG.cloudModel || model.startsWith('openrouter/') || model.startsWith('cloud:');
}

function isCloudConfigured() {
  return Boolean(CONFIG.cloudApiKey && CONFIG.cloudModel);
}

function logRoute(kind, requestedModel, route, body) {
  const stream = body?.stream !== false;
  const format = body?.format ? ` format=${body.format}` : '';
  const inferredJson = route === 'cloud' && !body?.format && messagesSuggestJson(body?.messages) ? ' inferredJson=true' : '';
  const guarded = body?.__connectAiPathGuard ? ' pathGuard=true' : '';
  const target = route === 'cloud' ? ` target=${resolveCloudModel(requestedModel)}` : '';
  console.log(`[connect-ai-proxy] ${kind} model=${requestedModel || '(default)'} route=${route}${target} stream=${stream}${format}${inferredJson}${guarded}`);
}

async function sendCloudAsOllama(ollamaBody, res) {
  const stream = ollamaBody.stream !== false;
  const jsonResponse = ollamaBody.format === 'json' || messagesSuggestJson(ollamaBody.messages);
  const bufferedJson = stream && jsonResponse;
  const targetModel = resolveCloudModel(ollamaBody.model);
  const cloudBody = {
    model: targetModel,
    messages: Array.isArray(ollamaBody.messages) ? ollamaBody.messages : [],
    stream: bufferedJson ? false : stream,
    temperature: ollamaBody.options?.temperature,
    top_p: ollamaBody.options?.top_p,
    reasoning: { effort: 'none', exclude: true },
  };

  const maxTokens = normalizeMaxTokens(ollamaBody.options?.num_predict);
  if (maxTokens !== undefined) cloudBody.max_tokens = maxTokens;
  if (jsonResponse) cloudBody.response_format = { type: 'json_object' };

  for (const key of Object.keys(cloudBody)) {
    if (cloudBody[key] === undefined) delete cloudBody[key];
  }

  if (!stream) {
    const data = await requestJson('POST', `${CONFIG.cloudBaseUrl}/chat/completions`, cloudBody, cloudHeaders());
    sendJson(res, 200, toOllamaNonStream(data, ollamaBody.model || CONFIG.cloudAlias));
    return;
  }

  if (bufferedJson) {
    let data = await requestJson('POST', `${CONFIG.cloudBaseUrl}/chat/completions`, cloudBody, cloudHeaders());
    let content = sanitizeConnectAiActionText(cloudMessageContent(data));
    if (isEmptyJsonContent(content)) {
      console.warn(`[connect-ai-proxy] buffered-json empty response; retrying without response_format`);
      const retryBody = {
        ...cloudBody,
        response_format: undefined,
        messages: strengthenJsonMessages(cloudBody.messages),
      };
      for (const key of Object.keys(retryBody)) {
        if (retryBody[key] === undefined) delete retryBody[key];
      }
      data = await requestJson('POST', `${CONFIG.cloudBaseUrl}/chat/completions`, retryBody, cloudHeaders());
      content = sanitizeConnectAiActionText(cloudMessageContent(data));
    }
    console.log(`[connect-ai-proxy] buffered-json contentLength=${content.length} preview=${JSON.stringify(content.slice(0, 160))}`);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    if (content) {
      res.write(JSON.stringify({
        model: ollamaBody.model || CONFIG.cloudAlias,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content },
        done: false,
      }) + '\n');
    }
    res.write(JSON.stringify({
      model: ollamaBody.model || CONFIG.cloudAlias,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: '' },
      done: true,
    }) + '\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  try {
    const sanitizer = createActionTagStreamSanitizer(chunk => {
      res.write(JSON.stringify({
        model: ollamaBody.model || CONFIG.cloudAlias,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: chunk },
        done: false,
      }) + '\n');
    });
    await requestOpenAIStreamWithRetry(`${CONFIG.cloudBaseUrl}/chat/completions`, cloudBody, cloudHeaders(), chunk => {
      sanitizer.push(chunk);
    });
    sanitizer.flush();
    writeOllamaDone(res, ollamaBody.model || CONFIG.cloudAlias);
  } catch (error) {
    console.error(`[connect-ai-proxy] cloud stream failed: ${error.message || error}`);
    if (!res.writableEnded) {
      res.write(JSON.stringify({
        model: ollamaBody.model || CONFIG.cloudAlias,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: `\n\n[ConnectAI proxy] Cloud stream failed: ${error.message || String(error)}`,
        },
        done: false,
      }) + '\n');
      writeOllamaDone(res, ollamaBody.model || CONFIG.cloudAlias);
    }
  }
}

function openAICloudBody(body) {
  const cloudBody = {
    ...body,
    model: resolveCloudModel(body?.model),
    reasoning: body?.reasoning || { effort: 'none', exclude: true },
  };
  delete cloudBody.__connectAiPathGuard;
  if (cloudBody.max_tokens !== undefined) {
    const maxTokens = normalizeMaxTokens(cloudBody.max_tokens);
    if (maxTokens === undefined) delete cloudBody.max_tokens;
    else cloudBody.max_tokens = maxTokens;
  }
  return cloudBody;
}

function stripProxyOnlyFields(body) {
  if (!body || typeof body !== 'object' || !body.__connectAiPathGuard) return body;
  const clean = { ...body };
  delete clean.__connectAiPathGuard;
  return clean;
}

function resolveCloudModel(requestedModel) {
  const model = String(requestedModel || '').trim();
  if (CONFIG.mode === 'cloud') {
    if (model.startsWith('openrouter/') || model.startsWith('cloud:')) return stripCloudModelPrefix(model);
    return CONFIG.cloudModel;
  }
  if (model === CONFIG.cloudAlias || model === CONFIG.cloudModel) return CONFIG.cloudModel;
  if (model.startsWith('openrouter/') || model.startsWith('cloud:')) return stripCloudModelPrefix(model);
  if (CONFIG.fallbackCloudModel) return CONFIG.fallbackCloudModel;
  return stripCloudModelPrefix(model) || CONFIG.cloudModel;
}

function stripCloudModelPrefix(model) {
  if (model.startsWith('openrouter/')) return model.slice('openrouter/'.length);
  if (model.startsWith('cloud:')) return model.slice('cloud:'.length);
  return model;
}

function normalizeMaxTokens(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function messagesSuggestJson(messages) {
  if (!Array.isArray(messages)) return false;
  const contents = messages
    .map(message => typeof message?.content === 'string' ? message.content : '');
  const text = contents
    .join('\n')
    .slice(0, 20000);
  const userText = messages
    .filter(message => message?.role === 'user' && typeof message.content === 'string')
    .map(message => message.content)
    .join('\n')
    .slice(0, 8000);

  if (!/\bjson\b/i.test(text)) return false;

  const strictJsonOnly = /반드시\s*(?:아래\s*)?JSON\s*형식으로만|JSON\s*외\s*텍스트|Return only (?:valid )?JSON|Output only (?:valid )?JSON|순수\s*JSON/i.test(text);
  if (!strictJsonOnly) return false;

  const isSpecialistDispatch = /^\s*\[CEO의 지시\]/m.test(userText);
  const isPlanner = /"brief"\s*:/.test(text) && /"tasks"\s*:/.test(text);
  const isConfer = /"turns"\s*:/.test(text) && /from/i.test(text) && /to/i.test(text);
  const isDecisionExtract = /"decisions"\s*:/.test(text) || /의사결정\s*로그|decisions\.md/i.test(text);
  const isToolClassifier = /"agent"\s*:/.test(text) && /"tool"\s*:/.test(text) && /도구|tool/i.test(text);

  if (isSpecialistDispatch) {
    return isConfer || isDecisionExtract || isToolClassifier;
  }
  return isPlanner || isConfer || isDecisionExtract || isToolClassifier;
}

function isEmptyJsonContent(content) {
  const trimmed = String(content || '').trim();
  return !trimmed || trimmed === '{}' || trimmed === '[]';
}

function strengthenJsonMessages(messages) {
  const base = Array.isArray(messages) ? messages.slice() : [];
  return [
    {
      role: 'system',
      content: 'Return one valid JSON object only. Do not return an empty object. If this is a planning request, include non-empty "brief" and "tasks" fields.',
    },
    ...base,
  ];
}

let connectAiPathCache = { at: 0, value: null };

function resolveConnectAiPaths() {
  const now = Date.now();
  if (connectAiPathCache.value && now - connectAiPathCache.at < 5000) return connectAiPathCache.value;

  const settings = readConnectAiSettings();
  const brainRaw = process.env.CONNECTAI_LOCAL_BRAIN_PATH ||
    process.env.CONNECTAI_KNOWLEDGE_ROOT ||
    process.env.CONNECTAI_BRAIN_DIR ||
    settings.localBrainPath ||
    '';
  const companyRaw = process.env.CONNECTAI_COMPANY_DIR || settings.companyDir || '';
  const brainDir = normalizeUserPath(brainRaw) || path.join(os.homedir(), '.connect-ai-brain');
  const companyDir = normalizeUserPath(companyRaw) || path.join(brainDir, '_company');
  const value = {
    brainDir,
    companyDir,
    sessionsDir: path.join(companyDir, 'sessions'),
    source: settings.source || (brainRaw || companyRaw ? 'env' : 'default'),
    brainExists: safeIsDirectory(brainDir),
    companyExists: safeIsDirectory(companyDir),
  };
  connectAiPathCache = { at: now, value };
  return value;
}

function readConnectAiSettings() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'Antigravity', 'User', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Code', 'User', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Cursor', 'User', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Windsurf', 'User', 'settings.json'),
    path.join(process.env.APPDATA || '', 'VSCodium', 'User', 'settings.json'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'User', 'settings.json'),
  ].filter(Boolean);

  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const localBrainPath = readJsonStringSetting(text, 'connectAiLab.localBrainPath');
      const companyDir = readJsonStringSetting(text, 'connectAiLab.companyDir');
      if (localBrainPath || companyDir) return { localBrainPath, companyDir, source: file };
    } catch {}
  }
  return {};
}

function readJsonStringSetting(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`"${escapedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'm'));
  if (!match) return '';
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replace(/\\\\/g, '\\');
  }
}

function normalizeUserPath(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  s = s.replace(/\$\{?(HOME|USERPROFILE|APPDATA|LOCALAPPDATA)\}?/g, (m, key) => {
    if (key === 'HOME') return process.env.HOME || os.homedir();
    return process.env[key] || m;
  });
  if (!path.isAbsolute(s)) return '';
  return path.normalize(s);
}

function safeIsDirectory(dir) {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function applyConnectAiPathGuard(body) {
  if (!CONFIG.pathGuardEnabled || !body || !Array.isArray(body.messages) || !shouldInjectConnectAiPathGuard(body.messages)) {
    return body;
  }
  return {
    ...body,
    __connectAiPathGuard: true,
    messages: [
      { role: 'system', content: buildConnectAiPathGuardMessage(resolveConnectAiPaths()) },
      ...body.messages,
    ],
  };
}

function shouldInjectConnectAiPathGuard(messages) {
  const text = messages
    .map(message => typeof message?.content === 'string' ? message.content : '')
    .join('\n')
    .slice(0, 50000);
  if (!text) return false;
  if (messagesSuggestJson(messages) && !/^\s*\[CEO의 지시\]/m.test(text)) return false;
  return /\[CEO의 지시\]|<\s*(?:list_files|read_file|create_file|edit_file|delete_file|glob|grep|run_command)\b|sessions\/|_company|회사\s*폴더|파일\s*경로|로컬\s*파일/i.test(text);
}

function buildConnectAiPathGuardMessage(paths) {
  return [
    '[ConnectAI Proxy Path Guard]',
    'Use these resolved local paths. Do not infer, remember, or invent another knowledge-store path.',
    `- Current brain root: ${paths.brainDir}`,
    `- Current company root: ${paths.companyDir}`,
    `- Current company sessions root: ${paths.sessionsDir}`,
    '- Never use stale roots such as ~/Downloads/지식메모리 or C:\\Users\\user\\Downloads\\지식메모리.',
    '- Never put session files under _agents/<agent>/sessions. The only valid session root is the company sessions root above.',
    '- For current-round files, prefer a simple relative filename. For previous sessions, use the absolute company sessions root above.',
    '- Before emitting action tags with path attributes, verify the path against this guard.',
  ].join('\n');
}

function sanitizeConnectAiActionText(text) {
  if (!CONFIG.pathGuardEnabled || typeof text !== 'string' || !text.includes('<')) return text;
  return text
    .replace(/(<(?:list_files|list_dir|ls|read_file|read|create_file|write_file|file|edit_file|edit|delete_file|delete|reveal_in_explorer|reveal|finder|explorer|open_file|open_in_app|launch)\b[^>]*?\b(?:path|dir|name|경로|파일)=)(["'])(.*?)\2/gi,
      (full, prefix, quote, value) => prefix + quote + rewriteConnectAiActionPath(value) + quote)
    .replace(/(<(?:list_files|list_dir|ls|read_file|read|create_file|write_file|file|edit_file|edit|delete_file|delete|reveal_in_explorer|reveal|finder|explorer|open_file|open_in_app|launch)\b[^>]*?\b(?:path|dir|name|경로|파일)=)([^\s'">]+)/gi,
      (full, prefix, value) => prefix + rewriteConnectAiActionPath(value));
}

function rewriteConnectAiActionPath(value) {
  const original = String(value || '').trim();
  if (!original) return original;
  const paths = resolveConnectAiPaths();
  const slash = original.replace(/\\/g, '/');
  const lower = slash.toLowerCase();
  const company = paths.companyDir;
  const sessions = paths.sessionsDir;

  const staleRootPatterns = [
    /^~\/Downloads\/지식메모리\/_company(?:\/|$)/i,
    /^~\/Downloads\/지식메모리\/company(?:\/|$)/i,
    /^C:\/Users\/user\/Downloads\/지식메모리\/_company(?:\/|$)/i,
    /^C:\/Users\/user\/Downloads\/지식메모리\/company(?:\/|$)/i,
  ];
  for (const re of staleRootPatterns) {
    if (re.test(slash)) {
      const rest = slash.replace(re, '');
      return rewriteCompanyRelativePath(rest, company, sessions);
    }
  }

  const badAgentSessions = slash.match(/^(.*?)(?:_company\/)?_agents\/[^/]+\/sessions(?:\/(.*))?$/i);
  if (badAgentSessions) {
    const rest = badAgentSessions[2] || '';
    return path.join(sessions, ...rest.split('/').filter(Boolean));
  }

  const noUnderscoreCompanySessions = slash.match(/^(.*?)[/\\]company\/sessions(?:\/(.*))?$/i);
  if (noUnderscoreCompanySessions && !lower.includes('/_company/sessions')) {
    const rest = noUnderscoreCompanySessions[2] || '';
    return path.join(sessions, ...rest.split('/').filter(Boolean));
  }

  const displayCompanySessions = slash.match(/^Company\/sessions(?:\/(.*))?$/i);
  if (displayCompanySessions) {
    const rest = displayCompanySessions[1] || '';
    return path.join(sessions, ...rest.split('/').filter(Boolean));
  }

  return original;
}

function rewriteCompanyRelativePath(rest, companyDir, sessionsDir) {
  const clean = String(rest || '').replace(/^\/+/, '');
  const badAgentSessions = clean.match(/^_agents\/[^/]+\/sessions(?:\/(.*))?$/i);
  if (badAgentSessions) {
    return path.join(sessionsDir, ...(badAgentSessions[1] || '').split('/').filter(Boolean));
  }
  return path.join(companyDir, ...clean.split('/').filter(Boolean));
}

function createActionTagStreamSanitizer(onChunk) {
  let buffer = '';
  const emit = chunk => {
    if (chunk) onChunk(chunk);
  };
  const drain = final => {
    while (buffer) {
      const start = buffer.indexOf('<');
      if (start < 0) {
        emit(buffer);
        buffer = '';
        return;
      }
      if (start > 0) {
        emit(buffer.slice(0, start));
        buffer = buffer.slice(start);
      }
      const end = buffer.indexOf('>');
      if (end < 0) {
        if (final || buffer.length > 4096) {
          const keep = final ? 0 : 1024;
          const head = keep ? buffer.slice(0, -keep) : buffer;
          buffer = keep ? buffer.slice(-keep) : '';
          emit(sanitizeConnectAiActionText(head));
        }
        return;
      }
      const tag = buffer.slice(0, end + 1);
      emit(sanitizeConnectAiActionText(tag));
      buffer = buffer.slice(end + 1);
    }
  };
  return {
    push(chunk) {
      buffer += String(chunk || '');
      drain(false);
    },
    flush() {
      drain(true);
    },
  };
}

function toOllamaNonStream(data, model) {
  return {
    model,
    created_at: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: sanitizeConnectAiActionText(cloudMessageContent(data)),
    },
    done: true,
  };
}

function cloudMessageContent(data) {
  const message = data?.choices?.[0]?.message || {};
  return String(message.content || '');
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

async function requestJson(method, targetUrl, body, headers = {}, options = {}) {
  return retryUpstream(`json ${method} ${targetUrl}`, () => requestJsonOnce(method, targetUrl, body, headers, options), {
    maxAttempts: options.retries,
  });
}

function requestJsonOnce(method, targetUrl, body, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const client = url.protocol === 'https:' ? https : http;
    const timeoutMs = Number(options.timeoutMs || CONFIG.requestTimeoutMs);
    const req = client.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: timeoutMs,
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
          const error = new Error(`HTTP ${response.statusCode}: ${data}`);
          error.statusCode = response.statusCode;
          error.responseBody = data;
          reject(error);
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestAndPipe(args) {
  return retryUpstream(`pipe ${args.method} ${args.targetUrl}`, () => requestAndPipeOnce(args), {
    shouldRetry: error => !args.res.headersSent && isRetryableUpstreamError(error),
  });
}

function requestAndPipeOnce({ method, targetUrl, body, rawBody = false, headers = {}, res }) {
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
      response.on('error', reject);
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
    let emittedTokens = 0;
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
        response.on('end', () => {
          const error = new Error(`HTTP ${response.statusCode}: ${errorBody}`);
          error.statusCode = response.statusCode;
          error.responseBody = errorBody;
          error.emittedTokens = emittedTokens;
          reject(error);
        });
        response.on('error', reject);
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
            if (token) {
              emittedTokens++;
              onToken(token);
            }
          } catch {}
        }
      });
      response.on('end', resolve);
      response.on('error', error => {
        error.emittedTokens = emittedTokens;
        reject(error);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${CONFIG.requestTimeoutMs}ms`)));
    req.on('error', error => {
      error.emittedTokens = emittedTokens;
      reject(error);
    });
    req.write(payload);
    req.end();
  });
}

async function requestOpenAIStreamWithRetry(targetUrl, body, headers, onToken) {
  for (let attempt = 1; attempt <= CONFIG.upstreamRetries; attempt++) {
    try {
      await requestOpenAIStream(targetUrl, body, headers, onToken);
      return;
    } catch (error) {
      const emittedTokens = Number(error.emittedTokens || 0);
      if (emittedTokens > 0 || attempt >= CONFIG.upstreamRetries || !isRetryableUpstreamError(error)) {
        throw error;
      }
      await waitBeforeRetry('stream POST ' + targetUrl, attempt, error);
    }
  }
}

async function retryUpstream(label, fn, options = {}) {
  const shouldRetry = options.shouldRetry || isRetryableUpstreamError;
  const maxAttempts = Math.max(1, Number(options.maxAttempts || CONFIG.upstreamRetries));
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= maxAttempts || !shouldRetry(error)) throw error;
      await waitBeforeRetry(label, attempt, error, maxAttempts);
    }
  }
}

async function waitBeforeRetry(label, attempt, error, maxAttempts = CONFIG.upstreamRetries) {
  const delayMs = CONFIG.retryBaseDelayMs * attempt;
  console.warn(`[connect-ai-proxy] upstream retry ${attempt}/${maxAttempts - 1} ${label}: ${error.code || error.message || error}`);
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

function isRetryableUpstreamError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(code)) {
    return true;
  }
  if (/ECONNRESET|socket hang up|aborted|timeout|ETIMEDOUT|EPIPE/i.test(message)) return true;
  const status = Number(error?.statusCode || 0);
  return [408, 429, 500, 502, 503, 504].includes(status);
}

function writeOllamaDone(res, model) {
  if (res.writableEnded) return;
  res.write(JSON.stringify({
    model,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content: '' },
    done: true,
  }) + '\n');
  res.end();
}

function sendJson(res, statusCode, body) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sendError(res, fallbackStatusCode, error) {
  const statusCode = error.statusCode || fallbackStatusCode;
  console.error(`[connect-ai-proxy] error status=${statusCode}: ${error.message || error}`);
  sendJson(res, statusCode, {
    error: {
      message: error.message || String(error),
      type: statusCode >= 500 ? 'proxy_error' : 'bad_request',
    },
  });
}
