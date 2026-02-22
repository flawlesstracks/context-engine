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
// P2 — Entity Extraction (stub — Step 3)
// ---------------------------------------------------------------------------

async function extractEntities(text, filename) {
  // TODO: Step 3
  return { entities: [], relationships: [], summary: '' };
}

// ---------------------------------------------------------------------------
// P4 — Confidence Assignment (stub — Step 4)
// ---------------------------------------------------------------------------

function assignConfidence(entities, relationships) {
  // TODO: Step 4
  return { entities, relationships };
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
  const extracted = await extractEntities(text, filename);

  // P4 — Confidence assignment
  const scored = assignConfidence(extracted.entities, extracted.relationships);

  // P3/Post — Post-processing
  const processed = postProcess(scored.entities, scored.relationships);

  const duration = Date.now() - startTime;
  const rawSize = Buffer.isBuffer(fileContent) ? fileContent.length : Buffer.byteLength(String(fileContent));

  return {
    metadata: {
      filename: filename || 'unknown',
      file_type: fileType,
      file_size: rawSize,
      parse_strategy: fileType === 'structured_profile' ? 'structured_import'
        : fileType === 'chat_export' ? 'chat_import'
        : 'ai_extraction',
      parse_duration_ms: duration,
      model_used: fileType === 'structured_profile' ? 'direct_import' : null,
      chunk_count: 1,
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
