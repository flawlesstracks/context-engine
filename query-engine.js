'use strict';

const fs = require('fs');
const path = require('path');
const { similarity } = require('./merge-engine');
const { listEntities, readEntity } = require('./src/graph-ops');

// ---------------------------------------------------------------------------
// Q1: Query Classification
// Keyword matching first, AI fallback second.
// ---------------------------------------------------------------------------

/**
 * Classify a natural language question into one of 5 query types.
 * @param {string} question
 * @returns {string} ENTITY_LOOKUP | RELATIONSHIP | AGGREGATION | COMPLETENESS | CONTRADICTION | UNKNOWN
 */
function classifyQuery(question) {
  const q = question.toLowerCase().trim()
    // Normalize smart quotes to ASCII
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');

  // CONTRADICTION patterns (check early — specific signals)
  if (/conflict|contradict|disagree|inconsisten|mismatch|wrong/.test(q)) return 'CONTRADICTION';
  if (/two (different|versions)|which is .*(right|correct)/.test(q)) return 'CONTRADICTION';

  // COMPLETENESS patterns (check before ENTITY_LOOKUP — "what" overlap)
  if (/\bmiss(ing)?\b|gap|incomplete|don.t .*(know|have)|need.* more|\benrich/.test(q)) return 'COMPLETENESS';
  if (/\bcoverage\b|\bempty\b|\bthin\b|\bsparse\b/.test(q)) return 'COMPLETENESS';

  // AGGREGATION patterns (check before ENTITY_LOOKUP — "who are" overlap)
  if (/^(how many|list|count|show all|find all)/.test(q)) return 'AGGREGATION';
  if (/\ball\b/.test(q) && /^(who|what|which|show|find)/.test(q)) return 'AGGREGATION';
  if (/^(what are the|which) .+ (in|at|from|of)/.test(q)) return 'AGGREGATION';

  // ENTITY_LOOKUP patterns
  if (/^(who|what) (is|are|was) /.test(q)) return 'ENTITY_LOOKUP';
  if (/^tell me about /.test(q)) return 'ENTITY_LOOKUP';
  if (/^(describe|summarize|profile) /.test(q)) return 'ENTITY_LOOKUP';

  // RELATIONSHIP patterns
  if (/how (does|do|is|are) .+ (connect|relate|know|link)/.test(q)) return 'RELATIONSHIP';
  if (/\bconnect|\brelate|\blink|\bbetween\b|\bpath\b|\brelationship\b/.test(q)) return 'RELATIONSHIP';

  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Q2.1: Entity Search (stub — Step 3)
// ---------------------------------------------------------------------------

function searchEntities(queryStr, graphDir, options = {}) {
  // TODO: Step 3
  return [];
}

// ---------------------------------------------------------------------------
// Q2.2: Relationship Index + Path Finding (stubs — Steps 2, 4)
// ---------------------------------------------------------------------------

function buildRelationshipIndex(graphDir) {
  // TODO: Step 2
  return {};
}

function findPaths(sourceId, targetId, index, maxDepth = 4) {
  // TODO: Step 4
  return [];
}

// ---------------------------------------------------------------------------
// Q2.3: Neighborhood Query (stub — Step 5)
// ---------------------------------------------------------------------------

function getNeighborhood(entityId, index, depth = 2) {
  // TODO: Step 5
  return { center: entityId, rings: [] };
}

// ---------------------------------------------------------------------------
// Q2.4: Attribute Filter (stub — Step 6)
// ---------------------------------------------------------------------------

function filterEntities(filters, graphDir) {
  // TODO: Step 6
  return [];
}

// ---------------------------------------------------------------------------
// Q3: Answer Synthesis (stub — Step 7)
// ---------------------------------------------------------------------------

function synthesizeAnswer(queryType, data) {
  // TODO: Step 7
  return { answer: '', entities: [], paths: [], gaps: [], conflicts: [], confidence: 0 };
}

// ---------------------------------------------------------------------------
// Entity Resolution (stub — Step 8)
// ---------------------------------------------------------------------------

function resolveEntities(question, graphDir) {
  // TODO: Step 8
  return [];
}

// ---------------------------------------------------------------------------
// Main entry point (stub — Step 9)
// ---------------------------------------------------------------------------

async function query(question, graphDir) {
  const startTime = Date.now();
  const classStart = Date.now();
  const queryType = classifyQuery(question);
  const classificationMs = Date.now() - classStart;

  // TODO: Steps 8-9 — resolve entities, graph ops, synthesis

  return {
    answer: '',
    query: {
      original: question,
      type: queryType,
      classified_by: 'keyword',
      entities_resolved: [],
    },
    entities: [],
    paths: [],
    gaps: [],
    conflicts: [],
    confidence: 0,
    timing: {
      classification_ms: classificationMs,
      graph_query_ms: 0,
      synthesis_ms: 0,
      total_ms: Date.now() - startTime,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  query,
  classifyQuery,
  resolveEntities,
  buildRelationshipIndex,
  searchEntities,
  findPaths,
  getNeighborhood,
  filterEntities,
  synthesizeAnswer,
};
