'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Spoke Operations — Heliocentric Hub-Spoke Architecture (MECE-015)
//
// Every tenant has a spokes.json file that stores spoke definitions.
// Each spoke has a "centered entity" — the sun everything orbits around.
// CJ's personal graph = default spoke (CJ as centered entity).
// A law firm client spoke = client entity as the center.
// ---------------------------------------------------------------------------

const SPOKES_FILENAME = 'spokes.json';

/**
 * Load all spokes for a tenant directory.
 * Auto-creates spokes.json with the default spoke if missing.
 */
function loadSpokes(graphDir) {
  const spokesPath = path.join(graphDir, SPOKES_FILENAME);
  if (!fs.existsSync(spokesPath)) {
    // Bootstrap: create default spoke
    const defaultSpoke = createDefaultSpoke(graphDir);
    const spokes = { default: defaultSpoke };
    saveSpokes(graphDir, spokes);
    return spokes;
  }
  try {
    return JSON.parse(fs.readFileSync(spokesPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Save spokes map to disk.
 */
function saveSpokes(graphDir, spokes) {
  if (!fs.existsSync(graphDir)) fs.mkdirSync(graphDir, { recursive: true });
  const spokesPath = path.join(graphDir, SPOKES_FILENAME);
  fs.writeFileSync(spokesPath, JSON.stringify(spokes, null, 2) + '\n');
}

/**
 * Create the default spoke, migrating self-entity → centered_entity.
 */
function createDefaultSpoke(graphDir) {
  // Resolve self-entity from self-entity.json or tenants.config.json
  let centeredEntityId = null;
  let centeredEntityName = null;

  // Check self-entity.json first
  const selfPath = path.join(graphDir, 'self-entity.json');
  try {
    if (fs.existsSync(selfPath)) {
      const cfg = JSON.parse(fs.readFileSync(selfPath, 'utf-8'));
      centeredEntityId = cfg.self_entity_id || null;
      centeredEntityName = cfg.self_entity_name || null;
    }
  } catch {}

  // Fallback: check tenants.config.json
  if (!centeredEntityId) {
    const dirName = path.basename(graphDir);
    const tenantMatch = dirName.match(/^tenant-([a-f0-9]+)$/);
    if (tenantMatch) {
      const tenantsPath = path.join(path.dirname(graphDir), 'tenants.config.json');
      try {
        if (fs.existsSync(tenantsPath)) {
          const tenants = JSON.parse(fs.readFileSync(tenantsPath, 'utf-8'));
          const tenant = tenants[tenantMatch[1]];
          if (tenant && tenant.self_entity_id) {
            centeredEntityId = tenant.self_entity_id;
            centeredEntityName = tenant.tenant_name || null;
          }
        }
      } catch {}
    }
  }

  // Try to resolve entity name if we have an ID but no name
  if (centeredEntityId && !centeredEntityName) {
    try {
      const entityPath = path.join(graphDir, `${centeredEntityId}.json`);
      if (fs.existsSync(entityPath)) {
        const data = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
        const e = data.entity || {};
        centeredEntityName = e.name?.full || e.name?.preferred || e.name?.common || centeredEntityId;
      }
    } catch {}
  }

  const now = new Date().toISOString();
  return {
    id: 'default',
    name: 'Default (Personal)',
    description: 'Personal knowledge graph — the default spoke',
    centered_entity_id: centeredEntityId,
    centered_entity_name: centeredEntityName,
    source: 'manual',
    external_id: null,
    sync_status: null,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Create a new spoke.
 * @param {string} graphDir - Tenant graph directory
 * @param {object} opts - { name, description, source?, centered_entity_id? }
 * @returns {object} The created spoke
 */
function createSpoke(graphDir, opts) {
  const { name, description, source, centered_entity_id } = opts;
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Spoke name is required');
  }

  const spokes = loadSpokes(graphDir);

  // Check duplicate name (case-insensitive)
  const lowerName = name.trim().toLowerCase();
  const duplicate = Object.values(spokes).find(s => s.name.toLowerCase() === lowerName);
  if (duplicate) {
    throw new Error(`Spoke "${name}" already exists`);
  }

  const id = 'spoke-' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();

  // Resolve centered entity name if ID provided
  let centeredEntityName = null;
  if (centered_entity_id) {
    try {
      const entityPath = path.join(graphDir, `${centered_entity_id}.json`);
      if (fs.existsSync(entityPath)) {
        const data = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
        const e = data.entity || {};
        centeredEntityName = e.name?.full || e.name?.preferred || e.name?.common || centered_entity_id;
      }
    } catch {}
  }

  const spoke = {
    id,
    name: name.trim(),
    description: (description || '').trim(),
    centered_entity_id: centered_entity_id || null,
    centered_entity_name: centeredEntityName,
    source: source || 'manual',
    external_id: opts.external_id || null,
    sync_status: opts.sync_status || null,
    created_at: now,
    updated_at: now,
  };

  spokes[id] = spoke;
  saveSpokes(graphDir, spokes);
  return spoke;
}

/**
 * Get a single spoke by ID.
 */
function getSpoke(graphDir, spokeId) {
  const spokes = loadSpokes(graphDir);
  return spokes[spokeId] || null;
}

/**
 * Update a spoke's fields.
 */
function updateSpoke(graphDir, spokeId, updates) {
  const spokes = loadSpokes(graphDir);
  if (!spokes[spokeId]) return null;

  const allowed = ['name', 'description', 'source', 'external_id', 'sync_status', 'template_type', 'gap_analysis', 'document_classification', 'files', 'shares', 'review_status', 'review_summary', 'events', 'recent_activity', 'form_state', 'form_submissions', 'conversation_sessions'];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      spokes[spokeId][key] = updates[key];
    }
  }
  spokes[spokeId].updated_at = new Date().toISOString();
  saveSpokes(graphDir, spokes);
  return spokes[spokeId];
}

/**
 * Set or change the centered entity for a spoke.
 */
function setCenteredEntity(graphDir, spokeId, entityId) {
  const spokes = loadSpokes(graphDir);
  if (!spokes[spokeId]) return null;

  let entityName = null;
  if (entityId) {
    try {
      const entityPath = path.join(graphDir, `${entityId}.json`);
      if (fs.existsSync(entityPath)) {
        const data = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
        const e = data.entity || {};
        entityName = e.name?.full || e.name?.preferred || e.name?.common || entityId;
      }
    } catch {}
  }

  spokes[spokeId].centered_entity_id = entityId || null;
  spokes[spokeId].centered_entity_name = entityName;
  spokes[spokeId].updated_at = new Date().toISOString();
  saveSpokes(graphDir, spokes);
  return spokes[spokeId];
}

/**
 * Delete a spoke. Rejects if entities exist unless force=true.
 * Cannot delete the default spoke.
 */
function deleteSpoke(graphDir, spokeId, force) {
  if (spokeId === 'default') {
    throw new Error('Cannot delete the default spoke');
  }

  const spokes = loadSpokes(graphDir);
  if (!spokes[spokeId]) return null;

  // Check for entities in this spoke (unless force)
  if (!force) {
    const count = countEntitiesInSpoke(graphDir, spokeId);
    if (count > 0) {
      throw new Error(`Spoke has ${count} entities. Use ?force=true to delete anyway.`);
    }
  }

  const deleted = spokes[spokeId];
  delete spokes[spokeId];
  saveSpokes(graphDir, spokes);
  return deleted;
}

/**
 * Count entities belonging to a specific spoke.
 */
function countEntitiesInSpoke(graphDir, spokeId) {
  if (!fs.existsSync(graphDir)) return 0;
  const files = fs.readdirSync(graphDir).filter(f =>
    f.startsWith('ENT-') && f.endsWith('.json')
  );
  let count = 0;
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(graphDir, f), 'utf-8'));
      const entitySpokeId = data.spoke_id || 'default';
      if (entitySpokeId === spokeId) count++;
    } catch {}
  }
  return count;
}

