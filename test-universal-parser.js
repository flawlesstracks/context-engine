'use strict';

require('dotenv').config();

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
const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

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
// Step 5 Tests — postProcess
// ---------------------------------------------------------------------------

function testStep5() {
  section('Step 5: postProcess — Name normalization');

  const entities = [
    { name: '  cj mitchell  ', type: 'PERSON', attributes: {}, confidence: 0.8 },
    { name: '  amazon  ', type: 'ORG', attributes: {}, confidence: 0.7 },
  ];
  const { entities: normed } = postProcess(entities, []);
  assert(normed[0].name === 'Cj Mitchell', 'PERSON name title-cased + trimmed');
  assert(normed[1].name === 'amazon', 'ORG name trimmed (not title-cased)');

  section('Step 5: postProcess — Entity deduplication (Dice > 0.8)');

  const dupes = [
    { name: 'Steve Hughes', type: 'PERSON', attributes: { age: '40' }, confidence: 0.7, evidence: 'short' },
    { name: 'Steven Hughes', type: 'PERSON', attributes: { location: 'Atlanta' }, confidence: 0.8, evidence: 'Steven Hughes is a long evidence string that should win.' },
    { name: 'Meta', type: 'ORG', attributes: { industry: 'Tech' }, confidence: 0.6 },
  ];
  const { entities: deduped } = postProcess(dupes, []);
  assert(deduped.length === 2, `Deduplication: ${deduped.length} entities (expected 2 — merged Steve/Steven)`);

  const steve = deduped.find(e => e.name.toLowerCase().includes('steve'));
  assert(steve !== undefined, 'Merged Steve entity exists');
  assert(steve.attributes.age === '40', 'Merged Steve has age from first');
  assert(steve.attributes.location === 'Atlanta', 'Merged Steve has location from second');
  assert(steve.confidence === 0.8, 'Merged Steve has higher confidence');
  assert(steve.evidence.includes('Steven Hughes is a long'), 'Merged Steve keeps longer evidence');

  section('Step 5: postProcess — Different types NOT merged');

  const diffTypes = [
    { name: 'Meta', type: 'ORG', attributes: {}, confidence: 0.7 },
    { name: 'Meta', type: 'CONCEPT', attributes: {}, confidence: 0.5 },
  ];
  const { entities: kept } = postProcess(diffTypes, []);
  assert(kept.length === 2, 'Different types: both entities kept');

  section('Step 5: postProcess — Relationship deduplication');

  const rels = [
    { source: 'CJ', target: 'Amazon', relationship: 'works_at', confidence: 0.7, evidence: 'short' },
    { source: 'CJ', target: 'Amazon', relationship: 'works_at', confidence: 0.85, evidence: 'CJ works at Amazon as a PM, a longer piece of evidence.' },
    { source: 'CJ', target: 'Steve', relationship: 'friend_of', confidence: 0.6, evidence: 'friends' },
  ];
  const { relationships: dedupedRels } = postProcess([], rels);
  // The two works_at should merge; friend_of stays separate
  assert(dedupedRels.length === 2, `Rel dedup: ${dedupedRels.length} rels (expected 2)`);

  section('Step 5: postProcess — PLACE promotion (3+ references)');

  const locEntities = [
    { name: 'Alice', type: 'PERSON', attributes: { location: 'Atlanta, GA' }, confidence: 0.7 },
    { name: 'Bob', type: 'PERSON', attributes: { location: 'Atlanta, GA' }, confidence: 0.6 },
    { name: 'Carol', type: 'PERSON', attributes: { location: 'Atlanta, GA' }, confidence: 0.8 },
    { name: 'Dave', type: 'PERSON', attributes: { location: 'New York' }, confidence: 0.5 },
  ];
  const { entities: promoted, relationships: promRels } = postProcess(locEntities, []);
  const place = promoted.find(e => e.type === 'PLACE');
  assert(place !== undefined, 'PLACE promoted for Atlanta, GA');
  assert(place.name === 'Atlanta, GA', `Promoted place name: ${place.name}`);
  const locRels = promRels.filter(r => r.relationship === 'located_in');
  assert(locRels.length === 3, `3 located_in relationships created (got ${locRels.length})`);

  // New York NOT promoted (only 1 reference)
  const nyPlace = promoted.find(e => e.type === 'PLACE' && e.name.toLowerCase().includes('new york'));
  assert(nyPlace === undefined, 'New York NOT promoted (only 1 ref)');

  section('Step 5: postProcess — EVENT promotion (3+ references)');

  const evtEntities = [
    { name: 'P1', type: 'PERSON', attributes: { event: 'Q3 Board Meeting' }, confidence: 0.7 },
    { name: 'P2', type: 'PERSON', attributes: { event: 'Q3 Board Meeting' }, confidence: 0.6 },
    { name: 'P3', type: 'PERSON', attributes: { event: 'Q3 Board Meeting' }, confidence: 0.8 },
  ];
  const { entities: evtPromoted, relationships: evtRels } = postProcess(evtEntities, []);
  const event = evtPromoted.find(e => e.type === 'EVENT');
  assert(event !== undefined, 'EVENT promoted for Q3 Board Meeting');
  assert(event.name === 'Q3 Board Meeting', `Promoted event name: ${event.name}`);
  const attendedRels = evtRels.filter(r => r.relationship === 'attended');
  assert(attendedRels.length === 3, `3 attended relationships created (got ${attendedRels.length})`);
}

