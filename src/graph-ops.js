'use strict';

const fs = require('fs');
const path = require('path');

const IS_PRODUCTION = process.env.RENDER || process.env.NODE_ENV === 'production';
const LOCAL_GRAPH_DIR = path.join(__dirname, '..', 'watch-folder', 'graph');

function resolveGraphDir() {
  if (!IS_PRODUCTION) return { graphDir: LOCAL_GRAPH_DIR, persistent: false };

  const candidates = [
    process.env.RENDER_DISK_PATH && path.join(process.env.RENDER_DISK_PATH, 'graph'),
    '/var/data/graph',
    '/data/graph',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parentDir = path.dirname(candidate);
      if (!fs.existsSync(parentDir)) continue;
      if (!fs.existsSync(candidate)) fs.mkdirSync(candidate, { recursive: true });
      const testFile = path.join(candidate, '.write-test');
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);
      return { graphDir: candidate, persistent: true };
    } catch {
      continue;
    }
  }

  return { graphDir: LOCAL_GRAPH_DIR, persistent: false };
}

function getSelfEntityId(graphDir) {
  const d = graphDir || LOCAL_GRAPH_DIR;
  // Extract tenant ID from path: .../tenant-eefc79c7 → eefc79c7
  const dirName = path.basename(d);
  const tenantMatch = dirName.match(/^tenant-([a-f0-9]+)$/);
  if (!tenantMatch) return null;
  const tenantId = tenantMatch[1];
  // Read tenants.config.json from parent directory (config-only, no secrets)
  const tenantsPath = path.join(path.dirname(d), 'tenants.config.json');
  try {
    const tenants = JSON.parse(fs.readFileSync(tenantsPath, 'utf-8'));
    return (tenants[tenantId] && tenants[tenantId].self_entity_id) || null;
  } catch { return null; }
}

function isSelfEntity(entityId, graphDir) {
  if (!entityId) return false;
  const selfId = getSelfEntityId(graphDir);
  return selfId !== null && entityId === selfId;
}

function readEntity(entityId, dir) {
  const d = dir || LOCAL_GRAPH_DIR;
  const filePath = path.join(d, `${entityId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeEntity(entityId, data, dir) {
  const d = dir || LOCAL_GRAPH_DIR;
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${entityId}.json`), JSON.stringify(data, null, 2) + '\n');
}

function listEntities(dir) {
  const d = dir || LOCAL_GRAPH_DIR;
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter(f => f.endsWith('.json') && f !== '_counter.json' && f !== 'tenants.json' && f !== 'tenants.config.json' && f !== 'tenants.state.json' && f !== 'shares.json')
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(d, f), 'utf-8'));
        return { file: f, data };
      } catch { return null; }
    })
    .filter(Boolean);
}

function getNextCounter(dir, entityType) {
  const counterPath = path.join(dir, '_counter.json');
  let counters = { person: 1, business: 1, institution: 1, role: 1, organization: 1, credential: 1, skill: 1 };
  if (fs.existsSync(counterPath)) {
    counters = JSON.parse(fs.readFileSync(counterPath, 'utf-8'));
  }
  const seq = counters[entityType] || 1;
  counters[entityType] = seq + 1;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(counterPath, JSON.stringify(counters, null, 2) + '\n');
  return seq;
}

function listEntitiesByType(dir, type) {
  return listEntities(dir).filter(({ data }) => {
    return (data.entity || {}).entity_type === type;
  });
}

function loadConnectedObjects(entityId, dir) {
  const entity = readEntity(entityId, dir);
  if (!entity) return null;

  const connected = [];
  for (const ref of (entity.connected_objects || [])) {
    const obj = readEntity(ref.entity_id, dir);
    if (obj) {
      connected.push({
        entity_id: ref.entity_id,
        entity_type: ref.entity_type,
        label: ref.label,
        data: obj,
      });
    }
  }

  return { entity, connected };
}

function deleteEntity(entityId, dir) {
  const d = dir || LOCAL_GRAPH_DIR;
  if (isSelfEntity(entityId, d)) return { deleted: false, error: 'self_entity_protected' };
  const filePath = path.join(d, `${entityId}.json`);
  if (!fs.existsSync(filePath)) return { deleted: false, error: 'not_found' };

  // Read entity to find connected objects to clean up
  let connected = [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    connected = (data.connected_objects || []).map(c => c.entity_id).filter(Boolean);
  } catch { /* proceed with delete even if parse fails */ }

  // Delete the entity file
  fs.unlinkSync(filePath);

  // Delete connected objects (roles, credentials, skills)
  const deletedConnected = [];
  for (const connId of connected) {
    const connPath = path.join(d, `${connId}.json`);
    if (fs.existsSync(connPath)) {
      fs.unlinkSync(connPath);
      deletedConnected.push(connId);
    }
  }

  return { deleted: true, entity_id: entityId, connected_deleted: deletedConnected };
}

module.exports = { readEntity, writeEntity, listEntities, listEntitiesByType, getNextCounter, resolveGraphDir, loadConnectedObjects, deleteEntity, getSelfEntityId, isSelfEntity, LOCAL_GRAPH_DIR };
