/**
 * server.js — ClickAI Multi-Agent Gateway Admin Server
 * REST API + Static file serving + OpenClaw filesystem bridge
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { initDb, userQueries, agentQueries, llmQueries, permQueries, skillQueries, cronQueries } = require('./lib/db');
const bridge = require('./lib/openclaw-bridge');
const wsClient = require('./lib/ws-client');

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

// ═══ Helpers ═══
function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
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
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    return sendJSON(res, { token, user: { email: user.email, name: user.name, role: user.role, avatar: user.avatar } });
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
      { name: 'OpenAI',    icon: 'openai',    models: ['gpt-5.4','gpt-5.4-pro','gpt-5.4-mini','gpt-5.4-nano','gpt-5.3','gpt-5.2','gpt-5.1','o4-mini','o3','gpt-4.1','gpt-4.1-mini','gpt-4o'] },
      { name: 'Anthropic',  icon: 'anthropic',  models: ['claude-opus-4-6','claude-sonnet-4-6','claude-sonnet-4-20250514','claude-opus-4-20250514','claude-3-5-haiku-latest'] },
      { name: 'Google',     icon: 'gemini',     models: ['gemini-3.1-pro-preview','gemini-3-flash-preview','gemini-3.1-flash-lite-preview','gemini-2.5-flash','gemini-2.5-pro','gemini-2.0-flash'] },
      { name: 'xAI',        icon: 'xai',        models: ['grok-4','grok-4.20-reasoning','grok-4.20-non-reasoning','grok-4-1-fast-reasoning','grok-3','grok-3-mini'] },
      { name: 'DeepSeek',   icon: 'deepseek',   models: ['deepseek-chat','deepseek-reasoner'] },
      { name: 'Qwen',       icon: 'qwen',       models: ['qwen3.5-plus','qwen3-max-2026-01-23','qwen3-coder-next','qwen3-coder-plus'] },
      { name: 'Mistral',    icon: 'mistral',    models: ['mistral-small-latest','mistral-large-latest','codestral-latest','pixtral-large-latest','mistral-medium-latest'] },
      { name: 'LLaMA',      icon: 'llama',      models: ['llama-4-maverick-17b-128e','llama-4-scout-17b-16e','llama-3.3-70b','llama-3.1-405b','llama-3.1-70b'] },
    ];
    return sendJSON(res, { providers: PROVIDER_CATALOG });
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
        // 1. Save to SQLite
        llmQueries.replaceAll(agentId, providers);

        // 2. Write auth-profiles.json for this agent
        const existingProfiles = bridge.readAuthProfiles(agentId);
        const authProfiles = bridge.providersToAuthProfiles(providers, existingProfiles);
        written = bridge.writeAuthProfiles(agentId, authProfiles);

        // 3. Mark written — reload happens after all changes below
        // (secrets.reload + config.reload done at step 5)
      }

      // 4. Update primary model if specified (both openclaw.json + DB)
      if (body.primaryModel) {
        bridge.updateAgentModel(agentId, body.primaryModel);
        // Also update in DB so dashboard reflects the active model
        const existing = agentQueries.getById(agentId);
        if (existing) {
          agentQueries.create({ ...existing, primary_model: body.primaryModel });
        }
      }

      // 5. Push model change to gateway in-memory config via config.patch
      if (body.primaryModel) {
        let normalizedModel = body.primaryModel;
        if (normalizedModel.startsWith('google/')) normalizedModel = 'gemini/' + normalizedModel.slice(7);
        try { await wsClient.configPatchModel(agentId, normalizedModel); } catch {}
      }
      // 6. Reload secrets (API keys) on gateway
      if (written) {
        try { reloaded = await wsClient.secretsReload(); } catch {}
      }

      return sendJSON(res, {
        ok: true,
        written,
        reloaded,
        configReloaded: true,
        providersCount: providers.length,
      });
    }
  }

  // ── Agent Sessions (from filesystem) ──
  const sessMatch = pathname.match(/^\/api\/agents\/([^/]+)\/sessions$/);
  if (sessMatch && method === 'GET') {
    const agentId = decodeURIComponent(sessMatch[1]);
    const sessions = bridge.readAgentSessions(agentId);
    return sendJSON(res, sessions);
  }

  // ── Session Chat History (read JSONL files) ──
  const histMatch = pathname.match(/^\/api\/agents\/([^/]+)\/sessions\/(.+)\/history$/);
  if (histMatch && method === 'GET') {
    const agentId = decodeURIComponent(histMatch[1]);
    const sessionKey = decodeURIComponent(histMatch[2]);
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
    const providers = llmQueries.getByAgent(agentId).map(p => ({
      name: CANONICAL_NAMES[(p.provider || '').toLowerCase()] || (p.provider || '').charAt(0).toUpperCase() + (p.provider || '').slice(1),
      provider: p.provider,
      apiKey: p.api_key || '',
      model: p.model || '',
      baseUrl: p.base_url || '',
      active: !!p.active,
    }));

    const permissions = permQueries.getByAgent(agentId) || {
      browser_control: 1, microphone: 1, notifications: 1,
      clipboard: 1, file_access: 1, tab_management: 1
    };

    let credentials = {};
    const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
    try { credentials = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}

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
    const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
    fs.mkdirSync(path.dirname(credFile), { recursive: true });
    fs.writeFileSync(credFile, JSON.stringify(body.credentials || {}, null, 2));
    console.log('[Admin] Credentials saved for agent:', agentId);
    return sendJSON(res, { ok: true });
  }
  if (credMatch && method === 'GET') {
    const agentId = decodeURIComponent(credMatch[1]);
    const credFile = path.join(__dirname, 'data', 'credentials', agentId + '.json');
    let creds = {};
    try { creds = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch {}
    return sendJSON(res, creds);
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
      return sendJSON(res, merged);
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (Array.isArray(body)) {
        for (const s of body) skillQueries.upsert(agentId, s);
      }
      return sendJSON(res, { ok: true });
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

    res.writeHead(200, {
      'Content-Type': ct,
      'Content-Length': stat.size,
      'Access-Control-Allow-Origin': '*'
    });
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
