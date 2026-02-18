#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { merge } = require('./merge-engine');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { readEntity, writeEntity, listEntities, listEntitiesByType, getNextCounter, loadConnectedObjects } = require('./src/graph-ops');
const { ingestPipeline } = require('./src/ingest-pipeline');
const { normalizeFileToText } = require('./src/parsers/normalize');
const { buildLinkedInPrompt, linkedInResponseToEntity } = require('./src/parsers/linkedin');
const { mapContactRows } = require('./src/parsers/contacts');
const auth = require('./src/auth');
const drive = require('./src/drive');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.set('trust proxy', 1); // MUST be first — Render terminates HTTPS at load balancer
app.set('etag', false);

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: false,  // inline scripts in HTML templates
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Context-API-Key, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '200mb' }));
app.use(cookieParser());

// --- Rate limiting ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many share requests, please try again later.' },
});

const sharedViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please try again in a minute.',
});

app.use('/api/', apiLimiter);

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

// --- Share helpers ---

function loadShares(tenantDir) {
  const sharesPath = path.join(tenantDir, 'shares.json');
  if (!fs.existsSync(sharesPath)) return [];
  return JSON.parse(fs.readFileSync(sharesPath, 'utf-8'));
}

function saveShares(tenantDir, shares) {
  fs.writeFileSync(path.join(tenantDir, 'shares.json'), JSON.stringify(shares, null, 2) + '\n');
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

function buildGenericTextPrompt(text, filename) {
  const truncated = text.length > 50000 ? text.substring(0, 50000) + '\n[...truncated]' : text;

  return `You are a structured data extraction engine. Analyze this document and extract every person and business mentioned by name.

This is a raw text document (not a ChatGPT conversation). It may contain:
- Personal notes, memories, or relationship descriptions
- Professional profiles, resumes, or bios
- Meeting notes, journal entries, or correspondence
- Any other text mentioning real people or organizations

RULES:
- Extract ALL named persons and businesses — even if only briefly mentioned
- entity_type: "person" or "business"
- name: { "full": "..." } for persons, { "common": "..." } for businesses
- summary: 2-3 sentences synthesizing what the document says about this entity
- attributes: only include clearly stated facts (role, location, expertise, industry, email, phone)
- relationships: connections between extracted entities or between an entity and the document author
- observations: each distinct piece of information about the entity, with the raw text snippet
- Do NOT invent information beyond what is explicitly stated
- If no named entities found, return {"entities": []}

Output ONLY valid JSON, no markdown fences, no commentary:
{
  "entities": [
    {
      "entity_type": "person",
      "name": { "full": "Jane Smith" },
      "summary": "...",
      "attributes": { "role": "...", "location": "..." },
      "relationships": [{ "name": "Other Entity", "relationship": "colleague", "context": "..." }],
      "observations": [{ "text": "What the document says about this entity" }]
    }
  ]
}

Source file: ${filename}

--- DOCUMENT TEXT ---
${truncated}
--- END ---`;
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

  // Source 2: Bearer token or ca_session cookie (browser sessions via Google OAuth)
  const session = auth.verifySession(req);
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
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json']);

app.post('/api/ingest/files', apiAuth, upload.array('files', 20), async (req, res) => {
  const files = req.files;
  if (files) {
    for (const f of files) {
      console.log('INGEST_DEBUG: file received:', f.originalname, f.mimetype, f.size);
    }
  }
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
      // JSON files: detect ChatGPT conversations format, otherwise treat as raw text
      if (path.extname(filename).toLowerCase() === '.json') {
        const raw = file.buffer.toString('utf-8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }

        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].mapping && parsed[0].title !== undefined) {
          // ChatGPT conversations.json format
          const conversations = parseChatGPTExport(parsed);
          if (conversations.length > 0) {
            const BATCH_SIZE = 5;
            let created = 0, updated = 0, obsAdded = 0;
            for (let b = 0; b < conversations.length; b += BATCH_SIZE) {
              const batch = conversations.slice(b, b + BATCH_SIZE);
              const prompt = buildIngestPrompt(batch);
              const message = await client.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 16384,
                messages: [{ role: 'user', content: prompt }],
              });
              const rawResp = message.content[0].text;
              const cleaned = rawResp.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
              const batchParsed = JSON.parse(cleaned);
              const entities = (batchParsed.entities || []).filter(e => e && ['person', 'business'].includes(e.entity_type));
              if (entities.length > 0) {
                const r = await ingestPipeline(entities, req.graphDir, req.agentId, { source: filename, truthLevel: 'INFERRED' });
                created += r.created; updated += r.updated; obsAdded += r.observationsAdded;
              }
            }
            sendEvent({ type: 'file_progress', file: filename, file_index: fi + 1, total_files: files.length, entities_created: created, entities_updated: updated, observations_added: obsAdded });
            totalCreated += created; totalUpdated += updated; totalObservations += obsAdded;
            continue;
          }
        }
        // Not ChatGPT format — fall through to generic text extraction
      }

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
        console.log('INGEST_DEBUG: generic text path for', filename, '— text length:', text.length);
        const prompt = buildGenericTextPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        console.log('INGEST_DEBUG: Claude response length:', rawResponse.length, 'first 200 chars:', rawResponse.substring(0, 200));
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        console.log('INGEST_DEBUG: extracted entities count:', (parsed.entities || []).length);

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

      const progressEvent = {
        type: 'file_progress',
        file: filename,
        file_index: fi + 1,
        total_files: files.length,
        entities_created: result.created,
        entities_updated: result.updated,
        observations_added: result.observationsAdded,
      };
      if (result.created === 0 && result.updated === 0) {
        progressEvent.warning = 'No named entities found in this file. The file may not contain recognizable person or business names.';
        console.log('INGEST_DEBUG: 0 entities extracted from', filename);
      }
      sendEvent(progressEvent);

    } catch (err) {
      console.error('INGEST_DEBUG: extraction error for', filename, err.message);
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

// --- Google Drive integration ---

// Helper: get tenant's Drive tokens from tenants.json
function getDriveTokens(tenantId) {
  const tenants = loadTenants();
  const tenant = tenants[tenantId];
  if (!tenant) return null;
  return { accessToken: tenant.access_token, refreshToken: tenant.refresh_token, tenant, tenants };
}

function saveDriveToken(tenantId, newAccessToken) {
  const tenants = loadTenants();
  if (tenants[tenantId]) {
    tenants[tenantId].access_token = newAccessToken;
    saveTenants(tenants);
  }
}

// GET /api/drive/files?folderId=X&q=searchterm — List or search Drive files
app.get('/api/drive/files', apiAuth, async (req, res) => {
  const tokens = getDriveTokens(req.tenantId);
  if (!tokens || !tokens.accessToken) {
    return res.status(401).json({ error: 'No Google Drive access. Please sign in with Google.' });
  }

  const folderId = req.query.folderId || null;
  const searchQuery = req.query.q || null;

  try {
    let files;
    if (searchQuery) {
      const r = await drive.withTokenRefresh(
        (token) => drive.searchFiles(token, searchQuery),
        tokens.accessToken,
        tokens.refreshToken,
      );
      files = r.result;
      if (r.newAccessToken) saveDriveToken(req.tenantId, r.newAccessToken);
      res.json({ files, search: searchQuery });
    } else {
      const r = await drive.withTokenRefresh(
        (token) => drive.listFiles(token, folderId),
        tokens.accessToken,
        tokens.refreshToken,
      );
      files = r.result;
      if (r.newAccessToken) saveDriveToken(req.tenantId, r.newAccessToken);
      res.json({ files, folderId: folderId || 'root' });
    }
  } catch (err) {
    console.error('Drive list error:', err.message);
    res.status(500).json({ error: 'Failed to list Drive files: ' + err.message });
  }
});

// POST /api/drive/ingest — Download files from Drive and ingest
app.post('/api/drive/ingest', apiAuth, async (req, res) => {
  console.log('INGEST_DEBUG: drive ingest request, fileIds:', req.body?.fileIds);
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'Missing fileIds array' });
  }

  const tokens = getDriveTokens(req.tenantId);
  if (!tokens || !tokens.accessToken) {
    return res.status(401).json({ error: 'No Google Drive access. Please sign in with Google.' });
  }

  let currentToken = tokens.accessToken;

  // Stream NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');
  sendEvent({ type: 'started', total_files: fileIds.length });

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalObservations = 0;
  const client = new Anthropic();

  for (let fi = 0; fi < fileIds.length; fi++) {
    const fileId = fileIds[fi];
    let filename = fileId;

    try {
      // Download from Drive (with token refresh)
      sendEvent({ type: 'file_downloading', file_index: fi + 1, file_id: fileId });

      const { result: downloaded, newAccessToken } = await drive.withTokenRefresh(
        (token) => drive.downloadFile(token, fileId),
        currentToken,
        tokens.refreshToken,
      );
      if (newAccessToken) {
        currentToken = newAccessToken;
        saveDriveToken(req.tenantId, newAccessToken);
      }

      const { buffer, filename: dlFilename } = downloaded;
      filename = dlFilename;

      // Run through the same parser pipeline as file upload
      const { text, metadata } = await normalizeFileToText(buffer, filename);

      let result;

      if (metadata.isContactList && metadata.rows) {
        const entities = mapContactRows(metadata.rows, filename, req.agentId);
        result = await ingestPipeline(entities, req.graphDir, req.agentId, {
          source: `drive:${filename}`,
          truthLevel: 'STRONG',
        });
      } else if (metadata.isLinkedIn) {
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
          source: `drive:${filename}`,
          truthLevel: 'INFERRED',
        });
      } else {
        console.log('INGEST_DEBUG: drive generic text path for', filename, '— text length:', text.length);
        const prompt = buildGenericTextPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        console.log('INGEST_DEBUG: drive Claude response length:', rawResponse.length);
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        console.log('INGEST_DEBUG: drive extracted entities count:', (parsed.entities || []).length);

        const now = new Date().toISOString();
        const v2Entities = (parsed.entities || []).map(extracted => {
          const entityType = extracted.entity_type;
          if (!entityType || !['person', 'business'].includes(entityType)) return null;

          const observations = (extracted.observations || []).map(obs => ({
            observation: (obs.text || '').trim(),
            observed_at: now,
            source: `drive_import:${filename}`,
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
              source_description: `drive_import:${filename}`,
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
              source_documents: [{ source: `drive_import:${filename}`, ingested_at: now }],
              merge_history: [],
            },
          };
        }).filter(Boolean);

        result = await ingestPipeline(v2Entities, req.graphDir, req.agentId, {
          source: `drive:${filename}`,
          truthLevel: 'INFERRED',
        });
      }

      totalCreated += result.created;
      totalUpdated += result.updated;
      totalObservations += result.observationsAdded;

      const progressEvent = {
        type: 'file_progress',
        file: filename,
        file_index: fi + 1,
        total_files: fileIds.length,
        entities_created: result.created,
        entities_updated: result.updated,
        observations_added: result.observationsAdded,
      };
      if (result.created === 0 && result.updated === 0) {
        progressEvent.warning = 'No named entities found in this file. The file may not contain recognizable person or business names.';
        console.log('INGEST_DEBUG: 0 entities extracted from', filename);
      }
      sendEvent(progressEvent);

    } catch (err) {
      console.error('INGEST_DEBUG: drive extraction error for', filename, err.message);
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
      files_processed: fileIds.length,
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

// GET /api/entity/:id/connected — Entity + all connected objects
app.get('/api/entity/:id/connected', apiAuth, (req, res) => {
  const result = loadConnectedObjects(req.params.id, req.graphDir);
  if (!result) return res.status(404).json({ error: 'Entity not found' });
  res.json(result);
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

// GET /api/search?q=&type= — Fuzzy search entities with optional type filter
app.get('/api/search', apiAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const typeFilter = req.query.type
    ? req.query.type.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    : null;

  const { similarity } = require('./merge-engine');
  let entities = listEntities(req.graphDir);

  // Apply type filter if specified
  if (typeFilter) {
    entities = entities.filter(({ data }) => {
      const type = (data.entity || {}).entity_type;
      return typeFilter.includes(type);
    });
  }

  // Resolve entity name across all types
  function getEntityName(e) {
    var type = e.entity_type;
    if (type === 'person') return e.name?.full || '';
    if (type === 'business') return e.name?.common || e.name?.legal || '';
    return e.name?.full || e.name?.common || '';
  }

  // Wildcard: return all entities
  if (q === '*') {
    const all = entities.map(({ data }) => {
      const e = data.entity || {};
      const name = getEntityName(e);
      return { entity_id: e.entity_id, entity_type: e.entity_type, name, summary: e.summary?.value || '', match_score: 1.0 };
    });
    return res.json({ query: q, count: all.length, results: all });
  }

  const results = [];

  for (const { data } of entities) {
    const e = data.entity || {};
    const type = e.entity_type;
    let name = getEntityName(e);
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

// --- Share API routes ---

// POST /api/share — Create a new share link for a Career Lite entity
app.post('/api/share', apiAuth, shareLimiter, (req, res) => {
  const { entityId, sections, expiresInDays } = req.body;

  // Validate entityId
  if (!entityId || typeof entityId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid entityId' });
  }
  if (!/^[\w-]+$/.test(entityId)) {
    return res.status(400).json({ error: 'Invalid entityId format' });
  }

  // Validate sections
  const allowedSections = ['summary', 'experience', 'education', 'skills', 'connections'];
  if (sections !== undefined && !Array.isArray(sections)) {
    return res.status(400).json({ error: 'sections must be an array of strings' });
  }
  if (sections && !sections.every(s => typeof s === 'string' && allowedSections.includes(s))) {
    return res.status(400).json({ error: 'Invalid section. Allowed: ' + allowedSections.join(', ') });
  }

  // Validate expiresInDays
  const validExpiries = [7, 30, 90, 365];
  if (expiresInDays !== undefined && !validExpiries.includes(expiresInDays)) {
    return res.status(400).json({ error: 'expiresInDays must be one of: ' + validExpiries.join(', ') });
  }

  const entityPath = path.join(req.graphDir, entityId + '.json');
  if (!fs.existsSync(entityPath)) return res.status(404).json({ error: 'Entity not found' });

  const entityData = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
  if (!entityData.career_lite || entityData.career_lite.interface !== 'career-lite') {
    return res.status(400).json({ error: 'Entity is not a Career Lite profile' });
  }

  const shareId = crypto.randomBytes(9).toString('base64url');
  const now = new Date();
  const days = expiresInDays || 30;
  const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();

  const selectedSections = (sections || ['summary', 'experience', 'education', 'skills'])
    .filter(s => allowedSections.includes(s));

  const share = {
    shareId,
    tenantId: req.tenantId,
    entityId,
    sections: selectedSections,
    createdAt: now.toISOString(),
    expiresAt,
  };

  const shares = loadShares(req.graphDir);
  shares.push(share);
  saveShares(req.graphDir, shares);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const shareUrl = `${protocol}://${host}/shared/${shareId}`;

  res.json({ shareId, shareUrl, sections: selectedSections, expiresAt });
});

// GET /api/shares/:entityId — List non-expired shares for an entity
app.get('/api/shares/:entityId', apiAuth, (req, res) => {
  const shares = loadShares(req.graphDir);
  const now = new Date().toISOString();
  const active = shares.filter(s => s.entityId === req.params.entityId && s.expiresAt > now);
  res.json(active);
});

// DELETE /api/share/:shareId — Revoke a share
app.delete('/api/share/:shareId', apiAuth, (req, res) => {
  const shares = loadShares(req.graphDir);
  const idx = shares.findIndex(s => s.shareId === req.params.shareId);
  if (idx === -1) return res.status(404).json({ error: 'Share not found' });
  shares.splice(idx, 1);
  saveShares(req.graphDir, shares);
  res.json({ ok: true });
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
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.removeHeader('ETag');
  res.send(WIKI_HTML);
});

// --- Public shared profile view (NO auth) ---

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSharedErrorPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .error-card { background: #fff; border-radius: 12px; padding: 48px; max-width: 420px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .error-card h1 { font-size: 1.4rem; color: #1a1a2e; margin-bottom: 12px; }
  .error-card p { font-size: 0.95rem; color: #64748b; line-height: 1.6; }
  .footer { margin-top: 32px; font-size: 0.75rem; color: #94a3b8; }
</style></head><body>
<div class="error-card">
  <h1>${escHtml(title)}</h1>
  <p>${escHtml(message)}</p>
  <div class="footer">Shared via Context Architecture</div>
</div></body></html>`;
}

function renderSharedProfilePage(entity, share) {
  const e = entity.entity || {};
  const cl = entity.career_lite || {};
  const name = e.name?.full || 'Unknown';
  const initials = name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
  const sections = share.sections || [];

  let body = '';

  // Summary
  if (sections.includes('summary') && e.summary?.value) {
    body += '<div class="sp-section"><h2>Summary</h2><p>' + escHtml(e.summary.value) + '</p></div>';
  }

  // Experience
  if (sections.includes('experience') && cl.experience?.length) {
    body += '<div class="sp-section"><h2>Experience</h2>';
    for (const x of cl.experience) {
      body += '<div class="sp-card">';
      if (x.company) body += '<div class="sp-card-title">' + escHtml(x.company) + '</div>';
      if (x.title) body += '<div class="sp-card-subtitle">' + escHtml(x.title) + '</div>';
      const dates = [x.start_date, x.end_date].filter(Boolean).join(' — ');
      if (dates) body += '<div class="sp-card-meta">' + escHtml(dates) + '</div>';
      if (x.description) body += '<div class="sp-card-desc">' + escHtml(x.description) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Education
  if (sections.includes('education') && cl.education?.length) {
    body += '<div class="sp-section"><h2>Education</h2>';
    for (const ed of cl.education) {
      body += '<div class="sp-card">';
      if (ed.institution) body += '<div class="sp-card-title">' + escHtml(ed.institution) + '</div>';
      const degree = [ed.degree, ed.field].filter(Boolean).join(', ');
      if (degree) body += '<div class="sp-card-subtitle">' + escHtml(degree) + '</div>';
      if (ed.years) body += '<div class="sp-card-meta">' + escHtml(ed.years) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Skills
  if (sections.includes('skills') && cl.skills?.length) {
    body += '<div class="sp-section"><h2>Skills</h2><div class="sp-skills">';
    for (const s of cl.skills) {
      body += '<span class="sp-skill-tag">' + escHtml(s) + '</span>';
    }
    body += '</div></div>';
  }

  // Connections
  if (sections.includes('connections') && e.relationships?.length) {
    body += '<div class="sp-section"><h2>Connections</h2>';
    for (const r of e.relationships) {
      body += '<div class="sp-card">';
      if (r.name) body += '<div class="sp-card-title">' + escHtml(r.name) + '</div>';
      const detail = [r.relationship, r.context].filter(Boolean).join(' — ');
      if (detail) body += '<div class="sp-card-subtitle">' + escHtml(detail) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Role / Location
  let subtitle = '';
  if (e.attributes?.role) subtitle += escHtml(e.attributes.role);
  if (e.attributes?.location) subtitle += (subtitle ? ' &middot; ' : '') + escHtml(e.attributes.location);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(name)} — Shared Profile</title>
<meta property="og:title" content="${escHtml(name)} — Shared Profile">
<meta property="og:description" content="${escHtml(subtitle || 'Career profile shared via Context Architecture')}">
<meta property="og:type" content="profile">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; min-height: 100vh; }
  .sp-header { background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 48px 24px 36px; text-align: center; color: #fff; }
  .sp-avatar { width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: inline-flex; align-items: center; justify-content: center; font-size: 1.8rem; font-weight: 700; margin-bottom: 16px; border: 3px solid rgba(255,255,255,0.3); }
  .sp-name { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .sp-subtitle { font-size: 0.95rem; opacity: 0.85; }
  .sp-body { max-width: 640px; margin: -20px auto 40px; padding: 0 16px; }
  .sp-section { background: #fff; border-radius: 10px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .sp-section h2 { font-size: 1rem; font-weight: 600; color: #6366f1; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 0.8rem; }
  .sp-section > p { font-size: 0.92rem; line-height: 1.7; color: #475569; }
  .sp-card { padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
  .sp-card:last-child { border-bottom: none; padding-bottom: 0; }
  .sp-card:first-of-type { padding-top: 0; }
  .sp-card-title { font-size: 0.92rem; font-weight: 600; color: #1a1a2e; }
  .sp-card-subtitle { font-size: 0.85rem; color: #475569; margin-top: 2px; }
  .sp-card-meta { font-size: 0.78rem; color: #94a3b8; margin-top: 2px; }
  .sp-card-desc { font-size: 0.85rem; color: #64748b; margin-top: 6px; line-height: 1.5; }
  .sp-skills { display: flex; flex-wrap: wrap; gap: 8px; }
  .sp-skill-tag { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 0.8rem; font-weight: 500; background: #ede9fe; color: #6366f1; }
  .sp-footer { text-align: center; padding: 24px; font-size: 0.75rem; color: #94a3b8; }
  @media (max-width: 600px) {
    .sp-header { padding: 32px 16px 28px; }
    .sp-name { font-size: 1.3rem; }
    .sp-body { margin-top: -12px; }
    .sp-section { padding: 18px; }
  }
</style></head><body>
<div class="sp-header">
  <div class="sp-avatar">${escHtml(initials)}</div>
  <div class="sp-name">${escHtml(name)}</div>
  ${subtitle ? '<div class="sp-subtitle">' + subtitle + '</div>' : ''}
</div>
<div class="sp-body">${body}</div>
<div class="sp-footer">Shared via Context Architecture</div>
</body></html>`;
}

app.get('/shared/:shareId', sharedViewLimiter, (req, res) => {
  const { shareId } = req.params;

  // Scan all tenant directories for this shareId
  let matchedShare = null;
  let tenantDir = null;

  try {
    const entries = fs.readdirSync(GRAPH_DIR).filter(f => f.startsWith('tenant-'));
    for (const dir of entries) {
      const fullDir = path.join(GRAPH_DIR, dir);
      const shares = loadShares(fullDir);
      const found = shares.find(s => s.shareId === shareId);
      if (found) {
        matchedShare = found;
        tenantDir = fullDir;
        break;
      }
    }
  } catch (err) {
    // GRAPH_DIR might not exist yet
  }

  if (!matchedShare) {
    return res.status(404).send(renderSharedErrorPage(
      'Profile Not Found',
      'This link is invalid or has been revoked. Please ask the profile owner for a new link.'
    ));
  }

  // Check expiry
  if (new Date(matchedShare.expiresAt) < new Date()) {
    return res.status(410).send(renderSharedErrorPage(
      'Link Expired',
      'This shared profile link has expired. Please ask the profile owner to generate a new link.'
    ));
  }

  // Load entity
  const entityPath = path.join(tenantDir, matchedShare.entityId + '.json');
  if (!fs.existsSync(entityPath)) {
    return res.status(404).send(renderSharedErrorPage(
      'Profile Not Found',
      'The profile could not be loaded. It may have been deleted.'
    ));
  }

  const entity = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
  res.send(renderSharedProfilePage(entity, matchedShare));
});

const WIKI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Architecture</title>
<style>
  :root {
    /* Backgrounds */
    --bg-primary: #f5f5f7;
    --bg-secondary: #ffffff;
    --bg-card: #ffffff;
    --bg-elevated: #ffffff;
    --bg-hover: rgba(99,102,241,0.05);
    --bg-active: rgba(99,102,241,0.08);
    --bg-input: #f5f5f7;
    --bg-tertiary: #eeeef0;

    /* Borders */
    --border-primary: #e5e5ea;
    --border-subtle: #f0f0f2;
    --border-focus: #6366f1;

    /* Text */
    --text-primary: #1a1a1a;
    --text-secondary: #4b5563;
    --text-tertiary: #6b7280;
    --text-muted: #9ca3af;
    --text-faint: #d1d5db;

    /* Accents */
    --accent-primary: #6366f1;
    --accent-secondary: #7c3aed;
    --accent-tertiary: #8b5cf6;
    --accent-light: #6366f1;
    --accent-gradient: linear-gradient(135deg, #6366f1, #8b5cf6);

    /* Status */
    --success: #059669;
    --success-bg: rgba(5,150,105,0.08);
    --warning: #d97706;
    --warning-bg: rgba(217,119,6,0.08);
    --error: #dc2626;
    --error-bg: rgba(220,38,38,0.06);
    --info: #2563eb;
    --info-bg: rgba(37,99,235,0.06);

    /* Layout */
    --sidebar-width: 300px;
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-xl: 16px;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.06);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.08);

    /* Transitions */
    --transition-fast: 0.15s ease;
    --transition-normal: 0.2s ease;

    /* Typography */
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    height: 100vh;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* --- Scrollbar --- */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

  /* --- Login --- */
  #login-screen {
    display: flex; align-items: center; justify-content: center;
    height: 100vh; flex-direction: column; gap: 20px;
    background: var(--bg-primary);
  }
  .login-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-xl);
    padding: 48px 40px;
    width: 400px;
    text-align: center;
    box-shadow: var(--shadow-lg);
  }
  .login-brand {
    display: flex; align-items: center; justify-content: center;
    gap: 10px; margin-bottom: 8px;
  }
  .login-card h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .login-card h1 span {
    background: var(--accent-gradient);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .login-card .subtitle { color: var(--text-tertiary); font-size: 0.88rem; margin-bottom: 28px; }
  .login-card input {
    width: 100%; padding: 11px 14px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.88rem;
    outline: none; margin-bottom: 14px;
    transition: border-color var(--transition-fast);
  }
  .login-card input:focus { border-color: var(--border-focus); }
  .login-card input::placeholder { color: var(--text-muted); }
  .login-error { color: var(--error); font-size: 0.8rem; margin-bottom: 10px; display: none; }
  .login-error.active { display: block; }
  .btn {
    width: 100%; padding: 12px;
    border: none; border-radius: var(--radius-md);
    font-size: 0.92rem; font-weight: 600; cursor: pointer;
    background: var(--accent-gradient); color: white;
    transition: all var(--transition-normal);
    font-family: var(--font-sans);
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.3); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .google-btn {
    display: flex; align-items: center; justify-content: center;
    background: #fff; color: #333; text-decoration: none; margin-bottom: 16px;
    font-size: 0.88rem; font-weight: 600;
    border: 1px solid var(--border-primary);
  }
  .google-btn:hover { background: #f9f9fb; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .login-divider {
    display: flex; align-items: center; margin-bottom: 14px;
    color: var(--text-muted); font-size: 0.72rem;
  }
  .login-divider::before, .login-divider::after {
    content: ''; flex: 1; border-bottom: 1px solid var(--border-primary);
  }
  .login-divider span { padding: 0 12px; }

  /* --- App Layout --- */
  #app { display: none; height: 100vh; }
  #sidebar {
    width: var(--sidebar-width); min-width: var(--sidebar-width);
    border-right: 1px solid var(--border-primary);
    display: flex; flex-direction: column;
    background: var(--bg-secondary);
  }

  /* --- Sidebar Brand --- */
  .sidebar-brand {
    display: flex; align-items: center; gap: 10px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border-primary);
  }
  .brand-icon {
    width: 32px; height: 32px; border-radius: var(--radius-md);
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.72rem; font-weight: 800; color: white;
    letter-spacing: -0.02em; flex-shrink: 0;
  }
  .brand-text {
    font-size: 0.88rem; font-weight: 700; color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  /* --- Sidebar Nav --- */
  .sidebar-nav {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-primary);
    display: flex; flex-direction: column; gap: 2px;
  }
  .nav-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.82rem; font-weight: 500; cursor: pointer;
    transition: all var(--transition-fast);
    font-family: var(--font-sans);
    text-align: left; width: 100%;
  }
  .nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav-item svg { flex-shrink: 0; opacity: 0.6; }
  .nav-item:hover svg { opacity: 1; }

  /* --- Sidebar Search --- */
  .sidebar-search { padding: 12px 16px 8px; }
  .search-wrapper { position: relative; display: flex; align-items: center; }
  .search-icon {
    position: absolute; left: 10px;
    color: var(--text-muted); pointer-events: none;
  }
  #searchInput {
    width: 100%; padding: 8px 12px 8px 32px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.82rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  #searchInput:focus { border-color: var(--border-focus); }
  #searchInput::placeholder { color: var(--text-muted); }

  /* --- Sidebar Actions (legacy compat) --- */
  .sidebar-actions {
    padding: 8px 16px; border-bottom: 1px solid var(--border-primary);
  }
  .btn-upload {
    width: 100%; padding: 7px 0;
    border: 1px dashed var(--border-primary); border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.75rem; font-weight: 600;
    cursor: pointer; transition: all var(--transition-fast);
    letter-spacing: 0.03em; font-family: var(--font-sans);
  }
  .btn-upload:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); background: var(--bg-hover); }

  /* --- Sidebar Count --- */
  .sidebar-count {
    padding: 8px 20px; font-size: 0.68rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    border-bottom: 1px solid var(--border-primary);
  }

  /* --- Entity List --- */
  #entityList { flex: 1; overflow-y: auto; }
  .entity-item {
    padding: 12px 20px; cursor: pointer;
    border-bottom: 1px solid var(--border-subtle);
    transition: all var(--transition-fast);
  }
  .entity-item:hover { background: var(--bg-hover); }
  .entity-item.active {
    background: var(--bg-active);
    border-left: 3px solid var(--accent-primary);
    padding-left: 17px;
  }
  .entity-item-name {
    font-size: 0.85rem; font-weight: 600;
    color: var(--text-primary); margin-bottom: 2px;
  }
  .entity-item-summary {
    font-size: 0.72rem; color: var(--text-muted); line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-top: 3px;
  }
  .type-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 2px 7px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.04em;
    vertical-align: middle; margin-left: 6px;
  }
  .type-badge.person { background: rgba(99,102,241,0.1); color: #6366f1; }
  .type-badge.business { background: rgba(14,165,233,0.1); color: #0284c7; }
  .type-badge.role { background: rgba(59,130,246,0.1); color: #2563eb; }
  .type-badge.organization { background: rgba(34,197,94,0.1); color: #16a34a; }
  .type-badge.credential { background: rgba(245,158,11,0.1); color: #d97706; }
  .type-badge.skill { background: rgba(20,184,166,0.1); color: #0d9488; }

  /* --- Main Panel --- */
  #main {
    flex: 1; overflow-y: auto;
    padding: 32px 40px;
    background: var(--bg-primary);
  }
  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-faint);
    font-size: 0.95rem; text-align: center;
    line-height: 1.8; flex-direction: column; gap: 12px;
  }

  /* --- Detail Header --- */
  .detail-header { margin-bottom: 28px; }
  .detail-header h2 {
    font-size: 1.6rem; font-weight: 700; color: var(--text-primary);
    display: inline; letter-spacing: -0.02em;
  }
  .entity-id-badge {
    font-size: 0.68rem; color: var(--accent-primary);
    font-family: var(--font-mono);
    background: rgba(99,102,241,0.08);
    padding: 3px 10px; border-radius: var(--radius-sm);
    margin-left: 10px; vertical-align: middle;
  }

  /* --- Sections --- */
  .section {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    padding: 20px; margin-bottom: 16px;
    transition: border-color var(--transition-fast);
    box-shadow: var(--shadow-sm);
  }
  .section:hover { border-color: #d1d5db; }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-muted);
  }
  .section-title-only { margin-bottom: 12px; }
  .summary-text { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.7; }
  .summary-edit {
    width: 100%; min-height: 70px; padding: 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.88rem; line-height: 1.6;
    resize: vertical; outline: none;
  }
  .summary-edit:focus { border-color: var(--border-focus); }
  .edit-actions { margin-top: 8px; display: flex; gap: 8px; }

  /* --- Attributes, Relationships, Values --- */
  .attr-row, .rel-row, .value-item {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 0; font-size: 0.84rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--border-subtle);
  }
  .attr-row:last-child, .rel-row:last-child, .value-item:last-child { border-bottom: none; }
  .attr-key {
    color: var(--accent-secondary); font-weight: 600;
    min-width: 90px; flex-shrink: 0; font-size: 0.82rem;
  }
  .attr-value { color: var(--text-primary); flex: 1; }
  .rel-name { color: var(--text-primary); font-weight: 600; min-width: 110px; }
  .rel-type {
    color: var(--info); font-size: 0.72rem;
    background: var(--info-bg);
    padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .rel-context { color: var(--text-tertiary); font-size: 0.78rem; flex: 1; }
  .rel-sentiment {
    font-size: 0.65rem; padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .sentiment-positive { background: var(--success-bg); color: var(--success); }
  .sentiment-neutral { background: rgba(107,114,128,0.08); color: var(--text-secondary); }
  .sentiment-strained { background: var(--error-bg); color: var(--error); }
  .value-text { color: var(--text-primary); }

  /* --- Badges --- */
  .badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 2px 7px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.04em;
    white-space: nowrap; vertical-align: middle;
  }
  .badge-verified { background: rgba(5,150,105,0.1); color: #059669; }
  .badge-strong { background: rgba(37,99,235,0.1); color: #2563eb; }
  .badge-moderate { background: rgba(217,119,6,0.1); color: #d97706; }
  .badge-speculative { background: rgba(234,88,12,0.1); color: #ea580c; }
  .badge-uncertain { background: rgba(220,38,38,0.1); color: #dc2626; }
  .badge-layer {
    font-size: 0.58rem; padding: 2px 6px; border-radius: var(--radius-sm);
  }
  .badge-layer-1 { background: rgba(5,150,105,0.08); color: #059669; }
  .badge-layer-2 { background: rgba(37,99,235,0.08); color: #2563eb; }
  .badge-layer-3 { background: rgba(219,39,119,0.08); color: #db2777; }

  /* --- Observations --- */
  .obs-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 12px 14px; margin-bottom: 8px;
    transition: all var(--transition-fast);
  }
  .obs-card:hover { border-color: var(--border-primary); }
  .obs-text { font-size: 0.86rem; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px; }
  .obs-meta {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-size: 0.7rem;
  }
  .obs-source {
    color: var(--text-muted); font-family: var(--font-mono);
    font-size: 0.65rem;
  }
  .obs-date { color: var(--text-muted); font-size: 0.65rem; }
  .obs-decay {
    font-size: 0.6rem; color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .btn-delete {
    background: none; border: 1px solid rgba(239,68,68,0.15);
    color: var(--error);
    font-size: 0.6rem; padding: 2px 8px; border-radius: var(--radius-sm);
    cursor: pointer; margin-left: auto; opacity: 0.4;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-delete:hover { opacity: 1; background: var(--error-bg); }

  /* --- Forms --- */
  .add-obs-form { margin-top: 12px; }
  .obs-textarea {
    width: 100%; min-height: 60px; padding: 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.86rem; line-height: 1.5;
    resize: vertical; outline: none; margin-bottom: 10px;
    transition: border-color var(--transition-fast);
  }
  .obs-textarea:focus { border-color: var(--border-focus); }
  .obs-textarea::placeholder { color: var(--text-muted); }
  .obs-form-row { display: flex; gap: 8px; align-items: center; }
  .obs-form-row select {
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.78rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  .obs-form-row select:focus { border-color: var(--border-focus); }
  .btn-sm {
    padding: 5px 14px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.72rem; cursor: pointer;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-sm:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .btn-add {
    padding: 7px 18px; border: none; border-radius: var(--radius-sm);
    background: var(--accent-gradient); color: white;
    font-size: 0.78rem; font-weight: 600; cursor: pointer;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-add:hover { transform: translateY(-1px); box-shadow: 0 2px 12px rgba(99,102,241,0.3); }
  .btn-add:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-save {
    padding: 5px 16px; border: none; border-radius: var(--radius-sm);
    background: var(--success); color: #fff;
    font-size: 0.72rem; font-weight: 600; cursor: pointer;
    font-family: var(--font-sans);
  }
  .btn-cancel {
    padding: 5px 16px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.72rem; cursor: pointer; font-family: var(--font-sans);
  }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 12px 20px; font-size: 0.82rem;
    color: var(--success);
    display: none; z-index: 100;
    box-shadow: var(--shadow-lg);
    animation: slideUp 0.25s ease;
  }
  .toast.active { display: block; }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* --- Upload Zone --- */
  .upload-view { display: none; }
  .upload-view.active { display: block; animation: fadeIn 0.2s ease; }
  .upload-dropzone {
    border: 2px dashed var(--border-primary);
    border-radius: var(--radius-xl);
    padding: 56px 24px;
    text-align: center; cursor: pointer;
    transition: all var(--transition-normal);
    background: var(--bg-secondary); margin-bottom: 20px;
  }
  .upload-dropzone:hover, .upload-dropzone.dragover {
    border-color: var(--accent-primary);
    background: var(--bg-hover);
  }
  .upload-dropzone-icon { font-size: 2.5rem; margin-bottom: 12px; opacity: 0.3; }
  .upload-dropzone-text { font-size: 0.92rem; color: var(--text-tertiary); margin-bottom: 6px; }
  .upload-dropzone-hint { font-size: 0.72rem; color: var(--text-muted); }
  .upload-file-list { margin-bottom: 16px; }
  .upload-file-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    margin-bottom: 6px; font-size: 0.82rem;
    transition: border-color var(--transition-fast);
  }
  .upload-file-item:hover { border-color: rgba(30,30,46,0.8); }
  .upload-file-name {
    color: var(--text-primary); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .upload-file-size { color: var(--text-muted); font-size: 0.72rem; margin-left: 10px; flex-shrink: 0; }
  .upload-file-status { margin-left: 10px; font-size: 0.72rem; flex-shrink: 0; font-weight: 500; }
  .upload-file-status.pending { color: var(--text-muted); }
  .upload-file-status.processing { color: var(--warning); }
  .upload-file-status.done { color: var(--success); }
  .upload-file-status.error { color: var(--error); }
  .upload-file-remove {
    margin-left: 10px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 1rem;
    padding: 0 4px; transition: color var(--transition-fast);
  }
  .upload-file-remove:hover { color: var(--error); }
  .btn-start-upload {
    width: 100%; padding: 11px; border: none; border-radius: var(--radius-md);
    font-size: 0.88rem; font-weight: 600; cursor: pointer;
    background: var(--accent-gradient); color: white;
    transition: all var(--transition-normal); margin-bottom: 8px;
    font-family: var(--font-sans);
  }
  .btn-start-upload:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.3); }
  .btn-start-upload:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-back-upload {
    width: 100%; padding: 9px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    font-size: 0.82rem; font-weight: 500; cursor: pointer;
    background: transparent; color: var(--text-tertiary);
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-back-upload:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .upload-progress-log {
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 14px; margin-bottom: 16px;
    max-height: 220px; overflow-y: auto;
    font-family: var(--font-mono); font-size: 0.72rem;
    line-height: 1.8; color: var(--text-tertiary);
  }
  .upload-progress-log .log-success { color: var(--success); }
  .upload-progress-log .log-info { color: var(--info); }
  .upload-progress-log .log-error { color: var(--error); }
  .upload-summary {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    padding: 20px; text-align: center; margin-bottom: 16px;
  }
  .upload-summary-stat {
    display: inline-block; margin: 0 20px; text-align: center;
  }
  .upload-summary-num {
    font-size: 1.8rem; font-weight: 700; color: var(--accent-tertiary);
    letter-spacing: -0.02em;
  }
  .upload-summary-label {
    font-size: 0.68rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px;
  }

  /* --- Drive Picker --- */
  .drive-breadcrumb {
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    margin-bottom: 12px; font-size: 0.78rem;
  }
  .drive-breadcrumb a {
    color: var(--info); text-decoration: none; cursor: pointer;
  }
  .drive-breadcrumb a:hover { text-decoration: underline; }
  .drive-breadcrumb .sep { color: var(--text-muted); }
  .drive-breadcrumb .current { color: var(--text-primary); font-weight: 600; }
  .drive-file-list {
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    overflow: hidden; margin-bottom: 16px;
  }
  .drive-file-row {
    display: flex; align-items: center; padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle); font-size: 0.82rem;
    transition: background var(--transition-fast); cursor: pointer;
  }
  .drive-file-row:last-child { border-bottom: none; }
  .drive-file-row:hover { background: var(--bg-hover); }
  .drive-file-row.selected { background: var(--bg-active); }
  .drive-file-check {
    width: 16px; height: 16px; margin-right: 10px;
    accent-color: var(--accent-primary); flex-shrink: 0;
  }
  .drive-file-icon {
    width: 20px; text-align: center; margin-right: 10px;
    flex-shrink: 0; font-size: 0.9rem;
  }
  .drive-file-name {
    flex: 1; color: var(--text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .drive-file-name.folder { color: var(--info); font-weight: 500; }
  .drive-file-meta {
    font-size: 0.68rem; color: var(--text-muted);
    margin-left: 12px; flex-shrink: 0; white-space: nowrap;
  }
  .drive-select-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; font-size: 0.78rem; color: var(--text-tertiary);
  }
  .drive-loading {
    text-align: center; padding: 40px; color: var(--text-muted); font-size: 0.85rem;
  }
  .drive-empty {
    text-align: center; padding: 28px; color: var(--text-muted); font-size: 0.82rem;
  }
  .drive-search-bar {
    display: flex; align-items: center; gap: 6px; margin-bottom: 12px;
  }
  .drive-search-bar input {
    flex: 1; padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.82rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  .drive-search-bar input:focus { border-color: var(--border-focus); }
  .drive-search-bar input::placeholder { color: var(--text-muted); }
  .drive-search-btn {
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary); cursor: pointer; font-size: 0.82rem;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .drive-search-btn:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .drive-search-clear {
    padding: 8px 12px; background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary); cursor: pointer; font-size: 0.75rem;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .drive-search-clear:hover { border-color: var(--error); color: var(--error); }
  .drive-search-tag {
    display: inline-block; font-size: 0.72rem; color: var(--info); margin-bottom: 8px;
  }

  /* --- Career Lite Profile --- */
  .cl-header {
    display: flex; gap: 20px; align-items: flex-start; margin-bottom: 6px;
  }
  .cl-avatar {
    width: 72px; height: 72px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 1.6rem; font-weight: 700; color: white; flex-shrink: 0;
    box-shadow: 0 4px 16px rgba(99,102,241,0.25);
  }
  .cl-header-info { flex: 1; min-width: 0; }
  .cl-name {
    font-size: 1.5rem; font-weight: 700; color: var(--text-primary);
    margin-bottom: 4px; letter-spacing: -0.02em;
  }
  .cl-headline { font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 4px; }
  .cl-current { font-size: 0.84rem; color: var(--accent-tertiary); margin-bottom: 4px; }
  .cl-location { font-size: 0.78rem; color: var(--text-tertiary); }
  .cl-contact-row {
    display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 0.78rem;
  }
  .cl-contact-row a { color: var(--info); text-decoration: none; }
  .cl-contact-row a:hover { text-decoration: underline; }
  .cl-contact-item { color: var(--text-secondary); }
  .cl-interface-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 3px 10px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.06em;
    background: rgba(139,92,246,0.12); color: var(--accent-tertiary);
    margin-top: 10px;
  }
  .cl-exp-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 14px 16px; margin-bottom: 8px;
    transition: border-color var(--transition-fast);
  }
  .cl-exp-card:hover { border-color: var(--border-primary); }
  .cl-exp-company { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .cl-exp-title { font-size: 0.84rem; color: var(--accent-tertiary); }
  .cl-exp-dates { font-size: 0.72rem; color: var(--text-tertiary); margin-top: 2px; }
  .cl-exp-desc { font-size: 0.8rem; color: var(--text-secondary); margin-top: 8px; line-height: 1.6; }
  .cl-edu-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 12px 16px; margin-bottom: 8px;
    transition: border-color var(--transition-fast);
  }
  .cl-edu-card:hover { border-color: var(--border-primary); }
  .cl-edu-institution { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .cl-edu-degree { font-size: 0.8rem; color: var(--text-secondary); }
  .cl-edu-years { font-size: 0.72rem; color: var(--text-tertiary); }
  .cl-skills-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
  .cl-skill-tag {
    display: inline-block; padding: 5px 12px; border-radius: 20px;
    font-size: 0.72rem; font-weight: 500;
    background: rgba(99,102,241,0.08); color: var(--accent-light);
    border: 1px solid rgba(99,102,241,0.15);
    transition: all var(--transition-fast);
  }
  .cl-skill-tag:hover { background: rgba(99,102,241,0.15); }

  /* --- Share Modal --- */
  .share-overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.3); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .share-modal {
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg); padding: 28px; width: 440px; max-width: 90vw;
    max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  }
  .share-modal h3 {
    font-size: 1.05rem; font-weight: 600; color: var(--text-primary);
    margin-bottom: 20px;
  }
  .share-section-toggles { margin-bottom: 20px; }
  .share-toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid var(--border-subtle);
  }
  .share-toggle-row:last-child { border-bottom: none; }
  .share-toggle-row label {
    font-size: 0.85rem; color: var(--text-secondary); cursor: pointer;
  }
  .share-toggle-row input[type="checkbox"] { accent-color: var(--accent-light); width: 16px; height: 16px; cursor: pointer; }
  .share-expiry-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px; padding: 10px 0;
  }
  .share-expiry-row label { font-size: 0.85rem; color: var(--text-secondary); }
  .share-expiry-row select {
    background: var(--bg-secondary); border: 1px solid var(--border-primary);
    color: var(--text-primary); border-radius: var(--radius-sm); padding: 6px 10px;
    font-size: 0.82rem;
  }
  .share-actions {
    display: flex; gap: 10px; margin-bottom: 16px;
  }
  .share-actions button {
    flex: 1; padding: 10px; border-radius: var(--radius-sm); font-size: 0.85rem;
    font-weight: 500; cursor: pointer; border: 1px solid var(--border-primary);
    transition: all var(--transition-fast);
  }
  .btn-generate {
    background: var(--accent-gradient); color: #fff; border: none !important;
  }
  .btn-generate:hover { opacity: 0.9; }
  .btn-cancel {
    background: var(--bg-secondary); color: var(--text-secondary);
  }
  .btn-cancel:hover { border-color: var(--text-muted); }
  .share-result {
    background: var(--bg-secondary); border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm); padding: 12px; margin-bottom: 16px;
  }
  .share-result-url {
    font-size: 0.8rem; color: var(--accent-light); word-break: break-all;
    margin-bottom: 8px; font-family: monospace;
  }
  .btn-copy-link {
    background: var(--bg-tertiary); border: 1px solid var(--border-primary);
    color: var(--text-primary); padding: 6px 14px; border-radius: var(--radius-sm);
    font-size: 0.78rem; cursor: pointer; transition: all var(--transition-fast);
  }
  .btn-copy-link:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .share-active-list { margin-top: 16px; }
  .share-active-list h4 {
    font-size: 0.82rem; font-weight: 600; color: var(--text-secondary);
    margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .share-active-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid var(--border-subtle);
    font-size: 0.8rem;
  }
  .share-active-item:last-child { border-bottom: none; }
  .share-active-info { color: var(--text-tertiary); }
  .share-active-sections { color: var(--text-muted); font-size: 0.72rem; }
  .btn-revoke {
    background: none; border: 1px solid rgba(239,68,68,0.3); color: #ef4444;
    padding: 4px 10px; border-radius: var(--radius-sm); font-size: 0.72rem;
    cursor: pointer; transition: all var(--transition-fast);
  }
  .btn-revoke:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
  .btn-share {
    background: var(--accent-gradient); color: #fff; border: none;
    padding: 5px 14px; border-radius: var(--radius-sm); font-size: 0.75rem;
    font-weight: 500; cursor: pointer; transition: opacity var(--transition-fast);
  }
  .btn-share:hover { opacity: 0.85; }
  .cl-header-actions {
    display: flex; align-items: center; gap: 10px;
  }

  /* --- Sidebar Footer --- */
  .sidebar-footer {
    padding: 12px 20px;
    border-top: 1px solid var(--border-primary);
    font-size: 0.7rem; color: var(--text-faint); text-align: center;
    line-height: 1.6;
  }
  .sidebar-footer a {
    color: var(--text-muted); text-decoration: none;
    transition: color var(--transition-fast);
  }
  .sidebar-footer a:hover { color: var(--accent-tertiary); }

  /* --- Sidebar Hierarchical Nav --- */
  .sidebar-section { border-bottom: 1px solid var(--border-subtle); }
  .sidebar-section:last-child { border-bottom: none; }
  .sidebar-section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 16px; cursor: pointer;
    font-size: 14px; font-weight: 700; color: var(--text-secondary);
    transition: background var(--transition-fast);
    user-select: none;
  }
  .sidebar-section-header:hover { background: var(--bg-hover); }
  .sidebar-section-chevron {
    display: inline-block; font-size: 0.6rem; transition: transform 0.2s ease;
    color: var(--text-muted); flex-shrink: 0;
  }
  .sidebar-section-chevron.collapsed { transform: rotate(-90deg); }
  .sidebar-section-title { flex: 1; }
  .sidebar-section-count {
    font-size: 0.65rem; font-weight: 500; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 7px; border-radius: 10px;
  }
  .sidebar-section-body { overflow: hidden; }
  .sidebar-section-body.collapsed { display: none; }
  .sidebar-profile-header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 20px 4px;
  }
  .sidebar-profile-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem; font-weight: 700; color: white; flex-shrink: 0;
    overflow: hidden;
  }
  .sidebar-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .sidebar-profile-name {
    font-size: 0.85rem; font-weight: 600; color: var(--text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-view-item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 20px 7px 36px; cursor: pointer;
    font-size: 13px; color: var(--text-tertiary);
    transition: all var(--transition-fast);
  }
  .sidebar-view-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .sidebar-view-item.active {
    background: #f5f0ff; color: #6366f1;
    border-left: 3px solid #6366f1;
    padding-left: 33px;
  }
  .sidebar-view-item .view-icon { font-size: 0.85rem; flex-shrink: 0; width: 18px; text-align: center; }
  .sidebar-view-item.placeholder { color: var(--text-muted); cursor: default; }
  .sidebar-view-item.placeholder:hover { background: transparent; color: var(--text-muted); }
  .coming-soon-badge {
    font-size: 0.55rem; font-weight: 600; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .sidebar-group-label {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 8px 20px 4px;
  }
  .sidebar-entity-row {
    display: block; padding: 6px 20px 6px 36px; cursor: pointer;
    font-size: 13px; color: var(--text-primary);
    transition: background var(--transition-fast);
  }
  .sidebar-entity-row:hover { background: #f0f0ff; }
  .sidebar-entity-row.active {
    background: #f5f0ff;
    border-left: 3px solid #6366f1;
    padding-left: 33px;
  }
  .sidebar-entity-row .entity-name {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 6px;
  }
  .sidebar-entity-row .entity-subtitle {
    font-size: 12px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    padding-left: 0;
  }
  .sidebar-empty-hint {
    padding: 8px 20px 8px 36px; font-size: 12px; color: var(--text-muted);
    font-style: italic;
  }
  .sidebar-footer-user {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px; justify-content: center;
  }
  .sidebar-user-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; font-weight: 700; color: white; flex-shrink: 0;
    overflow: hidden;
  }
  .sidebar-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .sidebar-footer-user-name {
    font-size: 13px; font-weight: 600; color: var(--text-primary);
  }
  .sidebar-footer-actions {
    display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
  }
  .sidebar-footer-actions a, .sidebar-footer-actions span a {
    color: var(--text-muted); text-decoration: none; font-size: 12px;
    transition: color var(--transition-fast);
  }
  .sidebar-footer-actions a:hover { color: var(--accent-tertiary); }
  .sidebar-footer-separator { color: var(--text-faint); }

  /* --- Skeleton Loading --- */
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .skeleton {
    background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-elevated) 50%, var(--bg-card) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: var(--radius-sm);
  }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login-screen">
  <div class="login-card">
    <div class="login-brand">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="url(#loginGrad)"/>
        <text x="18" y="23" text-anchor="middle" fill="white" font-size="14" font-weight="700" font-family="system-ui">CA</text>
        <defs><linearGradient id="loginGrad" x1="0" y1="0" x2="36" y2="36"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
      </svg>
    </div>
    <h1><span>Context Architecture</span></h1>
    <p class="subtitle">Knowledge Graph Dashboard</p>
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
    <div class="sidebar-brand">
      <div class="brand-icon">CA</div>
      <div class="brand-text">Context Architecture</div>
    </div>
    <div class="sidebar-search">
      <div class="search-wrapper">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="6.5" cy="6.5" r="5"/>
          <path d="M14.5 14.5l-4-4"/>
        </svg>
        <input type="text" id="searchInput" placeholder="Search entities..." oninput="onSearch()" />
      </div>
    </div>
    <div class="sidebar-count" id="sidebarCount"></div>
    <div id="entityList"></div>
    <div class="sidebar-footer">
      <div class="sidebar-footer-user">
        <div class="sidebar-user-avatar" id="userAvatar"></div>
        <span id="userInfo"></span>
      </div>
      <div class="sidebar-footer-actions">
        <a href="#" onclick="showUploadView();return false;">Upload</a>
        <span class="sidebar-footer-separator">&middot;</span>
        <a href="#" onclick="showDriveView();return false;" id="btnDrive" style="display:none;">Drive</a>
        <span class="sidebar-footer-separator" id="driveSep" style="display:none;">&middot;</span>
        <span id="logoutLink"></span>
      </div>
    </div>
  </div>
  <div id="main">
    <div class="empty-state" id="emptyState">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2">
        <circle cx="24" cy="24" r="20"/>
        <circle cx="24" cy="20" r="7"/>
        <path d="M12 40c0-6.627 5.373-12 12-12s12 5.373 12 12"/>
      </svg>
      <div>Select an entity from the sidebar<br/>to view its knowledge graph profile</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<input type="file" id="uploadFileInput" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.md,.json" style="display:none" />

<script>
var apiKey = '';
var sessionUser = null;
var entities = [];
var selectedId = null;
var selectedData = null;
var searchTimeout = null;
var primaryEntityId = null;
var primaryEntityData = null;
var allEntities = [];
var selectedView = null;
var collapsedSections = {};

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function findPrimaryUser(ents, user) {
  if (!user || !user.name) return null;
  var persons = ents.filter(function(e) { return e.entity_type === 'person'; });
  if (persons.length === 0) return null;
  var uname = user.name.toLowerCase().trim();
  var uemail = (user.email || '').toLowerCase().trim();

  for (var i = 0; i < persons.length; i++) {
    console.log('SIDEBAR_DEBUG: comparing entity:', persons[i].name, 'to user:', user.name, uemail);
  }

  // 1. Exact email match
  if (uemail) {
    for (var i = 0; i < persons.length; i++) {
      var pemail = (persons[i].email || '').toLowerCase().trim();
      if (pemail && pemail === uemail) { console.log('SIDEBAR_DEBUG: matched by email'); return persons[i].entity_id; }
    }
  }

  // 2. Exact name match
  for (var i = 0; i < persons.length; i++) {
    if (persons[i].name && persons[i].name.toLowerCase().trim() === uname) { console.log('SIDEBAR_DEBUG: matched by exact name'); return persons[i].entity_id; }
  }

  // 3. Substring match (either direction)
  for (var i = 0; i < persons.length; i++) {
    var pname = (persons[i].name || '').toLowerCase().trim();
    if (pname.indexOf(uname) !== -1 || uname.indexOf(pname) !== -1) { console.log('SIDEBAR_DEBUG: matched by substring'); return persons[i].entity_id; }
  }

  // 4. First+last word match: check if first AND last word of one appear in the other
  var uwords = uname.split(/\\s+/);
  if (uwords.length >= 2) {
    var ufirst = uwords[0];
    var ulast = uwords[uwords.length - 1];
    for (var i = 0; i < persons.length; i++) {
      var pname = (persons[i].name || '').toLowerCase();
      if (pname.indexOf(ufirst) !== -1 && pname.indexOf(ulast) !== -1) { console.log('SIDEBAR_DEBUG: matched by first+last'); return persons[i].entity_id; }
    }
  }
  // Also check reverse: entity first+last in user name
  for (var i = 0; i < persons.length; i++) {
    var pwords = (persons[i].name || '').toLowerCase().split(/\\s+/);
    if (pwords.length >= 2) {
      var pfirst = pwords[0];
      var plast = pwords[pwords.length - 1];
      if (uname.indexOf(pfirst) !== -1 && uname.indexOf(plast) !== -1) { console.log('SIDEBAR_DEBUG: matched by entity first+last in user'); return persons[i].entity_id; }
    }
  }

  // Fallback: single person entity
  if (persons.length === 1) return persons[0].entity_id;
  console.log('SIDEBAR_DEBUG: NO MATCH FOUND');
  return null;
}

function categorizeRelationship(relType, rel) {
  if (!relType) return 'other';
  var r = relType.toLowerCase();
  var familyTerms = ['spouse', 'wife', 'husband', 'parent', 'mother', 'father', 'son', 'daughter', 'child', 'brother', 'sister', 'sibling', 'nephew', 'niece', 'uncle', 'aunt', 'cousin', 'in-law', 'grandparent', 'grandmother', 'grandfather', 'ex-spouse'];
  for (var i = 0; i < familyTerms.length; i++) {
    if (r.indexOf(familyTerms[i]) !== -1) return 'family';
  }
  var innerTerms = ['close friend', 'best friend', 'groomsman', 'loyalty anchor', 'accountability partner', 'ai assistant', 'collaborator', 'co-founder'];
  for (var i = 0; i < innerTerms.length; i++) {
    if (r.indexOf(innerTerms[i]) !== -1) return 'inner_circle';
  }
  // Check strength/trust_level fields on the relationship object
  if (rel) {
    if (rel.strength === 'close') return 'inner_circle';
    var tl = String(rel.trust_level || '');
    if (tl.indexOf('9') !== -1 || tl.indexOf('10') !== -1) return 'inner_circle';
  }
  var proTerms = ['colleague', 'mentor', 'manager', 'coworker', 'professional', 'security architect', 'from your school'];
  for (var i = 0; i < proTerms.length; i++) {
    if (r.indexOf(proTerms[i]) !== -1) return 'professional';
  }
  return 'other';
}

function sortPeopleGroup(group, category) {
  if (category === 'family') {
    var priority = { 'spouse': 1, 'wife': 1, 'husband': 1, 'son': 2, 'daughter': 2, 'child': 2, 'brother': 3, 'sister': 3, 'sibling': 3 };
    group.sort(function(a, b) {
      var ra = (a._relType || '').toLowerCase();
      var rb = (b._relType || '').toLowerCase();
      var pa = 99, pb = 99;
      for (var k in priority) {
        if (ra.indexOf(k) !== -1) { pa = Math.min(pa, priority[k]); }
        if (rb.indexOf(k) !== -1) { pb = Math.min(pb, priority[k]); }
      }
      if (pa !== pb) return pa - pb;
      return (a.name || '').localeCompare(b.name || '');
    });
  } else {
    group.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
  }
  return group;
}

function buildSidebarData() {
  var q = (document.getElementById('searchInput') || {}).value;
  q = (q || '').trim().toLowerCase();
  var isSearching = q.length > 0;

  // Build relationship map from primary entity
  var relMap = {};
  if (primaryEntityData && primaryEntityData.relationships) {
    var rels = primaryEntityData.relationships;
    for (var i = 0; i < rels.length; i++) {
      var rname = (rels[i].name || '').toLowerCase().trim();
      relMap[rname] = {
        category: categorizeRelationship(rels[i].relationship_type, rels[i]),
        type: rels[i].relationship_type || ''
      };
    }
  }

  // Build role/credential maps from connected objects for org grouping
  var roleByOrg = {};  // orgName -> roleTitle
  var credByOrg = {}; // orgName -> credLabel
  var connected = (primaryEntityData && primaryEntityData.connected_objects) || [];
  for (var i = 0; i < connected.length; i++) {
    var c = connected[i];
    if (c.entity_type === 'role' && c.label) {
      // Role labels follow "Title at OrgName" pattern
      var atIdx = c.label.indexOf(' at ');
      if (atIdx !== -1) {
        var orgName = c.label.substring(atIdx + 4).trim();
        roleByOrg[orgName.toLowerCase()] = c.label.substring(0, atIdx).trim();
      }
    }
    if (c.entity_type === 'credential' && c.label) {
      // Credential labels follow "Degree, Institution" pattern
      var commaIdx = c.label.indexOf(', ');
      if (commaIdx !== -1) {
        var instName = c.label.substring(commaIdx + 2).trim();
        credByOrg[instName.toLowerCase()] = c.label;
      }
    }
  }

  var you = null;
  var people = { family: [], inner_circle: [], professional: [], other: [] };
  var organizations = { career: [], education: [], other: [] };
  var projects = { active: [], rnd: [], archive: [] };

  var src = isSearching ? entities : allEntities;
  for (var i = 0; i < src.length; i++) {
    var e = src[i];
    var t = e.entity_type;
    // Skip role/credential/skill from sidebar
    if (t === 'role' || t === 'credential' || t === 'skill') continue;

    // Filter out test entities
    var ename = (e.name || '');
    if (ename.match(/\\btest\\b/i) || ename.match(/\\bTestCorp\\b/i) || ename.match(/\\bBigTech\\b/i)) continue;

    if (e.entity_id === primaryEntityId) {
      you = e;
      continue;
    }
    if (t === 'person') {
      var elower = ename.toLowerCase().trim();
      var rel = relMap[elower];
      if (rel) {
        e._relType = rel.type;
        people[rel.category].push(e);
      } else {
        e._relType = '';
        people.other.push(e);
      }
    } else if (t === 'organization' || t === 'business') {
      var oname = ename.toLowerCase().trim();
      if (roleByOrg[oname]) {
        organizations.career.push({ org: e, roleTitle: roleByOrg[oname] });
      } else if (credByOrg[oname]) {
        organizations.education.push({ org: e, credLabel: credByOrg[oname] });
      } else {
        organizations.other.push(e);
      }
    } else if (t === 'project') {
      projects.active.push(e);
    }
  }

  // Sort people groups
  sortPeopleGroup(people.family, 'family');
  sortPeopleGroup(people.inner_circle, 'inner_circle');
  sortPeopleGroup(people.professional, 'professional');
  sortPeopleGroup(people.other, 'other');

  // If not searching and primary not in allEntities, still show You if we have data
  if (!you && primaryEntityId && !isSearching) {
    for (var i = 0; i < allEntities.length; i++) {
      if (allEntities[i].entity_id === primaryEntityId) { you = allEntities[i]; break; }
    }
  }
  return { you: you, people: people, organizations: organizations, projects: projects };
}

function selectView(viewId) {
  if (!primaryEntityId) return;
  selectedId = primaryEntityId;
  selectedView = viewId;
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  if (viewId === 'career-lite') {
    if (primaryEntityData) {
      renderCareerLite(primaryEntityData);
    } else {
      api('GET', '/api/entity/' + primaryEntityId).then(function(data) {
        primaryEntityData = data;
        selectedData = data;
        renderCareerLite(data);
      });
    }
  } else if (viewId === 'overview') {
    if (primaryEntityData) {
      renderProfileOverview(primaryEntityData);
    } else {
      api('GET', '/api/entity/' + primaryEntityId).then(function(data) {
        primaryEntityData = data;
        selectedData = data;
        renderProfileOverview(data);
      });
    }
  } else if (viewId === 'executive-brief') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Executive Brief</div><div style="color:var(--text-muted);">Coming soon &mdash; Achievement-led professional profile</div></div>';
  } else if (viewId === 'creator-profile') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Creator Profile</div><div style="color:var(--text-muted);">Coming soon &mdash; Projects, content, and ventures</div></div>';
  } else if (viewId === 'values-identity') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Values &amp; Identity</div><div style="color:var(--text-muted);">Coming soon &mdash; Core values, interests, and personality</div></div>';
  } else {
    var label = viewId.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">' + esc(label) + '</div><div style="color:var(--text-muted);">Coming soon</div></div>';
  }
  renderSidebar();
}

function renderProfileOverview(data) {
  var e = data.entity || {};
  var name = (e.name && e.name.full) ? e.name.full : (e.name && e.name.common) || '';
  var summary = (e.summary && e.summary.value) || '';
  var attrs = data.attributes || [];
  var connected = data.connected_objects || [];
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  var rels = data.relationships || [];

  // Extract key attributes
  var headline = '', location = '';
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].key === 'headline') headline = String(attrs[i].value || '');
    if (attrs[i].key === 'location') location = String(attrs[i].value || '');
  }

  // Count connected objects by type
  var connCounts = {};
  for (var i = 0; i < connected.length; i++) {
    var ct = connected[i].entity_type;
    connCounts[ct] = (connCounts[ct] || 0) + 1;
  }

  var h = '';

  // Profile header with large avatar
  h += '<div style="display:flex;align-items:center;gap:20px;padding:24px 0 16px;">';
  h += '<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;color:white;flex-shrink:0;overflow:hidden;">';
  if (sessionUser && sessionUser.picture) {
    h += '<img src="' + esc(sessionUser.picture) + '" alt="" style="width:100%;height:100%;object-fit:cover;" />';
  } else {
    var initials = name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
    h += initials;
  }
  h += '</div>';
  h += '<div>';
  h += '<h2 style="font-size:1.4rem;font-weight:700;color:var(--text-primary);margin:0 0 4px;">' + esc(name) + '</h2>';
  if (headline) h += '<div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:4px;">' + esc(headline) + '</div>';
  if (location) h += '<div style="font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:4px;">&#128205; ' + esc(location) + '</div>';
  h += '</div></div>';

  // Key stats card
  var roleCount = connCounts['role'] || 0;
  var skillCount = connCounts['skill'] || 0;
  var relCount = rels.length;
  h += '<div style="display:flex;gap:16px;margin-bottom:20px;">';
  var stats = [
    { n: roleCount, l: 'Roles' },
    { n: skillCount, l: 'Skills' },
    { n: relCount, l: 'Connections' }
  ];
  for (var i = 0; i < stats.length; i++) {
    h += '<div style="flex:1;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:12px 16px;text-align:center;">';
    h += '<div style="font-size:1.3rem;font-weight:700;color:#6366f1;">' + stats[i].n + '</div>';
    h += '<div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">' + stats[i].l + '</div>';
    h += '</div>';
  }
  h += '</div>';

  // Summary
  if (summary) {
    h += '<div class="section"><div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div></div>';
  }

  // Top 3 recent observations
  if (obs.length > 0) {
    var topObs = obs.slice(0, 3);
    h += '<div class="section"><div class="section-title section-title-only">Recent Observations</div>';
    for (var i = 0; i < topObs.length; i++) {
      var o = topObs[i];
      var decay = calcDecay(o.observed_at);
      h += '<div class="obs-card" style="opacity:' + Math.max(0.5, decay).toFixed(2) + '">';
      h += '<div class="obs-text">' + esc(o.observation) + '</div>';
      h += '<div class="obs-meta">';
      h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      h += confidenceBadge(o.confidence, o.confidence_label);
      h += '</div></div>';
    }
    h += '</div>';
  }

  // Connected objects summary
  var connKeys = Object.keys(connCounts);
  if (connKeys.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
    var connLabels = { role: 'Roles', organization: 'Organizations', credential: 'Credentials', skill: 'Skills' };
    for (var i = 0; i < connKeys.length; i++) {
      var ck = connKeys[i];
      var cl = connLabels[ck] || (ck.charAt(0).toUpperCase() + ck.slice(1) + 's');
      h += '<div style="background:var(--bg-card);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:8px 14px;font-size:0.82rem;">';
      h += '<span style="font-weight:600;color:#6366f1;">' + connCounts[ck] + '</span> ' + esc(cl);
      h += '</div>';
    }
    h += '</div></div>';
  }

  document.getElementById('main').innerHTML = h;
}

