'use strict';

const fs = require('fs');
const path = require('path');
const { similarity } = require('./merge-engine');
const { listEntities, readEntity, getSelfEntityId } = require('./src/graph-ops');

// ---------------------------------------------------------------------------
// Self-Entity Awareness
// ---------------------------------------------------------------------------

const _selfEntityCache = {};

/**
 * Get the self (main character) entity for a graph directory.
 * Checks self-entity.json first, then tenants.config.json, then falls back to most-connected entity.
 * @param {string} graphDir
 * @returns {{ entityId: string, name: string, isSelf: boolean } | null}
 */
function getSelfEntity(graphDir) {
  if (_selfEntityCache[graphDir]) return _selfEntityCache[graphDir];

  // 1. Check self-entity.json in graphDir
  const selfPath = path.join(graphDir, 'self-entity.json');
  try {
    if (fs.existsSync(selfPath)) {
      const cfg = JSON.parse(fs.readFileSync(selfPath, 'utf-8'));
      if (cfg.self_entity_id) {
        const data = readEntity(cfg.self_entity_id, graphDir);
        const name = cfg.self_entity_name || _getEntityName(data) || cfg.self_entity_id;
        const result = { entityId: cfg.self_entity_id, name, isSelf: true };
        _selfEntityCache[graphDir] = result;
        return result;
      }
    }
  } catch {}

  // 2. Check tenants.config.json via graph-ops
  const selfId = getSelfEntityId(graphDir);
  if (selfId) {
    const data = readEntity(selfId, graphDir);
    const name = _getEntityName(data) || selfId;
    const result = { entityId: selfId, name, isSelf: true };
    _selfEntityCache[graphDir] = result;
    return result;
  }

  // 3. Fallback: entity with most relationships
  const allEntities = listEntities(graphDir);
  let bestId = null;
  let bestName = '';
  let bestRelCount = 0;
  for (const { data } of allEntities) {
    const rels = data.relationships || [];
    if (rels.length > bestRelCount) {
      bestRelCount = rels.length;
      bestId = _getEntityId(data);
      bestName = _getEntityName(data);
    }
  }
  if (bestId) {
    const result = { entityId: bestId, name: bestName, isSelf: true };
    _selfEntityCache[graphDir] = result;
    return result;
  }

  return null;
}

/**
 * Clear cached self-entity (call after POST /api/self-entity).
 */
