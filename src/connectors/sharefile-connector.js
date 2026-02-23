'use strict';

const { BaseConnector } = require('./base-connector');
const { getConnectionDecrypted, updateConnection, updateConnectionTokens } = require('../connector-ops');
const { refreshAccessToken } = require('./oauth-handler');
const { createSpoke, loadSpokes, updateSpoke } = require('../spoke-ops');
const { stageAndScoreExtraction } = require('../signalStaging');
const { parse: universalParse } = require('../../universal-parser');

// ---------------------------------------------------------------------------
// ShareFile Connector (MECE-018)
//
// ShareFile is folder/file-centric — no structured contacts or matters.
// All intelligence comes from extracting entities from downloaded documents.
//
// Flow: connect → browseFolders → mapFoldersToSpokes → sync (download + parse)
//
// API: https://{subdomain}.sf-api.com/sf/v3/
// Auth: Bearer token in Authorization header
// Pagination: OData $top and $skip
// Download: GET Items(id)/Download → 302 redirect
// ---------------------------------------------------------------------------

// Rate limiting: ShareFile doesn't publish strict limits,
// but we pace at ~2 req/sec to be respectful
const RATE_LIMIT_DELAY = 500;

class ShareFileConnector extends BaseConnector {
  constructor(graphDir, connectionId) {
    super(graphDir, connectionId);
    this.provider = 'sharefile';
  }

  /**
   * Build the API base URL from connection config.
   */
  _getApiBase(config) {
    const subdomain = config?.subdomain || process.env.SHAREFILE_SUBDOMAIN;
    const apicp = config?.apicp || 'sf-api.com';
    if (!subdomain) throw new Error('ShareFile subdomain not configured');
    return `https://${subdomain}.${apicp}/sf/v3`;
  }

