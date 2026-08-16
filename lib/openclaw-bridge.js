/**
 * openclaw-bridge.js — Read/write OpenClaw agent data on the shared volume
 * Manages: auth-profiles.json per agent, openclaw.json config
 */
const fs = require('fs');
const path = require('path');
const { encryptAuthProfiles, decryptAuthProfiles } = require('./crypto-keys');

// ═══ All provider/model pairs supported by OpenClaw (sourced from onboard-auth.models.ts) ═══
// Pre-seeding these in openclaw.json means gateway already knows all models at startup.
// Users only need to add an API key → secrets.reload (no restart needed).
const DEFAULT_MODELS = {
  // ── Anthropic ─────────────────────────────────────────────────────────────────
  'anthropic/claude-opus-4-6': {},
  'anthropic/claude-sonnet-4-6': {},
  'anthropic/claude-opus-4-5': {},
  'anthropic/claude-sonnet-4-5': {},
  'anthropic/claude-sonnet-4-20250514': {},
  'anthropic/claude-opus-4-20250514': {},
  'anthropic/claude-3-5-haiku-latest': {},

  // ── OpenAI ────────────────────────────────────────────────────────────────────
  'openai/gpt-5.1-codex': {},
  'openai/gpt-4o': {},
  'openai/gpt-4.1': {},
  'openai/gpt-4.1-mini': {},
  'openai/o4-mini': {},
  'openai/o3': {},

  // ── Google / Gemini ───────────────────────────────────────────────────────────
  // OpenClaw uses "gemini/" prefix (not "google/") for all Gemini models
  'gemini/gemini-3.1-pro-preview': {},
  'gemini/gemini-3-flash-preview': {},
  'gemini/gemini-3.1-flash-lite-preview': {},
  'gemini/gemini-2.5-pro': {},
  'gemini/gemini-2.5-flash': {},
  'gemini/gemini-2.0-flash': {},

  // ── xAI ───────────────────────────────────────────────────────────────────────
  'xai/grok-4': {},
  'xai/grok-3': {},
  'xai/grok-3-mini': {},
  'xai/grok-4-1-fast': {},

  // ── Mistral ───────────────────────────────────────────────────────────────────
  'mistral/mistral-large-latest': {},
  'mistral/codestral-latest': {},
  'mistral/mistral-medium-latest': {},
  'mistral/mistral-small-latest': {},
  'mistral/pixtral-large-latest': {},

  // ── DeepSeek ──────────────────────────────────────────────────────────────────
  'deepseek/deepseek-chat': {},
  'deepseek/deepseek-reasoner': {},

  // ── Qwen / ModelStudio (Alibaba Cloud) ───────────────────────────────────────
  'modelstudio/qwen3.5-plus': {},
  'modelstudio/qwen3-coder-plus': {},
  'modelstudio/qwen3-coder-next': {},
  'modelstudio/qwen3-max-2026-01-23': {},

  // ── Moonshot / Kimi ───────────────────────────────────────────────────────────
  'moonshot/kimi-k2.5': {},
  'kimi-coding/k2p5': {},

  // ── MiniMax ───────────────────────────────────────────────────────────────────
  'minimax/MiniMax-M2.5': {},
  'minimax/MiniMax-M2.5-highspeed': {},

  // ── ZAI / GLM ─────────────────────────────────────────────────────────────────
  'zai/glm-5': {},
  'zai/glm-4.7': {},

  // ── NVIDIA ────────────────────────────────────────────────────────────────────
  'nvidia/nvidia/llama-3.1-nemotron-70b-instruct': {},

  // ── OpenRouter ────────────────────────────────────────────────────────────────
  'openrouter/auto': {},
};

// OpenClaw data directory (shared Docker volume or local path)
const OPENCLAW_DIR = process.env.OPENCLAW_DATA_DIR
  || path.join(require('os').homedir(), '.openclaw');

// For local dev: also check the sibling OpenClaw directory
const LOCAL_OPENCLAW_DIR = path.join(__dirname, '..', '..', '..', 'OpenClaw', '.openclaw-data');

