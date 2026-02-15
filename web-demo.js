#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { merge } = require('./merge-engine');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(express.json());

// --- Shared extraction logic ---

const PERSON_SCHEMA = `{
  "entity_type": "person",
  "name": { "full": "", "preferred": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "attributes": { "role": "", "location": "", "expertise": [] },
  "relationships": [{ "name": "", "relationship": "", "context": "" }],
  "values": [],
  "communication_style": { "tone": "", "preferences": [] },
  "active_projects": [{ "name": "", "status": "", "description": "" }],
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

const BUSINESS_SCHEMA = `{
  "entity_type": "business",
  "name": { "legal": "", "common": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "industry": "",
  "products_services": [],
  "key_people": [{ "name": "", "role": "", "context": "" }],
  "values": [],
  "customers": { "target": "", "segments": [] },
  "competitive_position": "",
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

function buildPrompt(type, text) {
  const schema = type === 'person' ? PERSON_SCHEMA : BUSINESS_SCHEMA;
  return `You are a structured data extraction engine. Given unstructured text about a ${type}, extract all relevant information into the following JSON structure. Fill in every field you can from the text. Leave fields as empty strings, empty arrays, or reasonable defaults if the information is not present. Do not invent information that is not in the text.

Output ONLY valid JSON, no markdown fences, no commentary.

JSON schema:
${schema}

Important:
- metadata.source should be "web-demo"
- metadata.generated should be the current timestamp in ISO 8601 format: "${new Date().toISOString()}"
- metadata.version should be "1.0"
- summary should be a 2-3 sentence synthesis of the most important information

Text to extract from:
---
${text}
---`;
}

async function callClaude(prompt) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text;
}

// --- Web UI extract endpoint (v2, no auth) ---

app.post('/extract', async (req, res) => {
  const { text, type } = req.body;

  if (!text || !type) {
    return res.status(400).json({ error: 'Missing text or type' });
  }
  if (!['person', 'business'].includes(type)) {
    return res.status(400).json({ error: 'Type must be person or business' });
  }

  try {
    const { execFile } = require('child_process');
    const tmpIn = path.join(__dirname, 'watch-folder', 'output', `_web_input_${Date.now()}.txt`);
    const tmpOut = path.join(__dirname, 'watch-folder', 'output', `_web_output_${Date.now()}.json`);

    fs.writeFileSync(tmpIn, text);

    await new Promise((resolve, reject) => {
      execFile('node', [
        path.join(__dirname, 'context-engine.js'),
        '--input', tmpIn, '--output', tmpOut, '--type', type, '--schema-version', '2.0',
      ], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
        timeout: 180000,
      }, (err) => err ? reject(err) : resolve());
    });

    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
    fs.unlinkSync(tmpIn);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Graph API ---

const IS_PRODUCTION = process.env.RENDER || process.env.NODE_ENV === 'production';
const PERSISTENT_GRAPH_DIR = '/var/data/graph';
const LOCAL_GRAPH_DIR = path.join(__dirname, 'watch-folder', 'graph');
const GRAPH_DIR = IS_PRODUCTION ? PERSISTENT_GRAPH_DIR : LOCAL_GRAPH_DIR;
const CONFIG_PATH = path.join(__dirname, 'watch-folder', 'config.json');

// Seed persistent disk from repo on first boot
if (IS_PRODUCTION) {
  if (!fs.existsSync(PERSISTENT_GRAPH_DIR)) {
    fs.mkdirSync(PERSISTENT_GRAPH_DIR, { recursive: true });
  }
  const existing = fs.readdirSync(PERSISTENT_GRAPH_DIR).filter(f => f.endsWith('.json'));
  if (existing.length === 0) {
    const seedFiles = fs.readdirSync(LOCAL_GRAPH_DIR).filter(f => f.endsWith('.json'));
    for (const file of seedFiles) {
      fs.copyFileSync(path.join(LOCAL_GRAPH_DIR, file), path.join(PERSISTENT_GRAPH_DIR, file));
    }
    console.log(`  Seeded ${seedFiles.length} entity file(s) to ${PERSISTENT_GRAPH_DIR}`);
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function readEntity(entityId) {
  const filePath = path.join(GRAPH_DIR, `${entityId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeEntity(entityId, data) {
  fs.writeFileSync(path.join(GRAPH_DIR, `${entityId}.json`), JSON.stringify(data, null, 2) + '\n');
}

function listEntities() {
  if (!fs.existsSync(GRAPH_DIR)) return [];
  return fs.readdirSync(GRAPH_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, f), 'utf-8'));
        return { file: f, data };
      } catch { return null; }
    })
    .filter(Boolean);
}

// Auth middleware
function apiAuth(req, res, next) {
  const config = loadConfig();
  const key = req.headers['x-context-api-key'];
  if (!key || key !== config.api_key) {
    return res.status(401).json({ error: 'Invalid or missing X-Context-API-Key header' });
  }
  req.agentId = req.headers['x-agent-id'] || 'external';
  next();
}

// GET /api/entity/:id — Full entity JSON
app.get('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.json(entity);
});

// GET /api/entity/:id/summary — Lightweight summary
app.get('/api/entity/:id/summary', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const e = entity.entity || {};
  const type = e.entity_type;
  let name = '';
  if (type === 'person') {
    name = e.name?.full || '';
  } else {
    name = e.name?.common || e.name?.legal || '';
  }

  res.json({
    entity_id: e.entity_id,
    entity_type: type,
    name,
    summary: e.summary?.value || '',
    confidence: entity.extraction_metadata?.extraction_confidence || null,
    last_updated: entity.extraction_metadata?.extracted_at || null,
    attributes_count: entity.attributes?.length || 0,
    relationships_count: entity.relationships?.length || 0,
    key_facts_count: entity.key_facts?.length || 0,
  });
});

// GET /api/entity/:id/context — Entity profile + top 20 weighted observations
app.get('/api/entity/:id/context', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const e = entity.entity || {};
  const type = e.entity_type;
  const name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  const now = Date.now();

  // Score and sort observations
  const observations = (entity.observations || []).map(obs => {
    const obsTime = new Date(obs.observed_at).getTime();
    const daysSince = Math.max(0, (now - obsTime) / (1000 * 60 * 60 * 24));
    const timeDecayFactor = Math.exp(-0.03 * daysSince);
    const relevanceWeight = (obs.confidence || 0) * timeDecayFactor;
    return { ...obs, days_since: Math.round(daysSince * 100) / 100, time_decay_factor: Math.round(timeDecayFactor * 1000) / 1000, relevance_weight: Math.round(relevanceWeight * 1000) / 1000 };
  });

  observations.sort((a, b) => b.relevance_weight - a.relevance_weight);
  const top20 = observations.slice(0, 20);
  const top5 = observations.slice(0, 5);

  // Build context summary
  const entitySummary = e.summary?.value || '';
  let contextSummary = entitySummary;
  if (top5.length > 0) {
    const obsText = top5.map((o, i) => `(${i + 1}) ${o.observation}`).join(' ');
    contextSummary += ' Recent observations: ' + obsText;
  }

  res.json({
    entity_id: e.entity_id,
    entity_type: type,
    name,
    entity_summary: entitySummary,
    context_summary: contextSummary,
    observation_count: (entity.observations || []).length,
    observations: top20,
    profile: {
      attributes_count: (entity.attributes || []).length,
      relationships_count: (entity.relationships || []).length,
      values_count: (entity.values || []).length,
      key_facts_count: (entity.key_facts || []).length,
      constraints_count: (entity.constraints || []).length,
      confidence: entity.extraction_metadata?.extraction_confidence || null,
    },
  });
});

// GET /api/search?q= — Fuzzy search entities
app.get('/api/search', apiAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const { similarity } = require('./merge-engine');
  const entities = listEntities();
  const results = [];

  for (const { data } of entities) {
    const e = data.entity || {};
    const type = e.entity_type;
    let name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
    let score = 0;

    // Check name similarity
    score = Math.max(score, similarity(q, name));

    // Check aliases
    const aliases = e.name?.aliases || [];
    for (const alias of aliases) {
      score = Math.max(score, similarity(q, alias));
    }

    // Check attributes for keyword match
    for (const attr of (data.attributes || [])) {
      if ((attr.value || '').toLowerCase().includes(q)) {
        score = Math.max(score, 0.6);
      }
    }

    // Check summary
    if ((e.summary?.value || '').toLowerCase().includes(q)) {
      score = Math.max(score, 0.5);
    }

    if (score > 0.3) {
      results.push({
        entity_id: e.entity_id,
        entity_type: type,
        name,
        summary: e.summary?.value || '',
        match_score: Math.round(score * 100) / 100,
      });
    }
  }

  results.sort((a, b) => b.match_score - a.match_score);
  res.json({ query: q, count: results.length, results });
});

// PATCH /api/entity/:id — Update fields (the magic endpoint)
app.patch('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const { source, updates } = req.body;
  if (!updates || !Array.isArray(updates)) {
    return res.status(400).json({ error: 'Missing or invalid updates array' });
  }

  const now = new Date().toISOString();
  const agentId = req.agentId;
  const changes = [];
  let applied = 0;
  let rejected = 0;

  for (const update of updates) {
    const { path: updatePath, action, value, target_id, new_confidence, new_sentiment, reason, confidence } = update;

    try {
      if (action === 'add') {
        // Add new item to the specified array
        const arr = entity[updatePath];
        if (!Array.isArray(arr)) { rejected++; continue; }
        arr.push(value);
        changes.push(`added ${value.attribute_id || value.relationship_id || value.fact_id || 'item'} to ${updatePath}`);
        applied++;

      } else if (action === 'update_confidence') {
        // Update confidence on existing item
        const arr = entity[updatePath];
        if (!Array.isArray(arr)) { rejected++; continue; }
        const item = arr.find(i =>
          i.attribute_id === target_id || i.relationship_id === target_id ||
          i.fact_id === target_id || i.value_id === target_id || i.project_id === target_id
        );
        if (!item) { rejected++; continue; }
        const old = item.confidence;
        item.confidence = new_confidence;
        // Update label
        if (new_confidence >= 0.90) item.confidence_label = 'VERIFIED';
        else if (new_confidence >= 0.75) item.confidence_label = 'STRONG';
        else if (new_confidence >= 0.50) item.confidence_label = 'MODERATE';
        else if (new_confidence >= 0.25) item.confidence_label = 'SPECULATIVE';
        else item.confidence_label = 'UNCERTAIN';
        changes.push(`updated ${target_id} confidence ${old}→${new_confidence}${reason ? ': ' + reason : ''}`);
        applied++;

      } else if (action === 'update_sentiment') {
        // Update relationship sentiment
        const rels = entity.relationships;
        if (!Array.isArray(rels)) { rejected++; continue; }
        const rel = rels.find(r => r.relationship_id === target_id);
        if (!rel) { rejected++; continue; }
        const old = rel.sentiment;
        rel.sentiment = new_sentiment;
        if (confidence) rel.confidence = confidence;
        changes.push(`updated ${target_id} sentiment ${old}→${new_sentiment}${reason ? ': ' + reason : ''}`);
        applied++;

      } else if (action === 'update_value') {
        // Update the actual value of an attribute
        const arr = entity[updatePath];
        if (!Array.isArray(arr)) { rejected++; continue; }
        const item = arr.find(i =>
          i.attribute_id === target_id || i.fact_id === target_id
        );
        if (!item) { rejected++; continue; }
        // Move old value to provenance
        if (!entity.provenance_chain) entity.provenance_chain = { merge_history: [] };
        entity.provenance_chain.merge_history.push({
          merged_at: now,
          merged_by: agentId,
          changes: [{ type: 'value_updated', target_id, old_value: item.value, new_value: value }],
        });
        item.value = value;
        if (confidence) item.confidence = confidence;
        changes.push(`updated ${target_id} value to "${value}"`);
        applied++;

      } else if (action === 'deprecate') {
        // Mark data point as deprecated
        const arr = entity[updatePath];
        if (!Array.isArray(arr)) { rejected++; continue; }
        const item = arr.find(i =>
          i.attribute_id === target_id || i.relationship_id === target_id ||
          i.fact_id === target_id || i.value_id === target_id
        );
        if (!item) { rejected++; continue; }
        item.confidence = 0.10;
        item.confidence_label = 'UNCERTAIN';
        item.deprecated = true;
        changes.push(`deprecated ${target_id}${reason ? ': ' + reason : ''}`);
        applied++;

      } else if (action === 'verify') {
        // Confirm existing data — bump confidence by +0.10 (cap 0.98)
        const arr = entity[updatePath];
        if (!Array.isArray(arr)) { rejected++; continue; }
        const item = arr.find(i =>
          i.attribute_id === target_id || i.relationship_id === target_id ||
          i.fact_id === target_id || i.value_id === target_id
        );
        if (!item) { rejected++; continue; }
        const old = item.confidence;
        item.confidence = Math.min(0.98, (item.confidence || 0) + 0.10);
        if (item.confidence >= 0.90) item.confidence_label = 'VERIFIED';
        changes.push(`verified ${target_id} confidence ${old}→${item.confidence}`);
        applied++;

      } else {
        rejected++;
      }
    } catch {
      rejected++;
    }
  }

  // Add provenance entry
  if (!entity.provenance_chain) {
    entity.provenance_chain = { created_at: now, created_by: 'api', source_documents: [], merge_history: [] };
  }
  entity.provenance_chain.merge_history = entity.provenance_chain.merge_history || [];
  entity.provenance_chain.merge_history.push({
    merged_at: now,
    merged_by: agentId,
    incoming_source: source?.agent || agentId,
    platform: source?.platform || 'api',
    conversation_id: source?.conversation_id || null,
    changes,
  });

  // Recalculate average confidence
  let totalConf = 0;
  let confCount = 0;
  for (const attr of (entity.attributes || [])) {
    if (attr.confidence != null) { totalConf += attr.confidence; confCount++; }
  }
  for (const rel of (entity.relationships || [])) {
    if (rel.confidence != null) { totalConf += rel.confidence; confCount++; }
  }
  for (const fact of (entity.key_facts || [])) {
    if (fact.confidence != null) { totalConf += fact.confidence; confCount++; }
  }
  if (confCount > 0 && entity.extraction_metadata) {
    entity.extraction_metadata.extraction_confidence = Math.round((totalConf / confCount) * 100) / 100;
  }

  writeEntity(req.params.id, entity);

  res.json({
    status: 'success',
    entity_id: req.params.id,
    updates_applied: applied,
    updates_rejected: rejected,
    new_entity_confidence: entity.extraction_metadata?.extraction_confidence || null,
    provenance_entry: {
      timestamp: now,
      agent: agentId,
      changes,
    },
  });
});

// POST /api/observe — Append an observation to an existing entity
const CONFIDENCE_MAP = {
  VERIFIED: 1.0, STRONG: 0.8, MODERATE: 0.6, SPECULATIVE: 0.4, UNCERTAIN: 0.2,
};
const VALID_LAYERS = ['L1_OBJECTIVE', 'L2_GROUP', 'L3_PERSONAL'];

app.post('/api/observe', apiAuth, (req, res) => {
  const { entity_id, observation, confidence_label, facts_layer, source } = req.body;

  // Validate required fields
  if (!entity_id) return res.status(400).json({ error: 'Missing entity_id' });
  if (!observation || typeof observation !== 'string' || !observation.trim()) {
    return res.status(400).json({ error: 'Missing or empty observation string' });
  }
  if (!confidence_label || !CONFIDENCE_MAP.hasOwnProperty(confidence_label)) {
    return res.status(400).json({
      error: 'Invalid confidence_label. Must be one of: ' + Object.keys(CONFIDENCE_MAP).join(', '),
    });
  }
  if (!facts_layer || !VALID_LAYERS.includes(facts_layer)) {
    return res.status(400).json({
      error: 'Invalid facts_layer. Must be one of: ' + VALID_LAYERS.join(', '),
    });
  }

  // Validate entity exists
  const entity = readEntity(entity_id);
  if (!entity) return res.status(404).json({ error: `Entity ${entity_id} not found` });

  // Build observation
  const now = new Date().toISOString();
  if (!entity.observations) entity.observations = [];
  const seq = String(entity.observations.length + 1).padStart(3, '0');
  const tsCompact = now.replace(/[-:T]/g, '').slice(0, 14);
  const obsId = `OBS-${entity_id}-${tsCompact}-${seq}`;

  const obs = {
    observation_id: obsId,
    observation: observation.trim(),
    confidence: CONFIDENCE_MAP[confidence_label],
    confidence_label,
    facts_layer,
    layer_number: parseInt(facts_layer.charAt(1)),
    observed_at: now,
    observed_by: req.agentId,
    source: source || null,
  };

  entity.observations.push(obs);

  // Log to provenance chain
  if (!entity.provenance_chain) {
    entity.provenance_chain = { created_at: now, created_by: 'api', source_documents: [], merge_history: [] };
  }
  entity.provenance_chain.merge_history = entity.provenance_chain.merge_history || [];
  entity.provenance_chain.merge_history.push({
    merged_at: now,
    merged_by: req.agentId,
    changes: [`added observation ${obsId}`],
  });

  writeEntity(entity_id, entity);

  res.status(201).json({
    status: 'created',
    entity_id,
    observation: obs,
  });
});

// POST /api/entity — Create entity from structured JSON
app.post('/api/entity', apiAuth, (req, res) => {
  const data = req.body;
  const entityId = data.entity?.entity_id;
  if (!entityId) {
    return res.status(400).json({ error: 'Missing entity.entity_id' });
  }

  // Check if entity already exists
  const existing = readEntity(entityId);
  if (existing) {
    return res.status(409).json({ error: `Entity ${entityId} already exists. Use PATCH to update or POST /api/extract for merge.` });
  }

  writeEntity(entityId, data);
  res.status(201).json({ status: 'created', entity_id: entityId });
});

// POST /api/extract — Extract from raw text (v2 schema)
app.post('/api/extract', apiAuth, async (req, res) => {
  const { text, type } = req.body;
  if (!text || !type) return res.status(400).json({ error: 'Missing text or type' });
  if (!['person', 'business'].includes(type)) return res.status(400).json({ error: 'Type must be person or business' });

  try {
    // Use v2 extraction via context-engine
    const { execFile } = require('child_process');
    const tmpIn = path.join(__dirname, 'watch-folder', 'output', `_api_input_${Date.now()}.txt`);
    const tmpOut = path.join(__dirname, 'watch-folder', 'output', `_api_output_${Date.now()}.json`);

    fs.writeFileSync(tmpIn, text);

    await new Promise((resolve, reject) => {
      execFile('node', [
        path.join(__dirname, 'context-engine.js'),
        '--input', tmpIn, '--output', tmpOut, '--type', type, '--schema-version', '2.0',
      ], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
        timeout: 180000,
      }, (err) => err ? reject(err) : resolve());
    });

    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));

    // Clean up temp input
    fs.unlinkSync(tmpIn);

    // Auto-add to graph if entity_id present
    const entityId = result.entity?.entity_id;
    if (entityId) {
      const existing = readEntity(entityId);
      if (existing) {
        const { merged } = merge(existing, result);
        if (merged) writeEntity(entityId, merged);
      } else {
        writeEntity(entityId, result);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/graph/stats — Knowledge graph health check
app.get('/api/graph/stats', apiAuth, (req, res) => {
  const entities = listEntities();
  let lastUpdated = null;
  let totalMerges = 0;
  const typeCounts = { person: 0, business: 0 };

  for (const { data } of entities) {
    const type = data.entity?.entity_type;
    if (type && typeCounts[type] !== undefined) typeCounts[type]++;

    const extractedAt = data.extraction_metadata?.extracted_at;
    if (extractedAt && (!lastUpdated || extractedAt > lastUpdated)) {
      lastUpdated = extractedAt;
    }

    totalMerges += (data.provenance_chain?.merge_history || []).length;
  }

  res.json({
    status: 'healthy',
    entity_count: entities.length,
    type_counts: typeCounts,
    total_merges: totalMerges,
    last_updated: lastUpdated,
    graph_directory: GRAPH_DIR,
  });
});

// --- Serve the UI ---

app.get('/', (req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Engine v2</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 40px 24px;
  }

  header {
    text-align: center;
    margin-bottom: 48px;
  }

  h1 {
    font-size: 2.4rem;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.02em;
  }

  h1 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    font-size: 1.1rem;
    color: #6b7280;
    margin-top: 8px;
  }

  .workspace {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    min-height: 500px;
  }

  .panel {
    background: #12121a;
    border: 1px solid #1e1e2e;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    padding: 16px 20px;
    border-bottom: 1px solid #1e1e2e;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-label {
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
  }

  textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.9rem;
    line-height: 1.6;
    padding: 20px;
    resize: none;
    outline: none;
  }

  textarea::placeholder { color: #3a3a4a; }

  .buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin: 24px 0;
  }

  button {
    padding: 12px 28px;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-person {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
  }

  .btn-person:hover:not(:disabled) {
    background: linear-gradient(135deg, #4f46e5, #7c3aed);
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }

  .btn-business {
    background: linear-gradient(135deg, #0ea5e9, #06b6d4);
    color: white;
  }

  .btn-business:hover:not(:disabled) {
    background: linear-gradient(135deg, #0284c7, #0891b2);
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(14, 165, 233, 0.3);
  }

  .result-area {
    flex: 1;
    padding: 20px;
    overflow: auto;
  }

  pre {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.85rem;
    line-height: 1.7;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #3a3a4a;
    font-size: 0.95rem;
    text-align: center;
    padding: 40px;
    line-height: 1.6;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    flex-direction: column;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid #1e1e2e;
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-text { color: #6b7280; font-size: 0.9rem; }

  .stats {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .stat {
    background: #1a1a2e;
    border: 1px solid #2a2a3e;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 0.8rem;
  }

  .stat-value {
    color: #a78bfa;
    font-weight: 700;
    margin-right: 4px;
  }

  .stat-label { color: #6b7280; }

  /* JSON syntax highlighting */
  .json-key { color: #8b5cf6; }
  .json-string { color: #34d399; }
  .json-number { color: #f59e0b; }
  .json-bool { color: #f472b6; }
  .json-null { color: #6b7280; }
  .json-bracket { color: #6b7280; }

  .timer {
    font-size: 0.8rem;
    color: #4b5563;
  }

  /* v2 structured view */
  .entity-card {
    background: #1a1a2e;
    border: 1px solid #2a2a3e;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .entity-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .entity-name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #fff;
  }

  .entity-id {
    font-size: 0.7rem;
    color: #6366f1;
    font-family: monospace;
    background: rgba(99,102,241,0.1);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .entity-summary {
    font-size: 0.85rem;
    color: #9ca3af;
    line-height: 1.5;
    margin-top: 6px;
  }

  .section {
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid #1e1e2e;
  }

  .item-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 0;
    font-size: 0.82rem;
    flex-wrap: wrap;
  }

  .item-key {
    color: #8b5cf6;
    font-weight: 600;
    min-width: 70px;
  }

  .item-value {
    color: #e0e0e0;
    flex: 1;
  }

  .badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .badge-verified { background: rgba(52,211,153,0.15); color: #34d399; }
  .badge-strong { background: rgba(96,165,250,0.15); color: #60a5fa; }
  .badge-moderate { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .badge-speculative { background: rgba(251,146,60,0.15); color: #fb923c; }
  .badge-uncertain { background: rgba(239,68,68,0.15); color: #ef4444; }

  .badge-time {
    background: rgba(139,92,246,0.1);
    color: #a78bfa;
    font-size: 0.6rem;
  }

  .badge-layer {
    font-size: 0.6rem;
  }

  .badge-layer-1 { background: rgba(52,211,153,0.1); color: #6ee7b7; }
  .badge-layer-2 { background: rgba(96,165,250,0.1); color: #93c5fd; }
  .badge-layer-3 { background: rgba(244,114,182,0.1); color: #f9a8d4; }

  .rel-sentiment {
    font-size: 0.65rem;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .sentiment-positive { background: rgba(52,211,153,0.12); color: #34d399; }
  .sentiment-neutral { background: rgba(156,163,175,0.12); color: #9ca3af; }
  .sentiment-strained { background: rgba(239,68,68,0.12); color: #ef4444; }
  .sentiment-complex { background: rgba(251,191,36,0.12); color: #fbbf24; }
  .sentiment-unknown { background: rgba(107,114,128,0.12); color: #6b7280; }

  .constraint-card {
    background: rgba(239,68,68,0.05);
    border: 1px solid rgba(239,68,68,0.15);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    font-size: 0.8rem;
  }

  .constraint-name { color: #fca5a5; font-weight: 600; }
  .constraint-desc { color: #9ca3af; margin-top: 3px; }

  .view-toggle {
    display: flex;
    gap: 4px;
  }

  .view-btn {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 3px 10px;
    font-size: 0.7rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .view-btn.active {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .json-view { display: none; }
  .json-view.active { display: block; }
  .structured-view { display: none; }
  .structured-view.active { display: block; }

  .provenance {
    font-size: 0.75rem;
    color: #4b5563;
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #1e1e2e;
  }

  .provenance code {
    color: #6366f1;
    font-size: 0.7rem;
  }

  .btn-sample {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 6px 14px;
    font-size: 0.8rem;
  }

  .btn-sample:hover:not(:disabled) {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .output-actions {
    display: flex;
    gap: 8px;
  }

  .btn-action {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 6px 14px;
    font-size: 0.75rem;
    display: none;
  }

  .btn-action:hover:not(:disabled) {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .btn-action.visible { display: inline-block; }

  .btn-action.copied {
    border-color: #34d399;
    color: #34d399;
  }

  footer {
    text-align: center;
    padding: 40px 24px 24px;
    color: #3a3a4a;
    font-size: 0.8rem;
  }

  footer a {
    color: #6b7280;
    text-decoration: none;
  }

  footer a:hover { color: #a78bfa; }

  @media (max-width: 768px) {
    .workspace { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>Context Engine</span></h1>
    <p class="subtitle">Turn messy text into structured intelligence</p>
  </header>

  <div class="workspace">
    <div class="panel">
      <div class="panel-header">
        <span class="panel-label">Input</span>
        <button class="btn-sample" onclick="loadSample()">Load Sample</button>
      </div>
      <textarea id="input" placeholder="Paste unstructured text about a person or business here..."></textarea>
    </div>

    <div class="panel">
      <div class="panel-header">
        <span class="panel-label">Structured Output</span>
        <div class="output-actions">
          <div class="view-toggle" id="view-toggle" style="display:none;">
            <button class="view-btn active" data-view="structured" onclick="toggleView('structured')">Structured</button>
            <button class="view-btn" data-view="json" onclick="toggleView('json')">JSON</button>
          </div>
          <button class="btn-action" id="btn-copy" onclick="copyJSON()">Copy JSON</button>
          <button class="btn-action" id="btn-download" onclick="downloadJSON()">Download JSON</button>
          <span class="timer" id="timer"></span>
        </div>
      </div>
      <div class="result-area" id="result">
        <div class="empty-state">
          Paste text on the left and click<br>Extract Person or Extract Business
        </div>
      </div>
    </div>
  </div>

  <div class="buttons">
    <button class="btn-person" id="btn-person" onclick="extract('person')">Extract Person</button>
    <button class="btn-business" id="btn-business" onclick="extract('business')">Extract Business</button>
  </div>
</div>

<footer>
  Built by CJ Mitchell | Context Architecture | <a href="https://github.com/flawlesstracks/context-engine" target="_blank">github.com/flawlesstracks/context-engine</a>
</footer>

<script>
var lastResult = null;
var currentView = 'structured';

var SAMPLE_TEXT = "Dr. Sarah Chen is a 38-year-old AI research lead at Meridian Labs in San Francisco. She previously spent six years at DeepMind working on reinforcement learning before joining Meridian in 2023 to build their applied AI division. Sarah holds a PhD from MIT in computational neuroscience and a BS from Stanford in computer science. She is known for her work on multi-agent systems and has published over 40 papers. Her close collaborators include Dr. James Park, CTO of Meridian Labs, and Professor Ana Ruiz at UC Berkeley who co-authored several papers with her. Sarah values rigorous experimentation and open science. She prefers written communication over meetings and is known for detailed technical memos. Outside of work she mentors undergrad researchers through a program called NextGen AI and is an avid rock climber.";

function loadSample() {
  document.getElementById('input').value = SAMPLE_TEXT;
}

function showActionButtons() {
  document.getElementById('btn-copy').classList.add('visible');
  document.getElementById('btn-download').classList.add('visible');
  document.getElementById('view-toggle').style.display = 'flex';
}

function hideActionButtons() {
  document.getElementById('btn-copy').classList.remove('visible');
  document.getElementById('btn-download').classList.remove('visible');
  document.getElementById('view-toggle').style.display = 'none';
}

async function copyJSON() {
  if (!lastResult) return;
  var btn = document.getElementById('btn-copy');
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(function() {
    btn.textContent = 'Copy JSON';
    btn.classList.remove('copied');
  }, 2000);
}

function downloadJSON() {
  if (!lastResult) return;
  var e = lastResult.entity || {};
  var name = e.name?.full || e.name?.common || e.name?.legal || 'context';
  var filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-context.json';
  var blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toggleView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.view === view);
  });
  var sv = document.querySelector('.structured-view');
  var jv = document.querySelector('.json-view');
  if (sv) sv.classList.toggle('active', view === 'structured');
  if (jv) jv.classList.toggle('active', view === 'json');
}

function esc(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function confidenceBadge(conf, label) {
  if (conf == null) return '';
  var cls = 'badge-moderate';
  var lbl = label || '';
  if (conf >= 0.90) { cls = 'badge-verified'; lbl = lbl || 'VERIFIED'; }
  else if (conf >= 0.75) { cls = 'badge-strong'; lbl = lbl || 'STRONG'; }
  else if (conf >= 0.50) { cls = 'badge-moderate'; lbl = lbl || 'MODERATE'; }
  else if (conf >= 0.25) { cls = 'badge-speculative'; lbl = lbl || 'SPECULATIVE'; }
  else { cls = 'badge-uncertain'; lbl = lbl || 'UNCERTAIN'; }
  return '<span class="badge ' + cls + '">' + esc(lbl) + ' ' + conf.toFixed(2) + '</span>';
}

function timeBadge(decay) {
  if (!decay) return '';
  return '<span class="badge badge-time">' + esc(decay) + '</span>';
}

function layerBadge(layer) {
  if (!layer) return '';
  var labels = { 1: 'Objective', 2: 'Group', 3: 'Personal' };
  return '<span class="badge badge-layer badge-layer-' + layer + '">L' + layer + ' ' + esc(labels[layer] || '') + '</span>';
}

function sentimentBadge(sentiment) {
  if (!sentiment) return '';
  var cls = 'sentiment-' + sentiment.toLowerCase().replace(/[^a-z]/g, '');
  if (!['positive','neutral','strained','complex','unknown'].some(function(s) { return cls === 'sentiment-' + s; })) {
    cls = 'sentiment-neutral';
  }
  return '<span class="rel-sentiment ' + cls + '">' + esc(sentiment) + '</span>';
}

function syntaxHighlight(json) {
  var str = JSON.stringify(json, null, 2);
  return str.replace(
    /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
    function(match) {
      var cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'json-key';
        } else {
          cls = 'json-string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
}

function buildStructuredView(data) {
  var html = '';
  var e = data.entity || {};
  var meta = data.extraction_metadata || {};
  var type = e.entity_type || 'person';

  // Entity card
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  html += '<div class="entity-card">';
  html += '<div class="entity-card-header">';
  html += '<span class="entity-name">' + esc(name) + '</span>';
  if (e.entity_id) html += '<span class="entity-id">' + esc(e.entity_id) + '</span>';
  html += confidenceBadge(meta.extraction_confidence);
  html += '</div>';
  if (e.summary?.value) {
    html += '<div class="entity-summary">' + esc(e.summary.value) + '</div>';
  }
  html += '</div>';

  // Stats bar
  var stats = [];
  stats.push({ v: (data.attributes || []).length, l: 'attributes' });
  stats.push({ v: (data.relationships || []).length, l: 'relationships' });
  stats.push({ v: (data.values || []).length, l: 'values' });
  stats.push({ v: (data.key_facts || []).length, l: 'key facts' });
  if ((data.constraints || []).length > 0) stats.push({ v: data.constraints.length, l: 'constraints' });
  if ((data.action_suggestions || []).length > 0) stats.push({ v: data.action_suggestions.length, l: 'actions' });
  html += '<div class="stats">' + stats.map(function(s) {
    return '<div class="stat"><span class="stat-value">' + s.v + '</span><span class="stat-label">' + s.l + '</span></div>';
  }).join('') + '</div>';

  // Attributes
  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    html += '<div class="section"><div class="section-title">Attributes</div>';
    attrs.forEach(function(a) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(a.key || '') + '</span>';
      html += '<span class="item-value">' + esc(String(a.value || '')) + '</span>';
      html += confidenceBadge(a.confidence, a.confidence_label);
      html += timeBadge(a.time_decay);
      html += layerBadge(a.facts_layer);
      html += '</div>';
    });
    html += '</div>';
  }

  // Relationships
  var rels = data.relationships || [];
  if (rels.length > 0) {
    html += '<div class="section"><div class="section-title">Relationships</div>';
    rels.forEach(function(r) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(r.name || '') + '</span>';
      html += '<span class="item-value">' + esc(r.relationship_type || '') + (r.context ? ' — ' + esc(r.context) : '') + '</span>';
      html += sentimentBadge(r.sentiment);
      html += confidenceBadge(r.confidence, r.confidence_label);
      html += '</div>';
    });
    html += '</div>';
  }

  // Values
  var vals = data.values || [];
  if (vals.length > 0) {
    html += '<div class="section"><div class="section-title">Values</div>';
    vals.forEach(function(v) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(v.value || '') + '</span>';
      html += '<span class="item-value">' + esc(v.interpretation || '') + '</span>';
      html += confidenceBadge(v.confidence, v.confidence_label);
      html += timeBadge(v.time_decay);
      html += '</div>';
    });
    html += '</div>';
  }

  // Key Facts
  var facts = data.key_facts || [];
  if (facts.length > 0) {
    html += '<div class="section"><div class="section-title">Key Facts</div>';
    facts.forEach(function(f) {
      html += '<div class="item-row">';
      html += '<span class="item-value">' + esc(f.fact || '') + '</span>';
      html += confidenceBadge(f.confidence, f.confidence_label);
      html += timeBadge(f.time_decay);
      html += layerBadge(f.facts_layer);
      if (f.category) html += '<span class="badge badge-time">' + esc(f.category) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Constraints
  var constraints = data.constraints || [];
  if (constraints.length > 0) {
    html += '<div class="section"><div class="section-title">Constraints</div>';
    constraints.forEach(function(c) {
      html += '<div class="constraint-card">';
      html += '<div class="constraint-name">' + esc(c.type || c.constraint_id || '') + '</div>';
      html += '<div class="constraint-desc">' + esc(c.description || '') + '</div>';
      if (c.linked_entities && c.linked_entities.length > 0) {
        html += '<div class="constraint-desc" style="margin-top:4px;color:#6366f1;">Linked: ' + c.linked_entities.map(function(le) { return esc(le); }).join(', ') + '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
  }

  // Action Suggestions
  var actions = data.action_suggestions || [];
  if (actions.length > 0) {
    html += '<div class="section"><div class="section-title">Action Suggestions</div>';
    actions.forEach(function(a) {
      html += '<div class="item-row">';
      html += '<span class="item-key" style="color:#34d399;">' + esc(a.priority || '') + '</span>';
      html += '<span class="item-value">' + esc(a.action || a.suggestion || '') + '</span>';
      if (a.rationale) html += '<span class="badge badge-time">' + esc(a.rationale) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Provenance
  var prov = data.provenance_chain || {};
  if (prov.created_at || prov.source_documents?.length > 0) {
    html += '<div class="provenance">';
    if (prov.created_at) html += 'Created: <code>' + esc(prov.created_at) + '</code>';
    if (prov.source_documents?.length > 0) {
      html += ' | Sources: <code>' + prov.source_documents.length + '</code>';
    }
    if (meta.schema_version) html += ' | Schema: <code>v' + esc(meta.schema_version) + '</code>';
    if (meta.source_hash) html += ' | Hash: <code>' + esc(meta.source_hash.slice(0, 12)) + '...</code>';
    html += '</div>';
  }

  return html;
}

async function extract(type) {
  var text = document.getElementById('input').value.trim();
  if (!text) return;

  var btnP = document.getElementById('btn-person');
  var btnB = document.getElementById('btn-business');
  var result = document.getElementById('result');
  var timer = document.getElementById('timer');

  btnP.disabled = true;
  btnB.disabled = true;
  lastResult = null;
  hideActionButtons();
  result.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Extracting ' + type + ' context (v2)...</div></div>';

  var start = Date.now();
  var interval = setInterval(function() {
    timer.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';
  }, 100);

  try {
    var res = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, type: type })
    });
    var data = await res.json();
    clearInterval(interval);
    timer.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';

    if (data.error) {
      result.innerHTML = '<div class="empty-state" style="color:#ef4444;">Error: ' + data.error + '</div>';
    } else {
      lastResult = data;
      showActionButtons();
      var structuredHtml = buildStructuredView(data);
      var jsonHtml = '<pre>' + syntaxHighlight(data) + '</pre>';
      result.innerHTML = '<div class="structured-view active">' + structuredHtml + '</div>' +
                         '<div class="json-view">' + jsonHtml + '</div>';
      currentView = 'structured';
      document.querySelectorAll('.view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === 'structured');
      });
    }
  } catch (err) {
    clearInterval(interval);
    result.innerHTML = '<div class="empty-state" style="color:#ef4444;">Request failed: ' + err.message + '</div>';
  }

  btnP.disabled = false;
  btnB.disabled = false;
}
</script>
</body>
</html>`;

// --- Start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  Context Engine - Web Demo + API');
  console.log('  ──────────────────────────────');
  console.log('  UI:     http://localhost:' + PORT);
  console.log('  API:    http://localhost:' + PORT + '/api/graph/stats');
  console.log('  Graph:  ' + GRAPH_DIR + (IS_PRODUCTION ? ' (persistent disk)' : ' (local)'));
  console.log('');
});
