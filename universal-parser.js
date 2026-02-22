'use strict';

const path = require('path');

// ---------------------------------------------------------------------------
// P1.1 — File Type Detection
// Extension first, content sniffing second.
// ---------------------------------------------------------------------------

const EXTENSION_MAP = {
  '.pdf':  'pdf',
  '.json': 'json',
  '.md':   'markdown',
  '.txt':  'plaintext',
  '.docx': 'docx',
  '.doc':  'docx',
  '.csv':  'csv',
  '.tsv':  'tsv',
  '.html': 'html',
  '.htm':  'html',
};

/**
 * Detect file type from extension + content sniffing.
 * @param {string|Buffer} fileContent
 * @param {string} filename
 * @returns {string} One of: pdf, json, markdown, plaintext, docx, csv, tsv, html, chat_export, structured_profile
 */
function detectFileType(fileContent, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const raw = Buffer.isBuffer(fileContent)
    ? fileContent.slice(0, 4096).toString('utf-8', 0, 4096)
    : String(fileContent).slice(0, 4096);

  // --- Extension-based detection ---
  if (ext === '.json') {
    // Check special-case JSON subtypes BEFORE returning generic json
    return _classifyJson(raw);
  }

  if (EXTENSION_MAP[ext]) {
    return EXTENSION_MAP[ext];
  }

  // --- Content-sniffing fallback (no recognized extension) ---
  // Binary PDF header
  const head = Buffer.isBuffer(fileContent)
    ? fileContent.slice(0, 5).toString('ascii')
    : String(fileContent).slice(0, 5);
  if (head.startsWith('%PDF')) return 'pdf';

  // ZIP / DOCX (PK header)
  if (head.startsWith('PK')) return 'docx';

  // JSON content
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return _classifyJson(raw);
  }

  // HTML content
  const lower = raw.toLowerCase();
  if (lower.includes('<html') || lower.includes('<body') || lower.includes('<!doctype html')) {
    return 'html';
  }

  // Markdown signals: # headers, **bold**, [links]()
  const mdSignals = [
    /^#{1,6}\s+/m,           // # headers
    /\*\*[^*]+\*\*/,         // **bold**
    /\[[^\]]+\]\([^)]+\)/,   // [link](url)
  ];
  let mdHits = 0;
  for (const sig of mdSignals) {
    if (sig.test(raw)) mdHits++;
  }
  if (mdHits >= 2) return 'markdown';

  // CSV sniffing: consistent comma/tab-separated columns
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length >= 2) {
    const commas = lines.slice(0, 5).map(l => (l.match(/,/g) || []).length);
    const tabs   = lines.slice(0, 5).map(l => (l.match(/\t/g) || []).length);
    const avgCommas = commas.reduce((a, b) => a + b, 0) / commas.length;
    const avgTabs   = tabs.reduce((a, b) => a + b, 0) / tabs.length;
    // Consistent delimiters across rows
    if (avgCommas >= 1 && commas.every(c => Math.abs(c - commas[0]) <= 1)) return 'csv';
    if (avgTabs   >= 1 && tabs.every(t => Math.abs(t - tabs[0]) <= 1))   return 'tsv';
  }

  // Fallback
  return 'plaintext';
}

/**
 * Classify JSON content into: structured_profile, chat_export, or generic json.
 */
function _classifyJson(raw) {
  try {
    const parsed = JSON.parse(raw);

    // ChatGPT export: has `mapping` key with nested `message` objects
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.mapping && typeof parsed.mapping === 'object') {
        const firstKey = Object.keys(parsed.mapping)[0];
        if (firstKey && parsed.mapping[firstKey] && parsed.mapping[firstKey].message) {
          return 'chat_export';
        }
      }
    }

    // Structured profile: has `entity_type` OR (`name` + `attributes`)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.entity_type) return 'structured_profile';
      if (parsed.entity && parsed.entity.entity_type) return 'structured_profile';
      if (parsed.name && (parsed.attributes || parsed.type)) return 'structured_profile';
    }

    return 'json';
  } catch {
    // Malformed JSON — treat as generic json; extractText will handle the error
    return 'json';
  }
}

