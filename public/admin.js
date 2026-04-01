/**
 * admin.js — ClickAI Multi-Agent Gateway Admin Dashboard Logic
 */

const API = window.location.origin + '/api';
let authToken = localStorage.getItem('admin_token') || '';
let currentUser = JSON.parse(localStorage.getItem('admin_user') || 'null');
let agents = [];
let selectedAgent = null;
let editingProviders = [];

// ═══ Theme Toggle ═══
function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('admin-theme', next);
  updateThemeIcon(next);
}
function updateThemeIcon(theme) {
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = theme === 'dark' ? '🌙' : '☀️';
}
// ═══ Init ═══
document.addEventListener('DOMContentLoaded', () => {
  updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');
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

  const titles = { dashboard: 'Dashboard', agents: 'Agent Management', users: 'Users', sessions: 'Sessions', config: 'Configuration', openclaw: 'OpenClaw WebChat' };
  document.getElementById('pageTitle').textContent = titles[page] || page;

  // Load page data
  if (page === 'dashboard') loadDashboard();
  else if (page === 'agents') loadAgents();
  else if (page === 'users') loadUsers();
  else if (page === 'sessions') loadSessions();
  else if (page === 'config') loadConfig();
  else if (page === 'openclaw') loadOpenClawFrame();
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

    // Load skill requests
    loadSkillRequests();

    // Try getting sessions count
    try {
      const status = await apiFetch('/openclaw/status');
      document.getElementById('statSessions').textContent = status.sessionsCount;
    } catch { document.getElementById('statSessions').textContent = '—'; }
  } catch (err) {
    toast('Failed to load dashboard: ' + err.message, 'error');
  }
}

// ═══ User Skill Requests ═══
async function loadSkillRequests() {
  const container = document.getElementById('dashboardRequests');
  if (!container) return;
  try {
    const requests = await apiFetch('/skill-requests');
    if (!requests || requests.length === 0) {
      container.innerHTML = '<p style="color:#64748b;font-size:13px;text-align:center;padding:20px">Chưa có yêu cầu nào từ Extension.</p>';
      return;
    }
    // Sort newest first
    requests.sort((a, b) => new Date(b.receivedAt || b.timestamp) - new Date(a.receivedAt || a.timestamp));

    let html = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="border-bottom:2px solid var(--surface-border);text-align:left">
        <th style="padding:10px 12px;color:var(--text3);font-weight:600;white-space:nowrap">👤 User</th>
        <th style="padding:10px 12px;color:var(--text3);font-weight:600;white-space:nowrap">🔧 Skill</th>
        <th style="padding:10px 12px;color:var(--text3);font-weight:600">📝 Mô tả</th>
        <th style="padding:10px 12px;color:var(--text3);font-weight:600">💡 Lý do</th>
        <th style="padding:10px 12px;color:var(--text3);font-weight:600;white-space:nowrap">🕐 Thời gian</th>
        <th style="padding:10px 12px;color:var(--text3);font-weight:600;white-space:nowrap">Status</th>
      </tr></thead><tbody>`;

    requests.forEach((req, idx) => {
      const status = req.status || 'new';
      const statusColors = { new: '#3b82f6', pending: '#f59e0b', done: '#22c55e' };
      const statusLabels = { new: 'New', pending: 'Pending', done: 'Done' };
      const ts = req.receivedAt || req.timestamp || '';
      const timeStr = ts ? new Date(ts).toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
      html += `<tr style="border-bottom:1px solid var(--surface-border);transition:background 0.15s" onmouseover="this.style.background='rgba(59,130,246,0.05)'" onmouseout="this.style.background=''">
        <td style="padding:8px 12px;color:var(--text);white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(req.userId || req.agentId || '—')}">${escapeHtml(req.userId || req.agentId || '—')}</td>
        <td style="padding:8px 12px"><span style="background:var(--surface-2);padding:3px 8px;border-radius:6px;font-weight:600;color:var(--primary);font-size:12px;border:1px solid var(--surface-border)">${escapeHtml(req.skillName || '—')}</span></td>
        <td style="padding:8px 12px;color:var(--text2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(req.description || '')}">${escapeHtml(req.description || '—')}</td>
        <td style="padding:8px 12px;color:var(--text2);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(req.reason || '')}">${escapeHtml(req.reason || '—')}</td>
        <td style="padding:8px 12px;color:var(--text3);white-space:nowrap;font-size:12px">${timeStr}</td>
        <td style="padding:8px 12px">
          <select data-req-idx="${idx}" data-req-id="${req.id || idx}" onchange="updateRequestStatus(this)" style="background:${statusColors[status]};color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;appearance:auto">
            <option value="new" ${status==='new'?'selected':''} style="background:var(--surface-solid);color:var(--text)">🆕 New</option>
            <option value="pending" ${status==='pending'?'selected':''} style="background:var(--surface-solid);color:var(--text)">⏳ Pending</option>
            <option value="done" ${status==='done'?'selected':''} style="background:var(--surface-solid);color:var(--text)">✅ Done</option>
          </select>
        </td>
      </tr>`;
    });
    html += '</tbody></table></div>';
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p style="color:#f87171;font-size:13px">Error loading requests: ${escapeHtml(err.message)}</p>`;
  }
}

