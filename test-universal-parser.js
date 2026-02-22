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
// Step 3 Tests — extractEntities (no-API paths: direct import + chat export)
// ---------------------------------------------------------------------------

async function testStep3() {
  section('Step 3: extractEntities — Structured profile direct import (flat)');

  const flatProfile = JSON.stringify({
    entity_type: 'person',
    name: 'Steve Hughes',
    attributes: { age: '40', location: 'Atlanta, GA' },
    relationships: [
      { target: 'Meta', relationship: 'works_at', direction: 'A_TO_B' },
      { target: 'CJ Mitchell', relationship: 'friend_of', direction: 'BIDIRECTIONAL' },
    ],
  });

  const flatResult = await extractEntities(flatProfile, 'steve.json', {
    fileType: 'structured_profile',
    fileContent: flatProfile,
  });

  assert(flatResult.entities.length >= 1, 'Flat profile: at least 1 entity');
  assert(flatResult.entities[0].name === 'Steve Hughes', 'Flat profile: name = Steve Hughes');
  assert(flatResult.entities[0].type === 'PERSON', 'Flat profile: type = PERSON');
  assert(flatResult.entities[0].attributes.age === '40', 'Flat profile: age attribute');
  assert(flatResult.entities[0].attributes.location === 'Atlanta, GA', 'Flat profile: location attribute');
  assert(flatResult.entities[0].confidence === 0.9, 'Flat profile: confidence = 0.9');
  assert(flatResult.relationships.length === 2, 'Flat profile: 2 relationships');
  assert(flatResult.relationships[0].target === 'Meta', 'Flat profile: works_at Meta');
  assert(flatResult.relationships[0].relationship === 'works_at', 'Flat profile: relationship type');
  assert(flatResult.summary.includes('Steve Hughes'), 'Flat profile: summary mentions name');

  section('Step 3: extractEntities — Structured profile direct import (nested entity)');

  const nestedProfile = JSON.stringify({
    entity: {
      entity_type: 'person',
      entity_id: 'ENT-SH-052',
      name: { full: 'Steven W. Hughes', preferred: 'Steve' },
      headline: 'Engineer at Meta',
      summary: 'A friend of CJ',
    },
    attributes: [
      { key: 'role', value: 'Engineer', confidence: 0.8 },
      { key: 'location', value: 'Atlanta, GA', confidence: 0.6 },
    ],
    relationships: [],
  });

  const nestedResult = await extractEntities(nestedProfile, 'ent-sh.json', {
    fileType: 'structured_profile',
    fileContent: nestedProfile,
  });

  assert(nestedResult.entities.length >= 1, 'Nested profile: at least 1 entity');
  assert(nestedResult.entities[0].name === 'Steve', 'Nested profile: preferred name used');
  assert(nestedResult.entities[0].type === 'PERSON', 'Nested profile: type = PERSON');
  assert(nestedResult.entities[0].attributes.role === 'Engineer', 'Nested profile: role from attributes array');
  assert(nestedResult.entities[0].attributes.location === 'Atlanta, GA', 'Nested profile: location from attributes array');

  section('Step 3: extractEntities — Structured profile (name + type format)');

  const nameTypeProfile = JSON.stringify({ name: 'Amazon', type: 'ORG', attributes: { industry: 'Technology' } });
  const ntResult = await extractEntities(nameTypeProfile, 'amazon.json', {
    fileType: 'structured_profile',
    fileContent: nameTypeProfile,
  });

  assert(ntResult.entities[0].name === 'Amazon', 'name+type format: name = Amazon');
  assert(ntResult.entities[0].type === 'ORG', 'name+type format: type = ORG');

  section('Step 3: extractEntities — Chat export routing');

  const chatContent = JSON.stringify({
    mapping: { 'x': { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } }
  });
  const chatResult = await extractEntities(chatContent, 'export.json', { fileType: 'chat_export' });

  assert(chatResult.entities.length === 0, 'Chat export: returns empty entities (route to existing pipeline)');
  assert(chatResult.summary.includes('ChatGPT'), 'Chat export: summary mentions ChatGPT routing');

  section('Step 3: extractEntities — AI extraction (requires ANTHROPIC_API_KEY)');

  if (process.env.ANTHROPIC_API_KEY) {
    const sampleText = 'CJ Mitchell works at Amazon as a Principal Product Manager. He lives in Redmond, WA. His friend Steve Hughes works at Meta in Atlanta, GA.';
    const aiResult = await extractEntities(sampleText, 'test-sample.txt', { fileType: 'plaintext' });

    assert(aiResult.entities.length >= 2, 'AI extraction: found at least 2 entities');
    const names = aiResult.entities.map(e => e.name.toLowerCase());
    assert(names.some(n => n.includes('mitchell') || n.includes('cj')), 'AI extraction: found CJ Mitchell');
    assert(names.some(n => n.includes('hughes') || n.includes('steve')), 'AI extraction: found Steve Hughes');
    assert(aiResult.relationships.length >= 1, 'AI extraction: found at least 1 relationship');
    assert(aiResult.summary.length > 0, 'AI extraction: summary non-empty');
  } else {
    console.log('  ⊘ Skipping AI extraction test (no ANTHROPIC_API_KEY)');
  }
}

