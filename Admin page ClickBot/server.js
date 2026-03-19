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

// ═══ Route handler ═══
async function handleRequest(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method;

  // ════════════════ API Routes ════════════════

  // Health check
  if (pathname === '/api/health') {
    return sendJSON(res, { ok: true, gateway: wsClient.isConnected(), timestamp: Date.now() });
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

  // ── Agent LLM Providers ──
  const llmMatch = pathname.match(/^\/api\/agents\/([^/]+)\/llm$/);
  if (llmMatch) {
    const agentId = decodeURIComponent(llmMatch[1]);

    if (method === 'GET') {
      return sendJSON(res, llmQueries.getByAgent(agentId));
    }

    if (method === 'PUT') {
      const body = await readBody(req);
      const providers = body.providers || body;
      if (!Array.isArray(providers)) return sendError(res, 'providers must be an array');

      // 1. Save to SQLite
      llmQueries.replaceAll(agentId, providers);

      // 2. Write auth-profiles.json for this agent
      const existingProfiles = bridge.readAuthProfiles(agentId);
      const authProfiles = bridge.providersToAuthProfiles(providers, existingProfiles);
      const written = bridge.writeAuthProfiles(agentId, authProfiles);

      // 3. Reload secrets on OpenClaw gateway
      let reloaded = false;
      if (written) {
        try { reloaded = await wsClient.secretsReload(); } catch {}
      }

      // 4. Update primary model if specified
      if (body.primaryModel) {
        bridge.updateAgentModel(agentId, body.primaryModel);
      }

      return sendJSON(res, {
        ok: true,
        written,
        reloaded,
        providersCount: providers.length,
      });
    }
  }

  // ── Agent Permissions ──
  const permMatch = pathname.match(/^\/api\/agents\/([^/]+)\/permissions$/);
  if (permMatch) {
    const agentId = decodeURIComponent(permMatch[1]);
    if (method === 'GET') return sendJSON(res, permQueries.getByAgent(agentId) || {});
    if (method === 'PUT') {
      const body = await readBody(req);
      permQueries.upsert(agentId, body);
      return sendJSON(res, { ok: true });
    }
  }

  // ── Agent Skills ──
  const skillMatch = pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
  if (skillMatch) {
    const agentId = decodeURIComponent(skillMatch[1]);
    if (method === 'GET') return sendJSON(res, skillQueries.getByAgent(agentId));
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
    let models = [], sessions = [];
    try {
      models = await wsClient.modelsList();
      sessions = await wsClient.sessionsList();
    } catch {}
    return sendJSON(res, {
      connected: wsClient.isConnected(),
      modelsCount: models.length,
      models,
      sessionsCount: sessions.length,
      sessions,
    });
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

  // AI Summarize via ClickAI API → Gemini 2.5 Flash
  if (pathname === '/api/meeting/summarize' && method === 'POST') {
    const body = await readBody(req);
    const { filePath: audioPath, config, accessToken } = body;

    if (!accessToken) return sendError(res, 'accessToken required', 401);
    if (!audioPath) return sendError(res, 'filePath required');

    try {
      // Read audio file from disk
      const fullAudioPath = path.join(__dirname, audioPath.startsWith('/') ? audioPath.slice(1) : audioPath);
      if (!fs.existsSync(fullAudioPath)) return sendError(res, 'Audio file not found', 404);

      const audioBuffer = fs.readFileSync(fullAudioPath);
      const audioBase64 = audioBuffer.toString('base64');
      const ext = path.extname(fullAudioPath).slice(1).toLowerCase();
      const mimeMap = { webm: 'audio/webm', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg' };
      const mimeType = mimeMap[ext] || 'audio/webm';

      const lang = config?.language || 'vi';
      const outLang = config?.outputLang || 'vi';
      const detail = config?.detailLevel || 'standard';
      const tone = config?.tone || 'neutral';
      const focusActions = config?.focusActions !== false;

      const langName = { vi: 'Vietnamese', en: 'English', auto: 'Auto-detect' }[lang] || lang;
      const outLangName = outLang === 'vi' ? 'Vietnamese' : 'English';

      const systemPrompt = `You are an expert meeting summarizer. Analyze the audio and produce structured JSON.

Output language: ${outLangName}
Detail level: ${detail}
Tone: ${tone}

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "transcript": "Full transcript of the meeting",
  "summary": "Brief overview summary",
  "actionItems": [
    { "task": "Description", "assignee": "Person", "deadline": "When" }
  ],
  "assignments": [
    { "person": "Name", "role": "Role", "tasks": ["task1", "task2"] }
  ],
  "keyDecisions": ["decision 1", "decision 2"]
}`;

      const userMsg = `Transcribe and summarize this meeting. Language: ${langName}.${focusActions ? ' Focus on action items, assignments, and deadlines.' : ''}`;

      // Build OpenAI-compatible chat request for ClickAI
      const payload = JSON.stringify({
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'audio_url', audio_url: { url: `data:${mimeType};base64,${audioBase64}` } },
              { type: 'text', text: userMsg }
            ]
          }
        ],
        temperature: 0.3,
        max_tokens: 8192
      });

      console.log(`   🤖 Summarizing audio (${(audioBuffer.length / 1024 / 1024).toFixed(1)}MB) via ClickAI...`);

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
          transcript: aiContent,
          summary: '',
          actionItems: [],
          assignments: [],
          keyDecisions: []
        };
      }

      console.log('   ✅ Summarization complete');
      return sendJSON(res, {
        ok: true,
        transcript: parsed.transcript || '',
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
          if (agent.providers?.length > 0) llmQueries.replaceAll(agent.id, agent.providers);
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
