'use strict';

require('dotenv').config();

const path = require('path');
const {
  query, classifyQuery, resolveEntities, buildRelationshipIndex,
  searchEntities, findPaths, getNeighborhood, filterEntities, synthesizeAnswer,
} = require('./query-engine');

const GRAPH_DIR = path.join(__dirname, 'watch-folder', 'graph', 'tenant-eefc79c7');

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
// Step 1 Tests — classifyQuery
// ---------------------------------------------------------------------------

function testStep1() {
  section('Step 1: classifyQuery — ENTITY_LOOKUP');
  assert(classifyQuery('Who is Steve Hughes?') === 'ENTITY_LOOKUP', '"Who is Steve Hughes?" → ENTITY_LOOKUP');
  assert(classifyQuery('What is Context Architecture?') === 'ENTITY_LOOKUP', '"What is Context Architecture?" → ENTITY_LOOKUP');
  assert(classifyQuery('Tell me about Amazon') === 'ENTITY_LOOKUP', '"Tell me about Amazon" → ENTITY_LOOKUP');
  assert(classifyQuery('Describe CJ Mitchell') === 'ENTITY_LOOKUP', '"Describe CJ Mitchell" → ENTITY_LOOKUP');
  assert(classifyQuery('Summarize Steve') === 'ENTITY_LOOKUP', '"Summarize Steve" → ENTITY_LOOKUP');
  assert(classifyQuery('Profile of Howard University') === 'ENTITY_LOOKUP', '"Profile of Howard University" → ENTITY_LOOKUP');

  section('Step 1: classifyQuery — RELATIONSHIP');
  assert(classifyQuery('How does Steve connect to Amazon?') === 'RELATIONSHIP', '"How does Steve connect to Amazon?" → RELATIONSHIP');
  assert(classifyQuery('How is Howard University related to BDAT?') === 'RELATIONSHIP', '"How is Howard related to BDAT?" → RELATIONSHIP');
  assert(classifyQuery('What connects CJ and Steve?') === 'RELATIONSHIP', '"What connects CJ and Steve?" → RELATIONSHIP');
  assert(classifyQuery("What's the link between Howard and CJ?") === 'RELATIONSHIP', '"link between Howard and CJ?" → RELATIONSHIP');
  assert(classifyQuery('Show the path from Steve to Amazon') === 'RELATIONSHIP', '"path from Steve to Amazon" → RELATIONSHIP');

  section('Step 1: classifyQuery — AGGREGATION');
  assert(classifyQuery('How many people are in my graph?') === 'AGGREGATION', '"How many people?" → AGGREGATION');
  assert(classifyQuery('List all organizations') === 'AGGREGATION', '"List all organizations" → AGGREGATION');
  assert(classifyQuery('Count all entities') === 'AGGREGATION', '"Count all entities" → AGGREGATION');
  assert(classifyQuery('Show all people in Atlanta') === 'AGGREGATION', '"Show all people in Atlanta" → AGGREGATION');
  assert(classifyQuery('Who are all the people at Amazon?') === 'AGGREGATION', '"Who are all people at Amazon?" → AGGREGATION');
  assert(classifyQuery('Which organizations in my graph?') === 'AGGREGATION', '"Which organizations in my graph?" → AGGREGATION');

  section('Step 1: classifyQuery — COMPLETENESS');
  assert(classifyQuery("What am I missing about Steve?") === 'COMPLETENESS', '"What am I missing about Steve?" → COMPLETENESS');
  assert(classifyQuery('Which entities need enrichment?') === 'COMPLETENESS', '"entities need enrichment?" → COMPLETENESS');
  assert(classifyQuery("What don't I know about CJ?") === 'COMPLETENESS', '"What don\'t I know about CJ?" → COMPLETENESS');
  assert(classifyQuery('What gaps exist in the graph?') === 'COMPLETENESS', '"gaps exist?" → COMPLETENESS');
  assert(classifyQuery('Which profiles are thin?') === 'COMPLETENESS', '"profiles are thin?" → COMPLETENESS');

  section('Step 1: classifyQuery — CONTRADICTION');
  assert(classifyQuery("Any conflicts in Steve's data?") === 'CONTRADICTION', '"conflicts in Steve\'s data?" → CONTRADICTION');
  assert(classifyQuery('What data disagrees?') === 'CONTRADICTION', '"data disagrees?" → CONTRADICTION');
  assert(classifyQuery('Are there inconsistencies?') === 'CONTRADICTION', '"inconsistencies?" → CONTRADICTION');
  assert(classifyQuery('Which is the correct MBTI?') === 'CONTRADICTION', '"which is correct?" → CONTRADICTION');

  section('Step 1: classifyQuery — UNKNOWN');
  assert(classifyQuery('Hello') === 'UNKNOWN', '"Hello" → UNKNOWN');
  assert(classifyQuery('Do something') === 'UNKNOWN', '"Do something" → UNKNOWN');

  section('Step 1: query() stub returns correct metadata');
}

async function testStep1Query() {
  const result = await query('Who is Steve?', GRAPH_DIR);
  assert(result.query.original === 'Who is Steve?', 'query.original correct');
  assert(result.query.type === 'ENTITY_LOOKUP', 'query.type correct');
  assert(result.query.classified_by === 'keyword', 'classified_by = keyword');
  assert(typeof result.timing.classification_ms === 'number', 'timing.classification_ms is number');
  assert(typeof result.timing.total_ms === 'number', 'timing.total_ms is number');
  assert(Array.isArray(result.entities), 'entities is array');
  assert(Array.isArray(result.paths), 'paths is array');
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const step = process.argv[2] ? parseInt(process.argv[2], 10) : null;

  console.log('Query Engine Tests');
  console.log('==================');

  if (!step || step === 1) {
    testStep1();
    await testStep1Query();
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
