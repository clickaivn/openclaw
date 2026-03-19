/**
 * admin.js — ClickAI Multi-Agent Gateway Admin Dashboard Logic
 */

const API = window.location.origin + '/api';
let authToken = localStorage.getItem('admin_token') || '';
let currentUser = JSON.parse(localStorage.getItem('admin_user') || 'null');
let agents = [];
let selectedAgent = null;
let editingProviders = [];

// ═══ Init ═══
document.addEventListener('DOMContentLoaded', () => {
  if (authToken && currentUser) {
    showApp();
    loadDashboard();
  } else {
    showLogin();
  }
});

// ═══ Auth ═══
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('btnLogin');
  const status = document.getElementById('loginStatus');

  if (!email || !password) { showLoginStatus('error', '⚠️ Please enter email and password'); return; }

  btn.classList.add('loading');
  status.style.display = 'none';

  try {
    const res = await apiFetch('/auth/login', 'POST', { email, password });
    authToken = res.token;
    currentUser = res.user;
    localStorage.setItem('admin_token', authToken);
    localStorage.setItem('admin_user', JSON.stringify(currentUser));
    showLoginStatus('success', `✅ Welcome, ${res.user.name || res.user.email}!`);
    setTimeout(() => { showApp(); loadDashboard(); }, 600);
  } catch (err) {
    showLoginStatus('error', `❌ ${err.message}`);
  } finally {
    btn.classList.remove('loading');
  }
}

function logout() {
  authToken = '';
  currentUser = null;
  localStorage.removeItem('admin_token');
  localStorage.removeItem('admin_user');
  showLogin();
}

function showLogin() {
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('app').style.visibility = 'hidden';
}

function showApp() {
  document.getElementById('loginOverlay').classList.add('hidden');
  document.getElementById('app').style.visibility = 'visible';
  if (currentUser) {
    document.getElementById('currentUserName').textContent = currentUser.name || 'Admin';
    document.getElementById('currentUserEmail').textContent = currentUser.email;
  }
}

function showLoginStatus(type, msg) {
  const el = document.getElementById('loginStatus');
  el.className = 'status-msg ' + type;
  el.textContent = msg;
}

// ═══ API Helper ═══
async function apiFetch(endpoint, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (authToken) opts.headers['Authorization'] = 'Bearer ' + authToken;
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(API + endpoint, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ═══ Page Navigation ═══
function switchPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + page)?.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');

  const titles = { dashboard: 'Dashboard', agents: 'Agent Management', users: 'Users', sessions: 'Sessions', config: 'Configuration' };
  document.getElementById('pageTitle').textContent = titles[page] || page;

  // Load page data
  if (page === 'dashboard') loadDashboard();
  else if (page === 'agents') loadAgents();
  else if (page === 'users') loadUsers();
  else if (page === 'sessions') loadSessions();
  else if (page === 'config') loadConfig();
}

// ═══ Dashboard ═══
async function loadDashboard() {
  checkGatewayStatus();
  try {
    agents = await apiFetch('/agents');
    const users = await apiFetch('/users');

    document.getElementById('statAgents').textContent = agents.length;
    document.getElementById('statUsers').textContent = users.length;
    document.getElementById('statModels').textContent = agents.reduce((sum, a) => sum + (a.providers?.length || 0), 0);

    renderAgentCards('dashboardAgents', agents.slice(0, 6));

    // Try getting sessions count
    try {
      const status = await apiFetch('/openclaw/status');
      document.getElementById('statSessions').textContent = status.sessionsCount;
    } catch { document.getElementById('statSessions').textContent = '—'; }
  } catch (err) {
    toast('Failed to load dashboard: ' + err.message, 'error');
  }
}

// ═══ Gateway Status ═══
async function checkGatewayStatus() {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'status-dot checking';
  text.textContent = 'Checking...';

  try {
    const health = await apiFetch('/health');
    if (health.gateway) {
      dot.className = 'status-dot ok';
      text.textContent = 'Gateway Connected';
    } else {
      dot.className = 'status-dot err';
      text.textContent = 'Gateway Disconnected';
    }
  } catch {
    dot.className = 'status-dot err';
    text.textContent = 'Server Error';
  }
}

// ═══ Agents ═══
async function loadAgents() {
  try {
    agents = await apiFetch('/agents');
    renderAgentCards('agentsList', agents);
  } catch (err) {
    toast('Failed to load agents: ' + err.message, 'error');
  }
}

