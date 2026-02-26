# MECE-011: Query Engine Specification

## Version: 1.0 | Date: 2026-02-22 | Author: CJ Mitchell + Claudine

---

## PURPOSE

Build a query layer that turns natural language questions into graph traversals and returns structured, relationship-aware answers. This is the intelligence layer that makes Context Engine BETTER than RAG.

RAG retrieves text chunks. The Query Engine traverses relationships.

```
query("How does Steve connect to Amazon?") 
→ Steve Hughes → friend_of → CJ Mitchell → works_at → Amazon
→ "Steve Hughes is connected to Amazon through CJ Mitchell, who works there as a Principal Product Manager."
```

**Single endpoint:**
```
GET /api/query?q={natural_language_question}
→ { answer: string, entities: [], paths: [], confidence: number }
```

---

## DESIGN PRINCIPLES

1. **Better than RAG**: Answers questions RAG literally cannot — multi-hop traversal, completeness checks, contradiction detection
2. **Easier than SPARQL**: User asks in plain English, engine figures out the graph query
3. **Faster than manual**: Traverses entire graph in milliseconds, AI synthesizes in seconds

---

## ARCHITECTURE: FOUR SUB-PROBLEMS (MECE)

```
MECE-011: Query Engine
├── Q1: Query Classification (What kind of question is this?)
│   ├── Q1.1: Entity Lookup ("Tell me about Steve")
│   ├── Q1.2: Relationship Traversal ("How does X connect to Y?")
│   ├── Q1.3: Aggregation ("How many people work at Amazon?")
│   ├── Q1.4: Completeness Check ("What am I missing about Steve?")
│   └── Q1.5: Contradiction Check ("Are there conflicts in Steve's data?")
├── Q2: Graph Operations (How do we search the graph?)
│   ├── Q2.1: Entity Search (fuzzy name match + type filter)
│   ├── Q2.2: Path Finding (shortest path between two entities)
│   ├── Q2.3: Neighborhood Query (all entities within N hops)
│   └── Q2.4: Attribute Filter (find entities matching criteria)
├── Q3: Answer Synthesis (How do we compose the response?)
│   ├── Q3.1: Direct Answer (structured data → natural language)
│   ├── Q3.2: Path Narrative (traversal → story)
│   └── Q3.3: Gap Report (missing data → actionable suggestions)
└── Q4: Response Format (What does the API return?)
    ├── Q4.1: Answer text (natural language)
    ├── Q4.2: Entity references (IDs + names of involved entities)
    ├── Q4.3: Evidence trail (which files/observations support this)
    └── Q4.4: Confidence score (how reliable is this answer)
```

---

## Q1: QUERY CLASSIFICATION

### The Five Query Types

Every natural language question maps to exactly one type:

| Type | Pattern | Example Questions | Graph Operation |
|------|---------|-------------------|----------------|
| **ENTITY_LOOKUP** | "Tell me about X", "Who is X", "What is X" | "Who is Steve Hughes?", "What is Context Architecture?" | Load entity, return profile |
| **RELATIONSHIP** | "How does X relate to Y", "What connects X and Y" | "How does Steve connect to Amazon?", "What's the link between Howard and CJ?" | Path finding between two entities |
| **AGGREGATION** | "How many", "List all", "Who are", "What are" | "How many people are in my inner circle?", "List all organizations" | Filter + count/collect |
| **COMPLETENESS** | "What's missing", "What don't I know", "What gaps" | "What am I missing about Steve?", "Which entities need enrichment?" | Coverage analysis |
| **CONTRADICTION** | "Any conflicts", "What disagrees", "Inconsistencies" | "Are there conflicting facts about Steve?", "What data disagrees?" | Attribute comparison across sources |

### Classification Method

Use keyword matching FIRST (fast, no AI call). Fall back to AI classification only if ambiguous.

