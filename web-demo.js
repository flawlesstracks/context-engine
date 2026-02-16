#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { merge } = require('./merge-engine');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { readEntity, writeEntity, listEntities, getNextCounter } = require('./src/graph-ops');
const { ingestPipeline } = require('./src/ingest-pipeline');
const { normalizeFileToText } = require('./src/parsers/normalize');
const { buildLinkedInPrompt, linkedInResponseToEntity } = require('./src/parsers/linkedin');
const { mapContactRows } = require('./src/parsers/contacts');
const auth = require('./src/auth');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Context-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '200mb' }));
app.use(cookieParser());

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
const LOCAL_GRAPH_DIR = path.join(__dirname, 'watch-folder', 'graph');
const CONFIG_PATH = path.join(__dirname, 'watch-folder', 'config.json');

// Resolve graph directory — try persistent disk candidates, fall back to local
let GRAPH_DIR = LOCAL_GRAPH_DIR;
let GRAPH_IS_PERSISTENT = false;
if (IS_PRODUCTION) {
  const candidates = [
    process.env.RENDER_DISK_PATH && path.join(process.env.RENDER_DISK_PATH, 'graph'),
    '/var/data/graph',
    '/data/graph',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parentDir = path.dirname(candidate);
      if (!fs.existsSync(parentDir)) continue;
      if (!fs.existsSync(candidate)) {
        fs.mkdirSync(candidate, { recursive: true });
      }
      // Test write access
      const testFile = path.join(candidate, '.write-test');
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);

      // Seed from repo on first boot
      const existing = fs.readdirSync(candidate).filter(f => f.endsWith('.json'));
      if (existing.length === 0) {
        const seedFiles = fs.readdirSync(LOCAL_GRAPH_DIR).filter(f => f.endsWith('.json'));
        for (const file of seedFiles) {
          fs.copyFileSync(path.join(LOCAL_GRAPH_DIR, file), path.join(candidate, file));
        }
        console.log(`  Seeded ${seedFiles.length} entity file(s) to ${candidate}`);
      }
      GRAPH_DIR = candidate;
      GRAPH_IS_PERSISTENT = true;
      break;
    } catch {
      continue;
    }
  }
  if (!GRAPH_IS_PERSISTENT) {
    console.warn('  WARNING: No writable persistent disk found');
    console.warn('  Falling back to local graph: ' + LOCAL_GRAPH_DIR);
    console.warn('  Set RENDER_DISK_PATH env var to your disk mount path');
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// --- Tenant management ---

const TENANTS_PATH = path.join(GRAPH_DIR, 'tenants.json');

function loadTenants() {
  if (!fs.existsSync(TENANTS_PATH)) return {};
  return JSON.parse(fs.readFileSync(TENANTS_PATH, 'utf-8'));
}

function saveTenants(tenants) {
  fs.writeFileSync(TENANTS_PATH, JSON.stringify(tenants, null, 2) + '\n');
}

// --- Google OAuth routes ---

auth.init({ graphDir: GRAPH_DIR, loadTenants, saveTenants });
app.use('/auth', auth.router);

// --- ChatGPT Ingest Helpers ---

function parseChatGPTExport(input) {
  let conversations;
  if (typeof input === 'string') {
    conversations = JSON.parse(input);
  } else if (Array.isArray(input)) {
    conversations = input;
  } else {
    throw new Error('Expected an array of conversations or a JSON string');
  }

  return conversations.map(conv => {
    const title = conv.title || 'Untitled';
    const createTime = conv.create_time
      ? new Date(conv.create_time * 1000).toISOString()
      : new Date().toISOString();
    const userMessages = [];

    if (conv.mapping) {
      const nodes = Object.values(conv.mapping);
      nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
      for (const node of nodes) {
        const msg = node.message;
        if (!msg || !msg.author || msg.author.role !== 'user') continue;
        const parts = (msg.content?.parts || []);
        const text = parts.filter(p => typeof p === 'string').join('\n').trim();
        if (text) userMessages.push(text);
      }
    }

    return { title, createTime, userMessages };
  }).filter(c => c.userMessages.length > 0);
}

function buildIngestPrompt(batch) {
  let text = '';
  batch.forEach((conv, i) => {
    text += '\nCONVERSATION ' + i + ' (title: "' + conv.title.replace(/"/g, '\\"') + '"):\n';
    let convText = conv.userMessages.join('\n');
    if (convText.length > 5000) convText = convText.substring(0, 5000) + '\n[...truncated]';
    text += convText + '\n';
  });

  return 'You are a structured data extraction engine. Analyze these user messages from ChatGPT conversations and extract every person and business the user mentions by name.\n\nRULES:\n- Only extract named entities (skip "my boss", "the company" without a specific name)\n- entity_type: "person" or "business"\n- name: { "full": "..." } for persons, { "common": "..." } for businesses\n- summary: 2-3 sentences synthesizing what the user said about this entity\n- attributes: only include clearly stated facts (role, location, expertise, industry)\n- relationships: connections between extracted entities\n- observations: each specific mention tagged with conversation_index (0-based integer matching conversation numbers below)\n- Do NOT invent information beyond what the user explicitly stated\n- If no named entities found, return {"entities": []}\n\nOutput ONLY valid JSON, no markdown fences, no commentary:\n{\n  "entities": [\n    {\n      "entity_type": "person",\n      "name": { "full": "Jane Smith" },\n      "summary": "...",\n      "attributes": { "role": "...", "location": "..." },\n      "relationships": [{ "name": "Other Entity", "relationship": "colleague", "context": "..." }],\n      "observations": [{ "text": "What the user said about this entity", "conversation_index": 0 }]\n    }\n  ]\n}\n\n--- USER MESSAGES FROM CONVERSATIONS ---' + text + '\n--- END ---';
}

// --- Auth middleware (multi-tenant) ---

function apiAuth(req, res, next) {
  const config = loadConfig();

  // Source 1: X-Context-API-Key header (existing behavior for API consumers)
  const key = req.headers['x-context-api-key'];

  if (key) {
    // Admin key — root namespace
    if (key === config.api_key) {
      req.agentId = req.headers['x-agent-id'] || 'external';
      req.graphDir = GRAPH_DIR;
      req.isAdmin = true;
      req.tenantId = null;
      return next();
    }

    // Tenant key lookup
    const tenants = loadTenants();
    const tenant = Object.values(tenants).find(t => t.api_key === key);
    if (tenant) {
      const tenantDir = path.join(GRAPH_DIR, `tenant-${tenant.tenant_id}`);
      if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
      req.agentId = req.headers['x-agent-id'] || tenant.tenant_name;
      req.graphDir = tenantDir;
      req.isAdmin = false;
      req.tenantId = tenant.tenant_id;
      return next();
    }

    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Source 2: ca_session cookie (browser sessions via Google OAuth)
  const session = auth.verifySession(req.cookies[auth.SESSION_COOKIE]);
  if (session && session.api_key) {
    const tenants = loadTenants();
    const tenant = Object.values(tenants).find(t => t.api_key === session.api_key);
    if (tenant) {
      const tenantDir = path.join(GRAPH_DIR, `tenant-${tenant.tenant_id}`);
      if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
      req.agentId = tenant.tenant_name;
      req.graphDir = tenantDir;
      req.isAdmin = false;
      req.tenantId = tenant.tenant_id;
      return next();
    }
  }

  return res.status(401).json({ error: 'Missing X-Context-API-Key header or valid session' });
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// POST /api/tenant — Create a new tenant (admin only)
app.post('/api/tenant', apiAuth, adminOnly, (req, res) => {
  const { tenant_name } = req.body;
  if (!tenant_name || typeof tenant_name !== 'string' || !tenant_name.trim()) {
    return res.status(400).json({ error: 'tenant_name is required' });
  }

  const tenants = loadTenants();

  // Check duplicate name
  if (Object.values(tenants).some(t => t.tenant_name.toLowerCase() === tenant_name.trim().toLowerCase())) {
    return res.status(409).json({ error: `Tenant "${tenant_name}" already exists` });
  }

  const tenantId = crypto.randomBytes(4).toString('hex');
  const apiKey = 'ctx-' + crypto.randomBytes(16).toString('hex');
  const tenantDir = path.join(GRAPH_DIR, `tenant-${tenantId}`);
  fs.mkdirSync(tenantDir, { recursive: true });

  tenants[tenantId] = {
    tenant_id: tenantId,
    tenant_name: tenant_name.trim(),
    api_key: apiKey,
    created_at: new Date().toISOString(),
    created_by: req.agentId,
  };
  saveTenants(tenants);

  res.status(201).json({
    status: 'created',
    tenant_id: tenantId,
    tenant_name: tenant_name.trim(),
    api_key: apiKey,
    graph_directory: `tenant-${tenantId}`,
    note: 'Save this API key — it will not be shown again.',
  });
});

// POST /api/ingest/chatgpt — Import ChatGPT conversation history
app.post('/api/ingest/chatgpt', apiAuth, async (req, res) => {
  const startTime = Date.now();

  // Parse input
  let conversations;
  try {
    const input = req.body.conversations || req.body.raw;
    if (!input) {
      return res.status(400).json({ error: 'Missing "conversations" array or "raw" JSON string' });
    }
    conversations = parseChatGPTExport(input);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse input: ' + err.message });
  }

  if (conversations.length === 0) {
    return res.status(400).json({ error: 'No conversations with user messages found' });
  }

  // Stream NDJSON progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');

  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
    batches.push(conversations.slice(i, i + BATCH_SIZE));
  }

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  let observationsAdded = 0;
  let conversationsProcessed = 0;

  sendEvent({
    type: 'started',
    total_conversations: conversations.length,
    total_batches: batches.length,
  });

  const client = new Anthropic();

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    try {
      const prompt = buildIngestPrompt(batch);
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      });
      const rawResponse = message.content[0].text;
      const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      // Build v2 entities from Claude's extraction
      const v2Entities = [];
      for (const extracted of (parsed.entities || [])) {
        const entityType = extracted.entity_type;
        if (!entityType || !['person', 'business'].includes(entityType)) continue;

        const displayName = entityType === 'person'
          ? (extracted.name?.full || '')
          : (extracted.name?.common || extracted.name?.legal || '');
        if (!displayName) continue;

        const now = new Date().toISOString();

        // Build observations from extracted data
        const observations = (extracted.observations || []).map(obs => {
          const convIdx = typeof obs.conversation_index === 'number' ? obs.conversation_index : 0;
          const conv = batch[convIdx] || batch[0];
          return {
            observation: (obs.text || '').trim(),
            observed_at: conv.createTime,
            source: 'chatgpt_import',
            confidence: 0.6,
            confidence_label: 'MODERATE',
            facts_layer: 'L2_GROUP',
            layer_number: 2,
            observed_by: req.agentId,
          };
        }).filter(o => o.observation);

        // Build attributes
        const attributes = [];
        if (extracted.attributes && typeof extracted.attributes === 'object') {
          let attrSeq = 1;
          for (const [key, value] of Object.entries(extracted.attributes)) {
            const val = Array.isArray(value) ? value.join(', ') : String(value);
            if (!val) continue;
            attributes.push({
              attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
              key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
              time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
              source_attribution: { facts_layer: 2, layer_label: 'group' },
            });
          }
        }

        // Build relationships
        const relationships = [];
        if (Array.isArray(extracted.relationships)) {
          let relSeq = 1;
          for (const rel of extracted.relationships) {
            relationships.push({
              relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
              name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
              sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
            });
          }
        }

        v2Entities.push({
          schema_version: '2.0',
          schema_type: 'context_architecture_entity',
          extraction_metadata: {
            extracted_at: now,
            updated_at: now,
            source_description: 'chatgpt_import',
            extraction_model: 'claude-sonnet-4-5-20250929',
            extraction_confidence: 0.6,
            schema_version: '2.0',
          },
          entity: {
            entity_type: entityType,
            name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
            summary: extracted.summary
              ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
              : { value: '', confidence: 0, facts_layer: 2 },
          },
          attributes,
          relationships,
          values: [],
          key_facts: [],
          constraints: [],
          observations,
          provenance_chain: {
            created_at: now,
            created_by: req.agentId,
            source_documents: [{ source: 'chatgpt_import', ingested_at: now }],
            merge_history: [],
          },
        });
      }

      // Ingest via unified pipeline
      const result = await ingestPipeline(v2Entities, req.graphDir, req.agentId, {
        source: 'chatgpt_import',
        truthLevel: 'INFERRED',
      });

      entitiesCreated += result.created;
      entitiesUpdated += result.updated;
      observationsAdded += result.observationsAdded;

      conversationsProcessed += batch.length;
      sendEvent({
        type: 'progress',
        batch: bi + 1,
        total_batches: batches.length,
        conversations_processed: conversationsProcessed,
        total_conversations: conversations.length,
        entities_created: entitiesCreated,
        entities_updated: entitiesUpdated,
        observations_added: observationsAdded,
      });

    } catch (err) {
      conversationsProcessed += batch.length;
      sendEvent({
        type: 'batch_error',
        batch: bi + 1,
        error: err.message,
        conversations_processed: conversationsProcessed,
      });
    }
  }

  // Final summary
  sendEvent({
    type: 'complete',
    summary: {
      entities_created: entitiesCreated,
      entities_updated: entitiesUpdated,
      observations_added: observationsAdded,
      conversations_processed: conversationsProcessed,
      processing_time_seconds: Math.round((Date.now() - startTime) / 10) / 100,
    },
  });
  res.end();
});