// ---------------------------------------------------------------------------
// P1.2 — Text Extraction
// Each file type gets a specific extraction strategy.
// ---------------------------------------------------------------------------

/**
 * Extract readable text from file content based on detected type.
 * @param {string|Buffer} fileContent
 * @param {string} fileType - Output of detectFileType()
 * @returns {Promise<string>} Extracted text
 */
async function extractText(fileContent, fileType) {
  const buf = Buffer.isBuffer(fileContent) ? fileContent : Buffer.from(String(fileContent), 'utf-8');
  const raw = buf.toString('utf-8');

  switch (fileType) {
    case 'pdf':
      return _extractPdf(buf);

    case 'json':
    case 'structured_profile':
    case 'chat_export':
      return _extractJson(raw);

    case 'markdown':
      return _extractMarkdown(raw);

    case 'docx':
      return _extractDocx(buf);

    case 'csv':
      return _extractCsv(raw, ',');

    case 'tsv':
      return _extractCsv(raw, '\t');

    case 'html':
      return _extractHtml(raw);

    case 'plaintext':
    default:
      return raw;
  }
}

/** PDF: use pdf-parse */
async function _extractPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer), verbosity: 0 });
  const result = await parser.getText();
  return result.text || '';
}

/** JSON: pretty-print for readability */
function _extractJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/** Markdown: strip formatting markers, keep structure */
function _extractMarkdown(raw) {
  return raw
    // Remove image links ![alt](url)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Convert [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Strip bold/italic markers
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Strip inline code backticks
    .replace(/`([^`]+)`/g, '$1')
    // Convert headers: "# Title" → "Title"
    .replace(/^#{1,6}\s+/gm, '')
    // Strip horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** DOCX: use mammoth */
async function _extractDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

/** CSV/TSV: parse and convert to readable row descriptions */
function _extractCsv(raw, delimiter) {
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 1) return raw;

  // Parse header
  const headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map(v => v.trim().replace(/^"|"$/g, ''));
    const parts = [];
    for (let j = 0; j < headers.length; j++) {
      if (values[j] && values[j].length > 0) {
        parts.push(`${headers[j]}=${values[j]}`);
      }
    }
    if (parts.length > 0) {
      rows.push(`Row ${i}: ${parts.join(', ')}`);
    }
  }

  return rows.join('\n');
}

/** HTML: strip tags */
function _extractHtml(raw) {
  return raw
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// P2 — Entity Extraction
// Uses Claude API for AI extraction, with direct import for structured JSON.
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an entity extraction system. Analyze the following content and extract all entities and relationships.

CONTENT SOURCE: {filename}
CONTENT:
{extracted_text}

INSTRUCTIONS:
1. Extract every named entity mentioned in this content
2. For each entity, determine its type: PERSON, ORG, or CONCEPT
3. For each entity, extract all attributes mentioned (role, location, age, description, dates, etc)
4. For every pair of entities that have a relationship, describe the connection
5. Assign confidence to each extraction based on how explicitly it appears in the text

RESPOND IN THIS EXACT JSON FORMAT:
{
  "entities": [
    {
      "name": "Full Name or Title",
      "type": "PERSON | ORG | CONCEPT",
      "attributes": {
        "key": "value"
      },
      "evidence": "The exact text that mentions this entity"
    }
  ],
  "relationships": [
    {
      "source": "Entity Name A",
      "target": "Entity Name B",
      "relationship": "description of connection",
      "direction": "A_TO_B | B_TO_A | BIDIRECTIONAL",
      "evidence": "The text establishing this relationship"
    }
  ],
  "file_summary": "One sentence describing what this file is about"
}

RULES:
- Extract EVERY entity, even if mentioned briefly
- Include full names when available, not just first names
- Attributes should be factual (role, location, dates) not interpretive
- Relationships should be specific: "works_at" not "is related to"
- If unsure about a fact, still extract it but note uncertainty in evidence
- Do NOT invent entities or relationships not present in the text
- Return valid JSON only, no markdown formatting`;