function renderOverview(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  if (['role', 'organization', 'credential', 'skill'].indexOf(type) !== -1) {
    return renderConnectedDetail(data);
  }
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  var summary = e.summary?.value || '';
  var meta = data.extraction_metadata || {};
  var h = '';

  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += confidenceBadge(meta.extraction_confidence);
  h += '</div>';

  h += '<div class="section">';
  h += '<div class="section-header"><span class="section-title">Summary</span>';
  h += '<button class="btn-sm" id="btnEditSummary" onclick="toggleSummaryEdit()">Edit</button></div>';
  h += '<div id="summaryDisplay" class="summary-text">' + esc(summary) + '</div>';
  h += '<div id="summaryEditSection" style="display:none">';
  h += '<textarea class="summary-edit" id="summaryEdit">' + esc(summary) + '</textarea>';
  h += '<div class="edit-actions"><button class="btn-save" onclick="saveSummary()">Save</button>';
  h += '<button class="btn-cancel" onclick="toggleSummaryEdit()">Cancel</button></div>';
  h += '</div></div>';

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

  var connected = data.connected_objects || [];
  if (connected.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects (' + connected.length + ')</div>';
    var groups = { role: [], organization: [], credential: [], skill: [] };
    for (var i = 0; i < connected.length; i++) {
      var c = connected[i];
      if (groups[c.entity_type]) groups[c.entity_type].push(c);
    }
    var groupLabels = { role: 'Roles', organization: 'Organizations', credential: 'Credentials', skill: 'Skills' };
    var groupKeys = ['role', 'organization', 'credential', 'skill'];
    for (var g = 0; g < groupKeys.length; g++) {
      var gk = groupKeys[g];
      var items = groups[gk];
      if (items.length === 0) continue;
      h += '<div style="margin-bottom:12px;"><div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">' + groupLabels[gk] + '</div>';
      for (var j = 0; j < items.length; j++) {
        h += '<div class="entity-item" style="padding:6px 10px;cursor:pointer;" onclick="selectEntity(' + "'" + esc(items[j].entity_id) + "'" + ')">';
        h += '<span class="entity-item-name">' + esc(items[j].label) + '</span>';
        h += '<span class="type-badge ' + esc(items[j].entity_type) + '">' + esc(items[j].entity_type) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
  }

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

function toggleSection(sectionId) {
  collapsedSections[sectionId] = !collapsedSections[sectionId];
  try { sessionStorage.setItem('ca_collapsed', JSON.stringify(collapsedSections)); } catch(e) {}
  renderSidebar();
}

// Capture OAuth session token from URL and store in sessionStorage
(function() {
  var params = new URLSearchParams(window.location.search);
  var sessionToken = params.get('session');
  if (sessionToken) {
    sessionStorage.setItem('ca_token', sessionToken);
    history.replaceState(null, '', '/wiki');
  }
})();

function getAuthHeaders() {
  var headers = { 'X-Agent-Id': 'wiki-dashboard' };
  if (apiKey) {
    headers['X-Context-API-Key'] = apiKey;
  } else {
    var token = sessionStorage.getItem('ca_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }
  return headers;
}

function api(method, path, body) {
  var opts = {
    method: method,
    headers: getAuthHeaders(),
  };
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

  // Restore collapsed sections from sessionStorage
  try {
    var saved = sessionStorage.getItem('ca_collapsed');
    if (saved) collapsedSections = JSON.parse(saved);
  } catch(e) {}

  // Set up footer user info
  if (user && user.name) {
    document.getElementById('userInfo').innerHTML = '<span class="sidebar-footer-user-name">' + esc(user.name) + '</span>';
    document.getElementById('logoutLink').innerHTML = '<a href="#" onclick="logout();return false;">Logout</a>';
    document.getElementById('btnDrive').style.display = 'inline';
    document.getElementById('driveSep').style.display = 'inline';
    // User avatar
    var avatarEl = document.getElementById('userAvatar');
    if (user.picture) {
      avatarEl.innerHTML = '<img src="' + esc(user.picture) + '" alt="" />';
    } else {
      var initials = user.name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
      avatarEl.textContent = initials;
    }
  }

  // Two-phase load: fetch all entities, then identify primary user
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    primaryEntityId = findPrimaryUser(allEntities, sessionUser);
    if (primaryEntityId) {
      return api('GET', '/api/entity/' + primaryEntityId).then(function(fullData) {
        primaryEntityData = fullData;
        renderSidebar();
        selectView('overview');
      });
    } else {
      renderSidebar();
    }
  });
}

function logout() {
  sessionStorage.removeItem('ca_token');
  fetch('/auth/logout', { method: 'POST' }).then(function() {
    window.location.reload();
  });
}

/* --- Login --- */
// Auto-login: check for existing session (Bearer token from sessionStorage)
(function() {
  var token = sessionStorage.getItem('ca_token');
  if (!token) return; // No token — show login screen
  fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + token } }).then(function(r) {
    if (r.ok) return r.json();
    throw new Error('auth failed: ' + r.status);
  }).then(function(user) {
    if (user && user.tenant_id) {
      enterApp(user);
    }
  }).catch(function(err) {
    sessionStorage.removeItem('ca_token');
  });
})();