function clearSelfEntityCache(graphDir) {
  if (graphDir) {
    delete _selfEntityCache[graphDir];
  } else {
    for (const key of Object.keys(_selfEntityCache)) delete _selfEntityCache[key];
  }
}

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
  const { type, limit = 10, minConfidence = 0, spokeId } = options;
  const q = queryStr.toLowerCase().trim();
  if (!q) return [];

  const allEntities = listEntities(graphDir, spokeId ? { spokeId } : undefined);
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
function buildRelationshipIndex(graphDir, opts) {
  const spokeId = opts?.spokeId;
  const allEntities = listEntities(graphDir, spokeId ? { spokeId } : undefined);
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
function filterEntities(filters, graphDir, opts) {
  const spokeId = opts?.spokeId;
  const allEntities = listEntities(graphDir, spokeId ? { spokeId } : undefined);
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
// Q3: Answer Synthesis — Step 7
// ---------------------------------------------------------------------------

// Q3.1: Entity Lookup
function _synthesizeEntityAnswer(entityData, isSelf) {
  if (!entityData) return { answer: 'Entity not found.', entities: [], paths: [], gaps: [], conflicts: [], confidence: 0 };

  const name = _getEntityName(entityData);
  const entityId = _getEntityId(entityData);
  const entityType = _getEntityType(entityData);
  const attrs = _getAttributes(entityData);
  const summary = (entityData.entity && entityData.entity.summary && entityData.entity.summary.value) || '';
  const rels = entityData.relationships || [];

  const subj = isSelf ? 'You' : name;
  const verb = isSelf ? 'are' : 'is';
  let answer = `${subj} ${verb} a ${entityType}.`;
  if (summary) answer += ` ${summary}`;

  // Key attributes
  const keyAttrs = ['location', 'role', 'employer', 'education', 'age', 'birthdate'];
  const attrParts = [];
  for (const key of keyAttrs) {
    if (attrs[key]) attrParts.push(`${key}: ${attrs[key]}`);
  }
  if (attrParts.length > 0) answer += ` Key details: ${attrParts.join(', ')}.`;

  // Relationship count
  if (rels.length > 0) {
    const relNames = rels.slice(0, 3).map(r => `${r.name} (${r.relationship_type || r.relationship || 'related'})`);
    answer += isSelf ? ` You're connected to ${rels.length} other entities` : ` Connected to ${rels.length} other entities`;
    answer += rels.length > 0 ? ` including ${relNames.join(', ')}.` : '.';
  }

  // Confidence
  const attrList = entityData.attributes || [];
  const avgConf = attrList.length > 0
    ? attrList.reduce((sum, a) => sum + (a.confidence || 0), 0) / attrList.length
    : 0.5;
  if (avgConf < 0.5) answer += ' Note: some data has low confidence.';

  return {
    answer,
    entities: [{ id: entityId, name, type: entityType, role: 'primary' }],
    paths: [],
    gaps: [],
    conflicts: [],
    confidence: Math.round(avgConf * 100) / 100,
  };
}

// Q3.2: Path Narrative
function _synthesizePathAnswer(paths, sourceName, targetName, sourceIsSelf, targetIsSelf) {
  const srcDisplay = sourceIsSelf ? 'You' : sourceName;
  const tgtDisplay = targetIsSelf ? 'you' : targetName;

  if (!paths || paths.length === 0) {
    return {
      answer: `No connection found between ${srcDisplay} and ${tgtDisplay} within 4 hops.`,
      entities: [],
      paths: [],
      gaps: [],
      conflicts: [],
      confidence: 0,
    };
  }

  const shortest = paths[0];
  const hops = shortest.length - 1;

  // Build narrative
  const steps = [];
  for (let i = 1; i < shortest.length; i++) {
    const node = shortest[i];
    steps.push(`${node.relationship} → ${node.entityName}`);
  }
  const srcLabel = sourceIsSelf ? 'You' : sourceName;
  const verb = sourceIsSelf ? "'re" : ' is';
  let answer = `${srcLabel}${verb} connected to ${tgtDisplay} in ${hops} hop${hops !== 1 ? 's' : ''}: ${sourceName} → ${steps.join(' → ')}.`;

  if (paths.length > 1) {
    answer += ` There are ${paths.length} connection paths. The shortest has ${hops} hop${hops !== 1 ? 's' : ''}.`;
  }

  // Collect all entities in the path
  const entities = shortest.map((node, i) => ({
    id: node.entityId,
    name: node.entityName || sourceName,
    role: i === 0 ? 'source' : (i === shortest.length - 1 ? 'target' : 'intermediary'),
  }));

  // Format paths for response
  const formattedPaths = paths.map(p => ({
    hops: p.length - 1,
    path: p.map(node => ({
      entity: node.entityName || node.entityId,
      relationship: node.relationship || '',
      direction: node.direction || '→',
    })),
    min_confidence: Math.min(...p.filter(n => n.confidence).map(n => n.confidence).concat([1])),
  }));

  return {
    answer,
    entities,
    paths: formattedPaths,
    gaps: [],
    conflicts: [],
    confidence: formattedPaths[0] ? formattedPaths[0].min_confidence : 0,
  };
}

// Q3.3: Completeness / Gap Report
function _synthesizeCompletenessAnswer(entityData, isSelf) {
  if (!entityData) return { answer: 'Entity not found.', entities: [], paths: [], gaps: [], conflicts: [], confidence: 0 };

  const name = _getEntityName(entityData);
  const entityId = _getEntityId(entityData);
  const entityType = _getEntityType(entityData);
  const attrs = _getAttributes(entityData);
  const rels = entityData.relationships || [];
  const observations = entityData.observations || [];

  const gaps = [];

  // Check standard person fields
  const personFields = ['location', 'role', 'employer', 'education', 'age', 'email'];
  if (entityType === 'person') {
    for (const field of personFields) {
      if (!attrs[field]) gaps.push({ field, status: 'missing', suggestion: `Find ${name}'s ${field}` });
    }
  }

  // Check relationship coverage
  const relTypes = rels.map(r => (r.relationship_type || r.relationship || '').toLowerCase());
  const hasFamily = relTypes.some(r => /spouse|parent|child|daughter|son|sibling|sister|brother|married/.test(r));
  const hasProfessional = relTypes.some(r => /work|employ|colleague|report|manage|found/.test(r));
  const hasSocial = relTypes.some(r => /friend|attend|member/.test(r));
  if (!hasFamily) gaps.push({ field: 'family_relationships', status: 'missing', suggestion: 'Add family connections' });
  if (!hasProfessional) gaps.push({ field: 'professional_relationships', status: 'missing', suggestion: 'Add work connections' });
  if (!hasSocial) gaps.push({ field: 'social_relationships', status: 'missing', suggestion: 'Add social connections' });

  // Check confidence
  const attrList = entityData.attributes || [];
  const lowConf = attrList.filter(a => (a.confidence || 0) < 0.5);
  for (const a of lowConf) {
    gaps.push({ field: a.key, status: 'low_confidence', confidence: a.confidence, suggestion: `Verify ${a.key} from another source` });
  }

  // Check source diversity
  const sources = new Set();
  for (const obs of observations) {
    if (obs.source) sources.add(obs.source);
    if (obs.source_attribution && obs.source_attribution.source_type) sources.add(obs.source_attribution.source_type);
  }

  // Coverage score
  const totalChecks = personFields.length + 3 + attrList.length; // fields + rel categories + attrs
  const gapCount = gaps.length;
  const coverage = totalChecks > 0 ? Math.round(((totalChecks - gapCount) / totalChecks) * 100) : 0;

  const subj = isSelf ? 'Your profile' : name;
  let answer = `${subj} has ${coverage}% coverage.`;
  const missingFields = gaps.filter(g => g.status === 'missing').map(g => g.field);
  if (missingFields.length > 0) answer += ` Missing: ${missingFields.join(', ')}.`;
  const lowConfFields = gaps.filter(g => g.status === 'low_confidence').map(g => g.field);
  if (lowConfFields.length > 0) answer += ` Low confidence on: ${lowConfFields.join(', ')}.`;
  if (sources.size > 0) answer += ` Sources: ${sources.size} unique.`;

  return {
    answer,
    entities: [{ id: entityId, name, coverage: coverage / 100 }],
    paths: [],
    gaps,
    conflicts: [],
    confidence: 0.9,
  };
}

// Q3.4: Aggregation
function _synthesizeAggregationAnswer(entities, question, isSelf) {
  if (!entities || entities.length === 0) {
    return { answer: 'No entities found matching your criteria.', entities: [], paths: [], gaps: [], conflicts: [], confidence: 1.0 };
  }

  // Group by type
  const byType = {};
  for (const e of entities) {
    const t = e.type || 'unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(e);
  }

  let answer = isSelf ? `You have ${entities.length} entities in your graph.` : `Found ${entities.length} entities.`;

  // Type breakdown
  const typeBreakdown = Object.entries(byType).map(([t, arr]) => `${arr.length} ${t}`).join(', ');
  if (Object.keys(byType).length > 1) {
    answer += ` By type: ${typeBreakdown}.`;
  }

  // List names (up to 10)
  const names = entities.slice(0, 10).map(e => e.name || e.entityId);
  answer += ` Including: ${names.join(', ')}`;
  if (entities.length > 10) answer += ` and ${entities.length - 10} more`;
  answer += '.';

  return {
    answer,
    entities: entities.map(e => ({ id: e.entityId || e.id, name: e.name, type: e.type })),
    paths: [],
    gaps: [],
    conflicts: [],
    confidence: 1.0,
  };
}

// Q3.5: Contradiction
function _synthesizeContradictionAnswer(entityData, isSelf) {
  if (!entityData) return { answer: 'Entity not found.', entities: [], paths: [], gaps: [], conflicts: [], confidence: 0 };

  const name = _getEntityName(entityData);
  const entityId = _getEntityId(entityData);
  const attrs = entityData.attributes || [];
  const existingConflicts = entityData.conflicts || [];

  const conflicts = [];

  // Check for duplicate attribute keys with different values
  const byKey = {};
  for (const a of attrs) {
    if (!a.key) continue;
    if (!byKey[a.key]) byKey[a.key] = [];
    byKey[a.key].push(a);
  }
  for (const [key, values] of Object.entries(byKey)) {
    if (values.length > 1) {
      const uniqueVals = [...new Set(values.map(v => String(v.value).toLowerCase()))];
      if (uniqueVals.length > 1) {
        conflicts.push({
          field: key,
          values: values.map(v => ({ value: v.value, confidence: v.confidence, source: v.source_attribution })),
          type: 'FACTUAL',
        });
      }
    }
  }

  // Include existing entity conflicts
  for (const c of existingConflicts) {
    conflicts.push(c);
  }

  let answer;
  if (conflicts.length === 0) {
    answer = isSelf ? 'No conflicts found in your data. All data is consistent.' : `No conflicts found for ${name}. All data is consistent.`;
  } else {
    const forWhom = isSelf ? 'in your data' : `for ${name}`;
    answer = `Found ${conflicts.length} conflict${conflicts.length !== 1 ? 's' : ''} ${forWhom}: `;
    const parts = conflicts.map((c, i) => {
      if (c.field && c.values) {
        return `(${i + 1}) ${c.field} has conflicting values: ${c.values.map(v => v.value).join(' vs ')}`;
      }
      return `(${i + 1}) ${c.type || 'conflict'}: ${c.attribute_key || c.field || 'unknown'}`;
    });
    answer += parts.join('. ') + '.';
  }

  return {
    answer,
    entities: [{ id: entityId, name }],
    paths: [],
    gaps: [],
    conflicts,
    confidence: conflicts.length > 0 ? 0.85 : 1.0,
  };
}

// Main synthesizeAnswer dispatcher
function synthesizeAnswer(queryType, data) {
  switch (queryType) {
    case 'ENTITY_LOOKUP':
      return _synthesizeEntityAnswer(data.entity, data.isSelf);
    case 'RELATIONSHIP':
      return _synthesizePathAnswer(data.paths, data.sourceName, data.targetName, data.sourceIsSelf, data.targetIsSelf);
    case 'AGGREGATION':
      return _synthesizeAggregationAnswer(data.entities, data.question, data.isSelf);
    case 'COMPLETENESS':
      return _synthesizeCompletenessAnswer(data.entity, data.isSelf);
    case 'CONTRADICTION':
      return _synthesizeContradictionAnswer(data.entity, data.isSelf);
    default:
      return { answer: "I'm not sure how to answer that question. Try asking about a specific person, organization, or relationship.", entities: [], paths: [], gaps: [], conflicts: [], confidence: 0 };
  }
}

// ---------------------------------------------------------------------------
// Entity Resolution — Step 8
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'must',
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it',
  'they', 'them', 'his', 'her', 'its', 'their', 'who', 'what', 'which',
  'that', 'this', 'these', 'those', 'am', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'about', 'between', 'through',
  'and', 'or', 'but', 'not', 'no', 'all', 'any', 'each', 'every',
  'how', 'many', 'much', 'tell', 'show', 'find', 'list', 'count',
  'describe', 'summarize', 'profile', 'connect', 'relate', 'link',
  'path', 'know', 'missing', 'gaps', 'conflicts', 'data',
  'graph', 'entities', 'people', 'organizations', 'there',
]);