const CHUNK_SIZE = 80000;
const MAX_TEXT_LENGTH = 100000;

/**
 * Extract entities and relationships from text.
 * Routes to direct import for structured profiles, or AI extraction otherwise.
 * @param {string} text - Extracted text content
 * @param {string} filename - Original filename
 * @param {object} [options] - Options: { fileType, fileContent }
 * @returns {Promise<{entities: Array, relationships: Array, summary: string}>}
 */
async function extractEntities(text, filename, options = {}) {
  const { fileType, fileContent } = options;

  // --- Structured profile: direct import (no AI call) ---
  if (fileType === 'structured_profile') {
    return _directImport(text, fileContent);
  }

  // --- Chat export: route to existing pipeline (return minimal result) ---
  if (fileType === 'chat_export') {
    return { entities: [], relationships: [], summary: 'ChatGPT export — route to existing chat ingest pipeline.' };
  }

  // --- AI extraction via Claude ---
  if (text.length <= MAX_TEXT_LENGTH) {
    return _callClaudeExtraction(text, filename);
  }

  // --- Large file: chunk and merge ---
  return _chunkedExtraction(text, filename);
}

/**
 * Direct import for structured JSON profiles.
 * Maps entity_type, name, attributes directly — no AI call needed.
 */
function _directImport(text, fileContent) {
  let parsed;
  try {
    parsed = JSON.parse(typeof fileContent === 'string' ? fileContent
      : Buffer.isBuffer(fileContent) ? fileContent.toString('utf-8')
      : text);
  } catch {
    parsed = JSON.parse(text);
  }

  const entities = [];
  const relationships = [];

  // Handle nested entity format: { entity: { entity_type, name, ... } }
  const entityData = parsed.entity || parsed;

  const name = _extractName(entityData);
  const type = _mapEntityType(entityData.entity_type || entityData.type || 'CONCEPT');

  const attrs = {};
  // Collect attributes from entity-level or top-level attributes (array or object)
  const attrSources = [entityData.attributes, parsed.attributes].filter(Boolean);
  for (const src of attrSources) {
    if (Array.isArray(src)) {
      for (const attr of src) {
        if (attr.key && attr.value !== undefined) {
          attrs[attr.key] = String(attr.value);
        }
      }
    } else if (typeof src === 'object') {
      Object.assign(attrs, src);
    }
  }

  // Collect known scalar fields as attributes
  const scalarFields = ['age', 'location', 'date_of_birth', 'zodiac', 'headline', 'summary',
    'preferred_name', 'full_name', 'email', 'phone'];
  for (const field of scalarFields) {
    if (entityData[field] && !attrs[field]) attrs[field] = String(entityData[field]);
    if (entityData.name && typeof entityData.name === 'object' && entityData.name[field]) {
      attrs[field] = String(entityData.name[field]);
    }
  }

  entities.push({
    name,
    type,
    attributes: attrs,
    confidence: 0.9,
    evidence: `Direct import from structured profile: ${name}`,
  });

  // Extract relationships if present
  if (Array.isArray(parsed.relationships || (parsed.entity && parsed.relationships))) {
    const rels = parsed.relationships || [];
    for (const rel of rels) {
      relationships.push({
        source: rel.source || name,
        target: rel.target || rel.entity_name || '',
        relationship: rel.relationship || rel.type || 'related_to',
        direction: rel.direction || 'A_TO_B',
        confidence: 0.9,
        evidence: `Direct import from structured profile`,
      });
    }
  }

  return {
    entities,
    relationships,
    summary: `Structured profile for ${name} (${type}).`,
  };
}

/** Extract a display name from various entity name formats */
function _extractName(entityData) {
  if (!entityData.name) return entityData.entity_id || 'Unknown';
  if (typeof entityData.name === 'string') return entityData.name;
  return entityData.name.preferred || entityData.name.full || entityData.name.display || 'Unknown';
}