// Manual API key login
function login() {
  apiKey = document.getElementById('apiKeyInput').value.trim();
  if (!apiKey) return;
  document.getElementById('btnLogin').disabled = true;
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderSidebar();
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
    var q = document.getElementById('searchInput').value.trim();
    if (!q) {
      // Empty search — restore all entities
      entities = allEntities.slice();
      renderSidebar();
      return;
    }
    var url = '/api/search?q=' + encodeURIComponent(q);
    api('GET', url).then(function(data) {
      entities = data.results || [];
      renderSidebar();
    });
  }, 250);
}

function renderSidebarSection(id, emoji, title, count, contentFn, defaultCollapsed) {
  var isCollapsed = collapsedSections[id] !== undefined ? collapsedSections[id] : !!defaultCollapsed;
  var html = '<div class="sidebar-section">';
  html += '<div class="sidebar-section-header" onclick="toggleSection(' + "'" + id + "'" + ')">';
  html += '<span class="sidebar-section-chevron' + (isCollapsed ? ' collapsed' : '') + '">&#9660;</span>';
  html += '<span class="sidebar-section-title">' + emoji + ' ' + esc(title) + '</span>';
  if (count != null) html += '<span class="sidebar-section-count">' + count + '</span>';
  html += '</div>';
  html += '<div class="sidebar-section-body' + (isCollapsed ? ' collapsed' : '') + '">';
  html += contentFn();
  html += '</div></div>';
  return html;
}

