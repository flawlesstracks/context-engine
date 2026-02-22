'use strict';

/**
 * Test runner for universal-parser.js
 * Usage: node test-universal-parser.js [step]
 *   step 1 — type detection
 *   step 2 — text extraction
 *   step 3 — entity extraction (requires API key)
 *   step 4 — confidence assignment
 *   step 5 — post-processing
 *   step 6 — integration
 *   (no arg) — run all steps that are implemented
 */

const { detectFileType, extractText, extractEntities, assignConfidence, postProcess, parse } = require('./universal-parser');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──`);
}

// ---------------------------------------------------------------------------
// Step 1 Tests — detectFileType
// ---------------------------------------------------------------------------

function testStep1() {
  section('Step 1: detectFileType — Extension-based');

  assert(detectFileType('', 'report.pdf') === 'pdf',       'report.pdf → pdf');
  assert(detectFileType('', 'data.json') === 'json',       'data.json → json (generic)');
  assert(detectFileType('', 'README.md') === 'markdown',   'README.md → markdown');
  assert(detectFileType('', 'notes.txt') === 'plaintext',  'notes.txt → plaintext');
  assert(detectFileType('', 'doc.docx') === 'docx',        'doc.docx → docx');
  assert(detectFileType('', 'doc.doc') === 'docx',         'doc.doc → docx');
  assert(detectFileType('', 'data.csv') === 'csv',         'data.csv → csv');
  assert(detectFileType('', 'data.tsv') === 'tsv',         'data.tsv → tsv');
  assert(detectFileType('', 'page.html') === 'html',       'page.html → html');
  assert(detectFileType('', 'page.htm') === 'html',        'page.htm → html');

  section('Step 1: detectFileType — JSON special cases');

  // Structured profile: has entity_type
  const structuredProfile = JSON.stringify({ entity_type: 'person', name: 'Steve Hughes', attributes: { age: 40 } });
  assert(detectFileType(structuredProfile, 'steve.json') === 'structured_profile',
    'JSON with entity_type → structured_profile');

  // Structured profile: nested entity.entity_type
  const nestedProfile = JSON.stringify({ entity: { entity_type: 'person', name: { full: 'CJ Mitchell' } } });
  assert(detectFileType(nestedProfile, 'cj.json') === 'structured_profile',
    'JSON with entity.entity_type → structured_profile');

  // Structured profile: name + attributes
  const nameAttrs = JSON.stringify({ name: 'Test', attributes: { role: 'dev' } });
  assert(detectFileType(nameAttrs, 'test.json') === 'structured_profile',
    'JSON with name + attributes → structured_profile');

  // Structured profile: name + type
  const nameType = JSON.stringify({ name: 'Test', type: 'PERSON' });
  assert(detectFileType(nameType, 'test.json') === 'structured_profile',
    'JSON with name + type → structured_profile');

  // ChatGPT export: mapping + message
  const chatExport = JSON.stringify({
    title: 'Chat',
    mapping: {
      'abc-123': { id: 'abc-123', message: { author: { role: 'user' }, content: { parts: ['Hello'] } } }
    }
  });
  assert(detectFileType(chatExport, 'chat.json') === 'chat_export',
    'JSON with mapping.*.message → chat_export');

  // Plain JSON (no special markers)
  const plainJson = JSON.stringify({ foo: 'bar', baz: [1, 2, 3] });
  assert(detectFileType(plainJson, 'misc.json') === 'json',
    'Generic JSON → json');

  section('Step 1: detectFileType — Content sniffing (no extension)');

  // PDF binary header
  assert(detectFileType('%PDF-1.4 ...', 'unknown') === 'pdf',
    '%PDF header → pdf');

  // PK / ZIP / DOCX
  assert(detectFileType('PK\x03\x04...', 'mystery') === 'docx',
    'PK header → docx');

  // JSON content without .json extension
  assert(detectFileType('{ "hello": "world" }', 'noext') === 'json',
    '{ ... } content → json');

  assert(detectFileType('[ {"a":1} ]', 'noext') === 'json',
    '[ ... ] content → json');

  // HTML content
  assert(detectFileType('<html><body>Hi</body></html>', 'page') === 'html',
    '<html> content → html');

  assert(detectFileType('<!DOCTYPE html><head></head>', 'page') === 'html',
    '<!DOCTYPE html> → html');

  // Markdown sniffing (needs 2+ signals)
  const mdContent = '# Title\n\nSome **bold** text and a [link](http://example.com).\n';
  assert(detectFileType(mdContent, 'noext') === 'markdown',
    'Markdown signals → markdown');

  // CSV sniffing
  const csvContent = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA\n';
  assert(detectFileType(csvContent, 'noext') === 'csv',
    'CSV content → csv');

  // TSV sniffing
  const tsvContent = 'Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA\n';
  assert(detectFileType(tsvContent, 'noext') === 'tsv',
    'TSV content → tsv');

  // Plain text fallback
  assert(detectFileType('Just some regular text without any markers.', 'noext') === 'plaintext',
    'Plain text fallback → plaintext');
}

// ---------------------------------------------------------------------------
// Step 1: parse() metadata smoke test
// ---------------------------------------------------------------------------

async function testStep1Parse() {
  section('Step 1: parse() metadata shape');

  const result = await parse('Hello world', 'test.txt');

  assert(result.metadata !== undefined,             'result.metadata exists');
  assert(result.metadata.filename === 'test.txt',   'metadata.filename correct');
  assert(result.metadata.file_type === 'plaintext',  'metadata.file_type correct');
  assert(typeof result.metadata.file_size === 'number', 'metadata.file_size is number');
  assert(result.metadata.parse_strategy === 'ai_extraction', 'metadata.parse_strategy correct');
  assert(typeof result.metadata.parse_duration_ms === 'number', 'metadata.parse_duration_ms is number');
  assert(result.metadata.timestamp !== undefined,    'metadata.timestamp exists');
  assert(Array.isArray(result.entities),             'result.entities is array');
  assert(Array.isArray(result.relationships),        'result.relationships is array');

  // Structured profile strategy
  const spResult = await parse(JSON.stringify({ entity_type: 'person', name: 'Test' }), 'test.json');
  assert(spResult.metadata.parse_strategy === 'structured_import', 'structured_profile → structured_import strategy');
  assert(spResult.metadata.model_used === 'direct_import',         'structured_profile → direct_import model');

  // Chat export strategy
  const ceContent = JSON.stringify({
    mapping: { 'x': { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } }
  });
  const ceResult = await parse(ceContent, 'export.json');
  assert(ceResult.metadata.parse_strategy === 'chat_import', 'chat_export → chat_import strategy');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const step = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  console.log('Universal Parser Tests');
  console.log('======================');

  if (!step || step === 1) {
    testStep1();
    await testStep1Parse();
  }

  console.log(`\n══════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