function getDataDir() {
  // Prioritize user's local OpenClaw CLI installation (where gateway actually reads)
  if (fs.existsSync(OPENCLAW_DIR)) return OPENCLAW_DIR;
  // Fallback: project's Docker-mounted data directory
  if (fs.existsSync(LOCAL_OPENCLAW_DIR)) return LOCAL_OPENCLAW_DIR;
  return OPENCLAW_DIR;
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

    // Primary model priority:
    // 1. Per-agent model from openclaw.json config
    // 2. Derive from auth-profiles provider (e.g. anthropic → anthropic/claude-sonnet-4-20250514)
    // 3. Global default (last resort)
    let primaryModel = configAgent?.model || '';
    if (!primaryModel && providers.length > 0) {
      const activeP = providers.find(p => p.active) || providers[0];
      const pName = activeP.provider || '';
      const pModel = activeP.model || '';
      primaryModel = pModel ? `${pName}/${pModel}` : pName;
    }
    if (!primaryModel) {
      primaryModel = config?.agents?.defaults?.model?.primary || '';
    }

    return {
      id: dirName,
      name: configAgent?.name || dirName,
      workspace: configAgent?.workspace || '',
      agentDir: configAgent?.agentDir || '',
      primaryModel,
      providers: providers,
      hasAuthProfiles: !!authProfiles,
    };
  });
}

// ═══ Read auth-profiles.json for an agent (with decryption) ═══
function readAuthProfiles(agentId) {
  const filePath = path.join(getAgentsDir(), agentId, 'agent', 'auth-profiles.json');
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return decryptAuthProfiles(raw);
  } catch {
    return null;
  }
}

