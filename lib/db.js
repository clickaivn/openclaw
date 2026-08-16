/**
 * db.js — SQLite database for ClickAI Admin (using sql.js — pure JS, no native build)
 * Tables: users, agents, agent_llm_providers, agent_permissions, agent_skills, agent_cron_jobs
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'admin.db');

let db = null;
let dbReady = null;

async function initDb() {
  if (db) return db;
  if (dbReady) return dbReady;

  dbReady = (async () => {
    const SQL = await initSqlJs();

    // Load existing DB or create new
    if (fs.existsSync(DB_PATH)) {
      const buffer = fs.readFileSync(DB_PATH);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    initSchema();
    saveDb(); // persist after schema init
    return db;
  })();

  return dbReady;
}

function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

// Auto-save every 30 seconds
setInterval(() => { if (db) saveDb(); }, 30000);

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      password_hash TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      name TEXT DEFAULT '',
      workspace TEXT DEFAULT '',
      agent_dir TEXT DEFAULT '',
      primary_model TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      config_json TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_llm_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      api_key TEXT DEFAULT '',
      model TEXT DEFAULT '',
      base_url TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_permissions (
      agent_id TEXT PRIMARY KEY,
      browser_control INTEGER DEFAULT 1,
      microphone INTEGER DEFAULT 1,
      notifications INTEGER DEFAULT 1,
      clipboard INTEGER DEFAULT 1,
      file_access INTEGER DEFAULT 0,
      tab_management INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      config_json TEXT DEFAULT '{}',
      description TEXT DEFAULT '',
      content TEXT DEFAULT '',
      skill_type TEXT DEFAULT 'custom',
      created_by TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migrate existing tables: add new columns if missing
  const migrateCols = [
    { col: 'description', def: "ALTER TABLE agent_skills ADD COLUMN description TEXT DEFAULT ''" },
    { col: 'content', def: "ALTER TABLE agent_skills ADD COLUMN content TEXT DEFAULT ''" },
    { col: 'skill_type', def: "ALTER TABLE agent_skills ADD COLUMN skill_type TEXT DEFAULT 'custom'" },
    { col: 'created_by', def: "ALTER TABLE agent_skills ADD COLUMN created_by TEXT DEFAULT 'user'" },
    { col: 'created_at', def: "ALTER TABLE agent_skills ADD COLUMN created_at TEXT DEFAULT (datetime('now'))" },
  ];
  for (const m of migrateCols) {
    try { db.run(m.def); } catch (e) {
      // Column already exists — ignore
      if (!e.message?.includes('duplicate column')) console.warn('[DB] Migration skip:', m.col);
    }
  }

  // Unique index on (agent_id, skill_name) to prevent duplicates
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_skills_unique ON agent_skills (agent_id, skill_name)'); } catch {}

  db.run(`
    CREATE TABLE IF NOT EXISTS agent_cron_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      command TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ═══ Per-Agent Credentials (DB backup for filesystem JSON) ═══
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      env_key TEXT NOT NULL,
      env_value TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_creds_unique ON agent_credentials (agent_id, skill_name, env_key)'); } catch {}

  // Seed admin
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@clickai.vn';
  const adminPw = process.env.ADMIN_PASSWORD || 'ClickAI@6789';
  const rows = db.exec("SELECT id FROM users WHERE email = '" + adminEmail.replace(/'/g, "''") + "'");
  if (!rows.length || !rows[0].values.length) {
    db.run("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)", [adminEmail, 'Admin', adminPw]);
  }
}

// ═══ Helper: run SELECT and return array of objects ═══
function query(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const rows = query(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ═══ User queries ═══
const userQueries = {
  getByEmail: (email) => queryOne('SELECT * FROM users WHERE email = ?', [email]),
  getAll: () => query('SELECT id, email, name, avatar, role, created_at FROM users ORDER BY created_at DESC'),
  create: (user) => { try { run('INSERT OR IGNORE INTO users (email, name, avatar, role) VALUES (?, ?, ?, ?)', [user.email, user.name || '', user.avatar || '', user.role || 'user']); } catch {} },
  update: (email, data) => run("UPDATE users SET name = ?, avatar = ?, updated_at = datetime('now') WHERE email = ?", [data.name || '', data.avatar || '', email]),
};

// ═══ Agent queries ═══
const agentQueries = {
  getAll: () => query('SELECT * FROM agents ORDER BY created_at DESC'),
  getById: (id) => queryOne('SELECT * FROM agents WHERE id = ?', [id]),
  getByUser: (email) => query('SELECT * FROM agents WHERE user_email = ? ORDER BY created_at DESC', [email]),
  create: (agent) => run(`INSERT OR REPLACE INTO agents (id, user_email, name, workspace, agent_dir, primary_model, config_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [agent.id, agent.user_email, agent.name || agent.id, agent.workspace || '', agent.agent_dir || '', agent.primary_model || '', agent.config_json || '{}']),
  updateModel: (id, model) => run("UPDATE agents SET primary_model = ?, updated_at = datetime('now') WHERE id = ?", [model, id]),
  delete: (id) => run('DELETE FROM agents WHERE id = ?', [id]),
};

// ═══ LLM Provider queries ═══
const llmQueries = {
  getByAgent: (agentId) => query('SELECT * FROM agent_llm_providers WHERE agent_id = ? ORDER BY id', [agentId]),
  replaceAll: (agentId, providers) => {
    run('DELETE FROM agent_llm_providers WHERE agent_id = ?', [agentId]);
    for (const p of providers) {
      run('INSERT INTO agent_llm_providers (agent_id, provider, api_key, model, base_url, active) VALUES (?, ?, ?, ?, ?, ?)',
        [agentId, p.provider || p.name || '', p.api_key || p.apiKey || '', p.model || '', p.base_url || p.baseUrl || '', p.active ? 1 : 0]);
    }
  },
};

// ═══ Permission queries ═══
const permQueries = {
  getByAgent: (agentId) => queryOne('SELECT * FROM agent_permissions WHERE agent_id = ?', [agentId]),
  upsert: (agentId, perms) => run(`INSERT OR REPLACE INTO agent_permissions (agent_id, browser_control, microphone, notifications, clipboard, file_access, tab_management) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [agentId, perms.browser_control ? 1 : 0, perms.microphone ? 1 : 0, perms.notifications ? 1 : 0, perms.clipboard ? 1 : 0, perms.file_access ? 1 : 0, perms.tab_management ? 1 : 0]),
};

// ═══ Skill queries ═══
const skillQueries = {
  getByAgent: (agentId) => query('SELECT * FROM agent_skills WHERE agent_id = ? ORDER BY skill_name', [agentId]),
  getCustomByAgent: (agentId) => query("SELECT * FROM agent_skills WHERE agent_id = ? AND skill_type = 'custom' ORDER BY created_at DESC", [agentId]),
  getByName: (agentId, skillName) => queryOne('SELECT * FROM agent_skills WHERE agent_id = ? AND skill_name = ?', [agentId, skillName]),
  upsert: (agentId, skill) => run('INSERT OR REPLACE INTO agent_skills (agent_id, skill_name, enabled, config_json) VALUES (?, ?, ?, ?)',
    [agentId, skill.skill_name, skill.enabled ? 1 : 0, skill.config_json || '{}']),
  createCustom: (agentId, skill) => run(
    `INSERT OR REPLACE INTO agent_skills (agent_id, skill_name, enabled, config_json, description, content, skill_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [agentId, skill.skill_name, skill.enabled !== false ? 1 : 0, skill.config_json || '{}',
     skill.description || '', skill.content || '', 'custom', skill.created_by || 'user']),
  deleteByName: (agentId, skillName) => run('DELETE FROM agent_skills WHERE agent_id = ? AND skill_name = ?', [agentId, skillName]),
};

// ═══ Cron queries ═══
const cronQueries = {
  getByAgent: (agentId) => query('SELECT * FROM agent_cron_jobs WHERE agent_id = ? ORDER BY name', [agentId]),
  create: (agentId, job) => run('INSERT INTO agent_cron_jobs (agent_id, name, schedule, command, enabled) VALUES (?, ?, ?, ?, ?)',
    [agentId, job.name, job.schedule, job.command, job.enabled ? 1 : 0]),
  delete: (id) => run('DELETE FROM agent_cron_jobs WHERE id = ?', [id]),
};

// ═══ Credential queries (per-agent, per-skill) ═══
const credQueries = {
  // Get all credentials for an agent → { skill_name: { env_key: env_value } }
  getByAgent: (agentId) => {
    const rows = query('SELECT skill_name, env_key, env_value FROM agent_credentials WHERE agent_id = ? ORDER BY skill_name, env_key', [agentId]);
    const result = {};
    for (const row of rows) {
      if (!result[row.skill_name]) result[row.skill_name] = {};
      result[row.skill_name][row.env_key] = row.env_value || '';
    }
    return result;
  },
  // Get credentials for a specific skill
  getBySkill: (agentId, skillName) => {
    const rows = query('SELECT env_key, env_value FROM agent_credentials WHERE agent_id = ? AND skill_name = ?', [agentId, skillName]);
    const result = {};
    for (const row of rows) result[row.env_key] = row.env_value || '';
    return result;
  },
  // Replace all credentials for an agent (atomic: delete all then insert)
  upsertAll: (agentId, credentials) => {
    // credentials format: { skillName: { ENV_KEY: value } }
    run('DELETE FROM agent_credentials WHERE agent_id = ?', [agentId]);
    for (const [skillName, vars] of Object.entries(credentials || {})) {
      if (typeof vars !== 'object') continue;
      for (const [envKey, envVal] of Object.entries(vars)) {
        if (!envKey || typeof envVal !== 'string') continue;
        run('INSERT INTO agent_credentials (agent_id, skill_name, env_key, env_value) VALUES (?, ?, ?, ?)',
          [agentId, skillName, envKey, envVal]);
      }
    }
  },
  // Delete all credentials for an agent
  deleteByAgent: (agentId) => run('DELETE FROM agent_credentials WHERE agent_id = ?', [agentId]),
};

module.exports = { initDb, saveDb, userQueries, agentQueries, llmQueries, permQueries, skillQueries, cronQueries, credQueries };