// ---------------------------------------------------------------------------
// Step 3: parse() integration with structured profile
// ---------------------------------------------------------------------------

async function testStep3Parse() {
  section('Step 3: parse() full pipeline — structured profile');

  const profile = JSON.stringify({
    entity_type: 'person',
    name: 'Test Person',
    attributes: { role: 'Developer' },
  });

  const result = await parse(profile, 'test-person.json');
  assert(result.metadata.parse_strategy === 'structured_import', 'parse() structured_import strategy');
  assert(result.metadata.model_used === 'direct_import', 'parse() direct_import model');
  assert(result.entities.length >= 1, 'parse() returns entities from direct import');
  assert(result.entities[0].name === 'Test Person', 'parse() entity name correct');
}

// ---------------------------------------------------------------------------
// Step 4 Tests — assignConfidence
// ---------------------------------------------------------------------------

function testStep4() {
  section('Step 4: assignConfidence — Entity scoring');

  // Entity with many attributes + long evidence → HIGH
  const richEntity = {
    name: 'CJ Mitchell',
    type: 'PERSON',
    attributes: { role: 'PM', company: 'Amazon', location: 'Redmond, WA', education: 'Howard University' },
    evidence: 'CJ Mitchell is a Principal Product Manager at Amazon, based in Redmond, WA. He attended Howard University.',
  };
  const { entities: [scored1] } = assignConfidence([richEntity], []);
  assert(scored1.confidence >= 0.85, `Rich entity confidence (${scored1.confidence}) >= 0.85`);

  // Entity with 1 attribute, some evidence → MEDIUM
  const medEntity = {
    name: 'Meta',
    type: 'ORG',
    attributes: { industry: 'Technology' },
    evidence: 'Steve works at Meta in Atlanta.',
  };
  const { entities: [scored2] } = assignConfidence([medEntity], []);
  assert(scored2.confidence >= 0.6 && scored2.confidence <= 0.8,
    `Medium entity confidence (${scored2.confidence}) in 0.6-0.8`);

  // Entity with no attributes, short evidence → LOW
  const thinEntity = {
    name: 'BDAT Group',
    type: 'ORG',
    attributes: {},
    evidence: 'BDAT member',
  };
  const { entities: [scored3] } = assignConfidence([thinEntity], []);
  assert(scored3.confidence >= 0.3 && scored3.confidence <= 0.6,
    `Thin entity confidence (${scored3.confidence}) in 0.3-0.6`);

  // Entity with no evidence at all → LOW
  const bareEntity = { name: 'Something', type: 'CONCEPT', attributes: {} };
  const { entities: [scored4] } = assignConfidence([bareEntity], []);
  assert(scored4.confidence <= 0.4, `Bare entity confidence (${scored4.confidence}) <= 0.4`);

  // Already-scored entity (direct import) preserved
  const preScored = { name: 'Pre', type: 'PERSON', confidence: 0.9 };
  const { entities: [scored5] } = assignConfidence([preScored], []);
  assert(scored5.confidence === 0.9, 'Pre-scored entity confidence preserved');

  section('Step 4: assignConfidence — Relationship scoring');

  // Explicit relationship with evidence → HIGH
  const explicitRel = {
    source: 'CJ', target: 'Amazon',
    relationship: 'works_at',
    evidence: 'CJ Mitchell works at Amazon as a PM in Redmond, WA.',
  };
  const { relationships: [rScored1] } = assignConfidence([], [explicitRel]);
  assert(rScored1.confidence === 0.85, `Explicit rel confidence (${rScored1.confidence}) = 0.85`);

  // Non-explicit with good evidence → MEDIUM
  const impliedRel = {
    source: 'CJ', target: 'Steve',
    relationship: 'mentioned_together',
    evidence: 'Both CJ and Steve were at the meeting last Thursday.',
  };
  const { relationships: [rScored2] } = assignConfidence([], [impliedRel]);
  assert(rScored2.confidence === 0.5, `Implied rel confidence (${rScored2.confidence}) = 0.5`);

  // Minimal evidence → LOW
  const weakRel = {
    source: 'X', target: 'Y',
    relationship: 'referenced',
    evidence: 'X and Y',
  };
  const { relationships: [rScored3] } = assignConfidence([], [weakRel]);
  assert(rScored3.confidence === 0.3, `Weak rel confidence (${rScored3.confidence}) = 0.3`);

  // Pre-scored relationship preserved
  const preScoredRel = { source: 'A', target: 'B', relationship: 'test', confidence: 0.9 };
  const { relationships: [rScored4] } = assignConfidence([], [preScoredRel]);
  assert(rScored4.confidence === 0.9, 'Pre-scored rel confidence preserved');
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

  if (!step || step === 3) {
    await testStep3();
    await testStep3Parse();
  }

  if (!step || step === 4) {
    testStep4();
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
