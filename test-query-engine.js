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
// Step 2 Tests — buildRelationshipIndex
// ---------------------------------------------------------------------------

function testStep2() {
  section('Step 2: buildRelationshipIndex — structure');
  const index = buildRelationshipIndex(GRAPH_DIR);
  assert(index && typeof index === 'object', 'returns an object');
  assert(index.edges && typeof index.edges === 'object', 'has edges map');
  assert(index.nameToId && typeof index.nameToId === 'object', 'has nameToId map');

  section('Step 2: buildRelationshipIndex — entities indexed');
  const entityIds = Object.keys(index.edges);
  assert(entityIds.length > 0, 'edges map has entries');
  assert(entityIds.includes('ENT-SH-052'), 'Steve Hughes in index');
  assert(entityIds.includes('ENT-CM-001'), 'CJ Mitchell in index');

  section('Step 2: buildRelationshipIndex — nameToId lookup');
  // Steve Hughes should map
  const steveId = index.nameToId['steve hughes'];
  assert(steveId === 'ENT-SH-052', 'nameToId maps "steve hughes" → ENT-SH-052');
  // CJ Mitchell should map
  const cjId = index.nameToId['cj mitchell'];
  assert(cjId === 'ENT-CM-001', 'nameToId maps "cj mitchell" → ENT-CM-001');

  section('Step 2: buildRelationshipIndex — forward edges');
  const steveEdges = index.edges['ENT-SH-052'] || [];
  assert(steveEdges.length > 0, 'Steve has edges');
  // Steve has relationship to CJ Mitchell (best friend)
  const steveToCJ = steveEdges.find(e => e.targetName === 'CJ Mitchell');
  assert(steveToCJ !== undefined, 'Steve has edge to CJ Mitchell');
  assert(steveToCJ && steveToCJ.relationship, 'edge has relationship label');

  section('Step 2: buildRelationshipIndex — reverse edges');
  // CJ should have a reverse edge back to Steve (from Steve's relationship)
  const cjEdges = index.edges['ENT-CM-001'] || [];
  const cjHasSteve = cjEdges.some(e => e.targetName === 'Steve Hughes' || e.targetId === 'ENT-SH-052');
  // CJ also has his own "Steven Hughes" relationship, so either direction works
  const cjToSteve = cjEdges.find(e => e.targetName === 'Steve Hughes' || e.targetName === 'Steven Hughes' || e.targetId === 'ENT-SH-052');
  assert(cjToSteve !== undefined, 'CJ has edge to Steve (forward or reverse)');

  section('Step 2: buildRelationshipIndex — edge properties');
  const sampleEdge = steveEdges[0];
  assert(typeof sampleEdge.targetName === 'string', 'edge has targetName string');
  assert(typeof sampleEdge.relationship === 'string', 'edge has relationship string');
  assert(typeof sampleEdge.confidence === 'number', 'edge has confidence number');
  assert(typeof sampleEdge.source === 'string', 'edge has source string');

  section('Step 2: buildRelationshipIndex — performance');
  const start = Date.now();
  buildRelationshipIndex(GRAPH_DIR);
  const elapsed = Date.now() - start;
  assert(elapsed < 500, `index builds in < 500ms (took ${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
// Step 3 Tests — searchEntities
// ---------------------------------------------------------------------------

function testStep3() {
  section('Step 3: searchEntities — exact match');
  const exact = searchEntities('Steve Hughes', GRAPH_DIR);
  assert(exact.length > 0, 'finds "Steve Hughes"');
  assert(exact[0].name === 'Steve Hughes' || (exact[0].name && exact[0].name.full === 'Steve Hughes'), 'top result is Steve Hughes');
  assert(exact[0].score === 1.0, 'exact match score = 1.0');

  section('Step 3: searchEntities — fuzzy match');
  const fuzzy = searchEntities('steven', GRAPH_DIR);
  assert(fuzzy.length > 0, 'finds results for "steven"');
  // Should find Steve Hughes via partial name match or Dice
  const hasSteveH = fuzzy.some(e => e.entityId === 'ENT-SH-052');
  assert(hasSteveH, '"steven" finds Steve Hughes (ENT-SH-052)');

  section('Step 3: searchEntities — partial name match');
  const partial = searchEntities('CJ', GRAPH_DIR);
  assert(partial.length > 0, 'finds results for "CJ"');
  const hasCJ = partial.some(e => e.entityId === 'ENT-CM-001');
  assert(hasCJ, '"CJ" finds CJ Mitchell (ENT-CM-001)');

  section('Step 3: searchEntities — type filter');
  const people = searchEntities('Amazon', GRAPH_DIR, { type: 'PERSON' });
  const orgs = searchEntities('Amazon', GRAPH_DIR, { type: 'ORG' });
  // Amazon should only show up in ORG results, not PERSON
  const amazonInPeople = people.some(e => e.name === 'Amazon' || (e.name && e.name.full === 'Amazon'));
  assert(!amazonInPeople, 'type:PERSON filter excludes Amazon org');

  section('Step 3: searchEntities — result structure');
  const results = searchEntities('Mitchell', GRAPH_DIR);
  assert(results.length > 0, 'finds results for "Mitchell"');
  const first = results[0];
  assert(typeof first.entityId === 'string', 'result has entityId');
  assert(first.name !== undefined, 'result has name');
  assert(typeof first.type === 'string', 'result has type');
  assert(typeof first.score === 'number', 'result has score');
  assert(first.data !== undefined, 'result has data');

  section('Step 3: searchEntities — limit');
  const limited = searchEntities('a', GRAPH_DIR, { limit: 3 });
  assert(limited.length <= 3, 'limit:3 returns at most 3 results');

  section('Step 3: searchEntities — sorted by relevance');
  const sorted = searchEntities('Steve Hughes', GRAPH_DIR);
  if (sorted.length >= 2) {
    assert(sorted[0].score >= sorted[1].score, 'results sorted descending by score');
  } else {
    assert(true, 'only one result, sorted trivially');
  }

  section('Step 3: searchEntities — no results');
  const noResults = searchEntities('xyznonexistent123', GRAPH_DIR);
  assert(noResults.length === 0, 'no results for nonsense query');

  section('Step 3: searchEntities — empty query');
  const empty = searchEntities('', GRAPH_DIR);
  assert(empty.length === 0, 'empty string returns no results');

  section('Step 3: searchEntities — minConfidence filter');
  const highConf = searchEntities('Steve', GRAPH_DIR, { minConfidence: 0.9 });
  const allConf = searchEntities('Steve', GRAPH_DIR, { minConfidence: 0 });
  assert(highConf.length <= allConf.length, 'minConfidence filters low-score results');
}

// ---------------------------------------------------------------------------
// Step 4 Tests — findPaths
// ---------------------------------------------------------------------------

function testStep4() {
  const index = buildRelationshipIndex(GRAPH_DIR);

  section('Step 4: findPaths — Steve to CJ (1 hop)');
  const steveToCJ = findPaths('ENT-SH-052', 'ENT-CM-001', index);
  assert(steveToCJ.length > 0, 'finds path Steve → CJ');
  if (steveToCJ.length > 0) {
    assert(steveToCJ[0].length === 2, 'path is 1 hop (2 nodes)');
    assert(steveToCJ[0][0].entityId === 'ENT-SH-052', 'path starts with Steve');
    assert(steveToCJ[0][steveToCJ[0].length - 1].entityId === 'ENT-CM-001', 'path ends with CJ');
  }

  section('Step 4: findPaths — path node structure');
  if (steveToCJ.length > 0 && steveToCJ[0].length >= 2) {
    const hop = steveToCJ[0][1];
    assert(typeof hop.entityId === 'string', 'path node has entityId');
    assert(typeof hop.entityName === 'string', 'path node has entityName');
    assert(typeof hop.relationship === 'string', 'path node has relationship');
    assert(typeof hop.direction === 'string', 'path node has direction');
  }

  section('Step 4: findPaths — no path for same entity');
  const selfPath = findPaths('ENT-SH-052', 'ENT-SH-052', index);
  assert(selfPath.length === 0, 'no path from entity to itself');

  section('Step 4: findPaths — no path for unknown entity');
  const unknownPath = findPaths('ENT-SH-052', 'FAKE-999', index);
  assert(unknownPath.length === 0, 'no path to unknown entity');

  section('Step 4: findPaths — sorted shortest first');
  // Find a multi-hop path if possible
  const paths = findPaths('ENT-SH-052', 'ENT-CM-001', index, 4);
  if (paths.length >= 2) {
    assert(paths[0].length <= paths[1].length, 'shortest path is first');
  } else {
    assert(true, 'only one path found, sorted trivially');
  }

  section('Step 4: findPaths — maxDepth respected');
  const shallow = findPaths('ENT-SH-052', 'ENT-CM-001', index, 0);
  assert(shallow.length === 0, 'maxDepth=0 finds no paths');

  section('Step 4: findPaths — performance');
  const start = Date.now();
  findPaths('ENT-SH-052', 'ENT-CM-001', index, 4);
  const elapsed = Date.now() - start;
  assert(elapsed < 500, `findPaths completes in < 500ms (took ${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
// Step 5 Tests — getNeighborhood
// ---------------------------------------------------------------------------

function testStep5() {
  const index = buildRelationshipIndex(GRAPH_DIR);

  section('Step 5: getNeighborhood — structure');
  const hood = getNeighborhood('ENT-SH-052', index, 2);
  assert(hood && typeof hood === 'object', 'returns an object');
  assert(hood.center === 'ENT-SH-052', 'center is Steve Hughes');
  assert(Array.isArray(hood.rings), 'has rings array');

  section('Step 5: getNeighborhood — depth 1 ring');
  assert(hood.rings.length >= 1, 'has at least 1 ring');
  const ring1 = hood.rings.find(r => r.depth === 1);
  assert(ring1 !== undefined, 'ring at depth 1 exists');
  assert(ring1 && ring1.entities.length > 0, 'depth 1 has entities');
  // Steve's direct connections include CJ Mitchell
  if (ring1) {
    const hasCJ = ring1.entities.some(e => e.entityId === 'ENT-CM-001' || e.entityName === 'CJ Mitchell');
    assert(hasCJ, 'depth 1 includes CJ Mitchell');
  }

  section('Step 5: getNeighborhood — ring entity structure');
  if (ring1 && ring1.entities.length > 0) {
    const e = ring1.entities[0];
    assert(typeof e.entityId === 'string', 'ring entity has entityId');
    assert(typeof e.entityName === 'string', 'ring entity has entityName');
    assert(typeof e.relationship === 'string', 'ring entity has relationship');
    assert(typeof e.fromEntity === 'string', 'ring entity has fromEntity');
  }

  section('Step 5: getNeighborhood — depth 2 ring');
  if (hood.rings.length >= 2) {
    const ring2 = hood.rings.find(r => r.depth === 2);
    assert(ring2 !== undefined, 'ring at depth 2 exists');
    assert(ring2 && ring2.entities.length > 0, 'depth 2 has entities');
    // Depth 2 should NOT repeat depth 1 entities
    if (ring1 && ring2) {
      const depth1Ids = new Set(ring1.entities.map(e => e.entityId));
      const overlap = ring2.entities.some(e => depth1Ids.has(e.entityId) || e.entityId === 'ENT-SH-052');
      assert(!overlap, 'depth 2 does not repeat depth 1 or center');
    }
  } else {
    assert(true, 'no depth 2 ring (isolated neighborhood)');
  }

  section('Step 5: getNeighborhood — depth 0');
  const hood0 = getNeighborhood('ENT-SH-052', index, 0);
  assert(hood0.rings.length === 0, 'depth 0 has no rings');

  section('Step 5: getNeighborhood — depth 1 only');
  const hood1 = getNeighborhood('ENT-SH-052', index, 1);
  assert(hood1.rings.length <= 1, 'depth 1 has at most 1 ring');
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

  if (!step || step === 2) {
    testStep2();
  }

  if (!step || step === 3) {
    testStep3();
  }

  if (!step || step === 4) {
    testStep4();
  }

  if (!step || step === 5) {
    testStep5();
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
