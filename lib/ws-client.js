/**
 * ws-client.js — WebSocket client to OpenClaw Gateway
 * Uses webchat protocol: wait for challenge, then send connect request
 */
const WebSocket = require('ws');

const DEFAULT_WS_URL = process.env.OPENCLAW_WS_URL || 'ws://localhost:18789';
const DEFAULT_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '5c6786904c93dc886c9b78525fb655c57e9084b41c42e833';

let ws = null;
let _reqId = 0;
let _authenticated = false;
let _autoReconnect = true;
let _reconnectTimer = null;
let _wsUrl = null;
let _wsToken = null;
const pendingRequests = new Map();

function genId() {
  return 'admin-' + (++_reqId) + '-' + Math.random().toString(36).slice(2, 6);
}

function connect(wsUrl, token) {
  return new Promise((resolve, reject) => {
    const url = wsUrl || DEFAULT_WS_URL;
    const tk = token || DEFAULT_TOKEN;

    if (ws && ws.readyState === WebSocket.OPEN && _authenticated) {
      resolve(ws);
      return;
    }

    _wsUrl = url;
    _wsToken = tk;
    _authenticated = false;
    ws = new WebSocket(url, {
      headers: { 'Origin': url.replace('ws://', 'http://').replace('wss://', 'https://') }
    });

    let connectSent = false;
    let connectTimer = null;

    function sendConnect() {
      if (connectSent || !ws || ws.readyState !== WebSocket.OPEN) return;
      connectSent = true;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }

      const id = genId();
      ws.send(JSON.stringify({
        type: 'req',
        id: id,
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: 'openclaw-control-ui',
            version: 'admin-server-1.0',
            platform: 'node',
            mode: 'webchat',
            instanceId: 'admin-' + Date.now().toString(36)
          },
          role: 'operator',
          scopes: ['operator.read', 'operator.write', 'operator.admin'],
          caps: ['tool-events'],
          auth: { token: tk },
          locale: 'en'
        }
      }));
    }

    ws.on('open', () => {
      console.log('[WS] Connected, waiting for challenge...');
      // Wait for connect.challenge event from gateway
      // If no challenge in 3s, try connecting without nonce
      connectTimer = setTimeout(() => {
        if (!connectSent) {
          console.log('[WS] No challenge received, connecting directly...');
          sendConnect();
        }
      }, 3000);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle connect.challenge event — gateway sends nonce
        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          console.log('[WS] Received challenge, sending connect...');
          sendConnect();
          return;
        }

        // Handle connect response (authentication success)
        if (!_authenticated && msg.type === 'res' && msg.id) {
          _authenticated = true;
          console.log('[WS] ✅ Authenticated with gateway');
          resolve(ws);
          return;
        }

        // Handle error response during auth
        if (!_authenticated && msg.type === 'err') {
          console.warn('[WS] Auth error:', JSON.stringify(msg));
          reject(new Error(msg.error?.message || 'Auth failed'));
          ws.close();
          return;
        }

        // Handle RPC responses
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve: res, reject: rej, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer);
          pendingRequests.delete(msg.id);
          if (msg.type === 'err' || msg.error) rej(new Error(msg.error?.message || msg.payload?.message || 'RPC error'));
          else res(msg.payload || msg.result || msg.params);
        }
      } catch (e) {
        console.warn('[WS] Parse error:', e.message);
      }
    });

    ws.on('error', (err) => {
      console.warn('[WS] Connection error:', err.message);
      if (!_authenticated) reject(err);
    });

    ws.on('close', (code, reason) => {
      console.log(`[WS] Disconnected (code=${code}, reason=${reason || 'n/a'})`);
      ws = null;
      const wasAuth = _authenticated;
      _authenticated = false;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      // Reject all pending
      for (const [id, { reject: rej, timer }] of pendingRequests) {
        clearTimeout(timer);
        rej(new Error('WebSocket closed'));
      }
      pendingRequests.clear();
      // Auto-reconnect
      if (_autoReconnect && _wsUrl) {
        if (_reconnectTimer) clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
          console.log('[WS] Auto-reconnecting...');
          connect(_wsUrl, _wsToken).then(() => {
            console.log('[WS] ✅ Reconnected');
          }).catch(e => {
            console.warn('[WS] Reconnect failed:', e.message);
          });
        }, 5000);
      }
    });

    // Auth timeout
    setTimeout(() => {
      if (!_authenticated) {
        reject(new Error('Connection timeout'));
        if (ws) ws.close();
      }
    }, 10000);
  });
}

async function request(method, params = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !_authenticated) {
    await connect();
  }

  const id = genId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 15000);

    pendingRequests.set(id, { resolve, reject, timer });

    ws.send(JSON.stringify({
      type: 'req',
      id,
      method,
      params
    }));
  });
}

async function secretsReload() {
  try { await request('secrets.reload', {}); console.log('[WS] ✅ secrets.reload'); return true; }
  catch (e) { console.warn('[WS] secrets.reload failed:', e.message); return false; }
}

async function modelsList() {
  try { const r = await request('models.list', {}); return r?.models || []; }
  catch (e) { console.warn('[WS] models.list failed:', e.message); return []; }
}

async function sessionsList() {
  try { const r = await request('sessions.list', {}); return r?.sessions || []; }
  catch (e) { console.warn('[WS] sessions.list failed:', e.message); return []; }
}

async function agentsList() {
  try { const r = await request('agents.list', {}); return r?.agents || []; }
  catch (e) { console.warn('[WS] agents.list failed:', e.message); return []; }
}