function renderAgentCards(containerId, agentList) {
  const container = document.getElementById(containerId);
  if (!agentList.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px;text-align:center">No agents found. Click "Sync from OpenClaw" to import.</div>';
    return;
  }

  container.innerHTML = agentList.map(a => `
    <div class="agent-card" onclick="openAgentDetail('${a.id}')">
      <div class="agent-status"></div>
      <div class="agent-card-header">
        <div class="agent-icon">🤖</div>
        <div>
          <div class="agent-name">${a.name || a.id}</div>
          <div class="agent-email">${a.user_email}</div>
        </div>
      </div>
      <div class="agent-meta">
        ${a.primary_model ? `<span class="agent-badge model">🧠 ${a.primary_model.split('/').pop()}</span>` : ''}
        <span class="agent-badge providers">🔑 ${a.providers?.length || 0} providers</span>
        <span class="agent-badge">📂 ${a.id}</span>
      </div>
    </div>
  `).join('');
}

// ═══ Agent Detail ═══
async function openAgentDetail(agentId) {
  try {
    selectedAgent = await apiFetch('/agents/' + encodeURIComponent(agentId));
    document.getElementById('detailAgentName').textContent = selectedAgent.name || selectedAgent.id;
    document.getElementById('agentDetail').style.display = 'block';

    // Overview tab
    renderOverview();
    // LLM tab
    editingProviders = [...(selectedAgent.providers || [])];
    renderLlmProviders();
    // Permissions tab
    renderPermissions();

    switchTab('overview');
  } catch (err) {
    toast('Failed to load agent: ' + err.message, 'error');
  }
}

function closeDetail() {
  document.getElementById('agentDetail').style.display = 'none';
  selectedAgent = null;
}

function switchTab(tab) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab)?.classList.add('active');
  event.target?.classList.add('active');
}

function renderOverview() {
  const a = selectedAgent;
  document.getElementById('overviewGrid').innerHTML = `
    <div class="detail-item"><div class="detail-label">Agent ID</div><div class="detail-value">${a.id}</div></div>
    <div class="detail-item"><div class="detail-label">Owner</div><div class="detail-value">${a.user_email}</div></div>
    <div class="detail-item"><div class="detail-label">Primary Model</div><div class="detail-value">${a.primary_model || 'Default'}</div></div>
    <div class="detail-item"><div class="detail-label">Status</div><div class="detail-value">${a.status || 'active'}</div></div>
    <div class="detail-item"><div class="detail-label">Workspace</div><div class="detail-value">${a.workspace || '—'}</div></div>
    <div class="detail-item"><div class="detail-label">Agent Dir</div><div class="detail-value">${a.agent_dir || '—'}</div></div>
    <div class="detail-item"><div class="detail-label">LLM Providers</div><div class="detail-value">${a.providers?.length || 0} configured</div></div>
    <div class="detail-item"><div class="detail-label">Created</div><div class="detail-value">${a.created_at || '—'}</div></div>
  `;
}

// ═══ LLM Providers ═══
function renderLlmProviders() {
  const container = document.getElementById('llmProvidersList');
  if (!editingProviders.length) {
    container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">No LLM providers configured. Click "Add Provider" to add one.</div>';
    return;
  }

  container.innerHTML = editingProviders.map((p, i) => `
    <div class="llm-card">
      <div class="llm-card-header">
        <span class="llm-provider-name">${providerIcon(p.provider)} ${p.provider || 'Unknown'}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" class="llm-toggle" ${p.active ? 'checked' : ''} onchange="editingProviders[${i}].active=this.checked?1:0" />
          <button class="llm-remove" onclick="removeProvider(${i})">🗑️</button>
        </div>
      </div>
      <div class="llm-fields">
        <div class="llm-field">
          <label>Provider</label>
          <select onchange="editingProviders[${i}].provider=this.value;renderLlmProviders()">
            ${['anthropic','openai','google','deepseek','xai','openrouter','mistral','ollama','custom'].map(
              v => `<option value="${v}" ${p.provider===v?'selected':''}>${v}</option>`
            ).join('')}
          </select>
        </div>
        <div class="llm-field">
          <label>Model</label>
          <input type="text" value="${p.model || ''}" placeholder="claude-sonnet-4-20250514" onchange="editingProviders[${i}].model=this.value" />
        </div>
        <div class="llm-field full">
          <label>API Key</label>
          <input type="password" value="${p.api_key || p.apiKey || ''}" placeholder="sk-... or AIza..." onchange="editingProviders[${i}].api_key=this.value" />
        </div>
        <div class="llm-field full">
          <label>Base URL (optional)</label>
          <input type="text" value="${p.base_url || p.baseUrl || ''}" placeholder="https://api.provider.com/v1" onchange="editingProviders[${i}].base_url=this.value" />
        </div>
      </div>
    </div>
  `).join('');
}

function providerIcon(name) {
  const icons = { anthropic:'🟠', openai:'🟢', google:'🧠', deepseek:'🔵', xai:'⚡', openrouter:'🌐', mistral:'🌪️', ollama:'🧊' };
  return icons[(name || '').toLowerCase()] || '🔧';
}

function addLlmProvider() {
  editingProviders.push({ provider: 'anthropic', api_key: '', model: '', base_url: '', active: 1 });
  renderLlmProviders();
}

