/**
 * openclaw-bridge.js — Read/write OpenClaw agent data on the shared volume
 * Manages: auth-profiles.json per agent, openclaw.json config
 */
const fs = require('fs');
const path = require('path');

// OpenClaw data directory (shared Docker volume or local path)
const OPENCLAW_DIR = process.env.OPENCLAW_DATA_DIR
  || path.join(require('os').homedir(), '.openclaw');

// For local dev: also check the sibling OpenClaw directory
const LOCAL_OPENCLAW_DIR = path.join(__dirname, '..', '..', '..', 'OpenClaw', '.openclaw-data');

function getDataDir() {
  // Prioritize project's Docker-mounted data directory over local CLI installation
  if (fs.existsSync(LOCAL_OPENCLAW_DIR)) return LOCAL_OPENCLAW_DIR;
  if (fs.existsSync(OPENCLAW_DIR)) return OPENCLAW_DIR;
  return OPENCLAW_DIR; // fallback
}

function getAgentsDir() {
  return path.join(getDataDir(), 'agents');
}

// ═══ Read openclaw.json ═══
function readOpenClawConfig() {
  const configPath = path.join(getDataDir(), 'openclaw.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.warn('[Bridge] Cannot read openclaw.json:', e.message);
    return null;
  }
}

// ═══ Write openclaw.json (careful: atomic write) ═══
function writeOpenClawConfig(config) {
  const configPath = path.join(getDataDir(), 'openclaw.json');
  const tmpPath = configPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, configPath);
    return true;
  } catch (e) {
    console.error('[Bridge] Cannot write openclaw.json:', e.message);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// ═══ List agents from filesystem ═══
function listAgentsFromFilesystem() {
  const agentsDir = getAgentsDir();
  if (!fs.existsSync(agentsDir)) return [];

  const config = readOpenClawConfig();
  const agentsList = config?.agents?.list || [];

  const dirs = fs.readdirSync(agentsDir).filter(d => {
    const stat = fs.statSync(path.join(agentsDir, d));
    return stat.isDirectory() && d !== 'main';
  });

  return dirs.map(dirName => {
    const configAgent = agentsList.find(a => a.id === dirName);
    const authProfiles = readAuthProfiles(dirName);
    const providers = authProfilesToProviders(authProfiles);

    return {
      id: dirName,
      name: configAgent?.name || dirName,
      workspace: configAgent?.workspace || '',
      agentDir: configAgent?.agentDir || '',
      primaryModel: configAgent?.model || config?.agents?.defaults?.model?.primary || '',
      providers: providers,
      hasAuthProfiles: !!authProfiles,
    };
  });
}

// ═══ Read auth-profiles.json for an agent ═══
function readAuthProfiles(agentId) {
  const filePath = path.join(getAgentsDir(), agentId, 'agent', 'auth-profiles.json');
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ═══ Write auth-profiles.json for an agent (atomic) ═══
function writeAuthProfiles(agentId, authProfiles) {
  const agentDir = path.join(getAgentsDir(), agentId, 'agent');
  const filePath = path.join(agentDir, 'auth-profiles.json');
  const tmpPath = filePath + '.tmp';

  try {
    // Ensure directory exists
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(authProfiles, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    console.log('[Bridge] ✅ Wrote auth-profiles.json for:', agentId);
    return true;
  } catch (e) {
    console.error('[Bridge] ❌ Cannot write auth-profiles.json for', agentId, ':', e.message);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// ═══ Convert LLM providers array → auth-profiles.json format ═══
function providersToAuthProfiles(providers, existingProfiles = null) {
  const profiles = {};
  const usageStats = existingProfiles?.usageStats || {};

  for (const p of providers) {
    if (!p.api_key && !p.apiKey) continue;
    const providerName = (p.provider || p.name || '').toLowerCase();
    const profileKey = providerName + ':default';

    profiles[profileKey] = {
      type: 'api_key',
      provider: providerName,
      key: p.api_key || p.apiKey,
    };
  }

  return {
    version: 1,
    profiles,
    usageStats,
  };
}

// ═══ Convert auth-profiles.json → LLM providers array ═══
function authProfilesToProviders(authProfiles) {
  if (!authProfiles?.profiles) return [];

  return Object.entries(authProfiles.profiles).map(([key, profile]) => ({
    provider: profile.provider || key.split(':')[0],
    api_key: profile.key || '',
    model: '',  // model is set in openclaw.json, not auth-profiles
    base_url: '',
    active: true,
  }));
}

// ═══ Update agent's primary model in openclaw.json ═══
function updateAgentModel(agentId, model) {
  const config = readOpenClawConfig();
  if (!config?.agents?.list) return false;

  const agent = config.agents.list.find(a => a.id === agentId);
  if (agent) {
    agent.model = model;
    return writeOpenClawConfig(config);
  }
  return false;
}

// ═══ Get global env vars (API keys) ═══
function getGlobalEnvVars() {
  const config = readOpenClawConfig();
  return config?.env || {};
}

module.exports = {
  getDataDir,
  getAgentsDir,
  readOpenClawConfig,
  writeOpenClawConfig,
  listAgentsFromFilesystem,
  readAuthProfiles,
  writeAuthProfiles,
  providersToAuthProfiles,
  authProfilesToProviders,
  updateAgentModel,
  getGlobalEnvVars,
};
