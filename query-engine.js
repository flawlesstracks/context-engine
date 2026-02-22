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
// Helpers: Entity name extraction from entity JSON
// ---------------------------------------------------------------------------

function _getEntityName(data) {
  if (!data) return '';
  const e = data.entity || {};
  if (typeof e.name === 'string') return e.name;
  if (e.name && typeof e.name === 'object') return e.name.preferred || e.name.full || '';
  return '';
}

function _getEntityId(data) {
  if (!data) return '';
  return (data.entity && data.entity.entity_id) || '';
}

function _getEntityType(data) {
  if (!data) return '';
  return (data.entity && data.entity.entity_type) || '';
}

function _getEntityAliases(data) {
  if (!data) return [];
  const e = data.entity || {};
  if (e.name && Array.isArray(e.name.aliases)) return e.name.aliases;
  return [];
}

function _getAttributes(data) {
  if (!data) return {};
  const attrs = {};
  if (Array.isArray(data.attributes)) {
    for (const a of data.attributes) {
      if (a.key) attrs[a.key] = a.value;
    }
  }
  if (data.structured_attributes) {
    // Flatten structured_attributes for searching
    const flat = _flattenObj(data.structured_attributes);
    Object.assign(attrs, flat);
  }
  return attrs;
}

function _flattenObj(obj, prefix = '') {
  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(result, _flattenObj(val, fullKey));
    } else {
      result[fullKey] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Q2.1: Entity Search — fuzzy search with Dice coefficient
// ---------------------------------------------------------------------------

/**
 * Search entities by name with fuzzy matching.
 * @param {string} queryStr - search term
 * @param {string} graphDir - graph directory path
 * @param {object} options - { type, limit, minConfidence }
 * @returns {Array} matching entities sorted by relevance
 */
function searchEntities(queryStr, graphDir, options = {}) {
  const { type, limit = 10, minConfidence = 0 } = options;
  const q = queryStr.toLowerCase().trim();
  if (!q) return [];

  const allEntities = listEntities(graphDir);
  const results = [];

  for (const { file, data } of allEntities) {
    const name = _getEntityName(data);
    const entityId = _getEntityId(data);
    const entityType = _getEntityType(data);
    const aliases = _getEntityAliases(data);
    const attrs = _getAttributes(data);

    // Type filter
    if (type && entityType !== type) continue;

    let score = 0;
    const nameLower = name.toLowerCase();

    // Exact match
    if (nameLower === q) {
      score = 1.0;
    }
    // Case-insensitive exact
    else if (nameLower === q) {
      score = 0.95;
    }
    // Alias match
    else if (aliases.some(a => a.toLowerCase() === q)) {
      score = 0.85;
    }
    // Dice coefficient on full name
    else {
      const dice = similarity(q, name);
      if (dice > 0.6) {
        score = dice;
      }
    }

    // Partial name match (first or last name)
    if (score === 0) {
      const parts = nameLower.split(/\s+/);
      for (const part of parts) {
        if (part === q || similarity(q, part) > 0.8) {
          score = 0.7;
          break;
        }
      }
    }

    // Alias fuzzy match
    if (score === 0) {
      for (const alias of aliases) {
        if (similarity(q, alias) > 0.7) {
          score = 0.75;
          break;
        }
      }
    }

    // Attribute value match
    if (score === 0) {
      for (const val of Object.values(attrs)) {
        if (typeof val === 'string' && val.toLowerCase().includes(q)) {
          score = 0.5;
          break;
        }
      }
    }

    if (score > 0 && score >= minConfidence) {
      results.push({ entityId, name, type: entityType, score, data, file });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Q2.2: Relationship Index — bidirectional adjacency list
// ---------------------------------------------------------------------------

const REVERSE_LABELS = {
  works_at: 'employs',
  employed_by: 'employs',
  friend_of: 'friend_of',
  parent_of: 'child_of',
  child_of: 'parent_of',
  married_to: 'married_to',
  spouse: 'spouse',
  created: 'created_by',
  created_by: 'created',
  belongs_to: 'has_member',
  has_member: 'belongs_to',
  member_of: 'has_member',
  reports_to: 'manages',
  manages: 'reports_to',
  founded: 'founded_by',
  founded_by: 'founded',
  attended: 'has_alumni',
  has_alumni: 'attended',
  leads: 'led_by',
  led_by: 'leads',
  daughter: 'parent_of',
  son: 'parent_of',
};

function _reverseLabel(label) {
  const key = label.toLowerCase().replace(/[\s_-]+/g, '_').trim();
  return REVERSE_LABELS[key] || key;
}

/**
 * Build an in-memory adjacency list from all entity relationship arrays.
 * Returns: { entityId: [{ targetId, targetName, relationship, confidence, source }] }
 * Also includes a name→id lookup map.
 */
function buildRelationshipIndex(graphDir) {
  const allEntities = listEntities(graphDir);
  const edges = {};   // entityId → array of edges
  const nameToId = {}; // lowercase name → entityId

  for (const { data } of allEntities) {
    const entityId = _getEntityId(data);
    const entityName = _getEntityName(data);
    const entityType = _getEntityType(data);
    if (!entityId) continue;

    nameToId[entityName.toLowerCase()] = entityId;
    // Also map aliases
    for (const alias of _getEntityAliases(data)) {
      nameToId[alias.toLowerCase()] = entityId;
    }

    if (!edges[entityId]) edges[entityId] = [];

    const rels = data.relationships || [];
    for (const rel of rels) {
      const targetName = rel.name || '';
      const relType = rel.relationship_type || rel.relationship || '';
      const confidence = rel.confidence || 0.5;

      // Resolve target name to ID
      const targetId = nameToId[targetName.toLowerCase()] || null;

      // Forward edge: entity → target
      edges[entityId].push({
        targetId,
        targetName,
        relationship: relType,
        confidence,
        source: entityId,
      });

      // Reverse edge: target → entity (if target ID is known)
      if (targetId) {
        if (!edges[targetId]) edges[targetId] = [];
        edges[targetId].push({
          targetId: entityId,
          targetName: entityName,
          relationship: _reverseLabel(relType),
          confidence,
          source: entityId,
        });
      }
    }
  }

  // Second pass: resolve any unresolved targetIds now that all names are mapped
  for (const entityId of Object.keys(edges)) {
    for (const edge of edges[entityId]) {
      if (!edge.targetId && edge.targetName) {
        edge.targetId = nameToId[edge.targetName.toLowerCase()] || null;
      }
    }
  }

  return { edges, nameToId };
}

// ---------------------------------------------------------------------------
// Q2.2: Path Finding — BFS between two entities
// ---------------------------------------------------------------------------

/**
 * Find shortest paths between two entities via BFS.
 * @param {string} sourceId
 * @param {string} targetId
 * @param {object} index - from buildRelationshipIndex()
 * @param {number} maxDepth - max hops (default 4)
 * @returns {Array} paths, each path = [{ entityId, entityName, relationship, direction }]
 */
function findPaths(sourceId, targetId, index, maxDepth = 4) {
  if (!sourceId || !targetId || sourceId === targetId) return [];
  const { edges } = index;
  if (!edges[sourceId]) return [];

  const paths = [];
  // BFS queue: [{ currentId, path: [...], visited: Set }]
  const queue = [{ currentId: sourceId, path: [{ entityId: sourceId }], visited: new Set([sourceId]) }];

  while (queue.length > 0) {
    const { currentId, path: currentPath, visited } = queue.shift();

    if (currentPath.length - 1 >= maxDepth) continue;

    const neighbors = edges[currentId] || [];
    for (const edge of neighbors) {
      const nextId = edge.targetId;
      if (!nextId || visited.has(nextId)) continue;

      const newPath = [...currentPath, {
        entityId: nextId,
        entityName: edge.targetName,
        relationship: edge.relationship,
        direction: '→',
        confidence: edge.confidence,
      }];

      if (nextId === targetId) {
        paths.push(newPath);
        continue; // Found a path — don't continue from target
      }

      const newVisited = new Set(visited);
      newVisited.add(nextId);
      queue.push({ currentId: nextId, path: newPath, visited: newVisited });
    }
  }

  // Sort: shortest first, then highest minimum confidence
  paths.sort((a, b) => {
    if (a.length !== b.length) return a.length - b.length;
    const minA = Math.min(...a.filter(n => n.confidence).map(n => n.confidence));
    const minB = Math.min(...b.filter(n => n.confidence).map(n => n.confidence));
    return minB - minA;
  });

  return paths;
}

// ---------------------------------------------------------------------------
// Q2.3: Neighborhood Query — BFS rings
// ---------------------------------------------------------------------------

/**
 * Get all entities within N hops of a starting entity.
 * @param {string} entityId
 * @param {object} index - from buildRelationshipIndex()
 * @param {number} depth - max hops (default 2)
 * @returns {{ center: string, rings: Array<{depth: number, entities: Array}> }}
 */
function getNeighborhood(entityId, index, depth = 2) {
  const { edges } = index;
  const visited = new Set([entityId]);
  const rings = [];
  let frontier = [entityId];

  for (let d = 1; d <= depth; d++) {
    const nextFrontier = [];
    const ringEntities = [];

    for (const currentId of frontier) {
      const neighbors = edges[currentId] || [];
      for (const edge of neighbors) {
        if (!edge.targetId || visited.has(edge.targetId)) continue;
        visited.add(edge.targetId);
        nextFrontier.push(edge.targetId);
        ringEntities.push({
          entityId: edge.targetId,
          entityName: edge.targetName,
          relationship: edge.relationship,
          fromEntity: currentId,
        });
      }
    }

    if (ringEntities.length > 0) {
      rings.push({ depth: d, entities: ringEntities });
    }
    frontier = nextFrontier;
  }

  return { center: entityId, rings };
}

// ---------------------------------------------------------------------------
// Q2.4: Attribute Filter — filter entities by criteria
// ---------------------------------------------------------------------------

/**
 * Find entities matching filter criteria.
 * @param {object} filters - { type: "person", "attributes.location": "Atlanta" }
 * @param {string} graphDir
 * @returns {Array} matching entities
 */
function filterEntities(filters, graphDir) {
  const allEntities = listEntities(graphDir);
  const results = [];

  for (const { file, data } of allEntities) {
    const entityId = _getEntityId(data);
    const entityName = _getEntityName(data);
    const entityType = _getEntityType(data);
    const attrs = _getAttributes(data);

    let matches = true;
    for (const [key, value] of Object.entries(filters)) {
      const filterVal = String(value).toLowerCase();

      if (key === 'type' || key === 'entity_type') {
        if (entityType.toLowerCase() !== filterVal) { matches = false; break; }
      } else if (key === 'name') {
        if (!entityName.toLowerCase().includes(filterVal)) { matches = false; break; }
      } else if (key.startsWith('attributes.') || key.includes('.')) {
        // Dot-notation attribute access
        const attrKey = key.replace(/^attributes\./, '');
        const attrVal = attrs[attrKey];
        if (!attrVal || !String(attrVal).toLowerCase().includes(filterVal)) { matches = false; break; }
      } else {
        // Check flat attributes
        const attrVal = attrs[key];
        if (!attrVal || !String(attrVal).toLowerCase().includes(filterVal)) { matches = false; break; }
      }
    }

    if (matches) {
      results.push({ entityId, name: entityName, type: entityType, data, file });
    }
  }

  return results;
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