// ---------------------------------------------------------------------------
// Step 6 Tests — Integration: full parse() pipeline with multiple file types
// ---------------------------------------------------------------------------

async function testStep6() {
  section('Step 6: Integration — Structured JSON profile (full pipeline)');

  const structuredJson = JSON.stringify({
    entity_type: 'person',
    name: 'Steve Hughes',
    attributes: {
      age: '40',
      location: 'Atlanta, GA',
      date_of_birth: '1985-05-24',
      zodiac: 'Gemini',
    },
    relationships: [
      { target: 'Meta', relationship: 'works_at', direction: 'A_TO_B' },
      { target: 'CJ Mitchell', relationship: 'friend_of', direction: 'BIDIRECTIONAL' },
    ],
  });

  const r1 = await parse(structuredJson, 'steve-hughes-profile.json');
  assert(r1.metadata.file_type === 'structured_profile', 'Structured JSON: file_type correct');
  assert(r1.metadata.parse_strategy === 'structured_import', 'Structured JSON: strategy correct');
  assert(r1.metadata.model_used === 'direct_import', 'Structured JSON: model_used correct');
  assert(r1.entities.length >= 1, 'Structured JSON: entities extracted');
  assert(r1.entities[0].name === 'Steve Hughes', 'Structured JSON: entity name correct');
  assert(r1.entities[0].type === 'PERSON', 'Structured JSON: entity type correct');
  assert(r1.entities[0].confidence === 0.9, 'Structured JSON: confidence = 0.9');
  assert(r1.relationships.length === 2, 'Structured JSON: 2 relationships');
  assert(r1.summary.length > 0, 'Structured JSON: summary non-empty');

  section('Step 6: Integration — Nested entity JSON (real entity format)');

  const nestedJson = JSON.stringify({
    schema_version: '2.0',
    entity: {
      entity_type: 'person',
      entity_id: 'ENT-SH-052',
      name: { full: 'Steve Hughes', preferred: 'Steve' },
      summary: 'Howard alum from the godparent circle.',
    },
    attributes: [
      { key: 'role', value: 'Engineer', confidence: 0.6 },
      { key: 'location', value: 'Atlanta, GA', confidence: 0.6 },
    ],
    relationships: [
      { target: 'BDAT Group', relationship: 'member_of', direction: 'A_TO_B' },
    ],
  });

  const r2 = await parse(nestedJson, 'ENT-SH-052.json');
  assert(r2.metadata.parse_strategy === 'structured_import', 'Nested entity: structured_import');
  assert(r2.entities[0].name === 'Steve', 'Nested entity: preferred name used');
  assert(r2.entities[0].attributes.role === 'Engineer', 'Nested entity: attributes mapped');
  assert(r2.relationships.length === 1, 'Nested entity: 1 relationship');

  section('Step 6: Integration — Plain text');

  if (HAS_API_KEY) {
    const plainText = 'CJ Mitchell works at Amazon as a Principal Product Manager. His friend Steve Hughes works at Meta in Atlanta.';
    const r3 = await parse(plainText, 'notes.txt');
    assert(r3.metadata.file_type === 'plaintext', 'Plain text: file_type correct');
    assert(r3.metadata.parse_strategy === 'ai_extraction', 'Plain text: ai_extraction strategy');
    assert(Array.isArray(r3.entities), 'Plain text: entities is array');
    assert(Array.isArray(r3.relationships), 'Plain text: relationships is array');
    assert(r3.entities.length >= 2, `Plain text: found ${r3.entities.length} entities (expected 2+)`);
    const names = r3.entities.map(e => e.name.toLowerCase());
    assert(names.some(n => n.includes('mitchell') || n.includes('cj')), 'Plain text: found CJ');
    assert(names.some(n => n.includes('hughes') || n.includes('steve')), 'Plain text: found Steve');
    assert(r3.relationships.length >= 1, 'Plain text: at least 1 relationship');
  } else {
    console.log('  ⊘ Skipping plain text AI test (no ANTHROPIC_API_KEY)');
  }

  section('Step 6: Integration — CSV');

  if (HAS_API_KEY) {
    const csvContent = 'Name,Role,Company,Location\nAlice Smith,Engineer,Acme Inc,NYC\nBob Jones,Manager,Globex Corp,LA\n';
    const r4 = await parse(csvContent, 'team.csv');
    assert(r4.metadata.file_type === 'csv', 'CSV: file_type correct');
    assert(r4.metadata.parse_strategy === 'ai_extraction', 'CSV: ai_extraction strategy');
    assert(r4.entities.length >= 2, `CSV: found ${r4.entities.length} entities (expected 2+)`);
  } else {
    console.log('  ⊘ Skipping CSV AI test (no ANTHROPIC_API_KEY)');
  }

  section('Step 6: Integration — HTML');

  if (HAS_API_KEY) {
    const htmlContent = '<html><body><h1>About Us</h1><p>Acme Corp was founded by Jane Doe in 2020. Bob Smith is the CTO.</p></body></html>';
    const r5 = await parse(htmlContent, 'about.html');
    assert(r5.metadata.file_type === 'html', 'HTML: file_type correct');
    assert(r5.metadata.parse_strategy === 'ai_extraction', 'HTML: ai_extraction strategy');
    assert(r5.entities.length >= 2, `HTML: found ${r5.entities.length} entities (expected 2+)`);
  } else {
    console.log('  ⊘ Skipping HTML AI test (no ANTHROPIC_API_KEY)');
  }

  section('Step 6: Integration — Markdown');

  if (HAS_API_KEY) {
    const mdContent = '# Team Overview\n\n**CJ Mitchell** leads the Context Architecture project at Amazon.\n\n## Members\n\n- Steve Hughes (Engineering Lead at Meta)\n- Lola Mafe (Design Lead)\n';
    const r6 = await parse(mdContent, 'team.md');
    assert(r6.metadata.file_type === 'markdown', 'Markdown: file_type correct');
    assert(r6.metadata.parse_strategy === 'ai_extraction', 'Markdown: ai_extraction strategy');
    assert(r6.entities.length >= 3, `Markdown: found ${r6.entities.length} entities (expected 3+)`);
  } else {
    console.log('  ⊘ Skipping Markdown AI test (no ANTHROPIC_API_KEY)');
  }

  section('Step 6: Integration — ChatGPT export');

  const chatContent = JSON.stringify({
    title: 'Chat about context architecture',
    mapping: {
      'msg-1': { id: 'msg-1', message: { author: { role: 'user' }, content: { parts: ['Tell me about context architecture'] } } },
    },
  });
  const r7 = await parse(chatContent, 'chatgpt-export.json');
  assert(r7.metadata.file_type === 'chat_export', 'Chat export: file_type correct');
  assert(r7.metadata.parse_strategy === 'chat_import', 'Chat export: chat_import strategy');

  section('Step 6: Integration — Generic JSON');

  const genericJson = JSON.stringify({ projects: [{ name: 'Alpha', status: 'active' }], count: 1 });
  const r8 = await parse(genericJson, 'projects.json');
  assert(r8.metadata.file_type === 'json', 'Generic JSON: file_type correct');
  assert(r8.metadata.parse_strategy === 'ai_extraction', 'Generic JSON: ai_extraction strategy');

  section('Step 6: Integration — TSV');

  const tsvContent = 'Name\tAge\tCity\nAlice\t30\tNYC\nBob\t25\tLA\n';
  const r9 = await parse(tsvContent, 'data.tsv');
  assert(r9.metadata.file_type === 'tsv', 'TSV: file_type correct');

  section('Step 6: Integration — Output schema validation');

  // Validate the complete output schema matches spec
  const schema = r1; // Use structured JSON result (has real data)
  assert(typeof schema.metadata === 'object', 'Schema: metadata is object');
  assert(typeof schema.metadata.filename === 'string', 'Schema: metadata.filename is string');
  assert(typeof schema.metadata.file_type === 'string', 'Schema: metadata.file_type is string');
  assert(typeof schema.metadata.file_size === 'number', 'Schema: metadata.file_size is number');
  assert(typeof schema.metadata.parse_strategy === 'string', 'Schema: metadata.parse_strategy is string');
  assert(typeof schema.metadata.parse_duration_ms === 'number', 'Schema: metadata.parse_duration_ms is number');
  assert(typeof schema.metadata.chunk_count === 'number', 'Schema: metadata.chunk_count is number');
  assert(typeof schema.metadata.timestamp === 'string', 'Schema: metadata.timestamp is string');
  assert(Array.isArray(schema.entities), 'Schema: entities is array');
  assert(Array.isArray(schema.relationships), 'Schema: relationships is array');
  assert(typeof schema.summary === 'string', 'Schema: summary is string');

  // Validate entity shape
  const ent = schema.entities[0];
  assert(typeof ent.name === 'string', 'Schema: entity.name is string');
  assert(typeof ent.type === 'string', 'Schema: entity.type is string');
  assert(typeof ent.attributes === 'object', 'Schema: entity.attributes is object');
  assert(typeof ent.confidence === 'number', 'Schema: entity.confidence is number');

  // Validate network schema fields
  assert(ent.ownership === 'referenced', 'Schema: entity.ownership defaults to referenced');
  assert(typeof ent.access_rules === 'object', 'Schema: entity.access_rules is object');
  assert(ent.access_rules.visibility === 'private', 'Schema: entity.access_rules.visibility defaults to private');
  assert(Array.isArray(ent.access_rules.shared_with), 'Schema: entity.access_rules.shared_with is array');
  assert(typeof ent.projection_config === 'object', 'Schema: entity.projection_config is object');
  assert(Array.isArray(ent.projection_config.lenses), 'Schema: entity.projection_config.lenses is array');
  assert(Array.isArray(ent.perspectives), 'Schema: entity.perspectives is array');

  // Validate relationship shape
  const rel = schema.relationships[0];
  assert(typeof rel.source === 'string' || rel.source === undefined, 'Schema: rel.source is string');
  assert(typeof rel.target === 'string', 'Schema: rel.target is string');
  assert(typeof rel.relationship === 'string', 'Schema: rel.relationship is string');
  assert(typeof rel.confidence === 'number', 'Schema: rel.confidence is number');
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

  if (!step || step === 5) {
    testStep5();
  }

  if (!step || step === 6) {
    await testStep6();
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