async function updateRequestStatus(select) {
  const reqId = select.dataset.reqId;
  const newStatus = select.value;
  const statusColors = { new: '#3b82f6', pending: '#f59e0b', done: '#22c55e' };
  select.style.background = statusColors[newStatus] || '#3b82f6';
  try {
    await fetch('/api/skill-requests/' + encodeURIComponent(reqId) + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });
    toast('Status updated: ' + newStatus, 'success');
  } catch (e) {
    toast('Failed to update status: ' + e.message, 'error');
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

// ═══ Agent Search / Filter ═══
function filterAgents(query) {
  if (!query || !query.trim()) {
    renderAgentCards('agentsList', agents);
    return;
  }
  const q = query.toLowerCase();
  const filtered = agents.filter(a =>
    (a.id || '').toLowerCase().includes(q) ||
    (a.name || '').toLowerCase().includes(q) ||
    (a.user_email || '').toLowerCase().includes(q) ||
    (a.primary_model || '').toLowerCase().includes(q)
  );
  renderAgentCards('agentsList', filtered);
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
        <div class="agent-icon"><img src="/clawbot-icon.svg" width="24" height="24" style="border-radius:4px" /></div>
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

    // Switch from list view to detail view
    document.getElementById('agentsListView').style.display = 'none';
    document.getElementById('agentDetailView').style.display = 'block';

    // Overview tab
    renderOverview();
    // LLM tab
    editingProviders = [...(selectedAgent.providers || [])];
    renderLlmProviders();
    // Permissions tab
    renderPermissions();
    // Skills tab
    renderSkills(agentId);

    switchTab('overview');

    // Load session history for this agent
    loadAgentSessions(agentId);
  } catch (err) {
    toast('Failed to load agent: ' + err.message, 'error');
  }
}

function backToAgentsList() {
  document.getElementById('agentDetailView').style.display = 'none';
  document.getElementById('agentsListView').style.display = 'block';
  selectedAgent = null;
}

function closeDetail() {
  backToAgentsList();
}

// ═══ Agent Session History ═══
async function loadAgentSessions(agentId) {
  const container = document.getElementById('agentSessionsList');
  container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">Loading sessions...</div>';

  try {
    const sessions = await apiFetch('/agents/' + encodeURIComponent(agentId) + '/sessions');

    if (!sessions.length) {
      container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px;text-align:center">No sessions found for this agent</div>';
      return;
    }

    container.innerHTML = `
      <table class="sessions-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Channel</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map(s => {
            const model = s.model || '—';
            const provider = s.modelProvider || '';
            const modelDisplay = provider ? `${provider}/${model}` : model;
            const tokens = s.totalTokens ? s.totalTokens.toLocaleString() : '—';
            const channel = s.lastChannel || s.channel || '—';
            const lastTime = s.updatedAt ? formatSessionTime(s.updatedAt) : '—';

            return `
              <tr>
                <td><code title="${escapeHtml(s.key)}">${escapeHtml(s.convKey || s.sessionId?.substring(0, 8) || '—')}</code></td>
                <td><span class="agent-badge model">${escapeHtml(modelDisplay)}</span></td>
                <td>${tokens}</td>
                <td><span class="agent-badge">${escapeHtml(channel)}</span></td>
                <td style="white-space:nowrap">${lastTime}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px;text-align:center">Cannot load sessions</div>';
  }
}

function switchTab(tab, evt) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + tab)?.classList.add('active');
  if (evt && evt.target) evt.target.classList.add('active');
  else document.querySelector(`.tab-btn[onclick*="'${tab}'"]`)?.classList.add('active');
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
  // Default all permissions to ON
  const defaults = { browser_control: 1, microphone: 1, notifications: 1, clipboard: 1, file_access: 1, tab_management: 1 };
  const merged = { ...defaults, ...perms };
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
      <input type="checkbox" class="perm-toggle" data-key="${f.key}" ${merged[f.key] ? 'checked' : ''} />
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

