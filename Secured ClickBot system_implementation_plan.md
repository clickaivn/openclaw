# Implementation Plan: API Key Encryption + ClickAI Token Verification

## Background

API keys are currently stored in plaintext in `auth-profiles.json` with world-readable permissions. Admin server accepts any base64 token without verifying ClickAI user identity, enabling cross-user agent access.

---

## Part 1: AES-256-GCM Encryption of API Keys

### Overview

Encrypt every API key field inside `auth-profiles.json` using AES-256-GCM. Master key lives in Docker env var (never on disk). Runtime decryption is transparent to the rest of the codebase.

### Component: Crypto Module

#### [NEW] [crypto-keys.js](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/crypto-keys.js)

New utility module with two functions:

```javascript
// encryptApiKey(plaintext) → "enc:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>"
// decryptApiKey(encrypted) → plaintext
// Master key from env: OPENCLAW_MASTER_KEY (64-char hex = 32 bytes)
```

- Uses Node.js built-in `crypto` module (no dependencies)
- AES-256-GCM with random 12-byte IV per encryption
- Returns tagged format `enc:v1:...` so we can detect already-encrypted vs plaintext keys
- `decryptApiKey()` passes through plaintext strings (for backward compatibility during migration)

---

### Component: Bridge Read/Write

#### [MODIFY] [openclaw-bridge.js](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js)