/** Map entity_type strings to standard codes */
function _mapEntityType(rawType) {
  const t = String(rawType).toLowerCase();
  if (t === 'person' || t === 'individual') return 'PERSON';
  if (t === 'org' || t === 'organization' || t === 'company') return 'ORG';
  return 'CONCEPT';
}

/**
 * Call Claude API for entity extraction on a single chunk.
 */
async function _callClaudeExtraction(text, filename) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const client = new Anthropic();

  const prompt = EXTRACTION_PROMPT
    .replace('{filename}', filename || 'unknown')
    .replace('{extracted_text}', text);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16384,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawResponse = message.content[0].text;

  try {
    // Strip any markdown code fences if present
    const cleaned = rawResponse.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);
    return {
      entities: parsed.entities || [],
      relationships: parsed.relationships || [],
      summary: parsed.file_summary || '',
    };
  } catch (err) {
    console.warn(`Failed to parse Claude extraction response for ${filename}: ${err.message}`);
    return { entities: [], relationships: [], summary: '' };
  }
}

/**
 * Split large text into chunks at paragraph boundaries and merge results.
 */
async function _chunkedExtraction(text, filename) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    // Find a paragraph boundary near CHUNK_SIZE
    let splitAt = remaining.lastIndexOf('\n\n', CHUNK_SIZE);
    if (splitAt < CHUNK_SIZE * 0.5) {
      // No good paragraph break — try single newline
      splitAt = remaining.lastIndexOf('\n', CHUNK_SIZE);
    }
    if (splitAt < CHUNK_SIZE * 0.5) {
      // Hard cut
      splitAt = CHUNK_SIZE;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  // Process chunks in sequence (to avoid rate limits)
  const allEntities = [];
  const allRelationships = [];
  let summary = '';

  for (const chunk of chunks) {
    const result = await _callClaudeExtraction(chunk, filename);
    allEntities.push(...result.entities);
    allRelationships.push(...result.relationships);
    if (!summary && result.summary) summary = result.summary;
  }

  // Deduplicate entities by name (case-insensitive)
  const merged = _mergeChunkEntities(allEntities);

  return {
    entities: merged,
    relationships: allRelationships,
    summary,
  };
}

/**
 * Merge entities from multiple chunks — deduplicate by name (case-insensitive).
 */