// POST /api/ingest/files — Upload files for entity extraction
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 20, fileSize: 50 * 1024 * 1024 } });
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md']);

app.post('/api/ingest/files', apiAuth, upload.array('files', 20), async (req, res) => {
  const files = req.files;
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded. Send files via multipart field "files".' });
  }

  // Validate extensions
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` });
    }
  }

  // Stream NDJSON progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');

  sendEvent({ type: 'started', total_files: files.length });

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalObservations = 0;
  const client = new Anthropic();

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const filename = file.originalname;

    try {
      const { text, metadata } = await normalizeFileToText(file.buffer, filename);

      let result;

      if (metadata.isContactList && metadata.rows) {
        // Direct mapping — no LLM call
        const entities = mapContactRows(metadata.rows, filename, req.agentId);
        result = await ingestPipeline(entities, req.graphDir, req.agentId, {
          source: filename,
          truthLevel: 'STRONG',
        });

      } else if (metadata.isLinkedIn) {
        // LinkedIn extraction via Claude
        const prompt = buildLinkedInPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        const entity = linkedInResponseToEntity(parsed, filename, req.agentId);
        result = await ingestPipeline([entity], req.graphDir, req.agentId, {
          source: filename,
          truthLevel: 'INFERRED',
        });

      } else {
        // Generic text extraction via Claude
        const truncated = text.length > 50000 ? text.substring(0, 50000) + '\n[...truncated]' : text;
        const prompt = buildIngestPrompt([{ title: filename, createTime: new Date().toISOString(), userMessages: [truncated] }]);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);

        const now = new Date().toISOString();
        const v2Entities = (parsed.entities || []).map(extracted => {
          const entityType = extracted.entity_type;
          if (!entityType || !['person', 'business'].includes(entityType)) return null;

          const observations = (extracted.observations || []).map(obs => ({
            observation: (obs.text || '').trim(),
            observed_at: now,
            source: `file_import:${filename}`,
            confidence: 0.6,
            confidence_label: 'MODERATE',
            facts_layer: 'L2_GROUP',
            layer_number: 2,
            observed_by: req.agentId,
          })).filter(o => o.observation);

          const attributes = [];
          if (extracted.attributes && typeof extracted.attributes === 'object') {
            let attrSeq = 1;
            for (const [key, value] of Object.entries(extracted.attributes)) {
              const val = Array.isArray(value) ? value.join(', ') : String(value);
              if (!val) continue;
              attributes.push({
                attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
                key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
                time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
                source_attribution: { facts_layer: 2, layer_label: 'group' },
              });
            }
          }

          const relationships = [];
          if (Array.isArray(extracted.relationships)) {
            let relSeq = 1;
            for (const rel of extracted.relationships) {
              relationships.push({
                relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
                name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
                sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
              });
            }
          }

          return {
            schema_version: '2.0',
            schema_type: 'context_architecture_entity',
            extraction_metadata: {
              extracted_at: now, updated_at: now,
              source_description: `file_import:${filename}`,
              extraction_model: 'claude-sonnet-4-5-20250929',
              extraction_confidence: 0.6, schema_version: '2.0',
            },
            entity: {
              entity_type: entityType,
              name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
              summary: extracted.summary
                ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
                : { value: '', confidence: 0, facts_layer: 2 },
            },
            attributes, relationships,
            values: [], key_facts: [], constraints: [],
            observations,
            provenance_chain: {
              created_at: now, created_by: req.agentId,
              source_documents: [{ source: `file_import:${filename}`, ingested_at: now }],
              merge_history: [],
            },
          };
        }).filter(Boolean);

        result = await ingestPipeline(v2Entities, req.graphDir, req.agentId, {
          source: filename,
          truthLevel: 'INFERRED',
        });
      }

      totalCreated += result.created;
      totalUpdated += result.updated;
      totalObservations += result.observationsAdded;

      sendEvent({
        type: 'file_progress',
        file: filename,
        file_index: fi + 1,
        total_files: files.length,
        entities_created: result.created,
        entities_updated: result.updated,
        observations_added: result.observationsAdded,
      });

    } catch (err) {
      sendEvent({
        type: 'file_error',
        file: filename,
        file_index: fi + 1,
        error: err.message,
      });
    }
  }

  sendEvent({
    type: 'complete',
    summary: {
      files_processed: files.length,
      entities_created: totalCreated,
      entities_updated: totalUpdated,
      observations_added: totalObservations,
    },
  });
  res.end();
});

// GET /api/entity/:id — Full entity JSON
app.get('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.json(entity);
});

// GET /api/entity/:id/summary — Lightweight summary
app.get('/api/entity/:id/summary', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
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
  const entity = readEntity(req.params.id, req.graphDir);
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
  const entities = listEntities(req.graphDir);

  // Wildcard: return all entities
  if (q === '*') {
    const all = entities.map(({ data }) => {
      const e = data.entity || {};
      const type = e.entity_type;
      const name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
      return { entity_id: e.entity_id, entity_type: type, name, summary: e.summary?.value || '', match_score: 1.0 };
    });
    return res.json({ query: q, count: all.length, results: all });
  }

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

// PATCH /api/entity/:id — Merge-update entity fields
app.patch('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const now = new Date().toISOString();
  const updates = req.body;
  const changes = [];

  // Merge into entity.entity (name, summary, entity_type)
  if (updates.name && entity.entity) {
    Object.assign(entity.entity.name || {}, updates.name);
    changes.push('updated name');
  }
  if (updates.summary != null && entity.entity) {
    if (typeof entity.entity.summary === 'object') {
      entity.entity.summary.value = updates.summary;
    } else {
      entity.entity.summary = { value: updates.summary, confidence: 0.8 };
    }
    changes.push('updated summary');
  }

  // Merge attributes (append new ones, update existing by key)
  if (updates.attributes && entity.attributes) {
    if (typeof updates.attributes === 'object' && !Array.isArray(updates.attributes)) {
      // Object form: { role: "new value", location: "new value" }
      for (const [key, value] of Object.entries(updates.attributes)) {
        const existing = entity.attributes.find(a => a.key === key);
        if (existing) {
          existing.value = value;
          existing.confidence = 0.8;
          existing.confidence_label = 'STRONG';
          changes.push(`updated attribute ${key}`);
        } else {
          entity.attributes.push({
            attribute_id: `ATTR-${String(entity.attributes.length + 1).padStart(3, '0')}`,
            key, value, confidence: 0.8, confidence_label: 'STRONG',
            time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
            source_attribution: { facts_layer: 2, layer_label: 'group' },
          });
          changes.push(`added attribute ${key}`);
        }
      }
    }
  }

  // Merge relationships (append new, dedup by name)
  if (Array.isArray(updates.relationships)) {
    if (!entity.relationships) entity.relationships = [];
    for (const rel of updates.relationships) {
      const existing = entity.relationships.find(r =>
        (r.name || '').toLowerCase() === (rel.name || '').toLowerCase()
      );
      if (existing) {
        if (rel.relationship) existing.relationship_type = rel.relationship;
        if (rel.context) existing.context = rel.context;
        changes.push(`updated relationship ${rel.name}`);
      } else {
        entity.relationships.push({
          relationship_id: `REL-${String(entity.relationships.length + 1).padStart(3, '0')}`,
          name: rel.name, relationship_type: rel.relationship || '', context: rel.context || '',
          sentiment: 'neutral', confidence: 0.8, confidence_label: 'STRONG',
        });
        changes.push(`added relationship ${rel.name}`);
      }
    }
  }

  // Merge values (append new, dedup by value text)
  if (Array.isArray(updates.values)) {
    if (!entity.values) entity.values = [];
    for (const val of updates.values) {
      const valText = typeof val === 'string' ? val : val.value;
      const existing = entity.values.find(v => (v.value || '').toLowerCase() === valText.toLowerCase());
      if (!existing) {
        entity.values.push({
          value_id: `VAL-${String(entity.values.length + 1).padStart(3, '0')}`,
          value: valText, confidence: 0.8, confidence_label: 'STRONG',
        });
        changes.push(`added value ${valText}`);
      }
    }
  }

  // Update timestamps
  if (!entity.extraction_metadata) entity.extraction_metadata = {};
  entity.extraction_metadata.updated_at = now;

  // Provenance
  if (!entity.provenance_chain) {
    entity.provenance_chain = { created_at: now, created_by: 'api', source_documents: [], merge_history: [] };
  }
  entity.provenance_chain.merge_history = entity.provenance_chain.merge_history || [];
  entity.provenance_chain.merge_history.push({
    merged_at: now, merged_by: req.agentId, changes,
  });

  writeEntity(req.params.id, entity, req.graphDir);

  res.json({
    status: 'updated',
    entity_id: req.params.id,
    changes,
    updated_at: now,
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
  const entity = readEntity(entity_id, req.graphDir);
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

  writeEntity(entity_id, entity, req.graphDir);

  res.status(201).json({
    status: 'created',
    entity_id,
    observation: obs,
  });
});

// POST /api/entity — Create a new entity with auto-generated ID
app.post('/api/entity', apiAuth, (req, res) => {
  const { entity_type, name, summary, attributes, relationships, values, source } = req.body;

  // Validate required fields
  if (!entity_type || !['person', 'business'].includes(entity_type)) {
    return res.status(400).json({ error: 'entity_type is required and must be "person" or "business"' });
  }
  if (!name || typeof name !== 'object') {
    return res.status(400).json({ error: 'name is required and must be an object (e.g. { "full": "John Smith" })' });
  }
  const displayName = entity_type === 'person'
    ? (name.full || name.preferred || '')
    : (name.common || name.legal || '');
  if (!displayName) {
    return res.status(400).json({ error: entity_type === 'person' ? 'name.full is required' : 'name.common or name.legal is required' });
  }

  // Check for duplicate names
  const { similarity } = require('./merge-engine');
  const entities = listEntities(req.graphDir);
  for (const { data } of entities) {
    const e = data.entity || {};
    if (e.entity_type !== entity_type) continue;
    const existingName = entity_type === 'person'
      ? (e.name?.full || '')
      : (e.name?.common || e.name?.legal || '');
    if (existingName && similarity(displayName, existingName) > 0.85) {
      return res.status(409).json({
        error: `Entity "${existingName}" (${e.entity_id}) already exists with similar name. Use PATCH to update.`,
        existing_entity_id: e.entity_id,
      });
    }
  }

  // Generate entity_id
  let initials;
  if (entity_type === 'person') {
    initials = displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  } else {
    initials = 'BIZ-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  }
  const seq = getNextCounter(req.graphDir, entity_type);
  const entityId = `ENT-${initials}-${String(seq).padStart(3, '0')}`;

  // Build v2-compatible entity
  const now = new Date().toISOString();
  const entityData = {
    schema_version: '2.0',
    schema_type: 'context_architecture_entity',
    extraction_metadata: {
      extracted_at: now,
      updated_at: now,
      source_description: source || 'API create',
      extraction_model: 'manual',
      extraction_confidence: 0.8,
      schema_version: '2.0',
    },
    entity: {
      entity_type,
      entity_id: entityId,
      name: { ...name, confidence: 0.9, facts_layer: 1 },
      summary: summary
        ? { value: summary, confidence: 0.8, facts_layer: 2 }
        : { value: '', confidence: 0, facts_layer: 2 },
    },
    attributes: [],
    relationships: [],
    values: [],
    key_facts: [],
    constraints: [],
    observations: [],
    provenance_chain: {
      created_at: now,
      created_by: req.agentId,
      source_documents: source ? [{ source: source, ingested_at: now }] : [],
      merge_history: [],
    },
  };

  // Populate attributes from object
  if (attributes && typeof attributes === 'object') {
    let attrSeq = 1;
    for (const [key, value] of Object.entries(attributes)) {
      const val = Array.isArray(value) ? value.join(', ') : String(value);
      entityData.attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key, value: val, confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'objective' },
      });
    }
  }

  // Populate relationships
  if (Array.isArray(relationships)) {
    let relSeq = 1;
    for (const rel of relationships) {
      entityData.relationships.push({
        relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
        name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
        sentiment: 'neutral', confidence: 0.8, confidence_label: 'STRONG',
      });
    }
  }

  // Populate values
  if (Array.isArray(values)) {
    let valSeq = 1;
    for (const v of values) {
      const valText = typeof v === 'string' ? v : v.value || '';
      entityData.values.push({
        value_id: `VAL-${String(valSeq++).padStart(3, '0')}`,
        value: valText, confidence: 0.8, confidence_label: 'STRONG',
      });
    }
  }

  writeEntity(entityId, entityData, req.graphDir);

  res.status(201).json({
    status: 'created',
    entity_id: entityId,
    entity_type,
    name: displayName,
    entity: entityData,
  });
});

// DELETE /api/observe/:id — Delete a specific observation
app.delete('/api/observe/:id', apiAuth, (req, res) => {
  const obsId = req.params.id;
  const entities = listEntities(req.graphDir);

  for (const { file, data } of entities) {
    const observations = data.observations || [];
    const idx = observations.findIndex(o => o.observation_id === obsId);
    if (idx !== -1) {
      const removed = observations.splice(idx, 1)[0];
      const entityId = data.entity?.entity_id || file.replace('.json', '');

      // Log to provenance
      if (!data.provenance_chain) {
        data.provenance_chain = { created_at: new Date().toISOString(), created_by: 'api', source_documents: [], merge_history: [] };
      }
      data.provenance_chain.merge_history = data.provenance_chain.merge_history || [];
      data.provenance_chain.merge_history.push({
        merged_at: new Date().toISOString(),
        merged_by: req.agentId,
        changes: [`deleted observation ${obsId}`],
      });

      writeEntity(entityId, data, req.graphDir);

      return res.json({
        status: 'deleted',
        observation_id: obsId,
        entity_id: entityId,
        deleted_observation: removed,
      });
    }
  }

  res.status(404).json({ error: `Observation ${obsId} not found` });
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
      const existing = readEntity(entityId, req.graphDir);
      if (existing) {
        const { merged } = merge(existing, result);
        if (merged) writeEntity(entityId, merged, req.graphDir);
      } else {
        writeEntity(entityId, result, req.graphDir);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/graph/stats — Knowledge graph health check
app.get('/api/graph/stats', apiAuth, (req, res) => {
  const entities = listEntities(req.graphDir);
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

// --- Ingest UI ---

app.get('/ingest', (req, res) => {
  res.send(INGEST_HTML);
});

const INGEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChatGPT Import — Context Engine</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 40px 24px; }
  header { text-align: center; margin-bottom: 48px; }
  h1 { font-size: 2.2rem; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
  h1 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle { font-size: 1rem; color: #6b7280; margin-top: 8px; }
  .steps {
    font-size: 0.8rem; color: #4b5563; margin-top: 16px; line-height: 1.7;
    text-align: left; max-width: 480px; margin-left: auto; margin-right: auto;
  }
  .steps strong { color: #6b7280; }

  .field { margin-bottom: 20px; }
  .field label {
    display: block; font-size: 0.8rem; font-weight: 600; color: #6b7280;
    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
  }
  .field input {
    width: 100%; padding: 10px 14px; background: #12121a;
    border: 1px solid #1e1e2e; border-radius: 8px; color: #e0e0e0;
    font-size: 0.9rem; outline: none; font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .field input:focus { border-color: #6366f1; }

  .drop-zone {
    border: 2px dashed #2a2a3e; border-radius: 12px;
    padding: 48px 24px; text-align: center; cursor: pointer;
    transition: all 0.2s; background: #12121a; margin-bottom: 24px;
  }
  .drop-zone:hover, .drop-zone.dragover {
    border-color: #6366f1; background: rgba(99, 102, 241, 0.05);
  }
  .drop-zone.has-file {
    border-color: #34d399; background: rgba(52, 211, 153, 0.05);
  }
  .drop-icon { font-size: 1.6rem; margin-bottom: 10px; color: #3a3a4a; }
  .drop-text { color: #6b7280; font-size: 0.9rem; }
  .drop-text strong { color: #a78bfa; }
  .file-info {
    color: #34d399; font-size: 0.85rem; margin-top: 10px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .btn {
    width: 100%; padding: 14px; border: none; border-radius: 8px;
    font-size: 1rem; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
    transition: all 0.2s;
  }
  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .progress-section { display: none; margin: 24px 0; }
  .progress-section.active { display: block; }
  .progress-bar-bg {
    width: 100%; height: 8px; background: #1e1e2e;
    border-radius: 4px; overflow: hidden; margin-bottom: 12px;
  }
  .progress-bar {
    height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6);
    border-radius: 4px; transition: width 0.3s; width: 0%;
  }
  .progress-text { font-size: 0.85rem; color: #9ca3af; }
  .progress-stats {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem; color: #6b7280; margin-top: 8px;
  }

  .summary { display: none; margin: 24px 0; }
  .summary.active { display: block; }
  .summary-card {
    background: #12121a; border: 1px solid #1e1e2e;
    border-radius: 12px; padding: 24px;
  }
  .summary-title { font-size: 1.1rem; font-weight: 700; color: #34d399; margin-bottom: 16px; }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .summary-stat {
    background: #1a1a2e; border: 1px solid #2a2a3e;
    border-radius: 8px; padding: 14px; text-align: center;
  }
  .summary-stat-value { font-size: 1.5rem; font-weight: 700; color: #a78bfa; }
  .summary-stat-label {
    font-size: 0.7rem; color: #6b7280;
    text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;
  }

  .error-msg { color: #ef4444; font-size: 0.85rem; margin-top: 12px; display: none; }
  .error-msg.active { display: block; }

  footer {
    text-align: center; padding: 40px 24px 24px;
    color: #3a3a4a; font-size: 0.8rem;
  }
  footer a { color: #6b7280; text-decoration: none; }
  footer a:hover { color: #a78bfa; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>ChatGPT Import</span></h1>
    <p class="subtitle">Import your ChatGPT conversation history into the knowledge graph</p>
    <div class="steps">
      <strong>How it works:</strong> Go to ChatGPT Settings &rarr; Data Controls &rarr; Export Data.
      You will receive a zip file containing <strong>conversations.json</strong>.
      Drop that file below. The engine extracts every person and business
      you mentioned, deduplicates across conversations, and builds your graph.
    </div>
  </header>

  <div class="field">
    <label>API Key</label>
    <input type="password" id="apiKey" placeholder="ctx-..." />
  </div>

  <div class="drop-zone" id="dropZone">
    <div class="drop-icon">&#8593;</div>
    <div class="drop-text">Drag &amp; drop <strong>conversations.json</strong> here, or click to browse</div>
    <div class="file-info" id="fileInfo"></div>
  </div>
  <input type="file" id="fileInput" accept=".json" style="display:none" />

  <button class="btn" id="btnImport" onclick="startImport()" disabled>Import Conversations</button>
  <div class="error-msg" id="errorMsg"></div>

  <div class="progress-section" id="progress">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText">Starting import...</div>
    <div class="progress-stats" id="progressStats"></div>
  </div>

  <div class="summary" id="summary">
    <div class="summary-card">
      <div class="summary-title">Import Complete</div>
      <div class="summary-grid" id="summaryGrid"></div>
    </div>
  </div>
</div>

<footer>
  <a href="/">&larr; Back to Context Engine</a>
</footer>

<script>
var fileData = null;

var dropZone = document.getElementById('dropZone');
var fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', function() { fileInput.click(); });
dropZone.addEventListener('dragover', function(e) {
  e.preventDefault(); dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', function() {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', function(e) {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', function() {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file) return;
  showError('');
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Expected a JSON array of conversations');
      fileData = data;
      dropZone.classList.add('has-file');
      document.getElementById('fileInfo').textContent =
        file.name + ' \\u2014 ' + data.length + ' conversations (' + (file.size / 1048576).toFixed(1) + ' MB)';
      document.getElementById('btnImport').disabled = false;
    } catch (err) {
      showError('Invalid file: ' + err.message);
      fileData = null;
    }
  };
  reader.readAsText(file);
}

function showError(msg) {
  var el = document.getElementById('errorMsg');
  el.textContent = msg;
  if (msg) { el.classList.add('active'); } else { el.classList.remove('active'); }
}

async function startImport() {
  var apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) return showError('API key is required');
  if (!fileData) return showError('No file selected');

  document.getElementById('btnImport').disabled = true;
  showError('');
  document.getElementById('progress').classList.add('active');
  document.getElementById('summary').classList.remove('active');
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressText').textContent = 'Starting import...';
  document.getElementById('progressStats').textContent = '';

  try {
    var response = await fetch('/api/ingest/chatgpt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Context-API-Key': apiKey },
      body: JSON.stringify({ conversations: fileData }),
    });

    if (!response.ok && !response.headers.get('content-type').includes('ndjson')) {
      var errBody = await response.json();
      throw new Error(errBody.error || 'Request failed with status ' + response.status);
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try { handleEvent(JSON.parse(lines[i])); } catch (e) {}
      }
    }
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer)); } catch (e) {}
    }
  } catch (err) {
    showError(err.message);
  }

  document.getElementById('btnImport').disabled = false;
}

function handleEvent(event) {
  if (event.type === 'started') {
    document.getElementById('progressText').textContent =
      'Processing ' + event.total_conversations + ' conversations in ' + event.total_batches + ' batches...';
  } else if (event.type === 'progress') {
    var pct = Math.round((event.batch / event.total_batches) * 100);
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressText').textContent =
      'Batch ' + event.batch + ' / ' + event.total_batches +
      ' \\u2014 ' + event.conversations_processed + ' of ' + event.total_conversations + ' conversations';
    document.getElementById('progressStats').textContent =
      event.entities_created + ' created, ' +
      event.entities_updated + ' updated, ' +
      event.observations_added + ' observations';
  } else if (event.type === 'complete') {
    document.getElementById('progressBar').style.width = '100%';
    document.getElementById('progressText').textContent = 'Done!';
    showSummary(event.summary);
  } else if (event.type === 'batch_error') {
    var stats = document.getElementById('progressStats');
    stats.textContent += ' [batch ' + event.batch + ' error: ' + event.error + ']';
  }
}

function showSummary(s) {
  document.getElementById('summary').classList.add('active');
  var items = [
    { value: s.entities_created, label: 'Entities Created' },
    { value: s.entities_updated, label: 'Entities Updated' },
    { value: s.observations_added, label: 'Observations Added' },
    { value: s.conversations_processed, label: 'Conversations' },
    { value: s.processing_time_seconds + 's', label: 'Processing Time' },
  ];
  document.getElementById('summaryGrid').innerHTML = items.map(function(it) {
    return '<div class="summary-stat"><div class="summary-stat-value">' +
      it.value + '</div><div class="summary-stat-label">' + it.label + '</div></div>';
  }).join('');
}
</script>
</body>
</html>`;

// --- Wiki Dashboard ---

app.get('/wiki', (req, res) => {
  res.send(WIKI_HTML);
});

const WIKI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wiki — Context Engine</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f; color: #e0e0e0; height: 100vh; overflow: hidden;
  }

  /* --- Login --- */
  #login-screen {
    display: flex; align-items: center; justify-content: center;
    height: 100vh; flex-direction: column; gap: 20px;
  }
  .login-card {
    background: #12121a; border: 1px solid #1e1e2e; border-radius: 12px;
    padding: 40px; width: 380px; text-align: center;
  }
  .login-card h1 { font-size: 1.8rem; font-weight: 700; margin-bottom: 6px; }
  .login-card h1 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .login-card .subtitle { color: #6b7280; font-size: 0.9rem; margin-bottom: 24px; }
  .login-card input {
    width: 100%; padding: 10px 14px; background: #0a0a0f;
    border: 1px solid #2a2a3e; border-radius: 8px; color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9rem;
    outline: none; margin-bottom: 14px;
  }
  .login-card input:focus { border-color: #6366f1; }
  .login-error { color: #ef4444; font-size: 0.8rem; margin-bottom: 10px; display: none; }
  .login-error.active { display: block; }
  .btn {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    font-size: 0.95rem; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
    transition: all 0.2s;
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.3); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .google-btn {
    display: flex; align-items: center; justify-content: center;
    background: #fff; color: #333; text-decoration: none; margin-bottom: 16px;
    font-size: 0.9rem; font-weight: 600;
  }
  .google-btn:hover { background: #f0f0f0; box-shadow: 0 4px 20px rgba(0,0,0,0.15); }
  .login-divider {
    display: flex; align-items: center; margin-bottom: 14px; color: #4b5563; font-size: 0.75rem;
  }
  .login-divider::before, .login-divider::after {
    content: ''; flex: 1; border-bottom: 1px solid #2a2a3e;
  }
  .login-divider span { padding: 0 10px; }

  /* --- App Layout --- */
  #app { display: none; height: 100vh; }
  #sidebar {
    width: 280px; min-width: 280px; border-right: 1px solid #1e1e2e;
    display: flex; flex-direction: column; background: #0d0d14;
  }
  .sidebar-header {
    padding: 16px; border-bottom: 1px solid #1e1e2e;
  }
  .sidebar-header h2 {
    font-size: 1rem; font-weight: 700; margin-bottom: 10px;
  }
  .sidebar-header h2 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  #searchInput {
    width: 100%; padding: 8px 12px; background: #12121a;
    border: 1px solid #1e1e2e; border-radius: 6px; color: #e0e0e0;
    font-size: 0.82rem; outline: none;
  }
  #searchInput:focus { border-color: #6366f1; }
  .sidebar-count {
    padding: 6px 16px; font-size: 0.7rem; color: #4b5563;
    text-transform: uppercase; letter-spacing: 0.05em;
    border-bottom: 1px solid #1e1e2e;
  }
  #entityList { flex: 1; overflow-y: auto; }
  .entity-item {
    padding: 10px 16px; cursor: pointer;
    border-bottom: 1px solid rgba(30,30,46,0.5); transition: background 0.15s;
  }
  .entity-item:hover { background: rgba(99,102,241,0.05); }
  .entity-item.active { background: rgba(99,102,241,0.1); border-left: 3px solid #6366f1; }
  .entity-item-name { font-size: 0.85rem; font-weight: 600; color: #e0e0e0; margin-bottom: 2px; }
  .entity-item-summary {
    font-size: 0.72rem; color: #4b5563; line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .type-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 1px 6px; border-radius: 3px; text-transform: uppercase;
    letter-spacing: 0.03em; vertical-align: middle; margin-left: 6px;
  }
  .type-badge.person { background: rgba(139,92,246,0.15); color: #a78bfa; }
  .type-badge.business { background: rgba(14,165,233,0.15); color: #38bdf8; }

  /* --- Main Panel --- */
  #main {
    flex: 1; overflow-y: auto; padding: 28px 32px;
  }
  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: #3a3a4a; font-size: 0.95rem; text-align: center;
    line-height: 1.7;
  }
  .detail-header { margin-bottom: 24px; }
  .detail-header h2 { font-size: 1.5rem; font-weight: 700; color: #fff; display: inline; }
  .entity-id-badge {
    font-size: 0.7rem; color: #6366f1;
    font-family: 'SF Mono', 'Fira Code', monospace;
    background: rgba(99,102,241,0.1); padding: 2px 8px;
    border-radius: 4px; margin-left: 8px; vertical-align: middle;
  }

  /* --- Sections --- */
  .section {
    background: #12121a; border: 1px solid #1e1e2e; border-radius: 10px;
    padding: 16px; margin-bottom: 16px;
  }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .section-title {
    font-size: 0.75rem; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.06em; color: #6b7280;
  }
  .section-title-only { margin-bottom: 10px; }
  .summary-text { font-size: 0.88rem; color: #9ca3af; line-height: 1.6; }
  .summary-edit {
    width: 100%; min-height: 70px; padding: 10px; background: #0a0a0f;
    border: 1px solid #2a2a3e; border-radius: 6px; color: #e0e0e0;
    font-family: inherit; font-size: 0.88rem; line-height: 1.6;
    resize: vertical; outline: none;
  }
  .summary-edit:focus { border-color: #6366f1; }
  .edit-actions { margin-top: 8px; display: flex; gap: 8px; }

  /* --- Attributes, Relationships, Values --- */
  .attr-row, .rel-row, .value-item {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 5px 0; font-size: 0.82rem; flex-wrap: wrap;
  }
  .attr-key {
    color: #8b5cf6; font-weight: 600; min-width: 80px; flex-shrink: 0;
  }
  .attr-value { color: #e0e0e0; flex: 1; }
  .rel-name { color: #e0e0e0; font-weight: 600; min-width: 100px; }
  .rel-type {
    color: #38bdf8; font-size: 0.75rem; background: rgba(14,165,233,0.1);
    padding: 1px 6px; border-radius: 3px;
  }
  .rel-context { color: #6b7280; font-size: 0.78rem; flex: 1; }
  .rel-sentiment {
    font-size: 0.65rem; padding: 1px 6px; border-radius: 4px;
  }
  .sentiment-positive { background: rgba(52,211,153,0.12); color: #34d399; }
  .sentiment-neutral { background: rgba(156,163,175,0.12); color: #9ca3af; }
  .sentiment-strained { background: rgba(239,68,68,0.12); color: #ef4444; }
  .value-text { color: #e0e0e0; }

  /* --- Badges --- */
  .badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 1px 6px; border-radius: 4px; text-transform: uppercase;
    letter-spacing: 0.03em; white-space: nowrap; vertical-align: middle;
  }
  .badge-verified { background: rgba(52,211,153,0.15); color: #34d399; }
  .badge-strong { background: rgba(96,165,250,0.15); color: #60a5fa; }
  .badge-moderate { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .badge-speculative { background: rgba(251,146,60,0.15); color: #fb923c; }
  .badge-uncertain { background: rgba(239,68,68,0.15); color: #ef4444; }
  .badge-layer {
    font-size: 0.58rem; padding: 1px 5px; border-radius: 3px;
  }
  .badge-layer-1 { background: rgba(52,211,153,0.1); color: #6ee7b7; }
  .badge-layer-2 { background: rgba(96,165,250,0.1); color: #93c5fd; }
  .badge-layer-3 { background: rgba(244,114,182,0.1); color: #f9a8d4; }

  /* --- Observations --- */
  .obs-card {
    background: #0d0d14; border: 1px solid #1a1a2e; border-radius: 8px;
    padding: 10px 12px; margin-bottom: 8px; transition: opacity 0.3s;
  }
  .obs-text { font-size: 0.84rem; color: #d1d5db; line-height: 1.5; margin-bottom: 6px; }
  .obs-meta {
    display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    font-size: 0.7rem;
  }
  .obs-source {
    color: #4b5563; font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.65rem;
  }
  .obs-date { color: #4b5563; font-size: 0.65rem; }
  .obs-decay {
    font-size: 0.6rem; color: #4b5563;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .btn-delete {
    background: none; border: 1px solid rgba(239,68,68,0.2); color: #ef4444;
    font-size: 0.6rem; padding: 1px 6px; border-radius: 3px; cursor: pointer;
    margin-left: auto; opacity: 0.5; transition: opacity 0.15s;
  }
  .btn-delete:hover { opacity: 1; background: rgba(239,68,68,0.1); }

  /* --- Forms --- */
  .add-obs-form { margin-top: 12px; }
  .obs-textarea {
    width: 100%; min-height: 56px; padding: 10px; background: #0a0a0f;
    border: 1px solid #2a2a3e; border-radius: 6px; color: #e0e0e0;
    font-family: inherit; font-size: 0.84rem; line-height: 1.5;
    resize: vertical; outline: none; margin-bottom: 8px;
  }
  .obs-textarea:focus { border-color: #6366f1; }
  .obs-form-row { display: flex; gap: 8px; align-items: center; }
  .obs-form-row select {
    padding: 6px 10px; background: #0a0a0f; border: 1px solid #2a2a3e;
    border-radius: 6px; color: #e0e0e0; font-size: 0.78rem; outline: none;
  }
  .obs-form-row select:focus { border-color: #6366f1; }
  .btn-sm {
    padding: 4px 12px; border: 1px solid #2a2a3e; border-radius: 5px;
    background: transparent; color: #6b7280; font-size: 0.72rem;
    cursor: pointer; transition: all 0.15s;
  }
  .btn-sm:hover { border-color: #6366f1; color: #a78bfa; }
  .btn-add {
    padding: 6px 16px; border: none; border-radius: 6px;
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
    font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all 0.15s;
  }
  .btn-add:hover { transform: translateY(-1px); box-shadow: 0 2px 12px rgba(99,102,241,0.3); }
  .btn-add:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-save {
    padding: 4px 14px; border: none; border-radius: 5px;
    background: #34d399; color: #0a0a0f; font-size: 0.72rem;
    font-weight: 600; cursor: pointer;
  }
  .btn-cancel {
    padding: 4px 14px; border: 1px solid #2a2a3e; border-radius: 5px;
    background: transparent; color: #6b7280; font-size: 0.72rem; cursor: pointer;
  }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: #1a1a2e; border: 1px solid #2a2a3e; border-radius: 8px;
    padding: 10px 18px; font-size: 0.82rem; color: #34d399;
    display: none; z-index: 100; animation: fadeIn 0.2s;
  }
  .toast.active { display: block; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

  .sidebar-footer {
    padding: 10px 16px; border-top: 1px solid #1e1e2e;
    font-size: 0.7rem; color: #3a3a4a; text-align: center;
  }
  .sidebar-footer a { color: #4b5563; text-decoration: none; }
  .sidebar-footer a:hover { color: #a78bfa; }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login-screen">
  <div class="login-card">
    <h1><span>Context Engine</span></h1>
    <p class="subtitle">Knowledge Graph Wiki</p>
    <a href="/auth/google" class="btn google-btn" id="btnGoogle">
      <svg width="18" height="18" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:8px;">
        <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 010-9.18l-7.98-6.19a24.1 24.1 0 000 21.56l7.98-6.19z"/>
        <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Sign in with Google
    </a>
    <div class="login-divider"><span>or use API key</span></div>
    <input type="password" id="apiKeyInput" placeholder="Enter API key (ctx-...)" />
    <div class="login-error" id="loginError"></div>
    <button class="btn" id="btnLogin" onclick="login()">Connect</button>
  </div>
</div>

<!-- App -->
<div id="app">
  <div id="sidebar">
    <div class="sidebar-header">
      <h2><span>Entities</span></h2>
      <input type="text" id="searchInput" placeholder="Search entities..." oninput="onSearch()" />
    </div>
    <div class="sidebar-count" id="sidebarCount"></div>
    <div id="entityList"></div>
    <div class="sidebar-footer">
      <span id="userInfo"></span>
      <a href="/">&larr; Context Engine</a> &middot; <a href="/ingest">Import</a>
      <span id="logoutLink"></span>
    </div>
  </div>
  <div id="main">
    <div class="empty-state" id="emptyState">Select an entity from the sidebar<br/>to view its knowledge graph profile</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var apiKey = '';
var sessionUser = null;
var entities = [];
var selectedId = null;
var selectedData = null;
var searchTimeout = null;

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function api(method, path, body) {
  var opts = {
    method: method,
    headers: { 'X-Agent-Id': 'wiki-dashboard' },
    credentials: 'same-origin',
  };
  if (apiKey) opts.headers['X-Context-API-Key'] = apiKey;
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function(r) {
    if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || 'Request failed'); });
    return r.json();
  });
}

function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('active');
  setTimeout(function() { el.classList.remove('active'); }, 2000);
}

function enterApp(user) {
  sessionUser = user;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  if (user && user.name) {
    document.getElementById('userInfo').textContent = user.name + ' ';
    document.getElementById('logoutLink').innerHTML = ' &middot; <a href="#" onclick="logout();return false;">Logout</a>';
  }
  api('GET', '/api/search?q=*').then(function(data) {
    entities = data.results || [];
    renderEntityList();
  });
}

function logout() {
  fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }).then(function() {
    window.location.reload();
  });
}

/* --- Login --- */
// Auto-login: check for existing session cookie
fetch('/auth/me', { credentials: 'same-origin' }).then(function(r) {
  if (r.ok) return r.json();
  return null;
}).then(function(user) {
  if (user && user.tenant_id) {
    enterApp(user);
  }
}).catch(function() {});

// Manual API key login
function login() {
  apiKey = document.getElementById('apiKeyInput').value.trim();
  if (!apiKey) return;
  document.getElementById('btnLogin').disabled = true;
  api('GET', '/api/search?q=*').then(function(data) {
    entities = data.results || [];
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderEntityList();
  }).catch(function(err) {
    var el = document.getElementById('loginError');
    el.textContent = err.message; el.classList.add('active');
    document.getElementById('btnLogin').disabled = false;
  });
}
document.getElementById('apiKeyInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') login();
});

/* --- Sidebar --- */
function onSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(function() {
    var q = document.getElementById('searchInput').value.trim() || '*';
    api('GET', '/api/search?q=' + encodeURIComponent(q)).then(function(data) {
      entities = data.results || [];
      renderEntityList();
    });
  }, 250);
}

function renderEntityList() {
  var html = '';
  for (var i = 0; i < entities.length; i++) {
    var e = entities[i];
    var cls = e.entity_id === selectedId ? 'entity-item active' : 'entity-item';
    html += '<div class="' + cls + '" onclick="selectEntity(\\'' + esc(e.entity_id) + '\\')">';
    html += '<div><span class="entity-item-name">' + esc(e.name) + '</span>';
    html += '<span class="type-badge ' + e.entity_type + '">' + e.entity_type + '</span></div>';
    if (e.summary) html += '<div class="entity-item-summary">' + esc(e.summary) + '</div>';
    html += '</div>';
  }
  document.getElementById('entityList').innerHTML = html || '<div style="padding:16px;color:#3a3a4a;font-size:0.82rem;">No entities found</div>';
  document.getElementById('sidebarCount').textContent = entities.length + ' entit' + (entities.length === 1 ? 'y' : 'ies');
}

/* --- Entity Detail --- */
function selectEntity(id) {
  selectedId = id;
  document.getElementById('emptyState').style.display = 'none';
  api('GET', '/api/entity/' + id).then(function(data) {
    selectedData = data;
    renderDetail(data);
    renderEntityList();
  });
}

function confidenceBadge(conf, label) {
  if (conf == null && !label) return '';
  var cls = 'badge-moderate'; var lbl = label || '';
  if (conf >= 0.90 || lbl === 'VERIFIED') { cls = 'badge-verified'; lbl = lbl || 'VERIFIED'; }
  else if (conf >= 0.75 || lbl === 'STRONG') { cls = 'badge-strong'; lbl = lbl || 'STRONG'; }
  else if (conf >= 0.50 || lbl === 'MODERATE') { cls = 'badge-moderate'; lbl = lbl || 'MODERATE'; }
  else if (conf >= 0.25 || lbl === 'SPECULATIVE') { cls = 'badge-speculative'; lbl = lbl || 'SPECULATIVE'; }
  else { cls = 'badge-uncertain'; lbl = lbl || 'UNCERTAIN'; }
  return ' <span class="badge ' + cls + '">' + lbl + (conf != null ? ' ' + conf.toFixed(2) : '') + '</span>';
}

function layerBadge(layer) {
  if (!layer) return '';
  var labels = { 1: 'Objective', 2: 'Group', 3: 'Personal' };
  return ' <span class="badge badge-layer badge-layer-' + layer + '">L' + layer + ' ' + (labels[layer] || '') + '</span>';
}

function sentimentBadge(s) {
  if (!s) return '';
  var cls = 'sentiment-neutral';
  if (s === 'positive') cls = 'sentiment-positive';
  else if (s === 'strained') cls = 'sentiment-strained';
  return ' <span class="rel-sentiment ' + cls + '">' + esc(s) + '</span>';
}

function calcDecay(observedAt) {
  if (!observedAt) return 1;
  var days = Math.max(0, (Date.now() - new Date(observedAt).getTime()) / 86400000);
  return Math.exp(-0.03 * days);
}

function renderDetail(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  var summary = e.summary?.value || '';
  var meta = data.extraction_metadata || {};
  var h = '';

  // Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += confidenceBadge(meta.extraction_confidence);
  h += '</div>';

  // Summary
  h += '<div class="section">';
  h += '<div class="section-header"><span class="section-title">Summary</span>';
  h += '<button class="btn-sm" id="btnEditSummary" onclick="toggleSummaryEdit()">Edit</button></div>';
  h += '<div id="summaryDisplay" class="summary-text">' + esc(summary) + '</div>';
  h += '<div id="summaryEditSection" style="display:none">';
  h += '<textarea class="summary-edit" id="summaryEdit">' + esc(summary) + '</textarea>';
  h += '<div class="edit-actions"><button class="btn-save" onclick="saveSummary()">Save</button>';
  h += '<button class="btn-cancel" onclick="toggleSummaryEdit()">Cancel</button></div>';
  h += '</div></div>';

  // Attributes
  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Attributes</div>';
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      h += '<div class="attr-row"><span class="attr-key">' + esc(a.key) + '</span>';
      h += '<span class="attr-value">' + esc(String(a.value || '')) + '</span>';
      h += confidenceBadge(a.confidence, a.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Relationships
  var rels = data.relationships || [];
  if (rels.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Relationships</div>';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += sentimentBadge(r.sentiment);
      h += confidenceBadge(r.confidence, r.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Values
  var vals = data.values || [];
  if (vals.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Values</div>';
    for (var i = 0; i < vals.length; i++) {
      h += '<div class="value-item"><span class="value-text">' + esc(vals[i].value || '') + '</span>';
      h += confidenceBadge(vals[i].confidence, vals[i].confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Observations
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  h += '<div class="section"><div class="section-title section-title-only">Observations (' + obs.length + ')</div>';
  if (obs.length === 0) {
    h += '<div style="color:#3a3a4a;font-size:0.82rem;padding:8px 0;">No observations yet</div>';
  }
  for (var i = 0; i < obs.length; i++) {
    var o = obs[i];
    var decay = calcDecay(o.observed_at);
    var opacity = Math.max(0.35, decay);
    h += '<div class="obs-card" style="opacity:' + opacity.toFixed(2) + '">';
    h += '<div class="obs-text">' + esc(o.observation) + '</div>';
    h += '<div class="obs-meta">';
    h += confidenceBadge(o.confidence, o.confidence_label);
    h += layerBadge(o.layer_number);
    if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
    h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
    h += '<span class="obs-decay">' + (decay * 100).toFixed(0) + '% weight</span>';
    h += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
    h += '</div></div>';
  }
  h += '</div>';

  // Add Observation Form
  h += '<div class="section"><div class="section-title section-title-only">Add Observation</div>';
  h += '<div class="add-obs-form">';
  h += '<textarea class="obs-textarea" id="obsText" placeholder="What did you learn about this entity?"></textarea>';
  h += '<div class="obs-form-row">';
  h += '<select id="obsConfidence"><option value="VERIFIED">Verified</option>';
  h += '<option value="STRONG" selected>Strong</option><option value="MODERATE">Moderate</option>';
  h += '<option value="SPECULATIVE">Speculative</option><option value="UNCERTAIN">Uncertain</option></select>';
  h += '<select id="obsLayer"><option value="L1_OBJECTIVE">L1 Objective</option>';
  h += '<option value="L2_GROUP" selected>L2 Group</option><option value="L3_PERSONAL">L3 Personal</option></select>';
  h += '<button class="btn-add" id="btnAddObs" onclick="addObs()">Add Observation</button>';
  h += '</div></div></div>';

  document.getElementById('main').innerHTML = h;
}

/* --- Actions --- */
function toggleSummaryEdit() {
  var d = document.getElementById('summaryDisplay');
  var e = document.getElementById('summaryEditSection');
  if (e.style.display === 'none') {
    e.style.display = 'block'; d.style.display = 'none';
  } else {
    e.style.display = 'none'; d.style.display = 'block';
  }
}

function saveSummary() {
  var val = document.getElementById('summaryEdit').value;
  api('PATCH', '/api/entity/' + selectedId, { summary: val }).then(function() {
    toast('Summary updated');
    selectEntity(selectedId);
  }).catch(function(err) { toast('Error: ' + err.message); });
}

function addObs() {
  var text = document.getElementById('obsText').value.trim();
  if (!text) return;
  document.getElementById('btnAddObs').disabled = true;
  api('POST', '/api/observe', {
    entity_id: selectedId,
    observation: text,
    confidence_label: document.getElementById('obsConfidence').value,
    facts_layer: document.getElementById('obsLayer').value,
  }).then(function() {
    toast('Observation added');
    selectEntity(selectedId);
  }).catch(function(err) {
    toast('Error: ' + err.message);
    document.getElementById('btnAddObs').disabled = false;
  });
}

function deleteObs(obsId) {
  if (!obsId || !confirm('Delete this observation?')) return;
  api('DELETE', '/api/observe/' + obsId).then(function() {
    toast('Observation deleted');
    selectEntity(selectedId);
  }).catch(function(err) { toast('Error: ' + err.message); });
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
  console.log('  Wiki:   http://localhost:' + PORT + '/wiki');
  console.log('  Import: http://localhost:' + PORT + '/ingest');
  console.log('  API:    http://localhost:' + PORT + '/api/graph/stats');
  console.log('  Auth:   http://localhost:' + PORT + '/auth/google' + (process.env.GOOGLE_CLIENT_ID ? '' : ' (not configured)'));
  console.log('  Graph:  ' + GRAPH_DIR + (GRAPH_IS_PERSISTENT ? ' (persistent disk)' : ' (local)'));
  console.log('');
});