function removeProvider(index) {
  editingProviders.splice(index, 1);
  renderLlmProviders();
}

async function saveLlmProviders() {
  if (!selectedAgent) return;
  try {
    const res = await apiFetch('/agents/' + encodeURIComponent(selectedAgent.id) + '/llm', 'PUT', {
      providers: editingProviders,
      primaryModel: editingProviders.find(p => p.active)?.provider
        ? editingProviders.find(p => p.active).provider + '/' + (editingProviders.find(p => p.active).model || '')
        : undefined
    });
    toast(`✅ Saved ${res.providersCount} providers. Auth-profiles ${res.written ? 'written' : 'failed'}. Secrets ${res.reloaded ? 'reloaded' : 'not reloaded'}.`, res.written ? 'success' : 'error');
    // Refresh
    await openAgentDetail(selectedAgent.id);
    await loadAgents();
  } catch (err) {
    toast('❌ Save failed: ' + err.message, 'error');
  }
}

// ═══ Permissions ═══
function renderPermissions() {
  const perms = selectedAgent?.permissions || {};
  const fields = [
    { key: 'browser_control', label: '🌐 Browser Control', icon: '' },
    { key: 'microphone', label: '🎤 Microphone Access', icon: '' },
    { key: 'notifications', label: '🔔 Notifications', icon: '' },
    { key: 'clipboard', label: '📋 Clipboard Access', icon: '' },
    { key: 'file_access', label: '📁 File System Access', icon: '' },
    { key: 'tab_management', label: '🗂 Tab Management', icon: '' },
  ];

  document.getElementById('permissionsForm').innerHTML = fields.map(f => `
    <div class="perm-row">
      <span class="perm-label">${f.label}</span>
      <input type="checkbox" class="perm-toggle" data-key="${f.key}" ${perms[f.key] ? 'checked' : ''} />
    </div>
  `).join('');
}

async function savePermissions() {
  if (!selectedAgent) return;
  const perms = {};
  document.querySelectorAll('#permissionsForm .perm-toggle').forEach(el => {
    perms[el.dataset.key] = el.checked;
  });
  try {
    await apiFetch('/agents/' + encodeURIComponent(selectedAgent.id) + '/permissions', 'PUT', perms);
    toast('✅ Permissions saved', 'success');
  } catch (err) {
    toast('❌ Save failed: ' + err.message, 'error');
  }
}

// ═══ Users ═══
async function loadUsers() {
  try {
    const users = await apiFetch('/users');
    document.getElementById('usersTable').innerHTML = `
      <table>
        <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Created</th></tr></thead>
        <tbody>
          ${users.map(u => `
            <tr>
              <td>${u.email}</td>
              <td>${u.name || '—'}</td>
              <td><span class="role-badge ${u.role}">${u.role}</span></td>
              <td>${u.created_at || '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    toast('Failed to load users: ' + err.message, 'error');
  }
}

// ═══ Sessions ═══
async function loadSessions() {
  try {
    const status = await apiFetch('/openclaw/status');
    const container = document.getElementById('sessionsList');
    if (!status.sessions?.length) {
      container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px">No active sessions</div>';
      return;
    }
    container.innerHTML = status.sessions.map(s => `
      <div class="session-card">
        <div class="session-id">🔗 ${s.id || s.sessionId || 'Unknown'}</div>
        <div class="session-meta">Agent: ${s.agentId || '—'} · Model: ${s.model || '—'}</div>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('sessionsList').innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px">Cannot connect to gateway</div>';
  }
}

// ═══ Config ═══
async function loadConfig() {
  try {
    const syncData = await apiFetch('/openclaw/sync');
    document.getElementById('globalEnvVars').innerHTML = syncData.globalEnv.map(k => `
      <div class="detail-item" style="display:inline-block;margin:4px">
        <span class="agent-badge">${k}</span>
      </div>
    `).join('');
  } catch {}

  // Show raw config (from server)
  try {
    const res = await fetch(API + '/health');
    document.getElementById('configEditor').value = JSON.stringify(await res.json(), null, 2);
  } catch {}
}

// ═══ Sync from OpenClaw ═══
async function syncFromOpenClaw() {
  try {
    const res = await apiFetch('/openclaw/sync');
    toast(`✅ Synced ${res.imported} agents from OpenClaw`, 'success');
    loadDashboard();
    loadAgents();
  } catch (err) {
    toast('❌ Sync failed: ' + err.message, 'error');
  }
}

// ═══ Toast ═══
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ═══ OpenClaw UI ═══
async function openOpenClawUI() {
  try {
    const health = await apiFetch('/health');
    const token = health.gatewayToken || '';
    const host = window.location.hostname;
    const port = health.gatewayPort || 18789;
    const url = `http://${host}:${port}/#token=${token}`;
    window.open(url, '_blank');
  } catch {
    // Fallback
    const host = window.location.hostname;
    window.open(`http://${host}:18789/`, '_blank');
  }
}