```javascript
function classifyQuery(question) {
  const q = question.toLowerCase().trim();
  
  // ENTITY_LOOKUP patterns
  if (/^(who|what) (is|are|was) /.test(q)) return 'ENTITY_LOOKUP';
  if (/^tell me about /.test(q)) return 'ENTITY_LOOKUP';
  if (/^(describe|summarize|profile) /.test(q)) return 'ENTITY_LOOKUP';
  
  // RELATIONSHIP patterns
  if (/connect|relate|link|between|path|relationship/.test(q)) return 'RELATIONSHIP';
  if (/how (does|do|is|are) .+ (connect|relate|know|link)/.test(q)) return 'RELATIONSHIP';
  
  // AGGREGATION patterns
  if (/^(how many|list|count|show all|find all|who are all)/.test(q)) return 'AGGREGATION';
  if (/^(what are the|which) .+ (in|at|from|of)/.test(q)) return 'AGGREGATION';
  
  // COMPLETENESS patterns
  if (/miss(ing)?|gap|incomplete|don.t (know|have)|need.* more|enrich/.test(q)) return 'COMPLETENESS';
  if (/coverage|empty|thin|sparse/.test(q)) return 'COMPLETENESS';
  
  // CONTRADICTION patterns
  if (/conflict|contradict|disagree|inconsisten|mismatch|wrong/.test(q)) return 'CONTRADICTION';
  if (/two (different|versions)|which is (right|correct)/.test(q)) return 'CONTRADICTION';
  
  // Default: treat as ENTITY_LOOKUP if a known entity name is found
  // Otherwise: use AI classification
  return 'UNKNOWN';
}
```

### AI Fallback Classification

If keyword matching returns UNKNOWN, send a lightweight Claude call:

```
Classify this question into exactly one category:
- ENTITY_LOOKUP: asking about a specific person, org, or concept
- RELATIONSHIP: asking how two things connect
- AGGREGATION: asking for a count or list
- COMPLETENESS: asking what's missing or incomplete
- CONTRADICTION: asking about conflicts or inconsistencies

Question: "{question}"
Respond with ONLY the category name, nothing else.
```

---

## Q2: GRAPH OPERATIONS

### Q2.1: Entity Search

Find entities by name, type, or attributes.

```javascript
/**
 * Search entities in the graph directory
 * @param {string} query - search term
 * @param {object} options - { type, limit, minConfidence }
 * @returns {Array} matching entities sorted by relevance
 */
function searchEntities(query, options = {}) {
  // 1. Load all entity files from graph/ directory
  // 2. Fuzzy match on name (Dice coefficient, threshold 0.6)
  // 3. Also match on aliases, preferred_name, attributes
  // 4. Filter by type if specified (PERSON, ORG, CONCEPT)
  // 5. Filter by minConfidence if specified
  // 6. Sort by match score descending
  // 7. Return top N (default 10)
}
```

**Fuzzy matching rules:**
- Exact match → score 1.0
- Case-insensitive exact → score 0.95
- Dice coefficient > 0.8 → score = dice_score
- Partial name match (first OR last name) → score 0.7
- Alias match → score 0.85
- Attribute value match → score 0.5

### Q2.2: Path Finding

Find how two entities connect through the relationship graph.

```javascript
/**
 * Find shortest path(s) between two entities
 * @param {string} sourceId - starting entity ID
 * @param {string} targetId - ending entity ID  
 * @param {number} maxDepth - maximum hops (default 4)
 * @returns {Array} array of paths, each path is array of { entity, relationship }
 */
function findPaths(sourceId, targetId, maxDepth = 4) {
  // BFS (Breadth-First Search) implementation:
  // 1. Load relationship index (all relationships across all entities)
  // 2. Build adjacency list: entityId → [{ targetId, relationship, confidence }]
  // 3. BFS from source, tracking visited nodes and paths
  // 4. Stop when target found OR maxDepth reached
  // 5. Return all paths found (may be multiple)
  // 6. Sort by: shortest first, then highest minimum confidence
}
```

**Building the relationship index:**

Relationships live in two places in the current graph:
1. Entity files: each entity JSON may have a `relationships` array
2. Universal parser output: relationships extracted between entities

The query engine needs to build an in-memory adjacency list on startup:

```javascript
function buildRelationshipIndex(graphDir) {
  const index = {}; // entityId → [{ targetId, targetName, relationship, confidence, source }]
  
  // Walk all entity files in graphDir
  // For each entity, read its relationships array
  // For each relationship, add edges in BOTH directions
  // (A works_at B) creates: A→B (works_at) AND B→A (employs)
  
  // Also read any standalone relationship files if they exist
  
  return index;
}
```

**Reverse relationship labels:**

| Forward | Reverse |
|---------|---------|
| works_at | employs |
| friend_of | friend_of |
| parent_of | child_of |
| married_to | married_to |
| created | created_by |
| belongs_to | has_member |
| reports_to | manages |
| founded | founded_by |
| attended | has_alumni |
| leads | led_by |
| Default: X | X (same label, reversed direction) |

### Q2.3: Neighborhood Query

Get all entities within N hops of a starting entity.

```javascript
/**
 * Get all entities within N hops
 * @param {string} entityId - center entity
 * @param {number} depth - how many hops (default 2)
 * @returns {object} { center, rings: [{ depth: 1, entities: [...] }, ...] }
 */
function getNeighborhood(entityId, depth = 2) {
  // BFS from entity, collecting entities at each depth level
  // Return as concentric rings: depth 1 = direct connections, depth 2 = connections of connections
}
```

### Q2.4: Attribute Filter

Find entities matching specific criteria.

```javascript
/**
 * Find entities where attributes match criteria
 * @param {object} filters - { type: "PERSON", "attributes.location": "Atlanta" }
 * @returns {Array} matching entities
 */
function filterEntities(filters) {
  // Load all entities
  // Apply each filter as a predicate
  // Support dot notation for nested attributes
  // Support operators: equals, contains, exists, gt, lt
}
```

---

## Q3: ANSWER SYNTHESIS

### Q3.1: Direct Answer (Entity Lookup)

For ENTITY_LOOKUP queries, compose a natural language profile:

```javascript
function synthesizeEntityAnswer(entity) {
  // Build a readable summary from entity data:
  // "{name} is a {type}. {summary or description}."
  // + key attributes formatted as prose
  // + relationship count: "Connected to {N} other entities."
  // + confidence note if low: "Note: some data has low confidence."
  
  return {
    answer: "Steve Hughes is a 40-year-old resident of Atlanta, GA. He works at Meta and is part of CJ's inner circle. Connected to 12 other entities including CJ Mitchell (friend_of), Tihitina (married_to), and Howard University (attended).",
    entities: [{ id: "ENT-SH-052", name: "Steve Hughes", role: "primary" }],
    paths: [],
    confidence: entity.confidence || 0.8
  };
}
```

### Q3.2: Path Narrative (Relationship Traversal)

For RELATIONSHIP queries, narrate the connection path:

```javascript
function synthesizePathAnswer(paths, sourceName, targetName) {
  if (paths.length === 0) {
    return {
      answer: `No connection found between ${sourceName} and ${targetName} within 4 hops.`,
      entities: [],
      paths: [],
      confidence: 0
    };
  }
  
  // Take shortest path
  // Narrate: "A → [relationship] → B → [relationship] → C"
  // Example: "Steve Hughes is connected to Amazon through CJ Mitchell. 
  //           Steve is a friend of CJ, who works at Amazon as a Principal Product Manager."
  
  // If multiple paths exist, mention: "There are {N} connection paths. The shortest is..."
}
```

### Q3.3: Gap Report (Completeness Check)

For COMPLETENESS queries, analyze what's missing:

```javascript
function synthesizeCompletenessAnswer(entity) {
  const gaps = [];
  
  // Check standard fields for PERSON:
  const personFields = ['location', 'role', 'employer', 'education', 'age', 'email'];
  // Check which are missing or empty
  
  // Check relationship coverage:
  // - Has family relationships?
  // - Has professional relationships?
  // - Has social relationships?
  
  // Check confidence:
  // - Any attributes below 0.5?
  // - Overall entity confidence?
  
  // Check source diversity:
  // - How many unique sources?
  // - Any single-source-only attributes?
  
  return {
    answer: "Steve Hughes has good coverage (78%). Missing: email, education history, career timeline. Low confidence on: conscientiousness score (conflicting sources). Suggested actions: Find LinkedIn profile, ask about education background.",
    entities: [{ id: entity.id, name: entity.name, coverage: 0.78 }],
    gaps: gaps,
    confidence: 0.9 // high confidence in the gap analysis itself
  };
}
```