**[writeAuthProfiles()](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#108-134)** (line 109-132):
- After building [authProfiles](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#221-246) object, iterate `profiles[*].apiKey` → call `encryptApiKey()`
- Set file permission to `0o600` after write
- Add `try/catch` on encrypt — if master key missing, log warning but still write (graceful degradation)

**[readAuthProfiles()](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#98-107)** (line 99-106):
- After JSON parse, iterate `profiles[*].apiKey` → call `decryptApiKey()`
- Returns decrypted profiles to callers (transparent)

**[authProfilesToProviders()](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#221-246)** (line 221+):
- No change needed — it receives already-decrypted profiles from [readAuthProfiles()](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#98-107)

---

### Component: Docker Environment

#### [MODIFY] [docker-compose-v1.yml](file:///Users/mac/Desktop/Antigravity/OpenClaw/docker-compose-v1.yml)

- Add `OPENCLAW_MASTER_KEY` to `admin-server` environment
- Generate random 32-byte hex key: `openssl rand -hex 32`

#### [MODIFY] [.env](file:///Users/mac/Desktop/Antigravity/OpenClaw/.env)

- Add `OPENCLAW_MASTER_KEY=<generated_key>`

---

### Migration Strategy

On first read of un-encrypted `auth-profiles.json`:
- `decryptApiKey()` detects no `enc:v1:` prefix → returns plaintext as-is
- Next [writeAuthProfiles()](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js#108-134) call encrypts all keys automatically
- Manual one-time script: read all agents, re-write to trigger encryption

---

## Part 2: ClickAI Token Verification

### Overview

Extension already has a ClickAI `accessToken` (via `authStorage.getAccessToken()`). We pass this token to Admin server with every request. Admin server verifies it against ClickAI API to get user email, then checks [emailToAgentId(email) === requested agentId](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js#680-691).

### Flow

```
Extension                    Admin Server                  ClickAI API
   │                              │                            │
   │── X-ClickAI-Token header ──►│                            │
   │                              │── GET /user/me ──────────►│
   │                              │   Authorization: Bearer    │
   │                              │◄── { email: "..." } ──────│
   │                              │                            │
   │                              │── emailToAgentId(email)    │
   │                              │   === req agentId? ────────│
   │◄── 200 OK / 403 Forbidden ──│                            │
```

### Component: Admin Server Auth Middleware

#### [MODIFY] [server.js](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/server.js)

**New function `verifyClickAIToken(req)`**:
```javascript
async function verifyClickAIToken(req) {
  const clickaiToken = req.headers['x-clickai-token'];
  if (!clickaiToken) return null;
  // Call ClickAI API to verify token and get user info
  const resp = await fetch('https://clickai.vn/user/me', {
    headers: { Authorization: `Bearer ${clickaiToken}` }
  });
  if (!resp.ok) return null;
  const user = await resp.json();
  return user?.email || null;  // returns verified email
}
```

**New function [emailToAgentId(email)](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js#680-691)**:
```javascript
function emailToAgentId(email) {
  if (!email) return '';
  return 'user-' + email.replace(/@/g, '-').replace(/\./g, '-');
}
```

**New middleware `requireAgentOwnership(req, res, agentId)`**:
```javascript
async function requireAgentOwnership(req, res, agentId) {
  const email = await verifyClickAIToken(req);
  if (!email) {
    sendError(res, 'ClickAI authentication required', 401);
    return false;
  }
  const ownedAgentId = emailToAgentId(email);
  if (ownedAgentId !== agentId) {
    sendError(res, 'Access denied: you do not own this agent', 403);
    return false;
  }
  return true;  // authorized
}
```

**Apply to agent-specific routes** (server.js lines ~250-400):
- `GET /api/agents/:agentId/llm` → add ownership check
- `POST /api/agents/:agentId/llm` → add ownership check
- `GET /api/agents/:agentId/permissions` → add ownership check
- `POST /api/agents/:agentId/permissions` → add ownership check
- `GET /api/agents/:agentId/sessions/*` → add ownership check

> [!IMPORTANT]
> **Caching**: ClickAI token verification involves an HTTP call. We should cache the `token → email` mapping for 5 minutes in-memory to avoid hitting ClickAI API on every request.

---

### Component: Extension — Send ClickAI Token

#### [MODIFY] [clawbot-settings.js](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js)

Every [fetch()](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js#212-254) call to Admin server needs to include the ClickAI token header:
```javascript
// Before: 
fetch(`${adminBase}/api/agents/${agentId}/llm`)

// After:
const clickaiToken = await getClickAIToken();
fetch(`${adminBase}/api/agents/${agentId}/llm`, {
  headers: { 'X-ClickAI-Token': clickaiToken }
})
```

Add helper function:
```javascript
async function getClickAIToken() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_ACCESS_TOKEN' }, resp => {
      resolve(resp?.accessToken || '');
    });
  });
}
```

#### [MODIFY] [clawbot-inject.js](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-inject.js)

Same pattern for any direct [fetch()](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js#212-254) to Admin server from inject script.

---

## User Review Required

> [!IMPORTANT]
> **ClickAI API endpoint**: The plan assumes `GET https://clickai.vn/user/me` with `Bearer <token>` returns `{ email: "..." }`. Please confirm:
> 1. Is this the correct URL? (could be `clickai.io` or different path)
> 2. What fields does the response contain? (need [email](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js#680-691) at minimum)
> 3. Is there a rate limit we should be aware of?

> [!WARNING]
> **Breaking change**: After Part 2, the Extension **must** be logged into ClickAI to access agent data. Non-logged-in users will get 401 from Admin API.

---

## File Change Summary

| File | Action | Part |
|------|--------|------|
| `lib/crypto-keys.js` | **NEW** | Part 1 |
| [lib/openclaw-bridge.js](file:///Users/mac/Desktop/Antigravity/OpenClaw/Admin%20page%20ClickBot/lib/openclaw-bridge.js) | MODIFY — encrypt/decrypt in read/write | Part 1 |
| [docker-compose-v1.yml](file:///Users/mac/Desktop/Antigravity/OpenClaw/docker-compose-v1.yml) | MODIFY — add `OPENCLAW_MASTER_KEY` env | Part 1 |
| [.env](file:///Users/mac/Desktop/Antigravity/OpenClaw/.env) | MODIFY — add master key value | Part 1 |
| [server.js](file:///Users/mac/Desktop/Antigravity/Meeting%20Recorder%20v1/server.js) | MODIFY — add `verifyClickAIToken` + `requireAgentOwnership` middleware | Part 2 |
| [clawbot-settings.js](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-settings.js) | MODIFY — send `X-ClickAI-Token` header | Part 2 |
| [clawbot-inject.js](file:///Users/mac/Desktop/Antigravity/Extension%20ClickBot%20V2/clawbot-inject.js) | MODIFY — send `X-ClickAI-Token` header for Admin API calls | Part 2 |

## Verification Plan

### Automated Tests
1. **Encryption roundtrip**: `encryptApiKey("sk-test") → decryptApiKey() === "sk-test"`
2. **Backward compatibility**: `decryptApiKey("sk-plaintext") === "sk-plaintext"` (no crash on unencrypted)
3. **File permissions**: `stat auth-profiles.json` → `0600`
4. **Auth rejection**: `curl /api/agents/user-admin-clickai/llm` without `X-ClickAI-Token` → 401
5. **Cross-user block**: Call with User A's token → request User B's agent → 403

### Manual Verification
1. Login Extension as `phuong.trinhvan@gmail.com` → verify skills/models load correctly
2. Check `auth-profiles.json` on disk → keys should show `enc:v1:...` format
3. Attempt to read another user's agent data → should be blocked