function renderSidebarEntityRow(e, subtitle) {
  var cls = (e.entity_id === selectedId && selectedView === null) ? 'sidebar-entity-row active' : 'sidebar-entity-row';
  var html = '<div class="' + cls + '" onclick="selectEntity(' + "'" + esc(e.entity_id) + "'" + ')">';
  html += '<div class="entity-name">' + esc(e.name) + ' <span class="type-badge ' + e.entity_type + '">' + e.entity_type + '</span></div>';
  if (subtitle) html += '<div class="entity-subtitle">' + esc(subtitle) + '</div>';
  html += '</div>';
  return html;
}

function renderSidebar() {
  var data = buildSidebarData();
  console.log('SIDEBAR_DEBUG: buildSidebarData called');
  console.log('SIDEBAR_DEBUG: you:', data.you ? data.you.name : 'NOT FOUND');
  console.log('SIDEBAR_DEBUG: allEntities:', allEntities.length, 'entities:', entities.length);
  console.log('SIDEBAR_DEBUG: primaryEntityId:', primaryEntityId);
  console.log('SIDEBAR_DEBUG: primaryEntityData:', primaryEntityData ? 'loaded' : 'null');
  console.log('SIDEBAR_DEBUG: people fam/inner/pro/other:', data.people.family.length, data.people.inner_circle.length, data.people.professional.length, data.people.other.length);
  console.log('SIDEBAR_DEBUG: orgs career/edu/other:', data.organizations.career.length, data.organizations.education.length, data.organizations.other.length);
  var html = '';
  var totalCount = 0;

  // Section 1: My Profiles
  if (data.you) {
    html += renderSidebarSection('you', '\uD83D\uDC64', 'My Profiles', null, function() {
      var h = '';
      // Profile card with avatar + name + headline
      var headline = '';
      var pAttrs = (primaryEntityData && primaryEntityData.attributes) || [];
      for (var a = 0; a < pAttrs.length; a++) {
        if (pAttrs[a].key === 'headline') { headline = String(pAttrs[a].value || ''); break; }
      }
      h += '<div class="sidebar-profile-header">';
      h += '<div class="sidebar-profile-avatar">';
      if (sessionUser && sessionUser.picture) {
        h += '<img src="' + esc(sessionUser.picture) + '" alt="" />';
      } else {
        var n = data.you.name || (sessionUser && sessionUser.name) || '';
        var init = n.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
        h += init;
      }
      h += '</div>';
      h += '<div style="overflow:hidden;">';
      h += '<div class="sidebar-profile-name">' + esc(data.you.name || '') + '</div>';
      if (headline) h += '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(headline) + '</div>';
      h += '</div>';
      h += '</div>';
      // Interface sub-items
      var views = [
        { id: 'overview', icon: '\uD83D\uDCCB', label: 'Overview' },
        { id: 'career-lite', icon: '\uD83D\uDCBC', label: 'Career Lite' },
        { id: 'executive-brief', icon: '\uD83D\uDCC4', label: 'Executive Brief', soon: true },
        { id: 'creator-profile', icon: '\uD83C\uDFA8', label: 'Creator Profile', soon: true },
        { id: 'values-identity', icon: '\uD83E\uDDED', label: 'Values & Identity', soon: true }
      ];
      for (var i = 0; i < views.length; i++) {
        var v = views[i];
        var active = (selectedId === primaryEntityId && selectedView === v.id);
        var cls = 'sidebar-view-item' + (active ? ' active' : '') + (v.soon ? ' placeholder' : '');
        if (v.soon) {
          h += '<div class="' + cls + '">';
        } else {
          h += '<div class="' + cls + '" onclick="selectView(' + "'" + v.id + "'" + ')">';
        }
        h += '<span class="view-icon">' + v.icon + '</span>';
        h += '<span>' + esc(v.label) + '</span>';
        if (v.soon) h += ' <span class="coming-soon-badge">Soon</span>';
        h += '</div>';
      }
      totalCount++;
      return h;
    }, false);
  }

  // Section 2: People
  var peopleCount = data.people.family.length + data.people.inner_circle.length +
                    data.people.professional.length + data.people.other.length;
  if (peopleCount > 0 || !data.you) {
    html += renderSidebarSection('people', '\uD83D\uDC65', 'People', peopleCount, function() {
      var h = '';
      var groups = [
        { key: 'family', emoji: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC66', label: 'Family' },
        { key: 'inner_circle', emoji: '\uD83E\uDD1D', label: 'Inner Circle' },
        { key: 'professional', emoji: '\uD83D\uDCBC', label: 'Professional' },
        { key: 'other', emoji: '\uD83D\uDC65', label: 'Other' }
      ];
      for (var g = 0; g < groups.length; g++) {
        var items = data.people[groups[g].key];
        if (items.length === 0) continue;
        h += '<div class="sidebar-group-label">' + groups[g].emoji + ' ' + groups[g].label + '</div>';
        for (var i = 0; i < items.length; i++) {
          h += renderSidebarEntityRow(items[i], items[i]._relType || '');
        }
      }
      if (peopleCount === 0) {
        h += '<div class="sidebar-empty-hint">No people found</div>';
      }
      return h;
    }, false);
    totalCount += peopleCount;
  }

  // Section 3: Organizations
  var orgCount = data.organizations.career.length + data.organizations.education.length + data.organizations.other.length;
  if (orgCount > 0) {
    html += renderSidebarSection('orgs', '\uD83C\uDFE2', 'Organizations', orgCount, function() {
      var h = '';
      // Career orgs (with roles)
      if (data.organizations.career.length > 0) {
        h += '<div class="sidebar-group-label">\uD83D\uDCBC Career</div>';
        for (var i = 0; i < data.organizations.career.length; i++) {
          var item = data.organizations.career[i];
          h += renderSidebarEntityRow(item.org, item.roleTitle);
        }
      }
      // Education orgs (with credentials)
      if (data.organizations.education.length > 0) {
        h += '<div class="sidebar-group-label">\uD83C\uDF93 Education</div>';
        for (var i = 0; i < data.organizations.education.length; i++) {
          var item = data.organizations.education[i];
          h += renderSidebarEntityRow(item.org, item.credLabel);
        }
      }
      // Other orgs
      if (data.organizations.other.length > 0) {
        if (data.organizations.career.length > 0 || data.organizations.education.length > 0) {
          h += '<div class="sidebar-group-label">Other</div>';
        }
        for (var i = 0; i < data.organizations.other.length; i++) {
          h += renderSidebarEntityRow(data.organizations.other[i], '');
        }
      }
      return h;
    }, true);
    totalCount += orgCount;
  }

  // Section 4: Projects
  var projCount = data.projects.active.length + data.projects.rnd.length + data.projects.archive.length;
  html += renderSidebarSection('projects', '\uD83D\uDD28', 'Projects', projCount, function() {
    var h = '';
    if (projCount === 0) {
      h += '<div class="sidebar-empty-hint">No projects yet &mdash; upload project docs to get started</div>';
      return h;
    }
    if (data.projects.active.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDFE2 Active</div>';
      for (var i = 0; i < data.projects.active.length; i++) {
        h += renderSidebarEntityRow(data.projects.active[i], '');
      }
    }
    if (data.projects.rnd.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDD2C R&amp;D</div>';
      for (var i = 0; i < data.projects.rnd.length; i++) {
        h += renderSidebarEntityRow(data.projects.rnd[i], '');
      }
    }
    if (data.projects.archive.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDCE6 Archive</div>';
      for (var i = 0; i < data.projects.archive.length; i++) {
        h += renderSidebarEntityRow(data.projects.archive[i], '');
      }
    }
    return h;
  }, true);

  // Section 5: Timeline placeholder
  html += renderSidebarSection('timeline', '\uD83D\uDCC5', 'Timeline', null, function() {
    return '<div class="sidebar-view-item placeholder"><span class="view-icon">\uD83D\uDCC5</span><span>Coming soon</span> <span class="coming-soon-badge">Soon</span></div>';
  }, true);

  document.getElementById('entityList').innerHTML = html || '<div style="padding:16px;color:#3a3a4a;font-size:0.82rem;">No entities found</div>';
  document.getElementById('sidebarCount').textContent = totalCount + ' entit' + (totalCount === 1 ? 'y' : 'ies');
}

// Backward-compat alias
function renderEntityList() { renderSidebar(); }

/* --- Entity Detail --- */
function selectEntity(id) {
  selectedId = id;
  selectedView = null;
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
  api('GET', '/api/entity/' + id).then(function(data) {
    selectedData = data;
    renderDetail(data);
    renderSidebar();
  }).catch(function(err) {
    document.getElementById('main').innerHTML = '<div class="empty-state">Error loading entity: ' + esc(err.message) + '</div>';
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

/* --- File Upload --- */
var uploadFiles = [];
var uploadInProgress = false;

function showUploadView() {
  selectedId = null;
  selectedView = null;
  uploadFiles = [];
  uploadInProgress = false;
  var h = '<div class="upload-view active">';
  h += '<h2 style="font-size:1.2rem;font-weight:700;color:var(--text-primary);margin-bottom:16px;">Upload Files</h2>';
  h += '<div class="upload-dropzone" id="uploadDropzone">';
  h += '<div class="upload-dropzone-icon">+</div>';
  h += '<div class="upload-dropzone-text">Drag & drop files here, or click to browse</div>';
  h += '<div class="upload-dropzone-hint">PDF, DOC, DOCX, XLSX, CSV, TXT, MD, JSON &mdash; up to 50 MB per file</div>';
  h += '</div>';
  h += '<div class="upload-file-list" id="uploadFileList"></div>';
  h += '<div id="uploadProgressLog" class="upload-progress-log" style="display:none;"></div>';
  h += '<div id="uploadSummary" style="display:none;"></div>';
  h += '<button class="btn-start-upload" id="btnStartUpload" onclick="startUpload()" style="display:none;">Upload & Extract</button>';
  h += '<button class="btn-back-upload" onclick="hideUploadView()">Back to Entities</button>';
  h += '</div>';
  document.getElementById('main').innerHTML = h;

  // Wire up drop zone
  var dz = document.getElementById('uploadDropzone');
  dz.addEventListener('click', function() { document.getElementById('uploadFileInput').click(); });
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function(e) {
    e.preventDefault(); dz.classList.remove('dragover');
    addUploadFiles(e.dataTransfer.files);
  });
  document.getElementById('uploadFileInput').onchange = function(e) {
    addUploadFiles(e.target.files);
    e.target.value = '';
  };

  // Deselect sidebar items
  var items = document.querySelectorAll('.entity-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
}

function hideUploadView() {
  if (uploadInProgress) return;
  document.getElementById('main').innerHTML = '<div class="empty-state" id="emptyState">Select an entity from the sidebar<br/>to view its knowledge graph profile</div>';
}

var ALLOWED_UPLOAD_EXT = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json'];

function addUploadFiles(fileList) {
  for (var i = 0; i < fileList.length; i++) {
    var f = fileList[i];
    var ext = '.' + f.name.split('.').pop().toLowerCase();
    if (ALLOWED_UPLOAD_EXT.indexOf(ext) === -1) {
      toast('Unsupported file type: ' + ext);
      continue;
    }
    // Avoid duplicates by name
    var dup = false;
    for (var j = 0; j < uploadFiles.length; j++) {
      if (uploadFiles[j].name === f.name) { dup = true; break; }
    }
    if (!dup) uploadFiles.push(f);
  }
  renderUploadFileList();
}

function removeUploadFile(idx) {
  uploadFiles.splice(idx, 1);
  renderUploadFileList();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderUploadFileList() {
  var html = '';
  for (var i = 0; i < uploadFiles.length; i++) {
    var f = uploadFiles[i];
    html += '<div class="upload-file-item">';
    html += '<span class="upload-file-name">' + esc(f.name) + '</span>';
    html += '<span class="upload-file-size">' + formatFileSize(f.size) + '</span>';
    html += '<span class="upload-file-status pending" id="uploadStatus' + i + '">ready</span>';
    html += '<button class="upload-file-remove" onclick="removeUploadFile(' + i + ')">&times;</button>';
    html += '</div>';
  }
  document.getElementById('uploadFileList').innerHTML = html;
  var btn = document.getElementById('btnStartUpload');
  if (btn) btn.style.display = uploadFiles.length > 0 ? 'block' : 'none';
}

function startUpload() {
  if (uploadFiles.length === 0 || uploadInProgress) return;
  uploadInProgress = true;
  document.getElementById('btnStartUpload').disabled = true;

  // Disable remove buttons
  var removeBtns = document.querySelectorAll('.upload-file-remove');
  for (var i = 0; i < removeBtns.length; i++) removeBtns[i].style.display = 'none';

  var log = document.getElementById('uploadProgressLog');
  log.style.display = 'block';
  log.innerHTML = '<div class="log-info">Starting upload...</div>';

  var formData = new FormData();
  for (var i = 0; i < uploadFiles.length; i++) {
    formData.append('files', uploadFiles[i]);
  }

  var headers = getAuthHeaders();
  headers['X-Agent-Id'] = 'wiki-upload';

  fetch('/api/ingest/files', {
    method: 'POST',
    headers: headers,
    body: formData,
  }).then(function(response) {
    if (!response.ok) {
      return response.json().then(function(e) {
        throw new Error(e.error || 'Upload failed (' + response.status + ')');
      });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function read() {
      return reader.read().then(function(result) {
        if (result.done) {
          uploadComplete();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            var evt = JSON.parse(lines[i]);
            handleUploadEvent(evt);
          } catch (e) {}
        }
        return read();
      });
    }
    return read();
  }).catch(function(err) {
    log.innerHTML += '<div class="log-error">Error: ' + esc(err.message) + '</div>';
    log.scrollTop = log.scrollHeight;
    uploadInProgress = false;
    document.getElementById('btnStartUpload').disabled = false;
    document.getElementById('btnStartUpload').textContent = 'Retry';
  });
}

function handleUploadEvent(evt) {
  var log = document.getElementById('uploadProgressLog');
  if (evt.type === 'started') {
    log.innerHTML += '<div class="log-info">Processing ' + evt.total_files + ' file' + (evt.total_files > 1 ? 's' : '') + '...</div>';
  } else if (evt.type === 'file_progress') {
    var idx = evt.file_index - 1;
    var statusEl = document.getElementById('uploadStatus' + idx);
    if (evt.warning) {
      if (statusEl) {
        statusEl.className = 'upload-file-status error';
        statusEl.textContent = 'no entities';
      }
      log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.warning) + '</div>';
    } else {
      if (statusEl) {
        statusEl.className = 'upload-file-status done';
        statusEl.textContent = evt.entities_created + ' created, ' + evt.entities_updated + ' merged';
      }
      log.innerHTML += '<div class="log-success">' + esc(evt.file) + ' — ' + evt.entities_created + ' created, ' + evt.entities_updated + ' updated</div>';
    }
  } else if (evt.type === 'file_error') {
    var idx = evt.file_index - 1;
    var statusEl = document.getElementById('uploadStatus' + idx);
    if (statusEl) {
      statusEl.className = 'upload-file-status error';
      statusEl.textContent = 'error';
    }
    log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.error) + '</div>';
  } else if (evt.type === 'complete') {
    var s = evt.summary || {};
    var sumEl = document.getElementById('uploadSummary');
    sumEl.style.display = 'block';
    sumEl.innerHTML = '<div class="upload-summary">' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.files_processed || 0) + '</div><div class="upload-summary-label">Files</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_created || 0) + '</div><div class="upload-summary-label">Created</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_updated || 0) + '</div><div class="upload-summary-label">Merged</div></div>' +
      '</div>';
  }
  log.scrollTop = log.scrollHeight;
}

function uploadComplete() {
  uploadInProgress = false;
  var btn = document.getElementById('btnStartUpload');
  btn.textContent = 'Done — View Entities';
  btn.disabled = false;
  btn.onclick = function() {
    hideUploadView();
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  };
  // Also refresh sidebar entity list
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    renderSidebar();
  });
}