### Q3.4: Aggregation Answer

For AGGREGATION queries, compute and format:

```javascript
function synthesizeAggregationAnswer(entities, query) {
  // Count: "There are 12 people in your inner circle."
  // List: "Organizations: Amazon, Howard University, Meta, BDAT Group..."
  // Group: "By type: 45 people, 26 organizations, 15 concepts."
  
  return {
    answer: "You have 69 people in your graph. By tier: 4 Inner Circle, 8 Close Friends, 15 Friends, 22 Colleagues, 20 Acquaintances.",
    entities: entities.map(e => ({ id: e.id, name: e.name })),
    count: entities.length,
    confidence: 1.0 // counts are deterministic
  };
}
```

### Q3.5: Contradiction Answer

For CONTRADICTION queries, find conflicts:

```javascript
function synthesizeContradictionAnswer(entity) {
  const conflicts = [];
  
  // Compare attributes across observations/sources:
  // - Same attribute, different values?
  // - Same relationship, different details?
  // - Temporal conflicts? (e.g., "works at Meta" AND "works at Google" both marked current)
  
  // Check observation history for the entity:
  // - Any observations that contradict each other?
  // - Any confidence scores that are suspicious (high confidence on conflicting facts)?
  
  return {
    answer: "Found 2 conflicts for Steve Hughes: (1) MBTI listed as both ENFJ and ENxP-T across different sources. (2) Conscientiousness score: 68th percentile vs 45th percentile. The newer assessment (Feb 2026) has higher source confidence.",
    conflicts: conflicts,
    entities: [{ id: entity.id, name: entity.name }],
    confidence: 0.85
  };
}
```

---

## Q4: RESPONSE FORMAT

### API Endpoint

```
GET /api/query?q={url_encoded_question}
Headers: X-Context-API-Key: ctx-xxxxx
```

### Response Schema

```javascript
{
  // The natural language answer
  answer: "Steve Hughes is connected to Amazon through CJ Mitchell...",
  
  // Query metadata
  query: {
    original: "How does Steve connect to Amazon?",
    type: "RELATIONSHIP",           // ENTITY_LOOKUP | RELATIONSHIP | AGGREGATION | COMPLETENESS | CONTRADICTION
    classified_by: "keyword",       // "keyword" or "ai"
    entities_resolved: ["ENT-SH-052", "ENT-AMZ-001"]  // entities mentioned in the query
  },
  
  // Entities involved in the answer
  entities: [
    { id: "ENT-SH-052", name: "Steve Hughes", type: "PERSON", role: "source" },
    { id: "ENT-CM-001", name: "CJ Mitchell", type: "PERSON", role: "intermediary" },
    { id: "ENT-AMZ-001", name: "Amazon", type: "ORG", role: "target" }
  ],
  
  // Relationship paths (for RELATIONSHIP queries)
  paths: [
    {
      hops: 2,
      path: [
        { entity: "Steve Hughes", relationship: "friend_of", direction: "→" },
        { entity: "CJ Mitchell", relationship: "works_at", direction: "→" },
        { entity: "Amazon" }
      ],
      min_confidence: 0.75
    }
  ],
  
  // Gaps found (for COMPLETENESS queries)
  gaps: [],
  
  // Conflicts found (for CONTRADICTION queries)
  conflicts: [],
  
  // Overall confidence in the answer
  confidence: 0.8,
  
  // Performance
  timing: {
    classification_ms: 2,
    graph_query_ms: 45,
    synthesis_ms: 1200,
    total_ms: 1247
  }
}
```

### Error Responses

```javascript
// No entities found matching query
{ answer: "I couldn't find any entities matching 'XYZ' in the graph.", confidence: 0, entities: [] }

// Query too vague
{ answer: "Could you be more specific? I have multiple entities that could match. Did you mean: Steve Hughes, Steve Martin, or Steven Spielberg?", entities: [...candidates] }

// Graph empty
{ answer: "The knowledge graph is empty. Upload some files to get started.", confidence: 0 }
```

