'use strict';

const { google } = require('googleapis');

// MIME types our parsers support
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/vnd.ms-excel',                                                // .xls
  'text/csv',
  'text/plain',
  'text/markdown',
]);

// Google-native types we can export
const GOOGLE_EXPORT_MAP = {
  'application/vnd.google-apps.document': {
    exportMime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
  },
  'application/vnd.google-apps.spreadsheet': {
    exportMime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx',
  },
};

// Folder type
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function buildOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
}

function getAuthedClient(accessToken) {
  const client = buildOAuth2Client();
  client.setCredentials({ access_token: accessToken });
  return client;
}

/**
 * Refresh an expired access token using the refresh token.
 * Returns the new access_token string.
 */
async function refreshAccessToken(refreshToken) {
  const client = buildOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return credentials.access_token;
}

/**
 * List files in a Drive folder (or root).
 * Returns folders + supported file types.
 */
async function listFiles(accessToken, folderId) {
  const auth = getAuthedClient(accessToken);
  const drive = google.drive({ version: 'v3', auth });

  const parent = folderId || 'root';

  // Build mimeType query: folders + supported files + google-native exportable
  const mimeQueries = [
    `mimeType = '${FOLDER_MIME}'`,
    ...[...SUPPORTED_MIME_TYPES].map(m => `mimeType = '${m}'`),
    ...Object.keys(GOOGLE_EXPORT_MAP).map(m => `mimeType = '${m}'`),
  ];

  const q = `'${parent}' in parents and trashed = false and (${mimeQueries.join(' or ')})`;

  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, size, modifiedTime)',
    orderBy: 'folder,name',
    pageSize: 200,
  });

  return (res.data.files || []).map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    size: f.size ? parseInt(f.size, 10) : 0,
    modifiedTime: f.modifiedTime || '',
    isFolder: f.mimeType === FOLDER_MIME,
    isGoogleNative: !!GOOGLE_EXPORT_MAP[f.mimeType],
  }));
}

/**
 * Download a file from Drive as a Buffer.
 * Google Docs → export as DOCX; Google Sheets → export as XLSX.
 * Regular files → direct download.
 * Returns { buffer, filename } where filename has the correct extension.
 */
async function downloadFile(accessToken, fileId) {
  const auth = getAuthedClient(accessToken);
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata to determine type
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType',
  });

  const { name, mimeType } = meta.data;
  const exportInfo = GOOGLE_EXPORT_MAP[mimeType];

  let buffer;
  let filename = name;

  if (exportInfo) {
    // Google-native file — export
    const res = await drive.files.export(
      { fileId, mimeType: exportInfo.exportMime },
      { responseType: 'arraybuffer' },
    );
    buffer = Buffer.from(res.data);
    // Ensure correct extension
    if (!filename.endsWith(exportInfo.ext)) {
      filename = filename + exportInfo.ext;
    }
  } else {
    // Regular file — direct download
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );
    buffer = Buffer.from(res.data);
  }

  return { buffer, filename };
}

/**
 * Wrapper that retries on 401 (expired token) by refreshing the token once.
 * Returns { result, newAccessToken } where newAccessToken is set if refreshed.
 */
async function withTokenRefresh(fn, accessToken, refreshToken) {
  try {
    const result = await fn(accessToken);
    return { result, newAccessToken: null };
  } catch (err) {
    if (err.code === 401 || err.status === 401 || (err.response && err.response.status === 401)) {
      if (!refreshToken) throw new Error('Access token expired and no refresh token available');
      const newToken = await refreshAccessToken(refreshToken);
      const result = await fn(newToken);
      return { result, newAccessToken: newToken };
    }
    throw err;
  }
}

module.exports = {
  listFiles,
  downloadFile,
  refreshAccessToken,
  withTokenRefresh,
  FOLDER_MIME,
  GOOGLE_EXPORT_MAP,
  SUPPORTED_MIME_TYPES,
};
