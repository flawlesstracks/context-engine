'use strict';

// ---------------------------------------------------------------------------
// Base Connector Interface + Provider Registry (MECE-018)
//
// Every connector extends BaseConnector and implements the abstract methods.
// CONNECTOR_REGISTRY defines OAuth URLs, env var requirements, and source types.
// ---------------------------------------------------------------------------

const CONNECTOR_REGISTRY = {
  sharefile: {
    name: 'ShareFile',
    description: 'Cloud file sharing — sync folders as spokes, extract entities from documents',
    icon: 'folder-cloud',
    oauth: {
      authorize_url: 'https://secure.sharefile.com/oauth/authorize',
      // Token URL is dynamic: https://{subdomain}.sf-api.com/oauth/token
      token_url_template: 'https://{subdomain}.sf-api.com/oauth/token',
      scopes: [],
    },
    env_keys: ['SHAREFILE_CLIENT_ID', 'SHAREFILE_CLIENT_SECRET', 'SHAREFILE_SUBDOMAIN'],
    source_type: 'sharefile',
  },
  clio: {
    name: 'Clio',
    description: 'Law practice management — sync matters, contacts, documents (pending approval)',
    icon: 'scales',
    oauth: {
      authorize_url: 'https://app.clio.com/oauth/authorize',
      token_url: 'https://app.clio.com/oauth/token',
      deauthorize_url: 'https://app.clio.com/oauth/deauthorize',
      scopes: [],
    },
    env_keys: ['CLIO_CLIENT_ID', 'CLIO_CLIENT_SECRET'],
    source_type: 'clio',
  },
};

class BaseConnector {
  /**
   * @param {string} graphDir - Tenant graph directory
   * @param {string} connectionId - Connection ID from connections.json
   */
  constructor(graphDir, connectionId) {
    this.graphDir = graphDir;
    this.connectionId = connectionId;
  }

  /**
   * Validate the connection (e.g., call "who am I" API).
   * Called after OAuth callback to confirm tokens work.
   * @returns {Promise<{user_name?, user_id?}>}
   */
  async connect() {
    throw new Error('connect() not implemented');
  }

  /**
   * Full or incremental sync.
   * @param {object} options - Sync options
   * @param {function} writeEvent - NDJSON event writer: (eventObj) => void
   * @returns {Promise<{folders_synced?, files_processed?, entities_staged?}>}
   */
  async sync(options, writeEvent) {
    throw new Error('sync() not implemented');
  }

  /**
   * Disconnect: revoke tokens, delete connection, mark spokes stale.
   * @returns {Promise<{ok: boolean}>}
   */
  async disconnect() {
    throw new Error('disconnect() not implemented');
  }

  /**
   * Return connection health/status.
   * @returns {{connected: boolean, provider: string, last_sync_at?, sync_status?, sync_error?}}
   */
  getStatus() {
    throw new Error('getStatus() not implemented');
  }

  /**
   * Handle incoming webhook from this provider.
   * @param {object} headers - Request headers
   * @param {object} body - Request body
   * @returns {Promise<{handshake?: boolean, processed?: boolean}>}
   */
  async handleWebhook(headers, body) {
    throw new Error('handleWebhook() not implemented');
  }

  /**
   * Execute a function with automatic token refresh on 401.
   * Pattern from src/drive.js:175-188.
   * @param {function} fn - async (accessToken) => result
   * @returns {Promise<any>}
   */
  async withTokenRefresh(fn) {
    const { getConnectionDecrypted, updateConnectionTokens } = require('../connector-ops');
    const { refreshAccessToken } = require('./oauth-handler');

    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);
    if (!conn) throw new Error('Connection not found: ' + this.connectionId);

    try {
      return await fn(conn.tokens.access_token);
    } catch (err) {
      const is401 = err.status === 401 || err.statusCode === 401 ||
        (err.response && err.response.status === 401) ||
        (err.message && err.message.includes('401'));

      if (is401 && conn.tokens.refresh_token) {
        const refreshed = await refreshAccessToken(conn.provider, conn.tokens.refresh_token);
        updateConnectionTokens(
          this.graphDir,
          this.connectionId,
          refreshed.access_token,
          refreshed.refresh_token || null
        );
        return await fn(refreshed.access_token);
      }
      throw err;
    }
  }
}

/**
 * Factory: get the connector class for a provider.
 * @param {string} provider
 * @returns {class|null}
 */
function getConnectorClass(provider) {
  switch (provider) {
    case 'sharefile': return require('./sharefile-connector');
    case 'clio': return require('./clio-connector');
    default: return null;
  }
}

/**
 * List registered providers with configuration status.
 * @returns {Array<{provider, name, description, icon, configured}>}
 */
function getRegisteredProviders() {
  return Object.entries(CONNECTOR_REGISTRY).map(([key, reg]) => ({
    provider: key,
    name: reg.name,
    description: reg.description,
    icon: reg.icon,
    configured: reg.env_keys.every(k => !!process.env[k]),
  }));
}

module.exports = {
  BaseConnector,
  CONNECTOR_REGISTRY,
  getConnectorClass,
  getRegisteredProviders,
};