---

## IMPLEMENTATION PLAN

### File: `query-engine.js`

```
Module Exports:
  query(question, graphDir) → { answer, query, entities, paths, gaps, conflicts, confidence, timing }
  
Internal Functions:
  classifyQuery(question) → string
  resolveEntities(question, graphDir) → entityIds[]
  buildRelationshipIndex(graphDir) → adjacencyList
  searchEntities(query, graphDir, options) → entities[]
  findPaths(sourceId, targetId, index, maxDepth) → paths[]
  getNeighborhood(entityId, index, depth) → { center, rings }
  filterEntities(filters, graphDir) → entities[]
  synthesizeAnswer(queryType, data) → responseObject
```

### Dependencies

```json
{
  "@anthropic-ai/sdk": "latest"  // Only needed for AI fallback classification + answer polish
}
```

Most operations are pure graph traversal — NO AI call needed for the graph operations themselves. AI is only used for:
1. Fallback query classification (when keywords don't match)
2. Answer polish (optional — can synthesize answers with templates first)

### Build Order

| Step | What | Test | Est. Time |
|------|------|------|-----------|
| 1 | Scaffold `query-engine.js` with exports and `classifyQuery()` | Correctly classifies 20+ sample questions across all 5 types | 25 min |
| 2 | `buildRelationshipIndex()` — reads graph/ dir, builds adjacency list | Index contains all entities and bidirectional edges | 30 min |
| 3 | `searchEntities()` — fuzzy search with Dice coefficient | Finds "Steve" when searching "steven", handles partial matches | 25 min |
| 4 | `findPaths()` — BFS path finding between two entities | Finds Steve→CJ→Amazon in 2 hops | 30 min |
| 5 | `getNeighborhood()` — BFS neighborhood rings | Returns correct entities at depth 1 and depth 2 | 20 min |
| 6 | `filterEntities()` — attribute filtering with dot notation | Finds all PERSON entities in Atlanta | 15 min |
| 7 | `synthesizeAnswer()` — template-based answer generation for all 5 types | Returns readable natural language for each query type | 30 min |
| 8 | `resolveEntities()` — extract entity names from question and match to graph | "How does Steve connect to Amazon?" → [ENT-SH-052, ENT-AMZ-001] | 20 min |
| 9 | Integration: wire `query()` main function, full pipeline test | 10 sample queries return correct answers | 20 min |
| 10 | Wire into web-demo.js: `GET /api/query?q=` endpoint | curl test returns structured response | 15 min |
| 11 | Wire into web UI: search bar in sidebar calls query endpoint, displays answer | Type question → see answer in UI | 20 min |

**Total estimated: ~4 hours**

### Test Questions (Use Against CJ's Graph)

| Question | Type | Expected Answer Contains |
|----------|------|------------------------|
| "Who is Steve Hughes?" | ENTITY_LOOKUP | Steve's name, age, location, relationships |
| "Tell me about Amazon" | ENTITY_LOOKUP | Amazon as org, CJ works there |
| "How does Steve connect to Amazon?" | RELATIONSHIP | Steve → CJ → Amazon path |
| "How does Howard University relate to BDAT?" | RELATIONSHIP | Path through CJ and/or other Howard alums |
| "How many people are in my graph?" | AGGREGATION | Count of PERSON entities |
| "List all organizations" | AGGREGATION | All ORG type entities |
| "What am I missing about Steve?" | COMPLETENESS | Gap list for Steve's profile |
| "Which entities need enrichment?" | COMPLETENESS | Low-coverage entities listed |
| "Any conflicts in Steve's data?" | CONTRADICTION | MBTI conflict if present |
| "Who are my inner circle?" | AGGREGATION | Tier-based filter results |

---

## PERFORMANCE REQUIREMENTS

| Operation | Target | Method |
|-----------|--------|--------|
| Query classification | < 5ms | Keyword regex (no AI) |
| Relationship index build | < 500ms | Cache after first build, rebuild on graph change |
| Entity search | < 50ms | In-memory fuzzy match |
| Path finding (2 hops) | < 100ms | BFS on adjacency list |
| Path finding (4 hops) | < 500ms | BFS with visited set |
| Answer synthesis (template) | < 10ms | String interpolation |
| Answer synthesis (AI polish) | < 3s | Optional Claude call |
| **Total (no AI)** | **< 600ms** | Graph operations only |
| **Total (with AI polish)** | **< 4s** | Graph + optional synthesis |

### Caching Strategy

- Relationship index: build once, cache in memory, invalidate on graph write
- Recent queries: LRU cache (50 entries), keyed by normalized question
- Entity list: cache in memory, invalidate on entity create/delete

---

## INTEGRATION POINTS

### With Existing API

New endpoint added alongside existing ones:

```
Existing:
  GET  /api/search?q=         → fuzzy entity search (keep as-is)
  GET  /api/entity/:id        → single entity profile
  GET  /api/entity/:id/context → weighted observations

New:
  GET  /api/query?q=          → natural language graph query (THIS SPEC)
```

### With DXT

The DXT `query` tool calls this endpoint:

```javascript
// DXT tool definition
{
  name: "query",
  description: "Ask a question about entities and relationships in the knowledge graph",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "Natural language question" }
    },
    required: ["question"]
  }
}

// DXT tool handler
async function handleQuery({ question }) {
  const response = await fetch(`${RENDER_URL}/api/query?q=${encodeURIComponent(question)}`, {
    headers: { 'X-Context-API-Key': tenantKey }
  });
  return await response.json();
}
```

### With Web UI

The sidebar search bar becomes a query interface:
- User types question in search bar
- On enter, calls `GET /api/query?q=...`
- Results display in the middle panel:
  - Answer text at top
  - Entity cards below (clickable to navigate to entity profiles)
  - Path visualization for RELATIONSHIP queries
  - Gap cards for COMPLETENESS queries

---

## WHAT RAG CANNOT DO (Why This Matters)

| Query | RAG Answer | Query Engine Answer |
|-------|-----------|-------------------|
| "How does Steve connect to Amazon?" | Returns chunks mentioning Steve OR Amazon. No traversal. | Steve → friend_of → CJ → works_at → Amazon. 2 hops, narrated. |
| "What am I missing about Steve?" | Returns whatever chunks exist. Can't know what's absent. | "Missing: email, education, career timeline. 78% coverage." |
| "Any conflicts in Steve's data?" | Returns all chunks. User must spot conflicts manually. | "MBTI conflict: ENFJ vs ENxP-T. Newer source has higher confidence." |
| "Who in my network went to Howard?" | Returns chunks mentioning Howard. May miss entities only linked by relationship. | Traverses attended→Howard for all entities. Complete list. |
| "How many connections does Steve have?" | Can't count. Returns text. | "Steve has 12 direct connections: 3 family, 4 friends, 5 professional." |

---

## SUCCESS CRITERIA

The query engine is DONE when:

1. ✅ Classifies questions into 5 types via keyword matching (< 5ms)
2. ✅ Builds relationship index from graph directory with bidirectional edges
3. ✅ Fuzzy entity search with Dice coefficient (finds "Steve" from "steven")
4. ✅ BFS path finding between any two entities (up to 4 hops)
5. ✅ Neighborhood query returns entities at each depth ring
6. ✅ Attribute filtering with type and dot-notation support
7. ✅ Synthesizes natural language answers for all 5 query types
8. ✅ API endpoint: GET /api/query?q= returns structured JSON response
9. ✅ Performance: graph operations < 600ms, full query < 4s
10. ✅ Works against CJ's existing 96-entity graph
11. ✅ Handles empty graph, no matches, and ambiguous queries gracefully

---

## WHAT THIS SPEC DOES NOT COVER (Parked for Later)

- AI-powered answer polish (use templates first, add AI refinement in v2)
- Embedding-based semantic search (pure keyword/fuzzy for MVP)
- Graph visualization / path rendering in UI (query returns data, UI renders later)
- Multi-tenant query isolation (reuse existing auth middleware)
- Query history / analytics (MEASURE lever — future)
- Streaming responses for long answers