/* --- Google Drive Picker --- */
var driveBreadcrumb = [{ id: null, name: 'My Drive' }];
var driveFiles = [];
var driveSelected = {};
var driveIngesting = false;
var driveSearchMode = false;
var driveSearchQuery = '';
var driveFilterTimeout = null;

function showDriveView() {
  selectedId = null;
  selectedView = null;
  driveBreadcrumb = [{ id: null, name: 'My Drive' }];
  driveFiles = [];
  driveSelected = {};
  driveIngesting = false;
  driveSearchMode = false;
  driveSearchQuery = '';
  renderDrivePanel();
  loadDriveFolder(null);
  var items = document.querySelectorAll('.entity-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
}

function renderDrivePanel() {
  var h = '<h2 style="font-size:1.2rem;font-weight:700;color:var(--text-primary);margin-bottom:16px;">Import from Google Drive</h2>';

  // Search bar
  h += '<div class="drive-search-bar">';
  h += '<input type="text" id="driveSearchInput" placeholder="Type to filter, press Enter to search all of Drive" value="' + esc(driveSearchQuery) + '" oninput="onDriveFilter()" onkeydown="if(event.key===' + "'" + 'Enter' + "'" + ')driveFullSearch()" />';
  if (driveSearchMode) {
    h += '<button class="drive-search-clear" onclick="clearDriveSearch()">Clear</button>';
  } else {
    h += '<button class="drive-search-btn" onclick="driveFullSearch()">Search</button>';
  }
  h += '</div>';

  if (driveSearchMode) {
    // Search results mode — show tag instead of breadcrumb
    h += '<div class="drive-search-tag">Search results for &ldquo;' + esc(driveSearchQuery) + '&rdquo;</div>';
  } else {
    // Breadcrumb
    h += '<div class="drive-breadcrumb">';
    for (var i = 0; i < driveBreadcrumb.length; i++) {
      if (i > 0) h += '<span class="sep">&rsaquo;</span>';
      if (i < driveBreadcrumb.length - 1) {
        h += '<a onclick="navigateDrive(' + i + ')">' + esc(driveBreadcrumb[i].name) + '</a>';
      } else {
        h += '<span class="current">' + esc(driveBreadcrumb[i].name) + '</span>';
      }
    }
    h += '</div>';
  }

  // Loading or file list
  h += '<div id="driveFileArea"><div class="drive-loading">Loading...</div></div>';

  // Progress log (hidden until ingest starts)
  h += '<div id="driveProgressLog" class="upload-progress-log" style="display:none;"></div>';
  h += '<div id="driveSummary" style="display:none;"></div>';

  // Action bar
  h += '<div id="driveActionBar">';
  var selCount = Object.keys(driveSelected).length;
  h += '<button class="btn-start-upload" id="btnDriveImport" onclick="startDriveIngest()" style="display:' + (selCount > 0 ? 'block' : 'none') + ';">Import ' + selCount + ' file' + (selCount !== 1 ? 's' : '') + '</button>';
  h += '<button class="btn-back-upload" onclick="hideUploadView()">Back to Entities</button>';
  h += '</div>';

  document.getElementById('main').innerHTML = h;
}

function onDriveFilter() {
  clearTimeout(driveFilterTimeout);
  driveFilterTimeout = setTimeout(function() {
    var input = document.getElementById('driveSearchInput');
    var q = input ? input.value.trim().toLowerCase() : '';
    if (driveSearchMode || !q) {
      renderDriveFiles();
      return;
    }
    // Local filter: re-render with filter applied
    renderDriveFiles(q);
  }, 150);
}

function driveFullSearch() {
  var input = document.getElementById('driveSearchInput');
  var q = input ? input.value.trim() : '';
  if (!q) return;
  driveSearchQuery = q;
  driveSearchMode = true;
  driveSelected = {};
  renderDrivePanel();
  // API search
  var area = document.getElementById('driveFileArea');
  if (area) area.innerHTML = '<div class="drive-loading">Searching Drive...</div>';
  api('GET', '/api/drive/files?q=' + encodeURIComponent(q)).then(function(data) {
    driveFiles = data.files || [];
    renderDriveFiles();
  }).catch(function(err) {
    if (area) area.innerHTML = '<div class="drive-empty" style="color:#ef4444;">Search error: ' + esc(err.message) + '</div>';
  });
}

function clearDriveSearch() {
  driveSearchMode = false;
  driveSearchQuery = '';
  driveSelected = {};
  var folderId = driveBreadcrumb[driveBreadcrumb.length - 1].id;
  renderDrivePanel();
  loadDriveFolder(folderId);
}

function loadDriveFolder(folderId) {
  var area = document.getElementById('driveFileArea');
  if (area) area.innerHTML = '<div class="drive-loading">Loading...</div>';

  var url = '/api/drive/files';
  if (folderId) url += '?folderId=' + encodeURIComponent(folderId);

  api('GET', url).then(function(data) {
    driveFiles = data.files || [];
    renderDriveFiles();
  }).catch(function(err) {
    if (area) area.innerHTML = '<div class="drive-empty" style="color:#ef4444;">Error: ' + esc(err.message) + '</div>';
  });
}

function renderDriveFiles(localFilter) {
  var area = document.getElementById('driveFileArea');
  if (!area) return;

  var filtered = driveFiles;
  if (localFilter) {
    filtered = driveFiles.filter(function(f) {
      return f.name.toLowerCase().indexOf(localFilter) !== -1;
    });
  }

  if (filtered.length === 0) {
    area.innerHTML = '<div class="drive-empty">' + (localFilter ? 'No files match &ldquo;' + esc(localFilter) + '&rdquo;' : 'No supported files in this folder') + '</div>';
    updateDriveActionBar();
    return;
  }

  var h = '<div class="drive-file-list">';
  for (var i = 0; i < filtered.length; i++) {
    var f = filtered[i];
    if (f.isFolder) {
      var fChecked = driveSelected[f.id] ? ' checked' : '';
      var fSelCls = driveSelected[f.id] ? ' selected' : '';
      h += '<div class="drive-file-row' + fSelCls + '">';
      h += '<input type="checkbox" class="drive-file-check"' + fChecked + ' onclick="event.stopPropagation(); toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" />';
      h += '<div class="drive-file-icon" onclick="openDriveFolder(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" style="cursor:pointer;">\\ud83d\\udcc1</div>';
      h += '<div class="drive-file-name folder" onclick="openDriveFolder(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" style="cursor:pointer;">' + esc(f.name) + '</div>';
      h += '<div class="drive-file-meta">' + formatDriveDate(f.modifiedTime) + '</div>';
      h += '</div>';
    } else {
      var checked = driveSelected[f.id] ? ' checked' : '';
      var selCls = driveSelected[f.id] ? ' selected' : '';
      h += '<div class="drive-file-row' + selCls + '" onclick="toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')">';
      h += '<input type="checkbox" class="drive-file-check"' + checked + ' onclick="event.stopPropagation(); toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" />';
      h += '<div class="drive-file-icon">' + driveFileIcon(f.mimeType, f.isGoogleNative) + '</div>';
      h += '<div class="drive-file-name">' + esc(f.name) + (f.isGoogleNative ? ' <span style="font-size:0.65rem;color:#4b5563;">(Google)</span>' : '') + '</div>';
      h += '<div class="drive-file-meta">' + (f.size ? formatFileSize(f.size) : '') + '</div>';
      h += '<div class="drive-file-meta">' + formatDriveDate(f.modifiedTime) + '</div>';
      h += '</div>';
    }
  }
  h += '</div>';
  area.innerHTML = h;
  updateDriveActionBar();
}