  /**
   * Make an authenticated ShareFile API call with rate limiting.
   */
  async _sfFetch(apiBase, endpoint, token, options = {}) {
    const url = `${apiBase}${endpoint}`;
    const resp = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        ...(options.headers || {}),
      },
    });

    // Handle rate limiting (429)
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('retry-after') || '60', 10);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return this._sfFetch(apiBase, endpoint, token, options);
    }

    if (!resp.ok) {
      const err = new Error(`ShareFile API error: ${resp.status} ${resp.statusText}`);
      err.status = resp.status;
      throw err;
    }

    // Download endpoints return redirect or binary
    if (options.rawResponse) return resp;

    return resp.json();
  }

  /**
   * Validate connection by calling Users endpoint.
   */
  async connect() {
    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);
    if (!conn) throw new Error('Connection not found');

    const apiBase = this._getApiBase(conn.config);

    return this.withTokenRefresh(async (token) => {
      const data = await this._sfFetch(apiBase, '/Users', token);
      // ShareFile returns the authenticated user info
      const user = data.value ? data.value[0] : data;
      return {
        user_name: user.FullName || user.Name || user.Email || 'ShareFile User',
        user_id: user.Id,
        email: user.Email,
      };
    });
  }

  /**
   * Browse folders in ShareFile for spoke mapping.
   * @param {string} parentId - Folder ID or 'home' for root
   * @returns {Promise<Array<{id, name, children_count, path, created_at}>>}
   */
  async browseFolders(parentId) {
    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);
    if (!conn) throw new Error('Connection not found');

    const apiBase = this._getApiBase(conn.config);
    const itemId = parentId || 'home';

    return this.withTokenRefresh(async (token) => {
      const data = await this._sfFetch(
        apiBase,
        `/Items(${itemId})/Children?$select=Id,Name,ChildrenCount,CreationDate,ProgenyEditDate&$orderby=Name`,
        token
      );

      const items = data.value || [];
      // Filter to folders only (ShareFile uses odata.type or StreamID absence)
      return items
        .filter(item => item.ChildrenCount !== undefined || !item.StreamID)
        .map(item => ({
          id: item.Id,
          name: item.Name,
          children_count: item.ChildrenCount || 0,
          created_at: item.CreationDate,
          updated_at: item.ProgenyEditDate,
        }));
    });
  }

  /**
   * Map selected folders to spokes.
   * @param {Array<{folder_id, folder_name, spoke_name?}>} folderMappings
   * @returns {{mapped: number, spokes: Array<{id, name, external_id}>}}
   */
  mapFoldersToSpokes(folderMappings) {
    if (!folderMappings || folderMappings.length === 0) {
      throw new Error('No folders provided for mapping');
    }

    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);
    if (!conn) throw new Error('Connection not found');

    const results = [];
    const folderMap = conn.sync_cursor?.folder_map || {};

    for (const mapping of folderMappings) {
      const { folder_id, folder_name, spoke_name } = mapping;
      const externalId = `sf:folder:${folder_id}`;

      // Check if this folder is already mapped
      if (folderMap[folder_id]) {
        results.push({
          id: folderMap[folder_id].spoke_id,
          name: folderMap[folder_id].spoke_name,
          external_id: externalId,
          already_mapped: true,
        });
        continue;
      }

      // Check if spoke already exists for this external_id
      const spokes = loadSpokes(this.graphDir);
      const existing = Object.values(spokes).find(s => s.external_id === externalId);

      let spoke;
      if (existing) {
        spoke = existing;
      } else {
        spoke = createSpoke(this.graphDir, {
          name: spoke_name || folder_name,
          description: `ShareFile folder: ${folder_name}`,
          source: 'sharefile',
          external_id: externalId,
          sync_status: 'synced',
        });
      }

      // Store mapping in sync_cursor
      folderMap[folder_id] = {
        spoke_id: spoke.id,
        spoke_name: spoke.name,
        last_sync_at: null,
      };

      results.push({
        id: spoke.id,
        name: spoke.name,
        external_id: externalId,
        already_mapped: false,
      });
    }

    // Save updated folder map
    updateConnection(this.graphDir, this.connectionId, {
      sync_cursor: { ...conn.sync_cursor, folder_map: folderMap },
    });

    return { mapped: results.filter(r => !r.already_mapped).length, spokes: results };
  }

  /**
   * Sync: download files from mapped folders → universal parse → signal staging.
   * Streams NDJSON progress events via writeEvent callback.
   *
   * @param {object} options - { folder_ids?: string[] } to sync specific folders
   * @param {function} writeEvent - (eventObj) => void for NDJSON streaming
   */
  async sync(options, writeEvent) {
    const write = writeEvent || (() => {});
    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);
    if (!conn) throw new Error('Connection not found');

    const apiBase = this._getApiBase(conn.config);
    const folderMap = conn.sync_cursor?.folder_map || {};

    if (Object.keys(folderMap).length === 0) {
      write({ type: 'error', message: 'No folders mapped. Use /api/connection/:id/map-folders first.' });
      return { folders_synced: 0, files_processed: 0, entities_staged: 0 };
    }

    // Filter to requested folders or sync all
    const targetFolders = options?.folder_ids
      ? Object.entries(folderMap).filter(([fid]) => options.folder_ids.includes(fid))
      : Object.entries(folderMap);

    updateConnection(this.graphDir, this.connectionId, {
      sync_status: 'syncing',
      sync_error: null,
    });

    const results = {
      folders_synced: 0,
      files_processed: 0,
      entities_staged: 0,
      errors: [],
    };

    try {
      const totalFolders = targetFolders.length;

      for (let fi = 0; fi < totalFolders; fi++) {
        const [folderId, folderInfo] = targetFolders[fi];
        const spokeName = folderInfo.spoke_name;
        const spokeId = folderInfo.spoke_id;

        write({
          type: 'progress',
          phase: 'folders',
          folder: spokeName,
          current: fi + 1,
          total: totalFolders,
        });

        try {
          // List files in this folder
          const filesResult = await this.withTokenRefresh(async (token) => {
            return this._sfFetch(
              apiBase,
              `/Items(${folderId})/Children?$select=Id,Name,FileSizeBytes,CreationDate&$top=200`,
              token
            );
          });

          const files = (filesResult.value || []).filter(item =>
            item.Name && !item.Name.startsWith('.') && item.FileSizeBytes > 0
          );

          const totalFiles = files.length;

          for (let i = 0; i < totalFiles; i++) {
            const file = files[i];

            write({
              type: 'progress',
              phase: 'files',
              folder: spokeName,
              current: i + 1,
              total: totalFiles,
              filename: file.Name,
            });

            try {
              // Download file
              const buffer = await this._downloadFile(apiBase, file.Id);

              if (buffer && buffer.length > 0) {
                // Parse with universal parser
                const parseResult = await universalParse(buffer, file.Name);

                if (parseResult && parseResult.entities && parseResult.entities.length > 0) {
                  // Convert parser output to v2 entities for staging
                  const v2Entities = this._convertToV2Entities(parseResult.entities, spokeId, file);

                  const source = {
                    type: 'sharefile',
                    url: `sharefile://item/${file.Id}`,
                    description: `ShareFile document: ${file.Name} (${spokeName})`,
                  };

                  const staged = stageAndScoreExtraction(v2Entities, source, this.graphDir);
                  results.entities_staged += staged.length;

                  write({
                    type: 'progress',
                    phase: 'extract',
                    folder: spokeName,
                    filename: file.Name,
                    entities_found: staged.length,
                  });
                }
              }

              results.files_processed++;
            } catch (fileErr) {
              results.errors.push({ file: file.Name, folder: spokeName, error: fileErr.message });
              write({ type: 'warning', message: `Failed to process ${file.Name}: ${fileErr.message}` });
            }

            await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
          }

          // Update folder sync timestamp
          folderMap[folderId].last_sync_at = new Date().toISOString();
          results.folders_synced++;

        } catch (folderErr) {
          results.errors.push({ folder: spokeName, error: folderErr.message });
          write({ type: 'warning', message: `Failed to sync folder ${spokeName}: ${folderErr.message}` });
        }
      }

      // Save updated folder map with sync timestamps
      updateConnection(this.graphDir, this.connectionId, {
        sync_status: 'idle',
        sync_error: null,
        last_sync_at: new Date().toISOString(),
        sync_cursor: { ...conn.sync_cursor, folder_map: folderMap, last_full_sync: new Date().toISOString() },
      });

      write({ type: 'complete', results });
      return results;

    } catch (err) {
      updateConnection(this.graphDir, this.connectionId, {
        sync_status: 'error',
        sync_error: err.message,
      });
      write({ type: 'error', message: err.message });
      throw err;
    }
  }

  /**
   * Download a file from ShareFile.
   * GET Items(id)/Download → follows 302 redirect → returns Buffer.
   */
  async _downloadFile(apiBase, fileId) {
    return this.withTokenRefresh(async (token) => {
      // First, get the download URL (ShareFile returns 302 or DownloadSpecification)
      const resp = await fetch(`${apiBase}/Items(${fileId})/Download?redirect=false`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      });

      if (!resp.ok) {
        throw Object.assign(new Error(`Download failed: ${resp.status}`), { status: resp.status });
      }

      const spec = await resp.json();
      const downloadUrl = spec.DownloadUrl || spec.DownloadToken;

      if (!downloadUrl) {
        // Try direct download with redirect
        const directResp = await fetch(`${apiBase}/Items(${fileId})/Download`, {
          headers: { 'Authorization': `Bearer ${token}` },
          redirect: 'follow',
        });
        if (!directResp.ok) throw new Error(`Direct download failed: ${directResp.status}`);
        return Buffer.from(await directResp.arrayBuffer());
      }

      // Download from the URL
      const dlResp = await fetch(downloadUrl);
      if (!dlResp.ok) throw new Error(`File download failed: ${dlResp.status}`);
      return Buffer.from(await dlResp.arrayBuffer());
    });
  }

  /**
   * Convert universal parser entities to v2 schema for signal staging.
   */
  _convertToV2Entities(entities, spokeId, file) {
    const now = new Date().toISOString();

    return entities.map(ent => {
      const entityType = (ent.type || 'person').toLowerCase();
      const mappedType = entityType === 'organization' || entityType === 'org' || entityType === 'company'
        ? 'business' : entityType === 'person' ? 'person' : 'business';

      return {
        schema_version: '2.0',
        schema_type: 'context_architecture_entity',
        extraction_metadata: {
          extracted_at: now,
          updated_at: now,
          source_description: `sharefile:${file.Name}`,
          extraction_confidence: ent.confidence || 0.7,
        },
        entity: {
          entity_type: mappedType,
          name: mappedType === 'person'
            ? { full: ent.name, confidence: ent.confidence || 0.7 }
            : { common: ent.name, confidence: ent.confidence || 0.7 },
          summary: { value: ent.evidence || '', confidence: 0.5, facts_layer: 2 },
        },
        attributes: (ent.attributes || []).map(a => ({
          key: a.key || a.attribute,
          value: a.value,
          confidence: a.confidence || 0.7,
          confidence_label: 'MODERATE',
          source_attribution: {
            type: 'sharefile',
            url: `sharefile://item/${file.Id}`,
            extracted_at: now,
            facts_layer: 2,
          },
        })),
        relationships: (ent.relationships || []).map(r => ({
          name: r.target || r.name,
          relationship_type: r.type || r.relationship_type || 'associated',
          context: r.context || '',
          confidence: r.confidence || 0.5,
        })),
        observations: [{
          observation: `Extracted from ShareFile document: ${file.Name}`,
          observed_at: now,
          source: 'sharefile',
          confidence_label: 'MODERATE',
          facts_layer: 2,
        }],
        provenance_chain: {
          created_at: now,
          created_by: 'sharefile-connector',
          source_documents: [{ source: `sharefile:${file.Name}`, ingested_at: now }],
          merge_history: [],
        },
        spoke_id: spokeId,
        source: 'sharefile',
        source_ref: `sf:file:${file.Id}`,
      };
    });
  }

  /**
   * Disconnect: delete connection, mark spokes stale.
   */
  async disconnect() {
    const { deleteConnection } = require('../connector-ops');
    const conn = getConnectionDecrypted(this.graphDir, this.connectionId);

    // Mark all mapped spokes as stale
    if (conn?.sync_cursor?.folder_map) {
      for (const mapping of Object.values(conn.sync_cursor.folder_map)) {
        try {
          updateSpoke(this.graphDir, mapping.spoke_id, { sync_status: 'stale' });
        } catch {}
      }
    }

    deleteConnection(this.graphDir, this.connectionId);
    return { ok: true };
  }

  /**
   * Connection health status.
   */
  getStatus() {
    const { getConnection } = require('../connector-ops');
    const conn = getConnection(this.graphDir, this.connectionId);
    if (!conn) return { connected: false };

    const folderMap = conn.sync_cursor?.folder_map || {};
    return {
      connected: conn.status === 'connected',
      provider: 'sharefile',
      display_name: conn.display_name,
      last_sync_at: conn.last_sync_at,
      sync_status: conn.sync_status,
      sync_error: conn.sync_error,
      folders_mapped: Object.keys(folderMap).length,
    };
  }

  /**
   * ShareFile doesn't have a standard webhook system like Clio.
   * This is a no-op placeholder.
   */
  async handleWebhook(headers, body) {
    return { processed: false, message: 'ShareFile webhooks not supported' };
  }
}

module.exports = ShareFileConnector;
