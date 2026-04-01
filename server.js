/**
 * server.js — ClickAI Multi-Agent Gateway Admin Server
 * REST API + Static file serving + OpenClaw filesystem bridge
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { initDb, userQueries, agentQueries, llmQueries, permQueries, skillQueries, cronQueries, credQueries } = require('./lib/db');
const bridge = require('./lib/openclaw-bridge');
const wsClient = require('./lib/ws-client');
const { decryptApiKey, isEncrypted } = require('./lib/crypto-keys');

const PORT = parseInt(process.env.ADMIN_PORT) || 3456;
const MEETING_DIR = path.join(__dirname, 'data', 'meeting');

// ═══ MIME types for static serving ═══
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ═══ CORS Allowlist ═══
const ALLOWED_ORIGINS = [
  'chrome-extension://bbkegbajkfhcipkpnnnpmndadopakjcp', // ClickBot Extension (production)
  'http://localhost:3456',    // Admin UI self
  'http://127.0.0.1:3456',
  'http://localhost:18789',   // OpenClaw Gateway
  'http://127.0.0.1:18789',
  'https://gateway.clickai.io',
  'https://admin.clickai.io',
  'https://app.clickai.io',
];

function getCorsOrigin(req) {
  const origin = req?.headers?.origin || '';
  // Allow any chrome-extension:// origin (dev + production)
  if (origin.startsWith('chrome-extension://')) return origin;
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  // Fallback: localhost with any port (dev flexibility)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return ''; // Deny — no CORS header sent
}

// ═══ Helpers ═══
function sendJSON(res, data, status = 200) {
  const origin = getCorsOrigin(res._req);
  const headers = { 'Content-Type': 'application/json' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendError(res, msg, status = 400) {
  sendJSON(res, { error: msg }, status);
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

// Simple token auth (JWT-like but simple for now)
function generateToken(email) {
  return Buffer.from(JSON.stringify({ email, ts: Date.now() })).toString('base64');
}

function verifyToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  try {
    const payload = JSON.parse(Buffer.from(auth.slice(7), 'base64').toString());
    if (payload.email && (Date.now() - payload.ts) < 86400000) return payload;
  } catch {}
  return null;
}

// Verify that X-User-Email header matches the agent's owner in DB
// Returns { ok, email } or { ok: false, error }
function verifyAgentOwner(req, agentId) {
  const email = req.headers['x-user-email'] || '';
  if (!email) return { ok: false, error: 'X-User-Email header required' };
  const agent = agentQueries.getById(agentId);
  if (!agent) return { ok: true, email }; // New agent — allow creation
  if (agent.user_email && agent.user_email !== email) {
    return { ok: false, error: 'Email mismatch: agent belongs to ' + agent.user_email };
  }
  return { ok: true, email };
}

async function readRawBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('File too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'POST',
      headers: options.headers || {}
    };
    const req = https.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ═══ OpenClaw Iframe Proxy — strips X-Frame-Options for embedding ═══
const OPENCLAW_GW_PORT = parseInt(process.env.OPENCLAW_PORT) || 18789;

function proxyOpenClawFrame(req, res) {
  // Proxy path: strip /api/openclaw-frame prefix, keep the rest
  let targetPath = req.url.replace(/^\/api\/openclaw-frame/, '') || '/';

  const proxyOpts = {
    hostname: '127.0.0.1',
    port: OPENCLAW_GW_PORT,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${OPENCLAW_GW_PORT}` },
  };

  const proxyReq = http.request(proxyOpts, (proxyRes) => {
    // Strip iframe-blocking headers
    const headers = { ...proxyRes.headers };
    delete headers['x-frame-options'];
    delete headers['content-security-policy'];

    // For HTML responses, inject <base href> so relative URLs resolve to gateway
    const isHtml = (headers['content-type'] || '').includes('text/html');
    if (isHtml) {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', chunk => body += chunk);
      proxyRes.on('end', () => {
        // Inject <base href> pointing to gateway so ./assets/* loads from gateway directly
        const baseTag = `<base href="http://127.0.0.1:${OPENCLAW_GW_PORT}/">`;
        body = body.replace('<head>', '<head>\n    ' + baseTag);
        delete headers['content-length']; // length changed
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    }
  });

  proxyReq.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('OpenClaw gateway unreachable');
  });
  proxyReq.setTimeout(15000, () => { proxyReq.destroy(); });
  req.pipe(proxyReq);
}

// ═══ Route handler ═══
async function handleRequest(req, res) {
  // Stash req on res for sendJSON CORS lookup
  res._req = req;

  // CORS — restricted to allowed origins
  const corsOrigin = getCorsOrigin(req);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Email');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // OpenClaw iframe proxy — strips X-Frame-Options for embedding
  if (req.url.startsWith('/api/openclaw-frame')) {
    return proxyOpenClawFrame(req, res);
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // ════════════════ API Routes ════════════════

  // Health check
  if (pathname === '/api/health') {
    return sendJSON(res, {
      ok: true,
      gateway: wsClient.isConnected(),
      gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || '5c6786904c93dc886c9b78525fb655c57e9084b41c42e833',
      gatewayPort: parseInt(process.env.OPENCLAW_GATEWAY_PORT) || 18789,
      timestamp: Date.now()
    });
  }

  // ── Auth ──
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readBody(req);
    const user = userQueries.getByEmail(body.email);
    if (!user || user.password_hash !== body.password) {
      return sendError(res, 'Invalid credentials', 401);
    }
    const token = generateToken(user.email);
    // Derive canonical agentId from email (same logic as Extension)
    const parts = user.email.toLowerCase().split('@');
    const local = parts[0] || 'unknown';
    const domain = (parts[1] || '').split('.').slice(0, -1).join('-') || 'local';
    const agentId = 'user-' + (local + '-' + domain).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return sendJSON(res, { token, agentId, user: { email: user.email, name: user.name, role: user.role, avatar: user.avatar } });
  }

  // ── /api/me — returns current user info + agentId (for Extension startup) ──
  if (pathname === '/api/me' && method === 'GET') {
    const auth = verifyToken(req);
    if (!auth) return sendError(res, 'Authentication required', 401);
    const parts = auth.email.toLowerCase().split('@');
    const local = parts[0] || 'unknown';
    const domain = (parts[1] || '').split('.').slice(0, -1).join('-') || 'local';
    const agentId = 'user-' + (local + '-' + domain).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const user = userQueries.getByEmail(auth.email);
    return sendJSON(res, { email: auth.email, agentId, name: user?.name || '', role: user?.role || 'user' });
  }

  // ── Agents CRUD ──
  if (pathname === '/api/agents' && method === 'GET') {
    const agents = agentQueries.getAll();
    // Enrich with LLM provider count
    const enriched = agents.map(a => ({
      ...a,
      providers: llmQueries.getByAgent(a.id),
      permissions: permQueries.getByAgent(a.id),
    }));
    return sendJSON(res, enriched);
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const agentId = decodeURIComponent(agentMatch[1]);

    if (method === 'GET') {
      const agent = agentQueries.getById(agentId);
      if (!agent) return sendError(res, 'Agent not found', 404);
      return sendJSON(res, {
        ...agent,
        providers: llmQueries.getByAgent(agentId),
        permissions: permQueries.getByAgent(agentId),
        skills: skillQueries.getByAgent(agentId),
        crons: cronQueries.getByAgent(agentId),
      });
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      agentQueries.create({ id: agentId, ...body });
      return sendJSON(res, { ok: true });
    }

    if (method === 'DELETE') {
      agentQueries.delete(agentId);
      return sendJSON(res, { ok: true });
    }
  }

  // ── Provider Library (canonical list of providers + models) ──
  if (pathname === '/api/providers' && method === 'GET') {
    const PROVIDER_CATALOG = [
      {
        name: 'Anthropic', icon: 'anthropic', provider: 'anthropic',
        models: ['claude-opus-4-20250514', 'claude-sonnet-4-20250514', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-3-5-haiku-latest'],
      },
      {
        name: 'OpenAI', icon: 'openai', provider: 'openai',
        models: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o4-mini', 'o3', 'gpt-4o', 'gpt-4o-mini'],
      },
      {
        name: 'Google', icon: 'gemini', provider: 'google',
        models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview'],
      },
      {
        name: 'xAI', icon: 'xai', provider: 'xai',
        models: ['grok-4', 'grok-3', 'grok-3-mini', 'grok-3-fast', 'grok-4-1-fast-reasoning', 'grok-4.20-reasoning'],
      },
      {
        name: 'Mistral', icon: 'mistral', provider: 'mistral',
        models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'pixtral-large-latest', 'mistral-medium-latest', 'ministral-8b-latest'],
      },
      {
        name: 'DeepSeek', icon: 'deepseek', provider: 'deepseek',
        models: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        name: 'Qwen', icon: 'qwen', provider: 'qwen',
        models: ['qwen3-max', 'qwen3-plus', 'qwen3-coder-plus', 'qwen3-coder-next', 'qwen3.5-plus', 'qwen3-max-2026-01-23'],
      },
      {
        name: 'Moonshot', icon: 'moonshot', provider: 'moonshot',
        models: ['moonshot-v1-128k', 'moonshot-v1-32k', 'moonshot-v1-8k', 'kimi-latest', 'kimi-k2.5'],
      },
      {
        name: 'NVIDIA', icon: 'nvidia', provider: 'nvidia',
        models: ['meta/llama-3.3-70b-instruct', 'nvidia/llama-3.1-nemotron-70b-instruct', 'mistralai/mistral-large-2-instruct', 'google/gemma-3-27b-it', 'deepseek-ai/deepseek-r1'],
      },
    ];

    return sendJSON(res, { providers: PROVIDER_CATALOG });
  }

  // ── Agent Model Switch (no gateway restart) ──
  const modelMatch = pathname.match(/^\/api\/agents\/([^/]+)\/model$/);
  if (modelMatch && method === 'PUT') {
    const agentId = decodeURIComponent(modelMatch[1]);
    const body = await readBody(req);
    const model = body.model || body.primaryModel || '';
    if (!model) return sendError(res, 'model is required');

    // 1. Write model to openclaw.json (filesystem — gateway reads on next session)
    let normalizedModel = model;
    if (normalizedModel.startsWith('google/')) normalizedModel = 'gemini/' + normalizedModel.slice(7);
    const fsWritten = bridge.updateAgentModel(agentId, normalizedModel);

    // 2. Update DB so dashboard reflects the active model
    const existing = agentQueries.getById(agentId);
    if (existing) {
      agentQueries.create({ ...existing, primary_model: model });
    }

    // 3. Reload secrets (hot-reload API keys, NO gateway restart)
    let reloaded = false;
    try { reloaded = await wsClient.secretsReload(); } catch {}

    console.log('[Admin] Model switch (no restart):', agentId, '→', normalizedModel,
      '| fs:', fsWritten, '| secrets:', reloaded);

    return sendJSON(res, { ok: true, model: normalizedModel, fsWritten, reloaded });
  }

  // ── Agent LLM Providers ──
  const llmMatch = pathname.match(/^\/api\/agents\/([^/]+)\/llm$/);
  if (llmMatch) {
    const agentId = decodeURIComponent(llmMatch[1]);

    if (method === 'GET') {
      return sendJSON(res, llmQueries.getByAgent(agentId));
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      // Verify caller owns this agent (skip if no header — backward compat)
      const callerEmail = req.headers['x-user-email'];
      if (callerEmail) {
        const verify = verifyAgentOwner(req, agentId);
        if (!verify.ok) return sendError(res, verify.error, 403);
      }
      const providers = body.providers || body;
      if (!Array.isArray(providers)) return sendError(res, 'providers must be an array');

      let written = false;
      let reloaded = false;

      // Auto-provision: workspace + SOUL.md + openclaw.json entry
      bridge.ensureAgentProvisioned(agentId, body.primaryModel || '');

      // Only update providers if non-empty (allows model-only updates)
      if (providers.length > 0) {
        // ═══ DECRYPT: Decrypt API keys received from Extension ═══
        for (const p of providers) {
          if (p.apiKey && isEncrypted(p.apiKey)) {
            p.apiKey = decryptApiKey(p.apiKey);
          }
          if (p.api_key && isEncrypted(p.api_key)) {
            p.api_key = decryptApiKey(p.api_key);
          }
        }
        console.log('[Admin] Decrypted provider keys for agent:', agentId,
          '| encrypted flag:', body.encrypted || false);

        // 1. Save to SQLite
        llmQueries.replaceAll(agentId, providers);

        // 2. Write auth-profiles.json for this agent
        const existingProfiles = bridge.readAuthProfiles(agentId);
        const authProfiles = bridge.providersToAuthProfiles(providers, existingProfiles);
        written = bridge.writeAuthProfiles(agentId, authProfiles);

        // 3. Mark written — reload happens after all changes below
        // (secrets.reload + config.reload done at step 5)
      }

      // 4. Update primary model if specified (filesystem + DB, NO config.patch)
      if (body.primaryModel) {
        let normalizedModel = body.primaryModel;
        if (normalizedModel.startsWith('google/')) normalizedModel = 'gemini/' + normalizedModel.slice(7);
        bridge.updateAgentModel(agentId, normalizedModel);
        // Also update in DB so dashboard reflects the active model
        const existing = agentQueries.getById(agentId);
        if (existing) {
          agentQueries.create({ ...existing, primary_model: body.primaryModel });
        }
      }

      // 5. Reload secrets (API keys) on gateway — NO config.patch, NO restart
      if (written || body.primaryModel) {
        try { reloaded = await wsClient.secretsReload(); } catch {}
      }

      return sendJSON(res, {
        ok: true,
        written,
        reloaded,
        providersCount: providers.length,
      });
    }
  }

  // ── 🔒 Authenticated User Sessions (Extension uses these) ──
  // Returns all sessions for the authenticated user (filtered by their agents)
  if (pathname === '/api/user/sessions' && method === 'GET') {
    const auth = verifyToken(req);
    if (!auth) return sendError(res, 'Authentication required', 401);
    
    // Get all agents owned by this user from DB
    const userAgents = agentQueries.getByUser(auth.email);
    if (!userAgents || userAgents.length === 0) {
      return sendJSON(res, { sessions: [], email: auth.email, agentCount: 0 });
    }

    // Collect sessions from all user's agents
    let allSessions = [];
    for (const agent of userAgents) {
      const sessions = bridge.readAgentSessions(agent.id);
      allSessions = allSessions.concat(sessions.map(s => ({ ...s, agentId: agent.id })));
    }
    allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    return sendJSON(res, {
      sessions: allSessions,
      email: auth.email,
      agentCount: userAgents.length,
      agents: userAgents.map(a => a.id),
    });
  }

  // Authenticated session history — verify JWT user owns the agent
  const userHistMatch = pathname.match(/^\/api\/user\/sessions\/([^/]+)\/(.+)\/history$/);
  if (userHistMatch && method === 'GET') {
    const auth = verifyToken(req);
    if (!auth) return sendError(res, 'Authentication required', 401);
    
    const agentId = decodeURIComponent(userHistMatch[1]);
    const sessionKey = decodeURIComponent(userHistMatch[2]);
    
    // Verify ownership: agent must belong to this user
    const agent = agentQueries.getById(agentId);
    if (agent && agent.user_email && agent.user_email !== auth.email) {
      return sendError(res, 'Access denied: session belongs to another user', 403);
    }
    
    const messages = bridge.readSessionHistory(agentId, sessionKey);
    return sendJSON(res, { messages });
  }

  // ── Agent Sessions (from filesystem) — ownership enforced ──
  const sessMatch = pathname.match(/^\/api\/agents\/([^/]+)\/sessions$/);
  if (sessMatch && method === 'GET') {
    const agentId = decodeURIComponent(sessMatch[1]);

    // Enforce ownership: JWT first, then X-User-Email
    const auth = verifyToken(req);
    const callerEmail = auth?.email || req.headers['x-user-email'] || '';
    if (!callerEmail) {
      return sendError(res, 'Authentication required', 401);
    }
    const agent = agentQueries.getById(agentId);
    if (agent && agent.user_email && agent.user_email !== callerEmail) {
      return sendError(res, 'Access denied: agent belongs to another user', 403);
    }

    const sessions = bridge.readAgentSessions(agentId);
    return sendJSON(res, sessions);
  }

  // ── Session Chat History (read JSONL files) — ownership ALWAYS enforced ──
  const histMatch = pathname.match(/^\/api\/agents\/([^/]+)\/sessions\/(.+)\/history$/);
  if (histMatch && method === 'GET') {
    const agentId = decodeURIComponent(histMatch[1]);
    const sessionKey = decodeURIComponent(histMatch[2]);

    // ALWAYS enforce ownership: JWT first, then X-User-Email
    const auth = verifyToken(req);
    const callerEmail = auth?.email || req.headers['x-user-email'] || '';
    if (!callerEmail) {
      return sendError(res, 'Authentication required: provide JWT or X-User-Email', 401);
    }
    const agent = agentQueries.getById(agentId);
    if (agent && agent.user_email && agent.user_email !== callerEmail) {
      return sendError(res, 'Access denied: session belongs to another user', 403);
    }

    const messages = bridge.readSessionHistory(agentId, sessionKey);
    return sendJSON(res, { messages });
  }

  // ── Skill Requests (from Extension) ──
  if (pathname === '/api/skill-requests' && method === 'POST') {
    const body = await readBody(req);
    const requestsFile = path.join(__dirname, 'data', 'skill-requests.json');
    let requests = [];
    try { requests = JSON.parse(fs.readFileSync(requestsFile, 'utf8')); } catch {}
    requests.push({ ...body, id: Date.now().toString(36), receivedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(requestsFile), { recursive: true });
    fs.writeFileSync(requestsFile, JSON.stringify(requests, null, 2));
    console.log('[Admin] Skill request received:', body.skillName, 'from', body.userId);
    return sendJSON(res, { ok: true, message: 'Request saved' });
  }
  if (pathname === '/api/skill-requests' && method === 'GET') {
    const requestsFile = path.join(__dirname, 'data', 'skill-requests.json');
    let requests = [];
    try { requests = JSON.parse(fs.readFileSync(requestsFile, 'utf8')); } catch {}
    return sendJSON(res, requests);
  }

  // Update skill request status
  const reqStatusMatch = pathname.match(/^\/api\/skill-requests\/([^/]+)\/status$/);
  if (reqStatusMatch && method === 'PATCH') {
    const reqId = decodeURIComponent(reqStatusMatch[1]);
    const body = await readBody(req);
    const requestsFile = path.join(__dirname, 'data', 'skill-requests.json');
    let requests = [];
    try { requests = JSON.parse(fs.readFileSync(requestsFile, 'utf8')); } catch {}
    const found = requests.find(r => r.id === reqId);
    if (found) {
      found.status = body.status || 'new';
      found.updatedAt = new Date().toISOString();
      fs.writeFileSync(requestsFile, JSON.stringify(requests, null, 2));
      console.log('[Admin] Request status updated:', reqId, '->', body.status);
      return sendJSON(res, { ok: true });
    }
    res.writeHead(404); res.end(JSON.stringify({ error: 'Request not found' }));
    return;
  }

  // ── Per-Agent Settings Sync (PULL from Admin → Extension) ──
  const syncMatch = pathname.match(/^\/api\/agents\/([^/]+)\/settings-sync$/);
  if (syncMatch && method === 'GET') {
    const agentId = decodeURIComponent(syncMatch[1]);
    const email = url.searchParams.get('email') || req.headers['x-user-email'] || '';
    if (!email) return sendError(res, 'email query param or X-User-Email header required', 400);

    // Verify email matches agent owner
    const agent = agentQueries.getById(agentId);
    if (agent && agent.user_email && agent.user_email !== email) {
      return sendError(res, 'Email mismatch: agent belongs to different user', 403);
    }

    // Gather all settings for this agent
    // Map lowercase provider names → canonical Extension display names
    const CANONICAL_NAMES = {
      openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google',
      gemini: 'Google', deepseek: 'DeepSeek', xai: 'xAI',
      mistral: 'Mistral', llama: 'LLaMA', qwen: 'Qwen',
      modelstudio: 'Qwen',
    };
    const { encryptApiKey: encKey } = require('./lib/crypto-keys');
    const providers = llmQueries.getByAgent(agentId).map(p => ({
      name: CANONICAL_NAMES[(p.provider || '').toLowerCase()] || (p.provider || '').charAt(0).toUpperCase() + (p.provider || '').slice(1),
      provider: p.provider,
      apiKey: encKey(p.api_key || ''),  // Encrypt before sending over network
      model: p.model || '',
      baseUrl: p.base_url || '',
      active: !!p.active,
    }));

    const permissions = permQueries.getByAgent(agentId) || {
      browser_control: 1, microphone: 1, notifications: 1,
      clipboard: 1, file_access: 1, tab_management: 1
    };

    let credentials = credQueries.getByAgent(agentId);
    if (!credentials || Object.keys(credentials).length === 0) {
      const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
      try { credentials = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}
    }

    const primaryModel = agent?.primary_model || '';

    console.log('[Admin] Settings-sync for agent:', agentId, '| email:', email,
      '| providers:', providers.length, '| model:', primaryModel);

    return sendJSON(res, {
      ok: true,
      agentId,
      providers,
      permissions,
      credentials,
      primaryModel,
    });
  }

  // ── Per-Agent Credentials (from Extension) ──
  const credMatch = pathname.match(/^\/api\/agents\/([^/]+)\/credentials$/);
  if (credMatch && method === 'POST') {
    const agentId = decodeURIComponent(credMatch[1]);
    // Verify caller owns this agent
    const callerEmail = req.headers['x-user-email'];
    if (callerEmail) {
      const verify = verifyAgentOwner(req, agentId);
      if (!verify.ok) return sendError(res, verify.error, 403);
    }
    const body = await readBody(req);
    const credentials = body.credentials || {};

    // ═══ DECRYPT: Decrypt credential values received from Extension ═══
    if (body.encrypted) {
      for (const [skillName, vars] of Object.entries(credentials)) {
        if (typeof vars === 'object' && vars !== null) {
          for (const [key, val] of Object.entries(vars)) {
            if (typeof val === 'string' && isEncrypted(val)) {
              vars[key] = decryptApiKey(val);
            }
          }
        }
      }
      console.log('[Admin] Decrypted credentials for agent:', agentId);
    }

    // 1. Save to per-agent JSON file (filesystem)
    const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify(credentials, null, 2));

    // 2. Save to DB (per-agent backup)
    try { credQueries.upsertAll(agentId, credentials); } catch (e) {
      console.warn('[Admin] DB credential save failed:', e.message);
    }

    console.log('[Admin] Credentials saved for agent:', agentId, '(file + DB)');
    return sendJSON(res, { ok: true });
  }
  if (credMatch && method === 'GET') {
    const agentId = decodeURIComponent(credMatch[1]);
    // Try DB first, fallback to file
    let creds = credQueries.getByAgent(agentId);
    if (!creds || Object.keys(creds).length === 0) {
      const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
      try { creds = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}
    }
    return sendJSON(res, creds || {});
  }

  // ── Per-Agent Credentials Verify + Sync (from Extension — enhanced flow) ──
  // Saves credentials → writes env vars to openclaw.json → unblocks skills → secrets.reload
  const credSyncMatch = pathname.match(/^\/api\/agents\/([^/]+)\/credentials\/verify-sync$/);
  if (credSyncMatch && method === 'POST') {
    const agentId = decodeURIComponent(credSyncMatch[1]);
    // Verify caller owns this agent
    const callerEmail = req.headers['x-user-email'];
    if (callerEmail) {
      const verify = verifyAgentOwner(req, agentId);
      if (!verify.ok) return sendError(res, verify.error, 403);
    }
    const body = await readBody(req);
    const credentials = body.credentials || {};
    const skillName = body.skillName || ''; // which skill was just saved

    // ═══ DECRYPT: Decrypt credential values received from Extension ═══
    if (body.encrypted) {
      for (const [sk, vars] of Object.entries(credentials)) {
        if (typeof vars === 'object' && vars !== null) {
          for (const [key, val] of Object.entries(vars)) {
            if (typeof val === 'string' && isEncrypted(val)) {
              vars[key] = decryptApiKey(val);
            }
          }
        }
      }
      console.log('[Admin] Decrypted verify-sync credentials for agent:', agentId);
    }

    const result = {
      ok: true,
      credentialsSaved: false,
      envWritten: [],
      skillsUnblocked: false,
      secretsReloaded: false,
    };

    // 1. Save credentials to per-agent JSON file
    try {
      const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
      fs.mkdirSync(path.dirname(credFile), { recursive: true });
      fs.writeFileSync(credFile, JSON.stringify(credentials, null, 2));
      result.credentialsSaved = true;
      console.log('[Admin] ✅ Credentials saved to file for agent:', agentId);
    } catch (e) {
      console.warn('[Admin] Credential file save failed:', e.message);
    }

    // 2. Save credentials to DB (per-agent backup — NO global env write)
    try {
      credQueries.upsertAll(agentId, credentials);
      result.dbSaved = true;
      console.log('[Admin] ✅ Credentials saved to DB for agent:', agentId);
    } catch (e) {
      console.warn('[Admin] DB credential save failed:', e.message);
    }

    // NOTE: Credentials are NOT written to global openclaw.json env.
    // Per-agent isolation: each agent's credentials stay in their own file + DB row.

    // 3. Unblock skills: ensure the saved skill is in the agent's allowBundled list
    // If the agent has a restrictive allowlist, add the skill to it
    try {
      const currentAllowlist = bridge.readAgentSkillAllowlist(agentId);
      if (currentAllowlist && currentAllowlist.length > 0 && skillName) {
        // Agent has restricted allowlist — ensure the skill being configured is allowed
        if (!currentAllowlist.includes(skillName)) {
          const updatedAllowlist = [...currentAllowlist, skillName];
          bridge.writeAgentSkillAllowlist(agentId, updatedAllowlist);
          // Push live to gateway
          try { await wsClient.configPatchSkillAllowlist(agentId, updatedAllowlist); } catch {}
          result.skillsUnblocked = true;
          console.log('[Admin] ✅ Skill unblocked:', skillName, 'for agent:', agentId);
        }
      }
      // If no restrictive allowlist (all skills allowed), nothing to unblock
    } catch (e) {
      console.warn('[Admin] Skill unblock failed:', e.message);
    }

    // 4. Reload secrets on gateway (picks up new env vars)
    try {
      result.secretsReloaded = await wsClient.secretsReload();
    } catch (e) {
      console.warn('[Admin] secrets.reload failed:', e.message);
    }

    console.log('[Admin] Credential verify-sync complete for agent:', agentId,
      '| file:', result.credentialsSaved,
      '| db:', result.dbSaved || false,
      '| unblocked:', result.skillsUnblocked,
      '| secrets:', result.secretsReloaded);

    return sendJSON(res, result);
  }

  // ── Agent Permissions ──
  const permMatch = pathname.match(/^\/api\/agents\/([^/]+)\/permissions$/);
  if (permMatch) {
    const agentId = decodeURIComponent(permMatch[1]);
    if (method === 'GET') {
      const saved = permQueries.getByAgent(agentId);
      // Return defaults (all ON) when no saved permissions exist
      const defaults = { browser_control: 1, microphone: 1, notifications: 1, clipboard: 1, file_access: 1, tab_management: 1 };
      return sendJSON(res, saved || defaults);
    }
    if (method === 'PUT') {
      // Verify caller owns this agent
      const callerEmail = req.headers['x-user-email'];
      if (callerEmail) {
        const verify = verifyAgentOwner(req, agentId);
        if (!verify.ok) return sendError(res, verify.error, 403);
      }
      const body = await readBody(req);
      permQueries.upsert(agentId, body);
      return sendJSON(res, { ok: true });
    }
  }

  // ── Agent Skills (merged: defaults + session-resolved + user-installed + DB) ──
  const skillMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
  if (skillMatch) {
    const agentId = decodeURIComponent(skillMatch[1]);
    if (method === 'GET') {
      // 1. Get default bundled skills
      const defaults = bridge.listDefaultSkills();
      // 2. Get resolved skills from sessions (most accurate active state)
      const sessionSkills = bridge.readAgentSkillsFromSessions(agentId);
      // 3. Get per-user installed skills
      const userSkills = bridge.readUserInstalledSkills(agentId);
      // 4. Get DB skills
      const dbSkills = skillQueries.getByAgent(agentId).map(s => ({
        name: s.skill_name, description: '', source: 'db', enabled: !!s.enabled,
      }));

      // Merge: session skills take priority (most accurate), then user, then defaults, then DB
      const seen = new Set();
      const merged = [];
      for (const list of [sessionSkills, userSkills, defaults, dbSkills]) {
        for (const s of list) {
          if (!seen.has(s.name)) {
            seen.add(s.name);
            merged.push(s);
          }
        }
      }

      // 5. Apply per-agent allowlist to set enabled state
      // allowBundled = undefined/[] means ALL enabled; [names] means only those are enabled
      const allowBundled = bridge.readAgentSkillAllowlist(agentId);
      const hasAllowlist = allowBundled && allowBundled.length > 0;
      const allowSet = hasAllowlist ? new Set(allowBundled) : null;
      const result = merged.map(s => ({
        ...s,
        // Per-agent toggle: disabled if allowlist exists AND skill NOT in it
        enabled: hasAllowlist ? allowSet.has(s.name) : (s.enabled !== false),
      }));

      return sendJSON(res, result);
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (Array.isArray(body)) {
        for (const s of body) skillQueries.upsert(agentId, s);
      }
      return sendJSON(res, { ok: true });
    }
  }

  // ── Agent Skills Allowlist (per-agent enable/disable, synced to openclaw.json) ──
  const skillAllowlistMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills\/allowlist$/);
  if (skillAllowlistMatch) {
    const agentId = decodeURIComponent(skillAllowlistMatch[1]);

    if (method === 'GET') {
      const allowBundled = bridge.readAgentSkillAllowlist(agentId);
      return sendJSON(res, { agentId, allowBundled: allowBundled || [], allAllowed: !allowBundled || allowBundled.length === 0 });
    }

    if (method === 'PUT') {
      // Verify caller owns this agent
      const callerEmail = req.headers['x-user-email'];
      if (callerEmail) {
        const verify = verifyAgentOwner(req, agentId);
        if (!verify.ok) return sendError(res, verify.error, 403);
      }
      const body = await readBody(req);
      // allowBundled: [] or undefined = allow ALL; [names] = restrict
      const allowBundled = Array.isArray(body.allowBundled) ? body.allowBundled : [];

      // 1. Write to openclaw.json via bridge
      const written = bridge.writeAgentSkillAllowlist(agentId, allowBundled);

      // 2. Push live to gateway via config.patch (no restart needed)
      let patched = false;
      try { patched = await wsClient.configPatchSkillAllowlist(agentId, allowBundled); } catch {}

      console.log('[Admin] Skills allowlist updated for agent:', agentId,
        '| skills:', allowBundled.length > 0 ? allowBundled.length + ' skills' : 'all allowed',
        '| written:', written, '| patched:', patched);

      return sendJSON(res, { ok: true, agentId, allowBundled, written, patched });
    }
  }

  // ── Custom Skills CRUD (agent-created skills) ──
  const customSkillMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills\/custom(?:\/([^/]+))?$/);
  if (customSkillMatch) {
    const agentId = decodeURIComponent(customSkillMatch[1]);
    const skillName = customSkillMatch[2] ? decodeURIComponent(customSkillMatch[2]) : null;

    // GET /api/agents/:id/skills/custom — list custom skills
    if (method === 'GET' && !skillName) {
      const customs = skillQueries.getCustomByAgent(agentId);
      return sendJSON(res, customs);
    }

    // GET /api/agents/:id/skills/custom/:name — get single custom skill
    if (method === 'GET' && skillName) {
      const skill = skillQueries.getByName(agentId, skillName);
      if (!skill) return sendError(res, 'Skill not found', 404);
      return sendJSON(res, skill);
    }

    // POST /api/agents/:id/skills/custom — create/update custom skill
    if (method === 'POST') {
      const body = await readBody(req);
      const name = (body.skill_name || body.name || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!name) return sendError(res, 'skill_name is required');

      const description = body.description || '';
      const content = body.content || '';
      const createdBy = body.created_by || 'user';

      const result = {
        ok: true,
        dbSaved: false,
        fileSaved: false,
        gatewayNotified: false,
      };

      // 1. Save to DB
      try {
        skillQueries.createCustom(agentId, {
          skill_name: name,
          description,
          content,
          created_by: createdBy,
        });
        result.dbSaved = true;
      } catch (e) {
        console.warn('[Admin] DB skill save failed:', e.message);
      }

      // 2. Write SKILL.md to filesystem
      try {
        result.fileSaved = bridge.writeCustomSkill(agentId, name, description, content);
      } catch (e) {
        console.warn('[Admin] Filesystem skill write failed:', e.message);
      }

      // 3. Notify gateway to re-discover skills
      try {
        result.gatewayNotified = !!(await wsClient.skillsStatus(agentId));
      } catch (e) {
        console.warn('[Admin] Gateway notify failed:', e.message);
      }

      console.log('[Admin] ✅ Custom skill created:', name, 'for agent:', agentId,
        '| db:', result.dbSaved, '| file:', result.fileSaved, '| gw:', result.gatewayNotified,
        '| by:', createdBy);

      return sendJSON(res, { ...result, skill_name: name });
    }

    // DELETE /api/agents/:id/skills/custom/:name — delete custom skill
    if (method === 'DELETE' && skillName) {
      const result = { ok: true, dbDeleted: false, fileDeleted: false };

      // 1. Delete from DB
      try {
        skillQueries.deleteByName(agentId, skillName);
        result.dbDeleted = true;
      } catch (e) {
        console.warn('[Admin] DB skill delete failed:', e.message);
      }

      // 2. Delete from filesystem
      try {
        result.fileDeleted = bridge.deleteCustomSkill(agentId, skillName);
      } catch (e) {
        console.warn('[Admin] Filesystem skill delete failed:', e.message);
      }

      console.log('[Admin] 🗑️ Custom skill deleted:', skillName, 'for agent:', agentId);
      return sendJSON(res, result);
    }
  }

  // ── Agent Cron Jobs ──
  const cronMatch = pathname.match(/^\/api\/agents\/([^/]+)\/crons$/);
  if (cronMatch) {
    const agentId = decodeURIComponent(cronMatch[1]);
    if (method === 'GET') return sendJSON(res, cronQueries.getByAgent(agentId));
    if (method === 'POST') {
      const body = await readBody(req);
      cronQueries.create(agentId, body);
      return sendJSON(res, { ok: true });
    }
  }

  // ── Users ──
  if (pathname === '/api/users' && method === 'GET') {
    return sendJSON(res, userQueries.getAll());
  }

  // ── OpenClaw Sync ──
  if (pathname === '/api/openclaw/sync' && method === 'GET') {
    // Import agents from OpenClaw filesystem into our DB
    const fsAgents = bridge.listAgentsFromFilesystem();
    const config = bridge.readOpenClawConfig();
    let imported = 0;

    for (const agent of fsAgents) {
      // Determine user_email from agent id pattern: user-phuong-trinhvan-gmail → phuong.trinhvan@gmail.com
      let userEmail = agent.id;
      if (agent.id.startsWith('user-')) {
        userEmail = agent.id.replace('user-', '').replace(/-/g, '.').replace(/\.([^.]+)$/, '@$1.com');
        // Fix common patterns: admin.clickai → admin@clickai.vn
        if (userEmail.endsWith('@clickai.com')) userEmail = userEmail.replace('@clickai.com', '@clickai.vn');
      }

      // Ensure user exists
      userQueries.create({ email: userEmail, name: '', role: 'user' });

      // Upsert agent
      agentQueries.create({
        id: agent.id,
        user_email: userEmail,
        name: agent.name,
        workspace: agent.workspace,
        agent_dir: agent.agentDir,
        primary_model: agent.primaryModel,
      });

      // Import LLM providers from auth-profiles
      if (agent.providers && agent.providers.length > 0) {
        llmQueries.replaceAll(agent.id, agent.providers);
      }

      imported++;
    }

    return sendJSON(res, {
      ok: true,
      imported,
      agents: fsAgents.map(a => ({ id: a.id, providers: a.providers?.length || 0 })),
      globalEnv: Object.keys(bridge.getGlobalEnvVars()),
    });
  }

  // ── Unblock All Skills (clear allowBundled for all agents → allow all bundled skills) ──
  if (pathname === '/api/openclaw/unblock-skills' && method === 'POST') {
    const config = bridge.readOpenClawConfig();
    if (!config?.agents?.list) return sendError(res, 'No agents.list in openclaw.json', 500);

    let unblocked = 0;
    const results = [];
    for (const agent of config.agents.list) {
      if (!agent?.id) continue;
      // Remove allowBundled restriction → allow all skills
      const had = !!(agent.skills?.allowBundled);
      if (agent.skills) {
        delete agent.skills.allowBundled;
        if (Object.keys(agent.skills).length === 0) delete agent.skills;
      }
      results.push({ id: agent.id, wasRestricted: had });
      if (had) unblocked++;
    }

    const written = bridge.writeOpenClawConfig(config);

    // Also push config.patch to gateway to apply live (one per agent would be excessive,
    // so do a single config.patch with the updated full agents list)
    let patched = false;
    try {
      await wsClient.request('config.patch', {
        raw: JSON.stringify({ agents: { list: config.agents.list, defaults: config.agents.defaults || {} } })
      });
      patched = true;
    } catch (e) {
      // Gateway may restart — that's fine
      if (e.message?.includes('closed') || e.message?.includes('disconnect')) patched = true;
    }

    console.log('[Admin] Unblocked skills for', unblocked, 'agents | written:', written, '| patched:', patched);
    return sendJSON(res, { ok: true, unblocked, written, patched, agents: results });
  }

  // ── OpenClaw Gateway Status ──
  if (pathname === '/api/openclaw/status' && method === 'GET') {
    let models = [];
    try {
      models = await wsClient.modelsList();
    } catch {}

    // Read sessions from filesystem (all agents)
    const fsAgents = bridge.listAgentsFromFilesystem();
    let allSessions = [];
    for (const agent of fsAgents) {
      const sessions = bridge.readAgentSessions(agent.id);
      allSessions = allSessions.concat(sessions.map(s => ({ ...s, agentId: agent.id })));
    }
    allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    return sendJSON(res, {
      connected: wsClient.isConnected(),
      modelsCount: models.length,
      models,
      sessionsCount: allSessions.length,
      sessions: allSessions,
    });
  }

  // ── Chat Proxy — route chat to correct subagent ──
  // POST /api/chat { agentId, message, sessionKey? }
  // OpenClaw or any external caller uses this to chat with a specific user's subagent
  if (pathname === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    const { agentId, message, sessionKey } = body;

    if (!message) return sendError(res, 'message is required');

    // Resolve agentId: explicit > from email > fallback
    let resolvedAgentId = agentId || '';
    if (!resolvedAgentId && body.email) {
      // Convert email to agent ID
      const parts = body.email.toLowerCase().split('@');
      const local = parts[0] || 'unknown';
      const domain = (parts[1] || '').split('.').slice(0, -1).join('-') || 'local';
      resolvedAgentId = 'user-' + (local + '-' + domain).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }

    if (!resolvedAgentId) return sendError(res, 'agentId or email is required');

    // Verify agent exists
    const agent = agentQueries.getById(resolvedAgentId);
    if (!agent) return sendError(res, 'Agent not found: ' + resolvedAgentId, 404);

    // Check agent has LLM providers configured
    const providers = llmQueries.getByAgent(resolvedAgentId);
    const hasKey = providers.some(p => p.api_key && p.api_key.length > 3);
    if (!hasKey) {
      return sendError(res, 'No API key configured for agent: ' + resolvedAgentId + '. Configure LLM providers first.', 400);
    }

    // Forward to gateway
    try {
      const result = await wsClient.chatSend(resolvedAgentId, message, sessionKey || 'main');
      return sendJSON(res, {
        ok: true,
        agentId: resolvedAgentId,
        sessionKey: `agent:${resolvedAgentId}:${sessionKey || 'main'}`,
        model: agent.primary_model || '',
        result,
      });
    } catch (e) {
      return sendError(res, 'Chat send failed: ' + e.message, 502);
    }
  }

  // ── Agent Config — read per-agent config from OpenClaw ──
  const configMatch = pathname.match(/^\/api\/agents\/([^/]+)\/config$/);
  if (configMatch && method === 'GET') {
    const agentId = decodeURIComponent(configMatch[1]);
    try {
      const config = bridge.readOpenClawConfig();
      if (!config) return sendError(res, 'Could not read openclaw.json', 500);

      const agentEntry = (config?.agents?.list || []).find(a => a.id === agentId);
      const defaults = config?.agents?.defaults || {};
      const authProfiles = bridge.readAuthProfiles(agentId);

      return sendJSON(res, {
        agentId,
        model: agentEntry?.model || defaults?.model?.primary || '',
        tools: agentEntry?.tools || {},
        workspace: agentEntry?.workspace || defaults?.workspace || '',
        hasAuthProfiles: !!authProfiles?.profiles && Object.keys(authProfiles.profiles).length > 0,
        providers: Object.keys(authProfiles?.profiles || {}),
        found: !!agentEntry,
      });
    } catch (e) {
      return sendError(res, 'Config read failed: ' + e.message, 500);
    }
  }

  // ════════════════ Meeting API ════════════════

  // Upload audio file
  if (pathname === '/api/meeting/upload' && method === 'POST') {
    try {
      const userId = req.headers['x-user-id'] || 'anonymous';
      const fileName = req.headers['x-file-name'] || `rec_${Date.now()}.webm`;
      const userDir = path.join(MEETING_DIR, userId);
      ensureDir(userDir);

      const raw = await readRawBody(req);
      const savePath = path.join(userDir, fileName);
      fs.writeFileSync(savePath, raw);

      return sendJSON(res, {
        ok: true,
        path: `/meeting/${userId}/${fileName}`,
        size: raw.length,
        fileName
      });
    } catch (e) {
      return sendError(res, 'Upload failed: ' + e.message, 500);
    }
  }

  // List meetings for a user
  const listMatch = pathname.match(/^\/api\/meeting\/list\/([^/]+)$/);
  if (listMatch && method === 'GET') {
    const userId = decodeURIComponent(listMatch[1]);
    const userDir = path.join(MEETING_DIR, userId);
    if (!fs.existsSync(userDir)) return sendJSON(res, []);

    const files = fs.readdirSync(userDir)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(userDir, f));
        return { name: f, size: stat.size, date: stat.mtimeMs, path: `/meeting/${userId}/${f}` };
      })
      .sort((a, b) => b.date - a.date);
    return sendJSON(res, files);
  }

  // AI Transcript only (audio → text)
  if (pathname === '/api/meeting/transcript' && method === 'POST') {
    const body = await readBody(req);
    const { filePath: audioPath, config, accessToken } = body;

    if (!accessToken) return sendError(res, 'accessToken required', 401);
    if (!audioPath) return sendError(res, 'filePath required');

    try {
      // audioPath is like "/meeting/{userId}/{file}" — resolve to data/meeting/{userId}/{file}
      const relativePath = audioPath.replace(/^\/meeting\//, '');
      const fullAudioPath = path.join(MEETING_DIR, relativePath);
      if (!fs.existsSync(fullAudioPath)) return sendError(res, 'Audio file not found', 404);

      const audioBuffer = fs.readFileSync(fullAudioPath);
      const audioBase64 = audioBuffer.toString('base64');
      const ext = path.extname(fullAudioPath).slice(1).toLowerCase();
      const mimeMap = { webm: 'audio/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg' };
      const mimeType = mimeMap[ext] || 'audio/webm';

      const lang = config?.language || 'vi';
      const langName = { vi: 'Vietnamese', en: 'English', auto: 'Auto-detect' }[lang] || lang;

      const payload = JSON.stringify({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: `You are a professional transcriber. Listen to the audio carefully and produce a complete, accurate transcript. Output ONLY the transcript text, no JSON, no markdown. Language: ${langName}. Include speaker changes as "Speaker 1:", "Speaker 2:" etc. if distinguishable.` },
          {
            role: 'user',
            content: [
              { type: 'audio_url', audio_url: { url: `data:${mimeType};base64,${audioBase64}` } },
              { type: 'text', text: `Transcribe this audio completely in ${langName}. Output only the transcript text.` }
            ]
          }
        ],
        temperature: 0.1,
        max_tokens: 8192
      });

      console.log(`   🎤 Transcribing audio (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB) via ClickAI...`);

      const resp = await httpsRequest('https://clickai.io/conversation/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${accessToken}`
        }
      }, payload);

      if (resp.status !== 200) {
        console.error('   ❌ ClickAI transcript error:', resp.status);
        return sendError(res, `AI API error (${resp.status})`, resp.status);
      }

      let transcript = '';
      if (resp.data?.choices?.[0]?.message?.content) {
        transcript = resp.data.choices[0].message.content;
      } else if (resp.data?.content) {
        transcript = typeof resp.data.content === 'string' ? resp.data.content : JSON.stringify(resp.data.content);
      }

      console.log('   ✅ Transcript complete, length:', transcript.length);
      return sendJSON(res, { ok: true, transcript });

    } catch (e) {
      console.error('   ❌ Transcript error:', e.message);
      return sendError(res, 'Transcription failed: ' + e.message, 500);
    }
  }

  // AI Summarize — uses transcript text if available, otherwise processes audio
  if (pathname === '/api/meeting/summarize' && method === 'POST') {
    const body = await readBody(req);
    const { filePath: audioPath, transcript: existingTranscript, config, accessToken } = body;

    if (!accessToken) return sendError(res, 'accessToken required', 401);
    if (!audioPath && !existingTranscript) return sendError(res, 'filePath or transcript required');

    try {
      const lang = config?.language || 'vi';
      const outLang = config?.outputLang || 'vi';
      const detail = config?.detailLevel || 'standard';
      const tone = config?.tone || 'neutral';
      const focusActions = config?.focusActions !== false;

      const outLangName = outLang === 'vi' ? 'Vietnamese' : 'English';

      const systemPrompt = `You are an expert meeting summarizer. Analyze the meeting content and produce structured JSON.

Output language: ${outLangName}
Detail level: ${detail}
Tone: ${tone}

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "transcript": "Full transcript (keep existing if provided)",
  "summary": "Brief overview summary of the meeting",
  "actionItems": [
    { "task": "Description of the task", "assignee": "Person responsible", "deadline": "When it's due" }
  ],
  "assignments": [
    { "person": "Name", "role": "Role", "tasks": ["task1", "task2"] }
  ],
  "keyDecisions": ["decision 1", "decision 2"]
}`;

      let userContent;

      if (existingTranscript) {
        // Use transcript text — no need to send audio again
        const userMsg = `Here is the meeting transcript. Summarize it and extract action items.\n\nTranscript:\n${existingTranscript}`;
        userContent = [{ type: 'text', text: userMsg }];
        console.log(`   🤖 Summarizing from transcript (${existingTranscript.length} chars)...`);
      } else {
        // Fallback: process audio directly
        const relativePath = audioPath.replace(/^\/meeting\//, '');
        const fullAudioPath = path.join(MEETING_DIR, relativePath);
        if (!fs.existsSync(fullAudioPath)) return sendError(res, 'Audio file not found', 404);

        const audioBuffer = fs.readFileSync(fullAudioPath);
        const audioBase64 = audioBuffer.toString('base64');
        const ext = path.extname(fullAudioPath).slice(1).toLowerCase();
        const mimeMap = { webm: 'audio/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg' };
        const mimeType = mimeMap[ext] || 'audio/webm';

        const langName = { vi: 'Vietnamese', en: 'English', auto: 'Auto-detect' }[lang] || lang;
        const userMsg = `Transcribe and summarize this meeting. Language: ${langName}.${focusActions ? ' Focus on action items, assignments, and deadlines.' : ''}`;
        userContent = [
          { type: 'audio_url', audio_url: { url: `data:${mimeType};base64,${audioBase64}` } },
          { type: 'text', text: userMsg }
        ];
        console.log(`   🤖 Summarizing audio (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB) via ClickAI...`);
      }

      const payload = JSON.stringify({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        max_tokens: 8192
      });

      const resp = await httpsRequest('https://clickai.io/conversation/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${accessToken}`
        }
      }, payload);

      if (resp.status !== 200) {
        console.error('   ❌ ClickAI API error:', resp.status, JSON.stringify(resp.data).slice(0, 500));
        return sendError(res, `AI API error (${resp.status}): ${typeof resp.data === 'string' ? resp.data.slice(0, 200) : JSON.stringify(resp.data).slice(0, 200)}`, resp.status);
      }

      // Extract AI content
      let aiContent = '';
      if (resp.data?.choices?.[0]?.message?.content) {
        aiContent = resp.data.choices[0].message.content;
      } else if (resp.data?.content) {
        aiContent = typeof resp.data.content === 'string' ? resp.data.content : JSON.stringify(resp.data.content);
      } else {
        aiContent = JSON.stringify(resp.data);
      }

      // Parse JSON from response
      let parsed;
      try {
        const jsonMatch = aiContent.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = jsonMatch ? jsonMatch[1].trim() : aiContent.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = {
          transcript: existingTranscript || aiContent,
          summary: '',
          actionItems: [],
          assignments: [],
          keyDecisions: []
        };
      }

      // If we had existing transcript, preserve it
      if (existingTranscript && !parsed.transcript) {
        parsed.transcript = existingTranscript;
      }

      console.log('   ✅ Summarization complete');
      return sendJSON(res, {
        ok: true,
        transcript: parsed.transcript || existingTranscript || '',
        summary: parsed.summary || '',
        actionItems: parsed.actionItems || [],
        assignments: parsed.assignments || [],
        keyDecisions: parsed.keyDecisions || []
      });

    } catch (e) {
      console.error('   ❌ Summarize error:', e.message);
      return sendError(res, 'Summarization failed: ' + e.message, 500);
    }
  }

  // Serve meeting audio files
  const meetingFileMatch = pathname.match(/^\/meeting\/([^/]+)\/(.+)$/);
  if (meetingFileMatch && method === 'GET') {
    const userId = decodeURIComponent(meetingFileMatch[1]);
    const fileName = decodeURIComponent(meetingFileMatch[2]);
    const meetingFilePath = path.join(MEETING_DIR, userId, fileName);

    if (!meetingFilePath.startsWith(MEETING_DIR)) return sendError(res, 'Forbidden', 403);
    if (!fs.existsSync(meetingFilePath)) { res.writeHead(404); res.end('Not found'); return; }

    const ext = path.extname(fileName);
    const audioMime = { '.webm': 'audio/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' };
    const ct = audioMime[ext] || 'application/octet-stream';
    const stat = fs.statSync(meetingFilePath);

    const meetingHeaders = {
      'Content-Type': ct,
      'Content-Length': stat.size,
    };
    const meetingOrigin = getCorsOrigin(req);
    if (meetingOrigin) meetingHeaders['Access-Control-Allow-Origin'] = meetingOrigin;
    res.writeHead(200, meetingHeaders);
    fs.createReadStream(meetingFilePath).pipe(res);
    return;
  }

  // ════════════════ Static Files ════════════════
  let filePath = pathname === '/' ? '/admin.html' : pathname;
  const fullPath = path.join(__dirname, 'public', filePath);

  // Security: prevent path traversal
  if (!fullPath.startsWith(path.join(__dirname, 'public'))) {
    return sendError(res, 'Forbidden', 403);
  }

  const ext = path.extname(fullPath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Try serving from Extension root (for icon-transparent.png etc)
      const extPath = path.join(__dirname, '..', filePath);
      fs.readFile(extPath, (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// ═══ Start server ═══
async function start() {
  await initDb();
  console.log('   📦 Database initialized');

  const server = http.createServer(handleRequest);

  server.listen(PORT, () => {
    console.log(`\n🔷 ClickAI Multi-Agent Gateway Admin`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api/health`);
    console.log(`   Data: ${bridge.getDataDir()}\n`);

    // Try connecting to OpenClaw gateway
    wsClient.connect().then(() => {
      console.log('   ✅ OpenClaw gateway connected\n');
    }).catch(e => {
      console.log(`   ⚠️  OpenClaw gateway not reachable (${e.message})\n`);
    });

    // Auto-sync agents from filesystem on startup
    setTimeout(() => {
      try {
        const fsAgents = bridge.listAgentsFromFilesystem();
        for (const agent of fsAgents) {
          let userEmail = agent.id;
          if (agent.id.startsWith('user-')) {
            userEmail = agent.id.replace('user-', '').replace(/-/g, '.').replace(/\.([^.]+)$/, '@$1.com');
            if (userEmail.endsWith('@clickai.com')) userEmail = userEmail.replace('@clickai.com', '@clickai.vn');
          }
          userQueries.create({ email: userEmail });
          agentQueries.create({
            id: agent.id, user_email: userEmail, name: agent.name,
            workspace: agent.workspace, agent_dir: agent.agentDir,
            primary_model: agent.primaryModel,
          });
          // Merge: only add filesystem providers if not already in DB with valid key
          if (agent.providers?.length > 0) {
            const existingDb = llmQueries.getByAgent(agent.id);
            const existingMap = {};
            for (const ep of existingDb) {
              if (ep.api_key && ep.api_key.length > 3) existingMap[ep.provider] = true;
            }
            // Only replace if DB has no providers at all
            if (existingDb.length === 0) {
              llmQueries.replaceAll(agent.id, agent.providers);
            }
            // Otherwise, only add NEW providers not already in DB with valid keys
            // Don't overwrite user-configured keys with empty filesystem keys
          }
        }
        console.log(`   📂 Synced ${fsAgents.length} agents from filesystem\n`);
      } catch (e) {
        console.warn('   ⚠️  Filesystem sync failed:', e.message);
      }
    }, 500);
  });
}

start().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