// ═══ Write auth-profiles.json for an agent (atomic, 0600) ═══
// NOTE: Encryption disabled — OpenClaw Gateway reads this file directly
// and does not have crypto-keys.js to decrypt. Encryption must be
// implemented at the gateway level (src/agents/pi-auth-json.ts) first.
function writeAuthProfiles(agentId, authProfiles) {
  const agentDir = path.join(getAgentsDir(), agentId, 'agent');
  const filePath = path.join(agentDir, 'auth-profiles.json');
  const tmpPath = filePath + '.tmp';

  try {
    fs.mkdirSync(agentDir, { recursive: true });

    // Write plaintext (gateway cannot decrypt encrypted keys)
    // Security: use 0600 permissions (owner-only read/write)
    fs.writeFileSync(tmpPath, JSON.stringify(authProfiles, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}

    console.log('[Bridge] ✅ Wrote auth-profiles.json for:', agentId,
      '| providers:', Object.keys(authProfiles?.profiles || {}).join(', '));

    // NOTE: syncGlobalAuthModes() removed — writing to openclaw.json triggers
    // the gateway's config file watcher, causing race conditions with secrets.reload.
    // Gateway already discovers providers from per-agent auth-profiles.json
    // via collectCandidateAgentDirs() → loadAuthProfileStoreForAgent().

    return true;
  } catch (e) {
    console.error('[Bridge] ❌ Cannot write auth-profiles.json for', agentId, ':', e.message);
    try { fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

// ═══ Sync provider modes from all agents → global openclaw.json auth.profiles ═══
// Scans all agents' auth-profiles.json, aggregates unique providers,
// writes mode-only entries (NO keys) to openclaw.json.auth.profiles
function syncGlobalAuthModes() {
  try {
    const config = readOpenClawConfig();
    if (!config) return;

    const agentsDir = getAgentsDir();
    const globalProfiles = {};

    // Scan all agent directories for auth-profiles
    const dirs = fs.readdirSync(agentsDir).filter(d => {
      try { return fs.statSync(path.join(agentsDir, d)).isDirectory(); }
      catch { return false; }
    });

    for (const dir of dirs) {
      const ap = readAuthProfiles(dir);
      if (!ap?.profiles) continue;
      for (const [key, profile] of Object.entries(ap.profiles)) {
        if (!globalProfiles[key]) {
          // Mode-only entry — NO key, just tell gateway this provider exists
          globalProfiles[key] = {
            provider: profile.provider || key.split(':')[0],
            mode: 'api_key',
          };
        }
      }
    }

    // Only write if something changed
    const existingProfiles = config.auth?.profiles || {};
    const existingKeys = Object.keys(existingProfiles).sort().join(',');
    const newKeys = Object.keys(globalProfiles).sort().join(',');
    if (existingKeys === newKeys) return; // No change

    config.auth = config.auth || {};
    config.auth.profiles = globalProfiles;

    const configPath = path.join(getDataDir(), 'openclaw.json');
    const tmpPath = configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, configPath);
    console.log('[Bridge] ✅ Global auth.profiles synced:', Object.keys(globalProfiles).join(', '));
  } catch (e) {
    console.warn('[Bridge] ⚠️ Could not sync global auth modes:', e.message);
  }
}

// ═══ Convert LLM providers array → auth-profiles.json format ═══
function providersToAuthProfiles(providers, existingProfiles = null) {
  const profiles = {};
  const usageStats = existingProfiles?.usageStats || {};

  // Provider aliases: some providers need multiple auth-profile entries
  // OpenClaw uses "gemini:" for Gemini models but Extension may send "google"
  const PROVIDER_ALIASES = {
    'google': ['google', 'gemini'],   // Google API key works for both
    'gemini': ['google', 'gemini'],   // Gemini key = Google key
  };

  for (const p of providers) {
    if (!p.api_key && !p.apiKey) continue;
    const providerName = (p.provider || p.name || '').toLowerCase();
    const key = p.api_key || p.apiKey;

    // Get all profile keys for this provider (including aliases)
    const profileNames = PROVIDER_ALIASES[providerName] || [providerName];
    for (const name of profileNames) {
      const profileKey = name + ':default';
      profiles[profileKey] = {
        type: 'api_key',
        provider: name,
        key,
      };
    }
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

  // Default models per provider (sourced from OpenClaw onboard-auth.models.ts)
  const defaultModels = {
    anthropic:    'claude-opus-4-6',
    openai:       'gpt-5.1-codex',
    google:       'gemini-3.1-pro-preview',
    gemini:       'gemini-3.1-pro-preview',
    xai:          'grok-4',
    mistral:      'mistral-large-latest',
    deepseek:     'deepseek-chat',
    modelstudio:  'qwen3.5-plus',
    moonshot:     'kimi-k2.5',
    minimax:      'MiniMax-M2.5',
    zai:          'glm-5',
    openrouter:   'auto',
    nvidia:       'nvidia/llama-3.1-nemotron-70b-instruct',
    qianfan:      'deepseek-v3.2',
  };

  return Object.entries(authProfiles.profiles).map(([key, profile]) => {
    const provider = profile.provider || key.split(':')[0];
    return {
      provider,
      api_key: profile.key || '',
      model: defaultModels[provider] || '',
      base_url: '',
      active: true,
    };
  });
}

// ═══ Update agent's primary model in openclaw.json ═══
function updateAgentModel(agentId, model) {
  const config = readOpenClawConfig();
  if (!config?.agents?.list) return false;

  // Normalize: google/ → gemini/ for OpenClaw
  if (model.startsWith('google/')) {
    model = 'gemini/' + model.slice(7);
  }

  const agent = config.agents.list.find(a => a.id === agentId);
  if (agent) {
    agent.model = model;

    // Also ensure model is in configured models list
    if (config.agents?.defaults?.models && !config.agents.defaults.models[model]) {
      config.agents.defaults.models[model] = {};
    }

    return writeOpenClawConfig(config);
  }
  return false;
}

// ═══ Get global env vars (API keys) ═══
function getGlobalEnvVars() {
  const config = readOpenClawConfig();
  return config?.env || {};
}

// ═══ Auto-provision new agent: workspace + SOUL.md + openclaw.json entry ═══
// Called when a new user syncs for the first time. Ensures:
// 1. Workspace dir with SOUL.md (copied from default workspace)
// 2. Agent dir for auth-profiles.json
// 3. Agent registered in openclaw.json with tools.profile: full
function ensureAgentProvisioned(agentId, model) {
  const dataDir = getDataDir();
  const changes = [];

  try {
    // 1. Create agent directory (for auth-profiles.json)
    const agentDir = path.join(getAgentsDir(), agentId, 'agent');
    if (!fs.existsSync(agentDir)) {
      fs.mkdirSync(agentDir, { recursive: true });
      changes.push('agent-dir');
    }

    // 2. Create per-agent workspace with SOUL.md from default
    const workspaceDir = path.join(dataDir, 'workspace-' + agentId);
    const soulTarget = path.join(workspaceDir, 'SOUL.md');
    const defaultSoul = path.join(dataDir, 'workspace', 'SOUL.md');

    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
      changes.push('workspace');
    }
    // Always keep SOUL.md in sync with default (in case instructions updated)
    if (fs.existsSync(defaultSoul)) {
      fs.copyFileSync(defaultSoul, soulTarget);
      changes.push('soul');
    }

    // 3. Register agent in openclaw.json if not present
    const config = readOpenClawConfig();
    if (config?.agents?.list) {
      const existing = config.agents.list.find(a => a.id === agentId);
      if (!existing) {
        // New agent — add with full tools profile
        const newEntry = {
          id: agentId,
          tools: { profile: 'full' },
        };
        if (model) newEntry.model = model;
        config.agents.list.push(newEntry);
        changes.push('openclaw-registered');
      }

      // Seed ALL default models so gateway knows them without config.patch.
      // This eliminates gateway restarts when users add new providers.
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!config.agents.defaults.models) config.agents.defaults.models = {};

      let seeded = 0;
      for (const [key, val] of Object.entries(DEFAULT_MODELS)) {
        if (!config.agents.defaults.models[key]) {
          config.agents.defaults.models[key] = val;
          seeded++;
        }
      }
      // Also register the agent's specific model
      if (model && !config.agents.defaults.models[model]) {
        config.agents.defaults.models[model] = {};
        seeded++;
      }

      if (!existing || seeded > 0) {
        writeOpenClawConfig(config);
        if (seeded > 0) changes.push(`models-seeded(${seeded})`);
      }
    }

    if (changes.length > 0) {
      console.log('[Bridge] ✅ Provisioned agent:', agentId, '|', changes.join(', '));
    }
    return true;
  } catch (e) {
    console.warn('[Bridge] ⚠️ Provision failed for', agentId, ':', e.message);
    return false;
  }
}

// ═══ Read chat messages from a session JSONL file ═══
function readSessionHistory(agentId, sessionKey) {
  const sessionsPath = path.join(getAgentsDir(), agentId, 'sessions', 'sessions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    // Find the session entry matching the key
    const session = raw[sessionKey];
    if (!session || !session.sessionId) return [];

    // Read the JSONL file for this session
    const sessDir = path.join(getAgentsDir(), agentId, 'sessions');
    const jsonlFile = path.join(sessDir, session.sessionId + '.jsonl');

    // Also try .jsonl.reset.* variants
    let filePath = jsonlFile;
    if (!fs.existsSync(filePath)) {
      // Look for reset files
      const files = fs.readdirSync(sessDir).filter(f => f.startsWith(session.sessionId + '.jsonl'));
      if (files.length > 0) filePath = path.join(sessDir, files[0]);
      else return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message') continue;
        const msg = entry.message;
        if (!msg) continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;

        // Extract text content
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter(c => c.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('');
        }

        if (!text.trim()) continue;

        // Clean up user messages — strip injected context
        if (role === 'user') {
          // Strip Sender (untrusted metadata) block with code fences
          text = text.replace(/Sender \(untrusted metadata\):[\s\S]*?```[\s\S]*?```\s*/g, '');
          // Strip [Wed 2026-...] timestamps
          text = text.replace(/\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+\]\s*/g, '');
          // Strip [CURRENT_TAB] block with content between two --- delimiters
          text = text.replace(/\[CURRENT_TAB\][\s\S]*?---[\s\S]*?---\s*/g, '');
          // Also handle leftover page content before --- delimiter (if [CURRENT_TAB] was already stripped)
          text = text.replace(/^[\s\S]*?---\s*\n\n/g, '');
          // Strip [INSTRUCTION] block
          text = text.replace(/\[INSTRUCTION\][\s\S]*?\n\n/g, '');
          // Strip [YOUTUBE RULE] and similar tags
          text = text.replace(/\[[\w\s]+RULE\][\s\S]*?(?=\n\n|$)/g, '');
          text = text.replace(/^\[.*?\]\s*/g, '');
          text = text.trim();
        }

        if (text.trim()) {
          messages.push({
            role,
            text: text.trim(),
            timestamp: entry.timestamp || '',
          });
        }
      } catch { continue; }
    }

    return messages;
  } catch {
    return [];
  }
}