function driveFileIcon(mimeType, isGoogleNative) {
  if (mimeType === 'application/pdf') return '\\ud83d\\udcc4';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') return '\\ud83d\\udcca';
  if (mimeType.includes('document') || mimeType.includes('wordprocessing')) return '\\ud83d\\udcdd';
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return '\\ud83d\\udcc3';
  return '\\ud83d\\udcc4';
}

function formatDriveDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function openDriveFolder(id, name) {
  driveBreadcrumb.push({ id: id, name: name });
  driveSelected = {};
  renderDrivePanel();
  loadDriveFolder(id);
}

function navigateDrive(index) {
  driveBreadcrumb = driveBreadcrumb.slice(0, index + 1);
  driveSelected = {};
  var folderId = driveBreadcrumb[driveBreadcrumb.length - 1].id;
  renderDrivePanel();
  loadDriveFolder(folderId);
}

function toggleDriveFile(fileId, fileName) {
  if (driveSelected[fileId]) {
    delete driveSelected[fileId];
  } else {
    driveSelected[fileId] = fileName;
  }
  renderDriveFiles();
}

function updateDriveActionBar() {
  var btn = document.getElementById('btnDriveImport');
  if (!btn) return;
  var selCount = Object.keys(driveSelected).length;
  btn.style.display = selCount > 0 ? 'block' : 'none';
  btn.textContent = 'Import ' + selCount + ' file' + (selCount !== 1 ? 's' : '');
}