// ═══ Skills ═══
async function renderSkills(agentId) {
  const container = document.getElementById('skillsList');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text3);font-size:12px;padding:12px">Loading skills...</div>';

  try {
    const skills = await apiFetch('/agents/' + encodeURIComponent(agentId) + '/skills');

    if (!skills.length) {
      container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px;text-align:center">No skills found</div>';
      return;
    }

    const sourceColors = {
      'openclaw-bundled': '#2196F3',
      'user-installed': '#4CAF50',
      'db': '#FF9800',
    };
    const sourceLabels = {
      'openclaw-bundled': '📦 Bundled',
      'user-installed': '👤 User',
      'db': '💾 Custom',
    };

    container.innerHTML = skills.map(s => `
      <div class="skill-card" style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border);transition:background 0.2s"
           onmouseenter="this.style.background='rgba(255,255,255,0.03)'" onmouseleave="this.style.background='transparent'">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
            <span style="font-weight:600;font-size:13px;color:var(--text1)">${escapeHtml(s.name)}</span>
            <span style="font-size:10px;padding:2px 6px;border-radius:4px;background:${sourceColors[s.source] || '#666'}22;color:${sourceColors[s.source] || '#666'};font-weight:500">${sourceLabels[s.source] || s.source}</span>
          </div>
          ${s.description ? `<div style="font-size:11px;color:var(--text3);line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${escapeHtml(s.description)}</div>` : ''}
        </div>
        <div style="flex-shrink:0;padding-top:2px">
          <span style="font-size:11px;color:${s.enabled ? '#4CAF50' : '#f44336'}">${s.enabled ? '✅' : '❌'}</span>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:16px;text-align:center">Cannot load skills</div>';
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
      container.innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px">No sessions found</div>';
      return;
    }

    // Sort by most recent first
    const sorted = [...status.sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    container.innerHTML = `
      <table class="sessions-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Agent</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Channel</th>
            <th>Last Activity</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(s => {
            const agentId = s.agentId || '—';
            const model = s.model || '—';
            const provider = s.modelProvider || '';
            const modelDisplay = provider ? `${provider}/${model}` : model;
            const tokens = s.totalTokens ? s.totalTokens.toLocaleString() : '—';
            const channel = s.lastChannel || s.channel || '—';
            const lastTime = s.updatedAt ? formatSessionTime(s.updatedAt) : '—';

            return `
              <tr>
                <td><code title="${escapeHtml(s.key || '')}">${escapeHtml(s.convKey || s.sessionId?.substring(0, 8) || '—')}</code></td>
                <td><strong>${escapeHtml(agentId)}</strong></td>
                <td><span class="agent-badge model">${escapeHtml(modelDisplay)}</span></td>
                <td>${tokens}</td>
                <td><span class="agent-badge">${escapeHtml(channel)}</span></td>
                <td style="white-space:nowrap">${lastTime}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    document.getElementById('sessionsList').innerHTML = '<div style="color:var(--text3);font-size:13px;padding:20px">Cannot load sessions</div>';
  }
}

function formatSessionTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
    // Refresh open agent detail if any
    if (selectedAgent) openAgentDetail(selectedAgent.id);
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

// ═══ OpenClaw Iframe ═══
let _openclawDirectUrl = '';

async function loadOpenClawFrame() {
  const frame = document.getElementById('openclawFrame');
  if (!frame) return;
  try {
    const health = await apiFetch('/health');
    const token = health.gatewayToken || '';
    const host = window.location.hostname;
    const port = health.gatewayPort || 18789;
    _openclawDirectUrl = `http://${host}:${port}/#token=${token}`;
    // Use proxy route to bypass X-Frame-Options
    const proxyUrl = `${window.location.origin}/api/openclaw-frame/#token=${token}`;
    if (!frame.src.includes('/api/openclaw-frame')) frame.src = proxyUrl;
  } catch {
    const host = window.location.hostname;
    _openclawDirectUrl = `http://${host}:18789/`;
    const proxyUrl = `${window.location.origin}/api/openclaw-frame/`;
    if (!frame.src.includes('/api/openclaw-frame')) frame.src = proxyUrl;
  }
}

function reloadOpenClawFrame() {
  const frame = document.getElementById('openclawFrame');
  if (frame) { frame.src = ''; setTimeout(() => loadOpenClawFrame(), 100); }
}

function openOpenClawExternal() {
  if (_openclawDirectUrl) window.open(_openclawDirectUrl, '_blank');
  else {
    const host = window.location.hostname;
    window.open(`http://${host}:18789/`, '_blank');
  }
}