function _mergeChunkEntities(entities) {
  const map = new Map(); // lowercase name → entity

  for (const ent of entities) {
    const key = (ent.name || '').toLowerCase().trim();
    if (!key) continue;

    if (map.has(key)) {
      // Merge attributes
      const existing = map.get(key);
      existing.attributes = { ...existing.attributes, ...ent.attributes };
      // Keep longer evidence
      if ((ent.evidence || '').length > (existing.evidence || '').length) {
        existing.evidence = ent.evidence;
      }
    } else {
      map.set(key, { ...ent });
    }
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// P4 — Confidence Assignment
// Score entities and relationships based on evidence quality.
// ---------------------------------------------------------------------------

/**
 * Assign confidence scores to entities and relationships.
 * Entities that already have confidence (e.g. from direct import) keep it.
 *
 * Entity confidence rules:
 *   Named + multiple attributes → HIGH (0.85-1.0)
 *   Named + minimal context → MEDIUM (0.6-0.8)
 *   Named once in passing → LOW-MEDIUM (0.4-0.6)
 *   Inferred, not named → LOW (0.2-0.4)
 *
 * Relationship confidence rules:
 *   Explicitly stated → HIGH (0.85)
 *   Implied by context → MEDIUM (0.5)
 *   Co-mention in same paragraph → LOW (0.3)
 */
function assignConfidence(entities, relationships) {
  const scoredEntities = entities.map(ent => {
    // If already scored (direct import sets 0.9), keep it
    if (typeof ent.confidence === 'number') return ent;

    const attrCount = ent.attributes ? Object.keys(ent.attributes).length : 0;
    const evidenceLen = (ent.evidence || '').length;

    let confidence;
    if (attrCount >= 3 && evidenceLen > 50) {
      confidence = 0.85 + Math.min(attrCount / 50, 0.15); // 0.85–1.0
    } else if (attrCount >= 1 || evidenceLen > 30) {
      confidence = 0.6 + Math.min(attrCount / 20, 0.2);   // 0.6–0.8
    } else if (evidenceLen > 0) {
      confidence = 0.5;                                     // LOW-MEDIUM
    } else {
      confidence = 0.3;                                     // LOW
    }

    return { ...ent, confidence: Math.round(confidence * 100) / 100 };
  });

  const scoredRelationships = relationships.map(rel => {
    if (typeof rel.confidence === 'number') return rel;

    const evidenceLen = (rel.evidence || '').length;
    const relationship = (rel.relationship || '').toLowerCase();

    let confidence;
    // Explicit relationships (specific verbs) get high confidence
    const explicitVerbs = ['works_at', 'employed_by', 'founded', 'married_to', 'parent_of',
      'friend_of', 'manages', 'reports_to', 'attended', 'graduated_from', 'created', 'leads',
      'member_of', 'sibling_of', 'mentor_of'];
    const isExplicit = explicitVerbs.some(v => relationship.includes(v));

    if (isExplicit && evidenceLen > 20) {
      confidence = 0.85;
    } else if (evidenceLen > 30) {
      confidence = 0.5;
    } else {
      confidence = 0.3;
    }

    return { ...rel, confidence: Math.round(confidence * 100) / 100 };
  });

  return { entities: scoredEntities, relationships: scoredRelationships };
}

// ---------------------------------------------------------------------------
// P3/Post — Post-Processing (stub — Step 5)
// ---------------------------------------------------------------------------

function postProcess(entities, relationships) {
  // TODO: Step 5
  return { entities, relationships };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Parse ANY file and return structured entities + relationships.
 * @param {string|Buffer} fileContent - Raw file content
 * @param {string} filename - Original filename (used for type detection)
 * @returns {Promise<{entities: Array, relationships: Array, metadata: Object, summary: string}>}
 */
async function parse(fileContent, filename) {
  const startTime = Date.now();

  // P1.1 — Detect file type
  const fileType = detectFileType(fileContent, filename);

  // P1.2 — Extract text
  let text;
  try {
    text = await extractText(fileContent, fileType);
  } catch (err) {
    // P1.3 — Fallback: treat as plain text
    console.warn(`Could not determine file type for ${filename}, treating as plain text`);
    text = Buffer.isBuffer(fileContent) ? fileContent.toString('utf-8') : String(fileContent);
  }

  // P2 — Extract entities + relationships
  const extracted = await extractEntities(text, filename, { fileType, fileContent });

  // P4 — Confidence assignment
  const scored = assignConfidence(extracted.entities, extracted.relationships);

  // P3/Post — Post-processing
  const processed = postProcess(scored.entities, scored.relationships);

  const duration = Date.now() - startTime;
  const rawSize = Buffer.isBuffer(fileContent) ? fileContent.length : Buffer.byteLength(String(fileContent));
  const chunkCount = text.length > MAX_TEXT_LENGTH ? Math.ceil(text.length / CHUNK_SIZE) : 1;

  return {
    metadata: {
      filename: filename || 'unknown',
      file_type: fileType,
      file_size: rawSize,
      parse_strategy: fileType === 'structured_profile' ? 'structured_import'
        : fileType === 'chat_export' ? 'chat_import'
        : 'ai_extraction',
      parse_duration_ms: duration,
      model_used: fileType === 'structured_profile' ? 'direct_import'
        : fileType === 'chat_export' ? 'chat_import'
        : 'claude-sonnet-4-5-20250929',
      chunk_count: chunkCount,
      timestamp: new Date().toISOString(),
    },
    entities: processed.entities,
    relationships: processed.relationships,
    summary: extracted.summary || '',
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parse,
  detectFileType,
  extractText,
  extractEntities,
  assignConfidence,
  postProcess,
};