function startDriveIngest() {
  var ids = Object.keys(driveSelected);
  if (ids.length === 0 || driveIngesting) return;
  driveIngesting = true;

  var btn = document.getElementById('btnDriveImport');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  var log = document.getElementById('driveProgressLog');
  log.style.display = 'block';
  log.innerHTML = '<div class="log-info">Starting import of ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' from Drive...</div>';

  var headers = getAuthHeaders();
  headers['Content-Type'] = 'application/json';
  headers['X-Agent-Id'] = 'wiki-drive';

  fetch('/api/drive/ingest', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ fileIds: ids }),
  }).then(function(response) {
    if (!response.ok) {
      return response.json().then(function(e) {
        throw new Error(e.error || 'Import failed (' + response.status + ')');
      });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function read() {
      return reader.read().then(function(result) {
        if (result.done) {
          driveIngestComplete();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            var evt = JSON.parse(lines[i]);
            handleDriveEvent(evt);
          } catch (e) {}
        }
        return read();
      });
    }
    return read();
  }).catch(function(err) {
    log.innerHTML += '<div class="log-error">Error: ' + esc(err.message) + '</div>';
    log.scrollTop = log.scrollHeight;
    driveIngesting = false;
    btn.disabled = false;
    btn.textContent = 'Retry Import';
  });
}

function handleDriveEvent(evt) {
  var log = document.getElementById('driveProgressLog');
  if (evt.type === 'started') {
    log.innerHTML += '<div class="log-info">Processing ' + evt.total_files + ' file' + (evt.total_files > 1 ? 's' : '') + '...</div>';
  } else if (evt.type === 'file_downloading') {
    log.innerHTML += '<div class="log-info">Downloading file ' + evt.file_index + '...</div>';
  } else if (evt.type === 'file_progress') {
    if (evt.warning) {
      log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.warning) + '</div>';
    } else {
      log.innerHTML += '<div class="log-success">' + esc(evt.file) + ' — ' + evt.entities_created + ' created, ' + evt.entities_updated + ' updated</div>';
    }
  } else if (evt.type === 'file_error') {
    log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.error) + '</div>';
  } else if (evt.type === 'complete') {
    var s = evt.summary || {};
    var sumEl = document.getElementById('driveSummary');
    sumEl.style.display = 'block';
    sumEl.innerHTML = '<div class="upload-summary">' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.files_processed || 0) + '</div><div class="upload-summary-label">Files</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_created || 0) + '</div><div class="upload-summary-label">Created</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_updated || 0) + '</div><div class="upload-summary-label">Merged</div></div>' +
      '</div>';
  }
  log.scrollTop = log.scrollHeight;
}