// ═══ Read sessions from filesystem for an agent ═══
function readAgentSessions(agentId) {
  const sessionsPath = path.join(getAgentsDir(), agentId, 'sessions', 'sessions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    // Convert from object { "agent:id:key": {...} } to sorted array
    return Object.entries(raw).map(([key, s]) => {
      // Extract conversation key from session key: "agent:user-xxx:conv-mmz0h3te-1edb" → "conv-mmz0h3te-1edb"
      const keyParts = key.split(':');
      const convKey = keyParts.length >= 3 ? keyParts.slice(2).join(':') : keyParts[keyParts.length - 1];
      return {
        key,
        convKey,
        sessionId: s.sessionId || '',
        updatedAt: s.updatedAt || 0,
        model: s.model || '',
        modelProvider: s.modelProvider || '',
        totalTokens: s.totalTokens || 0,
        lastChannel: s.lastChannel || '',
        channel: s.deliveryContext?.channel || s.lastChannel || '',
        surface: s.origin?.surface || '',
      };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

// ═══ List default (bundled) skills from OpenClaw skills directory ═══
function listDefaultSkills() {
  // Inside Docker: /app/skills/
  // On host: project root skills/ directory
  const skillsDirs = [
    '/app/skills',
    path.join(__dirname, '..', '..', 'skills'),
    path.join(require('os').homedir(), '.openclaw', 'skills'),
  ];

  for (const skillsDir of skillsDirs) {
    if (!fs.existsSync(skillsDir)) continue;
    try {
      const dirs = fs.readdirSync(skillsDir).filter(d => {
        try { return fs.statSync(path.join(skillsDir, d)).isDirectory() && !d.startsWith('.'); }
        catch { return false; }
      });

      return dirs.map(name => {
        // Try to read SKILL.md for description
        let description = '';
        const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
        if (fs.existsSync(skillMdPath)) {
          try {
            const content = fs.readFileSync(skillMdPath, 'utf8');
            // Extract description from YAML frontmatter
            const descMatch = content.match(/description:\s*(.+)/);
            if (descMatch) description = descMatch[1].trim();
          } catch {}
        }
        return { name, description, source: 'openclaw-bundled', enabled: true };
      });
    } catch { continue; }
  }
  return [];
}

// ═══ Read resolved skills from sessions.json (most recent session) ═══
function readAgentSkillsFromSessions(agentId) {
  const sessions = readAgentSessions(agentId);
  if (!sessions.length) return [];

  const sessionsPath = path.join(getAgentsDir(), agentId, 'sessions', 'sessions.json');
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    // Find the most recent session with a skillsSnapshot
    const sortedKeys = Object.entries(raw)
      .filter(([, s]) => s.skillsSnapshot?.resolvedSkills)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));

    if (sortedKeys.length > 0) {
      const [, session] = sortedKeys[0];
      return (session.skillsSnapshot.resolvedSkills || []).map(s => ({
        name: s.name,
        description: s.description || '',
        source: s.source || 'openclaw-bundled',
        filePath: s.filePath || '',
        enabled: !s.disableModelInvocation,
      }));
    }
  } catch {}
  return [];
}

// ═══ Read per-user installed skills from agent skills directory ═══
function readUserInstalledSkills(agentId) {
  // Per-user skills are installed under agents/{agentId}/skills/
  const userSkillsDir = path.join(getAgentsDir(), agentId, 'skills');
  if (!fs.existsSync(userSkillsDir)) return [];

  try {
    const dirs = fs.readdirSync(userSkillsDir).filter(d => {
      try { return fs.statSync(path.join(userSkillsDir, d)).isDirectory() && !d.startsWith('.'); }
      catch { return false; }
    });

    return dirs.map(name => {
      let description = '';
      const skillMdPath = path.join(userSkillsDir, name, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        try {
          const content = fs.readFileSync(skillMdPath, 'utf8');
          const descMatch = content.match(/description:\s*(.+)/);
          if (descMatch) description = descMatch[1].trim();
        } catch {}
      }
      return { name, description, source: 'user-installed', enabled: true };
    });
  } catch { return []; }
}

// ═══ Read per-agent skill allowlist from openclaw.json ═══
// Returns the allowBundled array (or undefined if not set = all allowed)
function readAgentSkillAllowlist(agentId) {
  const config = readOpenClawConfig();
  if (!config?.agents?.list) return undefined;
  const agent = config.agents.list.find(a => a.id === agentId);
  return agent?.skills?.allowBundled; // undefined = all allowed, [] = all allowed, [names] = restricted
}

// ═══ Write per-agent skill allowlist to openclaw.json ═══
// allowBundled: string[] of skill names to allow, or [] / undefined = allow ALL
function writeAgentSkillAllowlist(agentId, allowBundled) {
  const config = readOpenClawConfig();
  if (!config?.agents?.list) return false;
  const agent = config.agents.list.find(a => a.id === agentId);
  if (!agent) {
    // Provision agent entry if missing
    config.agents.list.push({ id: agentId, tools: { profile: 'full' } });
    const newAgent = config.agents.list.find(a => a.id === agentId);
    if (!newAgent) return false;
    if (allowBundled && allowBundled.length > 0) {
      newAgent.skills = { allowBundled };
    } else {
      delete newAgent.skills;
    }
  } else {
    if (allowBundled && allowBundled.length > 0) {
      if (!agent.skills) agent.skills = {};
      agent.skills.allowBundled = allowBundled;
    } else {
      // Empty array or undefined = allow everything (remove restriction)
      if (agent.skills) {
        delete agent.skills.allowBundled;
        // Clean up empty skills object
        if (Object.keys(agent.skills).length === 0) delete agent.skills;
      }
    }
  }
  return writeOpenClawConfig(config);
}

// ═══ Write skill credentials as env vars to openclaw.json ═══
// Flattens { skillName: { ENV_VAR: value } } → env: { ENV_VAR: value }
// Returns array of env keys written
function writeCredentialsToEnv(credentials) {
  const config = readOpenClawConfig();
  if (!config) return [];

  // Flatten all skill credentials into env key-value pairs
  const envVars = {};
  for (const [skillName, vars] of Object.entries(credentials || {})) {
    if (typeof vars === 'object') {
      for (const [key, val] of Object.entries(vars)) {
        if (val && typeof val === 'string' && !val.startsWith('__OPENCLAW_REDACTED')) {
          envVars[key] = val;
        }
      }
    }
  }

  if (Object.keys(envVars).length === 0) return [];

  // Merge into existing env (preserve other env vars)
  if (!config.env) config.env = {};
  Object.assign(config.env, envVars);

  const written = writeOpenClawConfig(config);
  if (written) {
    console.log('[Bridge] ✅ Wrote', Object.keys(envVars).length, 'env vars from credentials:', Object.keys(envVars).join(', '));
  }
  return written ? Object.keys(envVars) : [];
}

// ═══ Write custom skill SKILL.md to agent's skills directory ═══
// Creates: agents/{agentId}/skills/{skillName}/SKILL.md
function writeCustomSkill(agentId, skillName, description, content) {
  const skillDir = path.join(getAgentsDir(), agentId, 'skills', skillName);
  const skillMdPath = path.join(skillDir, 'SKILL.md');

  try {
    fs.mkdirSync(skillDir, { recursive: true });

    // Build SKILL.md with YAML frontmatter
    let skillMd = '---\n';
    skillMd += `name: ${skillName}\n`;
    if (description) skillMd += `description: ${description}\n`;
    skillMd += '---\n\n';
    skillMd += content || `# ${skillName}\n\n${description || 'Custom skill.'}\n`;

    fs.writeFileSync(skillMdPath, skillMd, 'utf8');
    console.log('[Bridge] ✅ Wrote custom skill:', skillName, 'for agent:', agentId);
    return true;
  } catch (e) {
    console.error('[Bridge] ❌ Cannot write custom skill', skillName, ':', e.message);
    return false;
  }
}

// ═══ Delete custom skill directory from agent's skills ═══
function deleteCustomSkill(agentId, skillName) {
  const skillDir = path.join(getAgentsDir(), agentId, 'skills', skillName);
  try {
    if (fs.existsSync(skillDir)) {
      // Remove directory recursively
      fs.rmSync(skillDir, { recursive: true, force: true });
      console.log('[Bridge] ✅ Deleted custom skill:', skillName, 'for agent:', agentId);
      return true;
    }
    return false;
  } catch (e) {
    console.error('[Bridge] ❌ Cannot delete custom skill', skillName, ':', e.message);
    return false;
  }
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
  ensureAgentProvisioned,
  readAgentSessions,
  readSessionHistory,
  listDefaultSkills,
  readAgentSkillsFromSessions,
  readUserInstalledSkills,
  readAgentSkillAllowlist,
  writeAgentSkillAllowlist,
  writeCredentialsToEnv,
  writeCustomSkill,
  deleteCustomSkill,
};
