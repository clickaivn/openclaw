/**
 * crypto-keys.js — AES-256-GCM encryption for API keys
 * Master key from env: OPENCLAW_MASTER_KEY (64-char hex = 32 bytes)
 * Format: "enc:v1:<iv_hex>:<ciphertext_hex>:<authTag_hex>"
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM
const PREFIX = 'enc:v1:';

/**
 * Get master key from environment variable.
 * Falls back to default dev key if not configured.
 * Returns a 32-byte Buffer or null if invalid.
 */
function getMasterKey() {
  // Default key for development — MUST match Extension's crypto-helper.js MASTER_KEY_HEX
  const DEFAULT_KEY = 'a1b2c3d4e5f6071829304050607080901a2b3c4d5e6f70819203040506070809';
  const keyHex = process.env.OPENCLAW_MASTER_KEY || DEFAULT_KEY;
  if (!keyHex || keyHex.length !== 64) {
    return null;
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Check if a value is already encrypted (has our prefix).
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext API key using AES-256-GCM.
 * Returns tagged format: "enc:v1:<iv>:<ciphertext>:<authTag>"
 * If master key is not set, returns plaintext unchanged (graceful degradation).
 * If value is already encrypted, returns as-is.
 */
function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // already encrypted

  const key = getMasterKey();
  if (!key) {
    // No master key configured — pass through
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${PREFIX}${iv.toString('hex')}:${encrypted}:${authTag}`;
}

/**
 * Decrypt an encrypted API key.
 * If the value doesn't have our prefix (plaintext), returns as-is (backward compatible).
 * If master key is missing, throws error for encrypted values.
 */
function decryptApiKey(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') return encrypted;
  if (!isEncrypted(encrypted)) return encrypted; // plaintext passthrough

  const key = getMasterKey();
  if (!key) {
    console.warn('[Crypto] ⚠️ OPENCLAW_MASTER_KEY not set — cannot decrypt API key');
    return encrypted; // return as-is, will fail at provider but won't crash
  }

  try {
    const payload = encrypted.slice(PREFIX.length); // remove "enc:v1:"
    const parts = payload.split(':');
    if (parts.length !== 3) {
      console.error('[Crypto] ❌ Invalid encrypted format');
      return encrypted;
    }

    const [ivHex, ciphertextHex, authTagHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (err) {
    console.error('[Crypto] ❌ Decryption failed:', err.message);
    return encrypted; // return as-is rather than crash
  }
}

/**
 * Encrypt all API key fields in an auth-profiles object.
 * Mutates the object in-place and returns it.
 */
function encryptAuthProfiles(authProfiles) {
  if (!authProfiles?.profiles) return authProfiles;
  
  for (const [profileId, profile] of Object.entries(authProfiles.profiles)) {
    if (profile && typeof profile === 'object') {
      // Encrypt apiKey field
      if (profile.apiKey) {
        profile.apiKey = encryptApiKey(profile.apiKey);
      }
      // Encrypt key field (alternative naming)
      if (profile.key) {
        profile.key = encryptApiKey(profile.key);
      }
      // Encrypt token field (some providers use token instead of key)
      if (profile.token && typeof profile.token === 'string' && profile.token.length > 20) {
        profile.token = encryptApiKey(profile.token);
      }
    }
  }
  return authProfiles;
}

/**
 * Decrypt all API key fields in an auth-profiles object.
 * Returns a deep clone with decrypted values (does NOT mutate original).
 */
function decryptAuthProfiles(authProfiles) {
  if (!authProfiles?.profiles) return authProfiles;
  
  // Deep clone to avoid mutating cached/stored data
  const cloned = JSON.parse(JSON.stringify(authProfiles));
  
  for (const [profileId, profile] of Object.entries(cloned.profiles)) {
    if (profile && typeof profile === 'object') {
      if (profile.apiKey) {
        profile.apiKey = decryptApiKey(profile.apiKey);
      }
      if (profile.key) {
        profile.key = decryptApiKey(profile.key);
      }
      if (profile.token && typeof profile.token === 'string' && isEncrypted(profile.token)) {
        profile.token = decryptApiKey(profile.token);
      }
    }
  }
  return cloned;
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
  isEncrypted,
  encryptAuthProfiles,
  decryptAuthProfiles,
  getMasterKey,
};