// Chat proxy: send message to a specific agent's session
async function chatSend(agentId, message, sessionKey = 'main') {
  // Build session key: agent:{agentId}:{sessionKey}
  const fullSessionKey = agentId ? `agent:${agentId}:${sessionKey}` : sessionKey;
  const idempotencyKey = 'admin-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  try {
    const r = await request('chat.send', {
      sessionKey: fullSessionKey,
      message,
      deliver: false,
      idempotencyKey
    });
    console.log('[WS] ✅ chat.send to', fullSessionKey);
    return r;
  } catch (e) {
    console.warn('[WS] chat.send failed:', e.message);
    throw e;
  }
}

// Config get: read current openclaw config
async function configGet() {
  try { return await request('config.get', {}); }
  catch (e) { console.warn('[WS] config.get failed:', e.message); return null; }
}

// Config patch: push agent model change to gateway via config.patch
// Uses filesystem config (valid JSON) instead of gateway raw (JS object format)
async function configPatchModel(agentId, model) {
  try {
    // Get baseHash from gateway (don't parse raw — it's JS object format, not JSON)
    let baseHash;
    try {
      const configRes = await request('config.get', {});
      baseHash = configRes?.hash || configRes?.baseHash;
    } catch {}

    // Read the REAL config from filesystem (valid JSON)
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config?.agents?.list) {
      console.warn('[WS] No agents.list in filesystem config');
      return false;
    }

    // Update the target agent's model
    const updatedList = config.agents.list.map(a => {
      if (a.id === agentId) return { ...a, model };
      return a;
    });

    // Ensure model is in configured models list
    const models = config.agents?.defaults?.models || {};
    if (!models[model]) models[model] = {};

    // Build minimal patch — only agents section
    const patch = {
      agents: {
        list: updatedList,
        defaults: { ...config.agents.defaults, models }
      }
    };
    const patchParams = { raw: JSON.stringify(patch) };
    if (baseHash) patchParams.baseHash = baseHash;

    await request('config.patch', patchParams);
    console.log('[WS] ✅ config.patch model:', model, 'for agent:', agentId);
    return true;
  } catch (e) {
    // Gateway may restart after config.patch — that's expected
    if (e.message?.includes('closed') || e.message?.includes('disconnect')) {
      console.log('[WS] Gateway restarting after config.patch (expected)');
      return true;
    }
    console.warn('[WS] config.patch failed:', e.message);
    return false;
  }
}

// Config patch: push per-agent skill allowlist change to gateway via config.patch
// allowBundled: [] or undefined = allow all skills (unblock); [names] = restrict to subset
async function configPatchSkillAllowlist(agentId, allowBundled) {
  try {
    // Get baseHash from gateway
    let baseHash;
    try {
      const configRes = await request('config.get', {});
      baseHash = configRes?.hash || configRes?.baseHash;
    } catch {}

    // Read REAL config from filesystem (valid JSON)
    const fs = require('fs');
    const path = require('path');
    const configPath = path.join(require('os').homedir(), '.openclaw', 'openclaw.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config?.agents?.list) {
      console.warn('[WS] No agents.list in filesystem config');
      return false;
    }

    // Update the target agent's skills.allowBundled
    let found = false;
    const updatedList = config.agents.list.map(a => {
      if (a.id !== agentId) return a;
      found = true;
      const updated = { ...a };
      if (allowBundled && allowBundled.length > 0) {
        updated.skills = { ...(updated.skills || {}), allowBundled };
      } else {
        // Remove allowBundled to allow ALL skills
        if (updated.skills) {
          const { allowBundled: _, ...rest } = updated.skills;
          updated.skills = Object.keys(rest).length > 0 ? rest : undefined;
          if (!updated.skills) delete updated.skills;
        }
      }
      return updated;
    });

    if (!found) {
      console.warn('[WS] Agent not found in config:', agentId);
      return false;
    }

    // Build minimal patch — only agents section
    const patch = {
      agents: {
        list: updatedList,
        defaults: config.agents.defaults || {}
      }
    };
    const patchParams = { raw: JSON.stringify(patch) };
    if (baseHash) patchParams.baseHash = baseHash;

    await request('config.patch', patchParams);
    console.log('[WS] ✅ config.patch skills allowlist for agent:', agentId,
      '| allowBundled:', allowBundled?.length > 0 ? allowBundled.slice(0, 5).join(',') + '...' : '(all)');
    return true;
  } catch (e) {
    // Gateway may restart after config.patch — that's expected
    if (e.message?.includes('closed') || e.message?.includes('disconnect')) {
      console.log('[WS] Gateway restarting after config.patch (expected)');
      return true;
    }
    console.warn('[WS] configPatchSkillAllowlist failed:', e.message);
    return false;
  }
}

// Skills status — trigger gateway to re-discover skills from filesystem
async function skillsStatus(agentId) {
  try {
    const r = await request('skills.status', { agentId: agentId || '' });
    console.log('[WS] ✅ skills.status for agent:', agentId);
    return r;
  } catch (e) {
    console.warn('[WS] skills.status failed:', e.message);
    return null;
  }
}

function isConnected() {
  return !!(ws && ws.readyState === WebSocket.OPEN && _authenticated);
}

function disconnect() {
  _autoReconnect = false;
  if (_reconnectTimer) clearTimeout(_reconnectTimer);
  if (ws) ws.close();
}

module.exports = { connect, request, secretsReload, modelsList, sessionsList, agentsList, chatSend, configGet, configPatchModel, configPatchSkillAllowlist, skillsStatus, isConnected, disconnect };
