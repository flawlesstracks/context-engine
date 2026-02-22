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
// Step 2 Tests — extractText
// ---------------------------------------------------------------------------

async function testStep2() {
  section('Step 2: extractText — Plain Text');
  const plainResult = await extractText('Hello world, this is plain text.', 'plaintext');
  assert(plainResult === 'Hello world, this is plain text.', 'plaintext pass-through');

  section('Step 2: extractText — JSON');
  const jsonInput = '{"name":"Steve","age":40}';
  const jsonResult = await extractText(jsonInput, 'json');
  assert(jsonResult.includes('"name": "Steve"'), 'JSON pretty-printed');
  assert(jsonResult.includes('"age": 40'), 'JSON values preserved');

  // Structured profile also uses JSON extraction
  const spResult = await extractText(jsonInput, 'structured_profile');
  assert(spResult.includes('"name": "Steve"'), 'structured_profile uses JSON extraction');

  section('Step 2: extractText — Markdown');
  const mdInput = '# My Title\n\nSome **bold** text and *italic* here.\n\n- List item\n- [Link Text](http://example.com)\n\n![image](http://img.png)\n\n`inline code`\n\n---\n';
  const mdResult = await extractText(mdInput, 'markdown');
  assert(!mdResult.includes('# '),         'Markdown: headers stripped');
  assert(!mdResult.includes('**'),          'Markdown: bold markers stripped');
  assert(!mdResult.includes('*italic*'),    'Markdown: italic markers stripped');
  assert(mdResult.includes('bold'),         'Markdown: bold text preserved');
  assert(mdResult.includes('italic'),       'Markdown: italic text preserved');
  assert(mdResult.includes('Link Text'),    'Markdown: link text preserved');
  assert(!mdResult.includes('](http'),      'Markdown: link URLs removed');
  assert(!mdResult.includes('!['),          'Markdown: image links removed');
  assert(!mdResult.includes('`inline'),     'Markdown: backticks removed');
  assert(mdResult.includes('inline code'),  'Markdown: code text preserved');

  section('Step 2: extractText — CSV');
  const csvInput = 'Name,Role,Company\nAlice,Engineer,Acme\nBob,Manager,Globex\n';
  const csvResult = await extractText(csvInput, 'csv');
  assert(csvResult.includes('Row 1:'),                   'CSV: row labels present');
  assert(csvResult.includes('Name=Alice'),               'CSV: first row values');
  assert(csvResult.includes('Role=Engineer'),             'CSV: attributes formatted');
  assert(csvResult.includes('Row 2:'),                   'CSV: second row present');
  assert(csvResult.includes('Company=Globex'),            'CSV: second row values');

  section('Step 2: extractText — TSV');
  const tsvInput = 'Name\tAge\tCity\nAlice\t30\tNYC\n';
  const tsvResult = await extractText(tsvInput, 'tsv');
  assert(tsvResult.includes('Name=Alice'), 'TSV: tab-separated values parsed');
  assert(tsvResult.includes('Age=30'),     'TSV: numeric values preserved');

  section('Step 2: extractText — HTML');
  const htmlInput = '<html><head><title>Test</title><style>body{color:red}</style></head><body><h1>Hello</h1><p>World &amp; <b>bold</b></p><script>alert(1)</script></body></html>';
  const htmlResult = await extractText(htmlInput, 'html');
  assert(htmlResult.includes('Hello'),     'HTML: heading text extracted');
  assert(htmlResult.includes('World'),     'HTML: paragraph text extracted');
  assert(htmlResult.includes('bold'),      'HTML: inline text extracted');
  assert(htmlResult.includes('&'),         'HTML: entities decoded');
  assert(!htmlResult.includes('<h1>'),     'HTML: tags stripped');
  assert(!htmlResult.includes('alert'),    'HTML: script content removed');
  assert(!htmlResult.includes('color'),    'HTML: style content removed');

  section('Step 2: extractText — Malformed JSON');
  const badJson = '{ broken json [[[';
  const badResult = await extractText(badJson, 'json');
  assert(badResult === badJson, 'Malformed JSON returned as-is');
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

  if (!step || step === 2) {
    await testStep2();
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
