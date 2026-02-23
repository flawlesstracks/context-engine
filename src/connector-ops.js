'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Connector Operations — Connection Storage + Token Encryption (MECE-018)
//
// Each tenant has a connections.json file storing provider connections.
// Tokens are encrypted with AES-256-GCM using a key derived from SESSION_SECRET.
// Pattern mirrors src/spoke-ops.js for consistency.
// ---------------------------------------------------------------------------

const CONNECTIONS_FILENAME = 'connections.json';

// --- Token Encryption (AES-256-GCM) ---

function deriveEncryptionKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not set — cannot encrypt tokens');
  return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
}

function encryptToken(plaintext) {
  if (!plaintext) return null;
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return { ciphertext: encrypted, iv: iv.toString('hex'), tag };
}

function decryptToken(ciphertext, ivHex, tagHex) {
  if (!ciphertext || !ivHex || !tagHex) return null;
  const key = deriveEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// --- connections.json CRUD ---

function loadConnections(graphDir) {
  const connPath = path.join(graphDir, CONNECTIONS_FILENAME);
  if (!fs.existsSync(connPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(connPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveConnections(graphDir, connections) {
  if (!fs.existsSync(graphDir)) fs.mkdirSync(graphDir, { recursive: true });
  const connPath = path.join(graphDir, CONNECTIONS_FILENAME);
  fs.writeFileSync(connPath, JSON.stringify(connections, null, 2) + '\n');
}

/**
 * Create a new connection with encrypted tokens.
 * @param {string} graphDir
 * @param {object} opts - { provider, tokens: { access_token, refresh_token, token_type, expires_in }, display_name, config }
 * @returns {object} Connection with tokens redacted
 */
function createConnection(graphDir, opts) {
  const { provider, tokens, display_name, config } = opts;
  if (!provider) throw new Error('Provider is required');
  if (!tokens || !tokens.access_token) throw new Error('Access token is required');

  const connections = loadConnections(graphDir);
  const id = 'conn-' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();

  // Encrypt tokens
  const accessEnc = encryptToken(tokens.access_token);
  const refreshEnc = encryptToken(tokens.refresh_token);

  // Calculate expiry
  let expiresAt = null;
  if (tokens.expires_in) {
    expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  }

  const connection = {
    id,
    provider,
    status: 'connected',
    display_name: display_name || `${provider} connection`,
    tokens: {
      access_token_enc: accessEnc ? accessEnc.ciphertext : null,
      refresh_token_enc: refreshEnc ? refreshEnc.ciphertext : null,
      token_type: tokens.token_type || 'Bearer',
      expires_at: expiresAt,
      iv: accessEnc ? accessEnc.iv : null,
      tag: accessEnc ? accessEnc.tag : null,
      refresh_iv: refreshEnc ? refreshEnc.iv : null,
      refresh_tag: refreshEnc ? refreshEnc.tag : null,
    },
    config: config || {},
    sync_cursor: {},
    last_sync_at: null,
    sync_status: 'idle',
    sync_error: null,
    webhook_id: null,
    created_at: now,
    updated_at: now,
  };

  connections[id] = connection;
  saveConnections(graphDir, connections);
  return redactTokens(connection);
}

/**
 * Get a connection (tokens encrypted, not decrypted).
 */
function getConnection(graphDir, connectionId) {
  const connections = loadConnections(graphDir);
  return connections[connectionId] || null;
}

/**
 * Get a connection with tokens decrypted. Internal use only.
 */
function getConnectionDecrypted(graphDir, connectionId) {
  const conn = getConnection(graphDir, connectionId);
  if (!conn) return null;

  const t = conn.tokens || {};
  return {
    ...conn,
    tokens: {
      access_token: decryptToken(t.access_token_enc, t.iv, t.tag),
      refresh_token: decryptToken(t.refresh_token_enc, t.refresh_iv, t.refresh_tag),
      token_type: t.token_type,
      expires_at: t.expires_at,
    },
  };
}

/**
 * Update connection fields.
 */
function updateConnection(graphDir, connectionId, updates) {
  const connections = loadConnections(graphDir);
  if (!connections[connectionId]) return null;

  const allowed = ['display_name', 'config', 'sync_status', 'sync_error',
    'last_sync_at', 'sync_cursor', 'status', 'webhook_id'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      connections[connectionId][key] = updates[key];
    }
  }
  connections[connectionId].updated_at = new Date().toISOString();
  saveConnections(graphDir, connections);
  return connections[connectionId];
}

/**
 * Update encrypted tokens after a refresh.
 */
function updateConnectionTokens(graphDir, connectionId, newAccessToken, newRefreshToken) {
  const connections = loadConnections(graphDir);
  if (!connections[connectionId]) return null;

  if (newAccessToken) {
    const accessEnc = encryptToken(newAccessToken);
    connections[connectionId].tokens.access_token_enc = accessEnc.ciphertext;
    connections[connectionId].tokens.iv = accessEnc.iv;
    connections[connectionId].tokens.tag = accessEnc.tag;
  }
  if (newRefreshToken) {
    const refreshEnc = encryptToken(newRefreshToken);
    connections[connectionId].tokens.refresh_token_enc = refreshEnc.ciphertext;
    connections[connectionId].tokens.refresh_iv = refreshEnc.iv;
    connections[connectionId].tokens.refresh_tag = refreshEnc.tag;
  }

  connections[connectionId].updated_at = new Date().toISOString();
  saveConnections(graphDir, connections);
  return connections[connectionId];
}

/**
 * Delete a connection.
 */
function deleteConnection(graphDir, connectionId) {
  const connections = loadConnections(graphDir);
  if (!connections[connectionId]) return null;
  const deleted = connections[connectionId];
  delete connections[connectionId];
  saveConnections(graphDir, connections);
  return deleted;
}

/**
 * List all connections with tokens redacted.
 */
function listConnections(graphDir) {
  const connections = loadConnections(graphDir);
  return Object.values(connections).map(redactTokens);
}

/**
 * Strip encrypted token fields from a connection for safe API responses.
 */
function redactTokens(connection) {
  if (!connection) return connection;
  const { tokens, ...rest } = connection;
  return {
    ...rest,
    tokens: {
      token_type: tokens?.token_type || 'Bearer',
      expires_at: tokens?.expires_at || null,
      has_refresh_token: !!(tokens?.refresh_token_enc),
    },
  };
}

module.exports = {
  encryptToken,
  decryptToken,
  loadConnections,
  saveConnections,
  createConnection,
  getConnection,
  getConnectionDecrypted,
  updateConnection,
  updateConnectionTokens,
  deleteConnection,
  listConnections,
  redactTokens,
  CONNECTIONS_FILENAME,
};