function driveIngestComplete() {
  driveIngesting = false;
  var btn = document.getElementById('btnDriveImport');
  btn.textContent = 'Done — View Entities';
  btn.disabled = false;
  btn.onclick = function() {
    hideUploadView();
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  };
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    renderSidebar();
  });
}

function renderCareerLite(data) {
  var e = data.entity || {};
  var cl = data.career_lite || {};
  var name = e.name?.full || '';
  var initials = name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase();
  var h = '';

  // Header with avatar
  h += '<div class="section">';
  h += '<div class="cl-header">';
  h += '<div class="cl-avatar">' + esc(initials) + '</div>';
  h += '<div class="cl-header-info">';
  h += '<div class="cl-name">' + esc(name) + '</div>';
  if (cl.headline) h += '<div class="cl-headline">' + esc(cl.headline) + '</div>';
  if (cl.current_role && cl.current_company) {
    h += '<div class="cl-current">' + esc(cl.current_role) + ' @ ' + esc(cl.current_company) + '</div>';
  } else if (cl.current_role || cl.current_company) {
    h += '<div class="cl-current">' + esc(cl.current_role || cl.current_company) + '</div>';
  }
  if (cl.location) h += '<div class="cl-location">' + esc(cl.location) + '</div>';

  // Contact row
  var contacts = [];
  var attrs = data.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].key === 'email' && attrs[i].value) contacts.push('<span class="cl-contact-item">' + esc(attrs[i].value) + '</span>');
    if (attrs[i].key === 'phone' && attrs[i].value) contacts.push('<span class="cl-contact-item">' + esc(attrs[i].value) + '</span>');
  }
  if (cl.linkedin_url) contacts.push('<a href="' + esc(cl.linkedin_url) + '" target="_blank">LinkedIn</a>');
  if (contacts.length > 0) h += '<div class="cl-contact-row">' + contacts.join('') + '</div>';

  h += '<div class="cl-header-actions"><div class="cl-interface-badge">Career Lite Profile</div>';
  h += '<button class="btn-share" onclick="openShareModal()">Share</button></div>';
  h += '</div></div></div>';

  // Summary
  var summary = e.summary?.value || '';
  if (summary) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div>';
    h += '</div>';
  }

  // Experience
  var exp = cl.experience || [];
  if (exp.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Experience (' + exp.length + ')</div>';
    for (var i = 0; i < exp.length; i++) {
      var x = exp[i];
      h += '<div class="cl-exp-card">';
      if (x.company) h += '<div class="cl-exp-company">' + esc(x.company) + '</div>';
      if (x.title) h += '<div class="cl-exp-title">' + esc(x.title) + '</div>';
      var dates = [x.start_date, x.end_date].filter(Boolean).join(' — ');
      if (dates) h += '<div class="cl-exp-dates">' + esc(dates) + '</div>';
      if (x.description) h += '<div class="cl-exp-desc">' + esc(x.description) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Education
  var edu = cl.education || [];
  if (edu.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Education (' + edu.length + ')</div>';
    for (var i = 0; i < edu.length; i++) {
      var ed = edu[i];
      h += '<div class="cl-edu-card">';
      if (ed.institution) h += '<div class="cl-edu-institution">' + esc(ed.institution) + '</div>';
      var degree = [ed.degree, ed.field].filter(Boolean).join(' in ');
      if (degree) h += '<div class="cl-edu-degree">' + esc(degree) + '</div>';
      var years = [ed.start_year, ed.end_year].filter(Boolean).join(' — ');
      if (years) h += '<div class="cl-edu-years">' + esc(years) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Skills
  var skills = cl.skills || [];
  if (skills.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Skills (' + skills.length + ')</div>';
    h += '<div class="cl-skills-wrap">';
    for (var i = 0; i < skills.length; i++) {
      h += '<span class="cl-skill-tag">' + esc(skills[i]) + '</span>';
    }
    h += '</div></div>';
  }

  // Relationships (if any)
  var rels = data.relationships || [];
  if (rels.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connections (' + rels.length + ')</div>';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Observations (collapsed view)
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  if (obs.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Observations (' + obs.length + ')</div>';
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      h += '<div class="obs-card">';
      h += '<div class="obs-text">' + esc(o.observation) + '</div>';
      h += '<div class="obs-meta">';
      h += confidenceBadge(o.confidence, o.confidence_label);
      if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
      h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      h += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
      h += '</div></div>';
    }
    h += '</div>';
  }

  document.getElementById('main').innerHTML = h;
}

function renderDetail(data) {
  // Check for Career Lite profile
  if (data.career_lite && data.career_lite.interface === 'career-lite') {
    return renderCareerLite(data);
  }

  var e = data.entity || {};
  var type = e.entity_type || '';

  // Route connected object types to their own renderer
  if (['role', 'organization', 'credential', 'skill'].indexOf(type) !== -1) {
    return renderConnectedDetail(data);
  }
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

  // Connected Objects
  var connected = data.connected_objects || [];
  if (connected.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects (' + connected.length + ')</div>';
    var groups = { role: [], organization: [], credential: [], skill: [] };
    for (var i = 0; i < connected.length; i++) {
      var c = connected[i];
      if (groups[c.entity_type]) groups[c.entity_type].push(c);
    }
    var groupLabels = { role: 'Roles', organization: 'Organizations', credential: 'Credentials', skill: 'Skills' };
    var groupKeys = ['role', 'organization', 'credential', 'skill'];
    for (var g = 0; g < groupKeys.length; g++) {
      var gk = groupKeys[g];
      var items = groups[gk];
      if (items.length === 0) continue;
      h += '<div style="margin-bottom:12px;"><div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">' + groupLabels[gk] + '</div>';
      for (var j = 0; j < items.length; j++) {
        h += '<div class="entity-item" style="padding:6px 10px;cursor:pointer;" onclick="selectEntity(' + "'" + esc(items[j].entity_id) + "'" + ')">';
        h += '<span class="entity-item-name">' + esc(items[j].label) + '</span>';
        h += '<span class="type-badge ' + esc(items[j].entity_type) + '">' + esc(items[j].entity_type) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
  }

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

function renderConnectedDetail(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  var name = e.name?.full || e.name?.common || '';
  var parentId = e.parent_entity_id || '';
  var h = '';

  // Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += '</div>';

  // Parent link
  if (parentId) {
    h += '<div class="section" style="padding:8px 0;">';
    h += '<span style="font-size:0.82rem;color:var(--text-muted);">Parent: </span>';
    h += '<a href="#" style="font-size:0.82rem;color:#6366f1;text-decoration:none;" onclick="event.preventDefault();selectEntity(' + "'" + esc(parentId) + "'" + ')">' + esc(parentId) + '</a>';
    h += '</div>';
  }

  // Type-specific data
  if (type === 'role' && data.role_data) {
    var rd = data.role_data;
    h += '<div class="section"><div class="section-title section-title-only">Role Details</div>';
    if (rd.title) h += '<div class="attr-row"><span class="attr-key">Title</span><span class="attr-value">' + esc(rd.title) + '</span></div>';
    if (rd.company) h += '<div class="attr-row"><span class="attr-key">Company</span><span class="attr-value">' + esc(rd.company) + '</span></div>';
    if (rd.start_date || rd.end_date) h += '<div class="attr-row"><span class="attr-key">Period</span><span class="attr-value">' + esc(rd.start_date || '?') + ' — ' + esc(rd.end_date || 'Present') + '</span></div>';
    if (rd.description) h += '<div style="margin-top:8px;font-size:0.82rem;color:var(--text-primary);line-height:1.5;">' + esc(rd.description) + '</div>';
    h += '</div>';
  }

  if (type === 'organization' && data.organization_data) {
    h += '<div class="section"><div class="section-title section-title-only">Organization Details</div>';
    h += '<div class="attr-row"><span class="attr-key">Name</span><span class="attr-value">' + esc(data.organization_data.name || name) + '</span></div>';
    h += '</div>';
  }

  if (type === 'credential' && data.credential_data) {
    var cd = data.credential_data;
    h += '<div class="section"><div class="section-title section-title-only">Credential Details</div>';
    if (cd.institution) h += '<div class="attr-row"><span class="attr-key">Institution</span><span class="attr-value">' + esc(cd.institution) + '</span></div>';
    if (cd.degree) h += '<div class="attr-row"><span class="attr-key">Degree</span><span class="attr-value">' + esc(cd.degree) + '</span></div>';
    if (cd.field) h += '<div class="attr-row"><span class="attr-key">Field</span><span class="attr-value">' + esc(cd.field) + '</span></div>';
    if (cd.start_year || cd.end_year) h += '<div class="attr-row"><span class="attr-key">Years</span><span class="attr-value">' + esc(cd.start_year || '?') + ' — ' + esc(cd.end_year || '?') + '</span></div>';
    h += '</div>';
  }

  if (type === 'skill' && data.skill_data) {
    h += '<div class="section"><div class="section-title section-title-only">Skill Details</div>';
    h += '<div class="attr-row"><span class="attr-key">Skill</span><span class="attr-value">' + esc(data.skill_data.name || name) + '</span></div>';
    h += '</div>';
  }

  // Summary if present
  var summary = e.summary?.value || '';
  if (summary) {
    h += '<div class="section"><div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div></div>';
  }

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

// --- Share functions ---

function openShareModal() {
  if (!selectedId) return;
  api('GET', '/api/shares/' + selectedId).then(function(shares) {
    showShareModal(shares);
  }).catch(function() {
    showShareModal([]);
  });
}

function showShareModal(existingShares) {
  var overlay = document.createElement('div');
  overlay.className = 'share-overlay';
  overlay.id = 'shareOverlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeShareModal(); };

  var sections = [
    { id: 'summary', label: 'Summary', defaultOn: true },
    { id: 'experience', label: 'Experience', defaultOn: true },
    { id: 'education', label: 'Education', defaultOn: true },
    { id: 'skills', label: 'Skills', defaultOn: true },
    { id: 'connections', label: 'Connections', defaultOn: false },
  ];

  var togglesHtml = '<div class="share-section-toggles">';
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    togglesHtml += '<div class="share-toggle-row">' +
      '<label for="share-sec-' + s.id + '">' + esc(s.label) + '</label>' +
      '<input type="checkbox" id="share-sec-' + s.id + '" ' + (s.defaultOn ? 'checked' : '') + '>' +
      '</div>';
  }
  togglesHtml += '</div>';

  var expiryHtml = '<div class="share-expiry-row">' +
    '<label>Expires in</label>' +
    '<select id="shareExpiry">' +
    '<option value="7">7 days</option>' +
    '<option value="30" selected>30 days</option>' +
    '<option value="90">90 days</option>' +
    '<option value="365">1 year</option>' +
    '</select></div>';

  var activeHtml = '';
  if (existingShares.length > 0) {
    activeHtml = '<div class="share-active-list"><h4>Active Links</h4>';
    for (var i = 0; i < existingShares.length; i++) {
      var sh = existingShares[i];
      var expDate = new Date(sh.expiresAt).toLocaleDateString();
      activeHtml += '<div class="share-active-item">' +
        '<div><div class="share-active-info">Expires ' + esc(expDate) + '</div>' +
        '<div class="share-active-sections">' + esc(sh.sections.join(', ')) + '</div></div>' +
        '<button class="btn-revoke" onclick="revokeShare(' + "'" + sh.shareId + "'" + ')">Revoke</button>' +
        '</div>';
    }
    activeHtml += '</div>';
  }

  var html = '<div class="share-modal">' +
    '<h3>Share Profile</h3>' +
    togglesHtml +
    expiryHtml +
    '<div class="share-actions">' +
    '<button class="btn-cancel" onclick="closeShareModal()">Cancel</button>' +
    '<button class="btn-generate" onclick="generateShareLink()">Generate Link</button>' +
    '</div>' +
    '<div id="shareResult"></div>' +
    activeHtml +
    '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function closeShareModal() {
  var overlay = document.getElementById('shareOverlay');
  if (overlay) overlay.remove();
}

function generateShareLink() {
  var sections = [];
  var ids = ['summary', 'experience', 'education', 'skills', 'connections'];
  for (var i = 0; i < ids.length; i++) {
    var cb = document.getElementById('share-sec-' + ids[i]);
    if (cb && cb.checked) sections.push(ids[i]);
  }
  var expiry = document.getElementById('shareExpiry');
  var days = expiry ? parseInt(expiry.value) : 30;

  api('POST', '/api/share', {
    entityId: selectedId,
    sections: sections,
    expiresInDays: days
  }).then(function(data) {
    var resultDiv = document.getElementById('shareResult');
    if (resultDiv) {
      resultDiv.innerHTML = '<div class="share-result">' +
        '<div class="share-result-url">' + esc(data.shareUrl) + '</div>' +
        '<button class="btn-copy-link" onclick="copyShareLink(' + "'" + data.shareUrl.replace(/'/g, "\\\\'") + "'" + ')">Copy Link</button>' +
        '</div>';
    }
  }).catch(function(err) {
    toast('Error creating share: ' + err.message);
  });
}

function copyShareLink(url) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      toast('Link copied to clipboard');
    }).catch(function() {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Link copied to clipboard'); }
  catch(e) { toast('Copy failed — select the URL manually'); }
  document.body.removeChild(ta);
}

function revokeShare(shareId) {
  if (!confirm('Revoke this share link? Anyone with this link will no longer be able to view the profile.')) return;
  api('DELETE', '/api/share/' + shareId).then(function() {
    toast('Share link revoked');
    closeShareModal();
    openShareModal();
  }).catch(function(err) {
    toast('Error revoking share: ' + err.message);
  });
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
  console.log('  Share:  http://localhost:' + PORT + '/shared/:shareId');
  console.log('  Auth:   http://localhost:' + PORT + '/auth/google' + (process.env.GOOGLE_CLIENT_ID ? '' : ' (not configured)'));
  console.log('  Graph:  ' + GRAPH_DIR + (GRAPH_IS_PERSISTENT ? ' (persistent disk)' : ' (local)'));
  console.log('');
});
