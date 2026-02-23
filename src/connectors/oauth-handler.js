'use strict';

const crypto = require('crypto');
const { CONNECTOR_REGISTRY } = require('./base-connector');

// ---------------------------------------------------------------------------
// Shared OAuth 2.0 Flow Handler (MECE-018)
//
// Generic across all providers. Handles authorize URL generation,
// HMAC-signed state for CSRF protection, code-for-token exchange,
// and token refresh. Follows pattern from src/auth.js.
// ---------------------------------------------------------------------------

const OAUTH_STATE_COOKIE = 'ca_connector_state';

/**
 * Build the OAuth authorize URL for a provider.
 * State is HMAC-signed to encode provider + tenant_id + CSRF nonce.
 *
 * @param {string} provider - e.g., 'sharefile', 'clio'
 * @param {string} redirectUri - Callback URL
 * @param {string} tenantId - Tenant ID to encode in state
 * @returns {{ url: string, state: string }}
 */
function buildAuthorizeUrl(provider, redirectUri, tenantId) {
  const reg = CONNECTOR_REGISTRY[provider];
  if (!reg) throw new Error('Unknown provider: ' + provider);

  const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  if (!clientId) {
    throw new Error(`${provider} not configured: missing ${provider.toUpperCase()}_CLIENT_ID`);
  }

  // Build HMAC-signed state (CSRF + provider + tenant)
  const statePayload = {
    provider,
    tenant_id: tenantId,
    csrf: crypto.randomBytes(16).toString('hex'),
    ts: Date.now(),
  };
  const stateJson = JSON.stringify(statePayload);
  const stateB64 = Buffer.from(stateJson).toString('base64url');
  const hmac = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-fallback')
    .update(stateB64).digest('hex');
  const state = stateB64 + '.' + hmac;

  // Build authorize URL
  const authorizeUrl = reg.oauth.authorize_url;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state,
  });

  // Add scopes if defined
  if (reg.oauth.scopes && reg.oauth.scopes.length > 0) {
    params.set('scope', reg.oauth.scopes.join(' '));
  }

  return {
    url: authorizeUrl + '?' + params.toString(),
    state,
  };
}

/**
 * Validate and decode the HMAC-signed state parameter.
 * Rejects if signature invalid or older than 10 minutes.
 *
 * @param {string} stateParam - The full state string from callback
 * @returns {{ provider: string, tenant_id: string, csrf: string, ts: number }}
 */
function validateState(stateParam) {
  if (!stateParam || !stateParam.includes('.')) {
    throw new Error('Invalid OAuth state format');
  }

  const dotIndex = stateParam.lastIndexOf('.');
  const b64 = stateParam.slice(0, dotIndex);
  const hmac = stateParam.slice(dotIndex + 1);

  const expectedHmac = crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev-fallback')
    .update(b64).digest('hex');

  const hmacBuf = Buffer.from(hmac, 'hex');
  const expectedBuf = Buffer.from(expectedHmac, 'hex');
  if (hmacBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(hmacBuf, expectedBuf)) {
    throw new Error('Invalid OAuth state signature');
  }

  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());

  // Reject expired state (>10 minutes)
  if (Date.now() - payload.ts > 10 * 60 * 1000) {
    throw new Error('OAuth state expired');
  }

  return payload;
}

/**
 * Resolve the token URL for a provider.
 * ShareFile uses a dynamic subdomain-based URL.
 */
function getTokenUrl(provider) {
  const reg = CONNECTOR_REGISTRY[provider];
  if (!reg) throw new Error('Unknown provider: ' + provider);

  // ShareFile: dynamic URL based on subdomain
  if (provider === 'sharefile') {
    const subdomain = process.env.SHAREFILE_SUBDOMAIN;
    if (!subdomain) throw new Error('SHAREFILE_SUBDOMAIN not set');
    return reg.oauth.token_url_template.replace('{subdomain}', subdomain);
  }

  return reg.oauth.token_url;
}

/**
 * Exchange an authorization code for tokens.
 * POST to provider's token URL with x-www-form-urlencoded body.
 *
 * @param {string} provider
 * @param {string} code - Authorization code from callback
 * @param {string} redirectUri - Must match the one used in authorize
 * @returns {Promise<{ access_token, refresh_token, expires_in, token_type, subdomain?, apicp? }>}
 */
async function exchangeCodeForTokens(provider, code, redirectUri) {
  const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`${provider} credentials not configured`);
  }

  const tokenUrl = getTokenUrl(provider);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

/**
 * Refresh an access token using a refresh token.
 *
 * @param {string} provider
 * @param {string} refreshToken
 * @returns {Promise<{ access_token, refresh_token?, expires_in }>}
 */
async function refreshAccessToken(provider, refreshToken) {
  const clientId = process.env[`${provider.toUpperCase()}_CLIENT_ID`];
  const clientSecret = process.env[`${provider.toUpperCase()}_CLIENT_SECRET`];

  if (!clientId || !clientSecret) {
    throw new Error(`${provider} credentials not configured`);
  }

  const tokenUrl = getTokenUrl(provider);

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  return resp.json();
}

module.exports = {
  buildAuthorizeUrl,
  validateState,
  exchangeCodeForTokens,
  refreshAccessToken,
  getTokenUrl,
  OAUTH_STATE_COOKIE,
};
