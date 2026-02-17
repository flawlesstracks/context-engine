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
    .filter(f => f.endsWith('.json') && f !== '_counter.json' && f !== 'tenants.json' && f !== 'shares.json')
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
  let counters = { person: 1, business: 1 };
  if (fs.existsSync(counterPath)) {
    counters = JSON.parse(fs.readFileSync(counterPath, 'utf-8'));
  }
  const seq = counters[entityType] || 1;
  counters[entityType] = seq + 1;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(counterPath, JSON.stringify(counters, null, 2) + '\n');
  return seq;
}

module.exports = { readEntity, writeEntity, listEntities, getNextCounter, resolveGraphDir, LOCAL_GRAPH_DIR };
