'use strict';

require('dotenv').config();

const path = require('path');
const {
  query, classifyQuery, resolveEntities, buildRelationshipIndex,
  searchEntities, findPaths, getNeighborhood, filterEntities, synthesizeAnswer,
  getSelfEntity, clearSelfEntityCache,
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
// Step 6 Tests — filterEntities
// ---------------------------------------------------------------------------

function testStep6() {
  section('Step 6: filterEntities — type filter');
  const people = filterEntities({ type: 'person' }, GRAPH_DIR);
  assert(people.length > 0, 'finds person entities');
  assert(people.every(e => e.type === 'person'), 'all results are person type');

  section('Step 6: filterEntities — type filter (business)');
  const biz = filterEntities({ type: 'business' }, GRAPH_DIR);
  assert(biz.length > 0, 'finds business entities');
  assert(biz.every(e => e.type === 'business'), 'all results are business type');

  section('Step 6: filterEntities — name filter');
  const steves = filterEntities({ name: 'steve' }, GRAPH_DIR);
  assert(steves.length > 0, 'finds entities with "steve" in name');
  const hasSteve = steves.some(e => e.entityId === 'ENT-SH-052');
  assert(hasSteve, 'finds Steve Hughes');

  section('Step 6: filterEntities — attribute filter with dot notation');
  const atlanta = filterEntities({ 'attributes.location': 'Atlanta' }, GRAPH_DIR);
  assert(atlanta.length > 0, 'finds entities in Atlanta');
  // ENT-AB-051 (Andre Burgin) is in Atlanta
  const hasAndre = atlanta.some(e => e.entityId === 'ENT-AB-051');
  assert(hasAndre, 'Atlanta filter finds Andre Burgin');

  section('Step 6: filterEntities — combined filters');
  const personInAtlanta = filterEntities({ type: 'person', 'attributes.location': 'Atlanta' }, GRAPH_DIR);
  assert(personInAtlanta.length > 0, 'finds people in Atlanta');
  assert(personInAtlanta.every(e => e.type === 'person'), 'combined filter: all are person');

  section('Step 6: filterEntities — result structure');
  if (people.length > 0) {
    const first = people[0];
    assert(typeof first.entityId === 'string', 'result has entityId');
    assert(first.name !== undefined, 'result has name');
    assert(typeof first.type === 'string', 'result has type');
    assert(first.data !== undefined, 'result has data');
    assert(typeof first.file === 'string', 'result has file');
  }

  section('Step 6: filterEntities — no matches');
  const none = filterEntities({ type: 'xyzfaketype' }, GRAPH_DIR);
  assert(none.length === 0, 'no results for fake type');

  section('Step 6: filterEntities — case insensitive');
  const upper = filterEntities({ type: 'PERSON' }, GRAPH_DIR);
  const lower = filterEntities({ type: 'person' }, GRAPH_DIR);
  assert(upper.length === lower.length, 'type filter is case insensitive');
}

// ---------------------------------------------------------------------------
// Step 7 Tests — synthesizeAnswer
// ---------------------------------------------------------------------------

function testStep7() {
  // Load real entity data
  const { readEntity } = require('./src/graph-ops');
  const steveData = readEntity('ENT-SH-052', GRAPH_DIR);
  const index = buildRelationshipIndex(GRAPH_DIR);

  section('Step 7: synthesizeAnswer — ENTITY_LOOKUP');
  const entityResult = synthesizeAnswer('ENTITY_LOOKUP', { entity: steveData });
  assert(typeof entityResult.answer === 'string', 'ENTITY_LOOKUP: answer is string');
  assert(entityResult.answer.length > 0, 'ENTITY_LOOKUP: answer is not empty');
  assert(entityResult.answer.includes('Steve Hughes'), 'ENTITY_LOOKUP: answer contains entity name');
  assert(entityResult.answer.includes('person'), 'ENTITY_LOOKUP: answer contains entity type');
  assert(Array.isArray(entityResult.entities), 'ENTITY_LOOKUP: has entities array');
  assert(entityResult.entities.length > 0, 'ENTITY_LOOKUP: entities not empty');
  assert(entityResult.entities[0].id === 'ENT-SH-052', 'ENTITY_LOOKUP: entity id correct');
  assert(entityResult.entities[0].role === 'primary', 'ENTITY_LOOKUP: entity role is primary');
  assert(typeof entityResult.confidence === 'number', 'ENTITY_LOOKUP: has confidence number');

  section('Step 7: synthesizeAnswer — RELATIONSHIP (with paths)');
  const paths = findPaths('ENT-SH-052', 'ENT-CM-001', index);
  const pathResult = synthesizeAnswer('RELATIONSHIP', { paths, sourceName: 'Steve Hughes', targetName: 'CJ Mitchell' });
  assert(typeof pathResult.answer === 'string', 'RELATIONSHIP: answer is string');
  assert(pathResult.answer.includes('Steve Hughes'), 'RELATIONSHIP: answer contains source name');
  assert(pathResult.answer.includes('CJ Mitchell'), 'RELATIONSHIP: answer contains target name');
  assert(pathResult.answer.includes('connected'), 'RELATIONSHIP: answer mentions connection');
  assert(Array.isArray(pathResult.paths), 'RELATIONSHIP: has paths array');
  assert(pathResult.paths.length > 0, 'RELATIONSHIP: has at least one path');
  assert(typeof pathResult.paths[0].hops === 'number', 'RELATIONSHIP: path has hops count');

  section('Step 7: synthesizeAnswer — RELATIONSHIP (no paths)');
  const noPathResult = synthesizeAnswer('RELATIONSHIP', { paths: [], sourceName: 'A', targetName: 'B' });
  assert(noPathResult.answer.includes('No connection found'), 'RELATIONSHIP no-path: correct message');
  assert(noPathResult.confidence === 0, 'RELATIONSHIP no-path: confidence is 0');

  section('Step 7: synthesizeAnswer — AGGREGATION');
  const people = filterEntities({ type: 'person' }, GRAPH_DIR);
  const aggResult = synthesizeAnswer('AGGREGATION', { entities: people, question: 'How many people?' });
  assert(typeof aggResult.answer === 'string', 'AGGREGATION: answer is string');
  assert(aggResult.answer.includes('Found'), 'AGGREGATION: answer has count');
  assert(aggResult.confidence === 1.0, 'AGGREGATION: confidence is 1.0 (deterministic)');
  assert(Array.isArray(aggResult.entities), 'AGGREGATION: has entities array');
  assert(aggResult.entities.length === people.length, 'AGGREGATION: entities count matches');

  section('Step 7: synthesizeAnswer — AGGREGATION (empty)');
  const emptyAgg = synthesizeAnswer('AGGREGATION', { entities: [], question: 'test' });
  assert(emptyAgg.answer.includes('No entities'), 'AGGREGATION empty: correct message');

  section('Step 7: synthesizeAnswer — COMPLETENESS');
  const compResult = synthesizeAnswer('COMPLETENESS', { entity: steveData });
  assert(typeof compResult.answer === 'string', 'COMPLETENESS: answer is string');
  assert(compResult.answer.includes('Steve Hughes'), 'COMPLETENESS: answer contains name');
  assert(compResult.answer.includes('%'), 'COMPLETENESS: answer has coverage percentage');
  assert(Array.isArray(compResult.gaps), 'COMPLETENESS: has gaps array');
  assert(compResult.confidence === 0.9, 'COMPLETENESS: confidence is 0.9');

  section('Step 7: synthesizeAnswer — CONTRADICTION');
  const conflictResult = synthesizeAnswer('CONTRADICTION', { entity: steveData });
  assert(typeof conflictResult.answer === 'string', 'CONTRADICTION: answer is string');
  assert(conflictResult.answer.includes('Steve Hughes'), 'CONTRADICTION: answer contains name');
  assert(Array.isArray(conflictResult.conflicts), 'CONTRADICTION: has conflicts array');
  assert(typeof conflictResult.confidence === 'number', 'CONTRADICTION: has confidence number');

  section('Step 7: synthesizeAnswer — UNKNOWN type');
  const unknownResult = synthesizeAnswer('UNKNOWN', {});
  assert(typeof unknownResult.answer === 'string', 'UNKNOWN: answer is string');
  assert(unknownResult.answer.length > 0, 'UNKNOWN: answer is not empty');
  assert(unknownResult.confidence === 0, 'UNKNOWN: confidence is 0');

  section('Step 7: synthesizeAnswer — null entity');
  const nullResult = synthesizeAnswer('ENTITY_LOOKUP', { entity: null });
  assert(nullResult.answer.includes('not found'), 'null entity: answer says not found');
}

// ---------------------------------------------------------------------------
// Step 8 Tests — resolveEntities
// ---------------------------------------------------------------------------

function testStep8() {
  section('Step 8: resolveEntities — single entity');
  const single = resolveEntities('Who is Steve Hughes?', GRAPH_DIR);
  assert(single.length > 0, '"Who is Steve Hughes?" resolves at least 1 entity');
  const hasSteve = single.some(e => e.entityId === 'ENT-SH-052');
  assert(hasSteve, 'resolves Steve Hughes → ENT-SH-052');

  section('Step 8: resolveEntities — two entities');
  const two = resolveEntities('How does Steve Hughes connect to CJ Mitchell?', GRAPH_DIR);
  assert(two.length >= 2, 'resolves at least 2 entities');
  const hasSteveTwo = two.some(e => e.entityId === 'ENT-SH-052');
  const hasCJ = two.some(e => e.entityId === 'ENT-CM-001');
  assert(hasSteveTwo, 'resolves Steve Hughes');
  assert(hasCJ, 'resolves CJ Mitchell');

  section('Step 8: resolveEntities — result structure');
  if (single.length > 0) {
    const r = single[0];
    assert(typeof r.entityId === 'string', 'result has entityId');
    assert(r.name !== undefined, 'result has name');
    assert(typeof r.score === 'number', 'result has score');
  }

  section('Step 8: resolveEntities — no entities');
  const none = resolveEntities('Hello world', GRAPH_DIR);
  assert(none.length === 0, '"Hello world" resolves no entities');

  section('Step 8: resolveEntities — partial name');
  const partial = resolveEntities('Tell me about Steve', GRAPH_DIR);
  assert(partial.length > 0, '"Tell me about Steve" resolves at least 1 entity');

  section('Step 8: resolveEntities — no duplicates');
  const dupes = resolveEntities('Steve Hughes and Steve Hughes again', GRAPH_DIR);
  const steveCount = dupes.filter(e => e.entityId === 'ENT-SH-052').length;
  assert(steveCount <= 1, 'no duplicate entity IDs in results');
}

// ---------------------------------------------------------------------------
// Step 9 Tests — query() integration
// ---------------------------------------------------------------------------

async function testStep9() {
  section('Step 9: query() — ENTITY_LOOKUP "Who is Steve Hughes?"');
  const q1 = await query('Who is Steve Hughes?', GRAPH_DIR);
  assert(q1.query.type === 'ENTITY_LOOKUP', 'classified as ENTITY_LOOKUP');
  assert(q1.answer.includes('Steve Hughes'), 'answer contains Steve Hughes');
  assert(q1.query.entities_resolved.includes('ENT-SH-052'), 'resolved ENT-SH-052');
  assert(q1.entities.length > 0, 'has entities');
  assert(q1.confidence > 0, 'has confidence > 0');

  section('Step 9: query() — ENTITY_LOOKUP "Tell me about Amazon"');
  const q2 = await query('Tell me about Amazon', GRAPH_DIR);
  assert(q2.query.type === 'ENTITY_LOOKUP', 'classified as ENTITY_LOOKUP');
  assert(q2.answer.length > 0, 'answer not empty');

  section('Step 9: query() — RELATIONSHIP "How does Steve Hughes connect to CJ Mitchell?"');
  const q3 = await query('How does Steve Hughes connect to CJ Mitchell?', GRAPH_DIR);
  assert(q3.query.type === 'RELATIONSHIP', 'classified as RELATIONSHIP');
  assert(q3.answer.includes('Steve Hughes'), 'answer contains source');
  assert(q3.answer.includes('CJ Mitchell'), 'answer contains target');
  assert(q3.paths.length > 0, 'has paths');
  assert(q3.query.entities_resolved.length >= 2, 'resolved 2+ entities');

  section('Step 9: query() — AGGREGATION "How many people are in my graph?"');
  const q4 = await query('How many people are in my graph?', GRAPH_DIR);
  assert(q4.query.type === 'AGGREGATION', 'classified as AGGREGATION');
  assert(q4.answer.includes('Found') || q4.answer.includes('You have'), 'answer has count');
  assert(q4.entities.length > 0, 'has entities');
  assert(q4.confidence === 1.0, 'confidence is 1.0');

  section('Step 9: query() — AGGREGATION "List all organizations"');
  const q5 = await query('List all organizations', GRAPH_DIR);
  assert(q5.query.type === 'AGGREGATION', 'classified as AGGREGATION');
  assert(q5.entities.length > 0, 'has entities');

  section('Step 9: query() — COMPLETENESS "What am I missing about Steve Hughes?"');
  const q6 = await query('What am I missing about Steve Hughes?', GRAPH_DIR);
  assert(q6.query.type === 'COMPLETENESS', 'classified as COMPLETENESS');
  assert(q6.answer.includes('Steve Hughes'), 'answer contains name');
  assert(q6.answer.includes('%'), 'answer has coverage %');
  assert(Array.isArray(q6.gaps), 'has gaps array');

  section('Step 9: query() — CONTRADICTION "Any conflicts in Steve Hughes data?"');
  const q7 = await query("Any conflicts in Steve Hughes' data?", GRAPH_DIR);
  assert(q7.query.type === 'CONTRADICTION', 'classified as CONTRADICTION');
  assert(q7.answer.includes('Steve Hughes'), 'answer contains name');
  assert(Array.isArray(q7.conflicts), 'has conflicts array');

  section('Step 9: query() — UNKNOWN "Hello"');
  const q8 = await query('Hello', GRAPH_DIR);
  assert(q8.query.type === 'UNKNOWN', 'classified as UNKNOWN');
  assert(q8.answer.length > 0, 'answer not empty');
  assert(q8.confidence === 0, 'confidence is 0');

  section('Step 9: query() — timing metadata');
  assert(typeof q1.timing.classification_ms === 'number', 'has classification_ms');
  assert(typeof q1.timing.graph_query_ms === 'number', 'has graph_query_ms');
  assert(typeof q1.timing.synthesis_ms === 'number', 'has synthesis_ms');
  assert(typeof q1.timing.total_ms === 'number', 'has total_ms');
  assert(q1.timing.total_ms < 5000, 'total < 5s (no AI call)');

  section('Step 9: query() — response schema');
  assert(typeof q1.answer === 'string', 'answer is string');
  assert(typeof q1.query === 'object', 'query is object');
  assert(typeof q1.query.original === 'string', 'query.original is string');
  assert(typeof q1.query.type === 'string', 'query.type is string');
  assert(typeof q1.query.classified_by === 'string', 'query.classified_by is string');
  assert(Array.isArray(q1.query.entities_resolved), 'query.entities_resolved is array');
  assert(Array.isArray(q1.entities), 'entities is array');
  assert(Array.isArray(q1.paths), 'paths is array');
  assert(Array.isArray(q1.gaps), 'gaps is array');
  assert(Array.isArray(q1.conflicts), 'conflicts is array');
  assert(typeof q1.confidence === 'number', 'confidence is number');
}

// ---------------------------------------------------------------------------
// Step 10 Tests — API endpoint (validated via curl above, structural test here)
// ---------------------------------------------------------------------------

function testStep10() {
  section('Step 10: web-demo.js has /api/query endpoint');
  const webDemo = require('fs').readFileSync(path.join(__dirname, 'web-demo.js'), 'utf8');
  assert(webDemo.includes("require('./query-engine')"), 'web-demo.js imports query-engine');
  assert(webDemo.includes("/api/query"), 'web-demo.js has /api/query route');
  assert(webDemo.includes('queryEngine'), 'web-demo.js calls queryEngine');
  assert(webDemo.includes('req.query.q'), 'endpoint reads q parameter');
  assert(webDemo.includes('apiAuth'), '/api/query uses apiAuth middleware');
}

// ---------------------------------------------------------------------------
// Step 11 Tests — Web UI search bar integration
// ---------------------------------------------------------------------------

function testStep11() {
  section('Step 11: web-demo.js has query UI wiring');
  const webDemo = require('fs').readFileSync(path.join(__dirname, 'web-demo.js'), 'utf8');
  assert(webDemo.includes('isQuestion'), 'has isQuestion() function');
  assert(webDemo.includes('renderQueryResult'), 'has renderQueryResult() function');
  assert(webDemo.includes('/api/query?q='), 'search calls /api/query endpoint');
  assert(webDemo.includes('Search or ask a question'), 'placeholder updated for query mode');
  assert(webDemo.includes('Connection Paths'), 'renderQueryResult shows paths section');
  assert(webDemo.includes('Gaps Found'), 'renderQueryResult shows gaps section');
  assert(webDemo.includes('Conflicts'), 'renderQueryResult shows conflicts section');
  assert(webDemo.includes('Thinking...'), 'shows loading state while query runs');
}

// ---------------------------------------------------------------------------
// Self-Entity Awareness Tests
// ---------------------------------------------------------------------------

function testSelfEntity() {
  section('Self-Entity: getSelfEntity()');
  clearSelfEntityCache();
  const self = getSelfEntity(GRAPH_DIR);
  assert(self !== null, 'getSelfEntity returns a result');
  assert(typeof self.entityId === 'string', 'self has entityId');
  assert(typeof self.name === 'string', 'self has name');
  assert(self.isSelf === true, 'self.isSelf is true');
  // CJ Mitchell should be the self-entity (most relationships or from config)
  assert(self.entityId === 'ENT-CM-001', 'self-entity is CJ Mitchell (ENT-CM-001)');

  section('Self-Entity: getSelfEntity() caching');
  const self2 = getSelfEntity(GRAPH_DIR);
  assert(self2 === self, 'second call returns cached result');
}

async function testSelfEntityQueries() {
  section('Self-Entity: "Who are my friends?" resolves self');
  const q1 = await query('Who are my friends?', GRAPH_DIR);
  assert(q1.query.entities_resolved.includes('ENT-CM-001'), '"my friends" resolves self-entity');

  section('Self-Entity: "What am I missing?" uses "your" in answer');
  const q2 = await query('What am I missing?', GRAPH_DIR);
  assert(q2.query.type === 'COMPLETENESS', 'classified as COMPLETENESS');
  assert(q2.answer.includes('Your profile') || q2.answer.includes('your'), 'answer uses "your" for self-entity');
  assert(q2.query.entities_resolved.includes('ENT-CM-001'), 'resolves self-entity');

  section('Self-Entity: "How do I connect to Howard?" resolves self');
  const q3 = await query('How do I connect to Howard University?', GRAPH_DIR);
  assert(q3.query.type === 'RELATIONSHIP', 'classified as RELATIONSHIP');
  assert(q3.query.entities_resolved.includes('ENT-CM-001'), 'resolves self-entity from "I"');

  section('Self-Entity: "How many people are in my graph?" uses "You have"');
  const q4 = await query('How many people are in my graph?', GRAPH_DIR);
  assert(q4.answer.includes('You have'), 'answer uses "You have" for self-entity');

  section('Self-Entity: non-self queries still use entity name');
  const q5 = await query('Who is Steve Hughes?', GRAPH_DIR);
  assert(q5.answer.includes('Steve Hughes'), 'non-self query uses entity name');
  assert(!q5.answer.startsWith('You'), 'non-self query does not start with "You"');
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

  if (!step || step === 6) {
    testStep6();
  }

  if (!step || step === 7) {
    testStep7();
  }

  if (!step || step === 8) {
    testStep8();
  }

  if (!step || step === 9) {
    await testStep9();
  }

  if (!step || step === 10) {
    testStep10();
  }

  if (!step || step === 11) {
    testStep11();
  }

  if (!step || step === 12) {
    testSelfEntity();
    await testSelfEntityQueries();
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