const SELF_PRONOUNS = /\b(my|i|me|mine|myself|our|i'm|i've|i'd)\b/gi;

/**
 * Extract entity names from a question and resolve to entity IDs.
 * Substitutes self-pronouns ("my", "I", "me") with the self-entity name.
 * @param {string} question
 * @param {string} graphDir
 * @returns {Array<{entityId, name, score, isSelf?: boolean}>}
 */
function resolveEntities(question, graphDir, opts) {
  let q = question.replace(/[?!.,;:'"]/g, ' ').trim();

  // Substitute self-pronouns with self-entity name
  const selfEntity = getSelfEntity(graphDir);
  let hasSelfPronoun = false;
  if (selfEntity && SELF_PRONOUNS.test(q)) {
    hasSelfPronoun = true;
    // Replace pronouns with self name for entity matching
    q = q.replace(SELF_PRONOUNS, selfEntity.name);
  }

  const words = q.split(/\s+/).filter(w => w.length > 0);

  // Build candidate phrases: try multi-word combos (longest first)
  const candidates = [];

  // Try 3-word, 2-word, then 1-word phrases
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    for (let i = 0; i <= words.length - len; i++) {
      const phrase = words.slice(i, i + len).join(' ');
      const phraseLower = phrase.toLowerCase();
      // Skip if all words are stop words
      const phraseWords = phraseLower.split(/\s+/);
      if (phraseWords.every(w => STOP_WORDS.has(w))) continue;
      candidates.push({ phrase, start: i, end: i + len });
    }
  }

  // Search each candidate against the graph
  const resolved = [];
  const usedRanges = []; // Track which word positions are already matched

  for (const cand of candidates) {
    // Skip if overlaps with already-matched range
    if (usedRanges.some(r => cand.start < r.end && cand.end > r.start)) continue;

    const results = searchEntities(cand.phrase, graphDir, { limit: 1, minConfidence: 0.6, spokeId: opts?.spokeId });
    if (results.length > 0) {
      const match = results[0];
      // Avoid duplicate entity IDs
      if (!resolved.some(r => r.entityId === match.entityId)) {
        const isSelf = selfEntity && match.entityId === selfEntity.entityId;
        resolved.push({ entityId: match.entityId, name: match.name, score: match.score, isSelf });
        usedRanges.push({ start: cand.start, end: cand.end });
      }
    }
  }

  // If self-pronoun was in the question and self-entity wasn't already resolved, inject it
  if (hasSelfPronoun && selfEntity && !resolved.some(r => r.entityId === selfEntity.entityId)) {
    resolved.unshift({ entityId: selfEntity.entityId, name: selfEntity.name, score: 1.0, isSelf: true });
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Main entry point — Step 9
// ---------------------------------------------------------------------------

async function query(question, graphDir, opts) {
  const startTime = Date.now();
  const spokeId = opts?.spokeId;

  // Q1: Classify
  const classStart = Date.now();
  const queryType = classifyQuery(question);
  const classificationMs = Date.now() - classStart;

  // Q2: Resolve entities + graph operations
  const graphStart = Date.now();
  const resolved = resolveEntities(question, graphDir, { spokeId });

  let synthesisData = {};
  let result;

  // Determine if the primary resolved entity is the self-entity
  const primaryIsSelf = resolved.length > 0 && resolved[0].isSelf;

  switch (queryType) {
    case 'ENTITY_LOOKUP': {
      if (resolved.length > 0) {
        const entityData = readEntity(resolved[0].entityId, graphDir);
        synthesisData = { entity: entityData, isSelf: primaryIsSelf };
      } else {
        synthesisData = { entity: null };
      }
      break;
    }
    case 'RELATIONSHIP': {
      if (resolved.length >= 2) {
        const index = buildRelationshipIndex(graphDir, { spokeId });
        const paths = findPaths(resolved[0].entityId, resolved[1].entityId, index, 4);
        synthesisData = {
          paths,
          sourceName: resolved[0].name,
          targetName: resolved[1].name,
          sourceIsSelf: resolved[0].isSelf,
          targetIsSelf: resolved[1].isSelf,
        };
      } else if (resolved.length === 1) {
        const index = buildRelationshipIndex(graphDir, { spokeId });
        const hood = getNeighborhood(resolved[0].entityId, index, 2);
        const neighbors = hood.rings.flatMap(r => r.entities);
        synthesisData = { paths: [], sourceName: resolved[0].name, targetName: 'unknown', sourceIsSelf: resolved[0].isSelf };
      } else {
        synthesisData = { paths: [], sourceName: 'unknown', targetName: 'unknown' };
      }
      break;
    }
    case 'AGGREGATION': {
      const q = question.toLowerCase();
      let typeFilter = null;
      if (/people|person|friend/.test(q)) typeFilter = 'person';
      else if (/organization|org|company|companies/.test(q)) typeFilter = 'organization';
      else if (/business/.test(q)) typeFilter = 'business';
      else if (/institution/.test(q)) typeFilter = 'institution';

      const filters = typeFilter ? { type: typeFilter } : {};
      const entities = filterEntities(filters, graphDir, { spokeId });
      synthesisData = { entities, question, isSelf: SELF_PRONOUNS.test(question) };
      break;
    }
    case 'COMPLETENESS': {
      if (resolved.length > 0) {
        const entityData = readEntity(resolved[0].entityId, graphDir);
        synthesisData = { entity: entityData, isSelf: primaryIsSelf };
      } else {
        synthesisData = { entity: null };
      }
      break;
    }
    case 'CONTRADICTION': {
      if (resolved.length > 0) {
        const entityData = readEntity(resolved[0].entityId, graphDir);
        synthesisData = { entity: entityData, isSelf: primaryIsSelf };
      } else {
        synthesisData = { entity: null };
      }
      break;
    }
    default: {
      synthesisData = {};
      break;
    }
  }

  const graphQueryMs = Date.now() - graphStart;

  // Q3: Synthesize answer
  const synthStart = Date.now();
  result = synthesizeAnswer(queryType, synthesisData);
  const synthesisMs = Date.now() - synthStart;

  // Add spoke context to answer if scoped
  let answer = result.answer;
  if (spokeId && opts?.spokeName && answer) {
    const spokePrefix = opts.centeredEntityName
      ? `[Context: ${opts.spokeName}, centered on ${opts.centeredEntityName}] `
      : `[Context: ${opts.spokeName}] `;
    answer = spokePrefix + answer;
  }

  return {
    answer,
    query: {
      original: question,
      type: queryType,
      classified_by: 'keyword',
      entities_resolved: resolved.map(r => r.entityId),
      spoke_id: spokeId || null,
    },
    entities: result.entities,
    paths: result.paths,
    gaps: result.gaps || [],
    conflicts: result.conflicts || [],
    confidence: result.confidence,
    timing: {
      classification_ms: classificationMs,
      graph_query_ms: graphQueryMs,
      synthesis_ms: synthesisMs,
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
  getSelfEntity,
  clearSelfEntityCache,
};