/**
 * Get entity counts per spoke.
 * Returns { spokeId: count, ... }
 */
function getEntityCountsBySpoke(graphDir) {
  const counts = {};
  if (!fs.existsSync(graphDir)) return counts;
  const files = fs.readdirSync(graphDir).filter(f =>
    f.startsWith('ENT-') && f.endsWith('.json')
  );
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(graphDir, f), 'utf-8'));
      const spokeId = data.spoke_id || 'default';
      counts[spokeId] = (counts[spokeId] || 0) + 1;
    } catch {}
  }
  return counts;
}

/**
 * List all spokes with entity counts and optional source filter.
 */
function listSpokesWithCounts(graphDir, sourceFilter) {
  const spokes = loadSpokes(graphDir);
  const counts = getEntityCountsBySpoke(graphDir);

  let result = Object.values(spokes).map(s => ({
    ...s,
    entity_count: counts[s.id] || 0,
  }));

  // Apply source filter if provided
  if (sourceFilter) {
    result = result.filter(s => s.source === sourceFilter);
  }

  // Sort: default first, then by created_at
  result.sort((a, b) => {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return 1;
    return new Date(a.created_at) - new Date(b.created_at);
  });

  return result;
}

/**
 * Migrate existing entities: add spoke_id: "default" where missing.
 * Also adds source and source_ref fields.
 * Returns count of entities migrated.
 */
function migrateEntitiesToSpokes(graphDir) {
  if (!fs.existsSync(graphDir)) return 0;
  const files = fs.readdirSync(graphDir).filter(f =>
    f.startsWith('ENT-') && f.endsWith('.json')
  );
  let migrated = 0;
  for (const f of files) {
    try {
      const filePath = path.join(graphDir, f);
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let changed = false;

      if (!data.spoke_id) {
        data.spoke_id = 'default';
        changed = true;
      }
      if (data.source === undefined) {
        data.source = null;
        changed = true;
      }
      if (data.source_ref === undefined) {
        data.source_ref = null;
        changed = true;
      }

      if (changed) {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
        migrated++;
      }
    } catch {}
  }
  return migrated;
}

/**
 * Find a spoke by its share token. Scans all tenant directories.
 * @param {string} graphDir - Root graph directory (parent of tenant-* dirs)
 * @param {string} token - Share token to look up
 * @returns {{ spoke: object, graphDir: string, share: object } | null}
 */
function findSpokeByShareToken(graphDir, token) {
  if (!token || !fs.existsSync(graphDir)) return null;
  try {
    const entries = fs.readdirSync(graphDir).filter(f => f.startsWith('tenant-'));
    for (const dir of entries) {
      const tenantDir = path.join(graphDir, dir);
      const spokesPath = path.join(tenantDir, SPOKES_FILENAME);
      if (!fs.existsSync(spokesPath)) continue;
      try {
        const spokes = JSON.parse(fs.readFileSync(spokesPath, 'utf-8'));
        for (const spoke of Object.values(spokes)) {
          const shares = spoke.shares || [];
          const share = shares.find(s => s.token === token);
          if (share) {
            return { spoke, graphDir: tenantDir, share };
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

module.exports = {
  loadSpokes,
  saveSpokes,
  createSpoke,
  getSpoke,
  updateSpoke,
  setCenteredEntity,
  deleteSpoke,
  countEntitiesInSpoke,
  getEntityCountsBySpoke,
  listSpokesWithCounts,
  migrateEntitiesToSpokes,
  findSpokeByShareToken,
  SPOKES_FILENAME,
};
