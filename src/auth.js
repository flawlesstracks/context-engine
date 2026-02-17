'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const express = require('express');

const router = express.Router();

const SESSION_COOKIE = 'ca_session';
const STATE_COOKIE = 'ca_oauth_state';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET env var is required');
  return secret;
}

function buildOAuth2Client(redirectUri) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
  );
}

function getRedirectUri(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}/auth/google/callback`;
}

function isSecure(req) {
  return req.secure || req.headers['x-forwarded-proto'] === 'https' || process.env.NODE_ENV === 'production';
}

// --- Tenant helpers (passed via mount options) ---
let _graphDir, _loadTenants, _saveTenants;

function init({ graphDir, loadTenants, saveTenants }) {
  _graphDir = graphDir;
  _loadTenants = loadTenants;
  _saveTenants = saveTenants;
}

/**
 * Extract session token from Bearer header or cookie.
 * Bearer header takes priority.
 */
function extractSessionToken(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return (req.cookies || {})[SESSION_COOKIE] || null;
}

// GET /auth/google — Start OAuth flow
router.get('/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = getRedirectUri(req);
  const oauth2Client = buildOAuth2Client(redirectUri);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSecure(req),
    sameSite: 'lax',
    maxAge: 5 * 60 * 1000, // 5 minutes
  });

  res.redirect(authUrl);
});

// GET /auth/google/callback — Handle OAuth callback
router.get('/google/callback', async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(503).send('Google OAuth not configured on server. <a href="/">Go back</a>');
  }

  try {
    const { code, state } = req.query;
    const savedState = req.cookies[STATE_COOKIE];

    // Validate CSRF state
    if (!state || !savedState || state !== savedState) {
      return res.status(403).send('Invalid OAuth state. Please try logging in again. <a href="/auth/google">Retry</a>');
    }
    res.clearCookie(STATE_COOKIE);

    if (!code) {
      return res.status(400).send('Missing authorization code. <a href="/auth/google">Retry</a>');
    }

    const redirectUri = getRedirectUri(req);
    const oauth2Client = buildOAuth2Client(redirectUri);

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    const { access_token, refresh_token, id_token } = tokens;

    // Decode id_token to get user info
    const idPayload = jwt.decode(id_token);
    if (!idPayload || !idPayload.sub) {
      return res.status(400).send('Failed to decode Google ID token. <a href="/auth/google">Retry</a>');
    }

    const { sub: googleSub, email, name, picture } = idPayload;

    // Look up or create tenant
    const tenants = _loadTenants();
    let tenant = Object.values(tenants).find(t => t.google_sub === googleSub);
    const now = new Date().toISOString();

    if (tenant) {
      // Existing user — update
      tenant.last_login = now;
      tenant.email = email;
      tenant.name = name;
      tenant.picture = picture;
      if (refresh_token) tenant.refresh_token = refresh_token;
      if (access_token) tenant.access_token = access_token;
      _saveTenants(tenants);
    } else {
      // New user — auto-create tenant
      const tenantId = crypto.randomBytes(4).toString('hex');
      const apiKey = 'ctx-' + crypto.randomBytes(16).toString('hex');
      const tenantDir = path.join(_graphDir, `tenant-${tenantId}`);
      if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });

      tenant = {
        tenant_id: tenantId,
        tenant_name: name || email,
        api_key: apiKey,
        created_at: now,
        created_by: 'google_oauth',
        google_sub: googleSub,
        email,
        name,
        picture,
        refresh_token: refresh_token || null,
        access_token: access_token || null,
        last_login: now,
      };

      tenants[tenantId] = tenant;
      _saveTenants(tenants);
    }

    // Sign session JWT
    const sessionPayload = {
      tenant_id: tenant.tenant_id,
      google_sub: googleSub,
      api_key: tenant.api_key,
      email,
      name,
      picture,
    };

    const sessionToken = jwt.sign(sessionPayload, getSessionSecret(), { expiresIn: SESSION_MAX_AGE_S });

    // Redirect to wiki with token in URL — sessionStorage picks it up client-side
    res.redirect('/wiki?session=' + encodeURIComponent(sessionToken));
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    console.error('  redirect_uri used:', getRedirectUri(req));
    res.status(500).send('Authentication failed: ' + err.message + '<br/><br/><a href="/auth/google">Retry</a>');
  }
});

// GET /auth/me — Return current session info
router.get('/me', (req, res) => {
  const token = extractSessionToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const payload = jwt.verify(token, getSessionSecret());
    res.json({
      tenant_id: payload.tenant_id,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    });
  } catch (err) {
    res.status(401).json({ error: 'Session expired or invalid' });
  }
});

// POST /auth/logout — Clear session
router.post('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

// --- Helper: verify session from Bearer header or cookie ---
function verifySession(req) {
  const token = extractSessionToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, getSessionSecret());
  } catch {
    return null;
  }
}

module.exports = { router, init, verifySession, extractSessionToken, SESSION_COOKIE };
