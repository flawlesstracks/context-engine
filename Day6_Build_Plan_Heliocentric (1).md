# Day 6 Build Plan — Heliocentric Hub-Spoke Architecture

**Date:** February 23, 2026
**Objective:** Ship Builds 1-4. End the day with a working spoke system where ANY entity can be the center.
**Design Principle:** The system is HELIOCENTRIC, not CJ-centric. Every spoke has a Centered Entity — the "sun" that everything in that spoke orbits around. CJ's personal graph is just one instance of this pattern.

---

## THE HELIOCENTRIC PRINCIPLE

The old model: CJ is the center. Everyone relates to CJ. The graph radiates outward from one fixed point.

The new model: **Every spoke defines its own center.** The center is whatever entity the spoke orbits around.

| Context | Hub Center | Spoke | Spoke Center |
|---------|-----------|-------|--------------|
| Personal | CJ Mitchell | (default spoke) | CJ Mitchell |
| Law Firm | The Firm | Johnson LLC | Johnson LLC (the business entity) |
| Law Firm | The Firm | Smith Estate | Margaret Smith (the client) |
| Enterprise | The Company | Engineering | VP Engineering (or the dept itself) |
| Agency | The Agency | Nike Account | Nike (the brand entity) |

The `self-entity` concept we already built becomes `centered_entity` — and it's per-spoke, not per-tenant. CJ's personal graph works exactly the same way it does now, because CJ is the centered entity of the default spoke. But when a firm creates a "Johnson LLC" spoke, Johnson LLC becomes the sun of that spoke. Every entity extracted into that spoke gets its relationships mapped relative to Johnson LLC, not relative to CJ.

This means:
- Pronoun resolution ("their filing") resolves to the spoke's centered entity
- Relationship labels ("spouse", "accountant") are relative to the centered entity
- Completeness checks measure against the centered entity's requirements
- "Who is missing?" means "who is missing from this spoke's center's orbit?"

One architecture. Infinite centers.

---

## WHAT'S SHIPPED (Days 1-5)

| MECE | What | Status |
|------|------|--------|
| 001-010 | Core engine, parsers, wiki, OAuth, Career Lite, Drive connector, sharing | ✅ |
| 011 | Query Engine (5 query types, BFS traversal, fuzzy search) | ✅ |
| 012 | DXT/MCPB Package (3 tools, manifest, build script) | ✅ |
| 017 | Aggressive tool descriptions for Claude routing | ✅ |

---

## TOMORROW'S BUILDS

### Build 1: Spoke Data Model (MECE-015)

**What:** Add spoke partitioning to the entity model. Every spoke has a name, description, and a `centered_entity` — the entity that serves as the gravitational center of that spoke.

**Spoke data structure:**
```json
{
  "id": "spoke-uuid",
  "name": "Johnson LLC",
  "description": "Tax filing client since 2019",
  "centered_entity_id": null,
  "centered_entity_name": null,
  "created_at": "2026-02-23T...",
  "updated_at": "2026-02-23T...",
  "entity_count": 0,
  "meta_schema_id": null
}
```

**Key design decisions:**
- `centered_entity_id` starts null on spoke creation. Gets set when the first "primary" entity is identified (could be auto-detected from the first uploaded doc or manually set).
- The existing `self-entity` feature migrates to become the centered entity of the "default" spoke. No breaking change — it's the same data, just now scoped to a spoke.
- Entity storage: every entity gets a `spoke_id` field. Default value: `"default"`.

**Endpoints:**
- `POST /api/spoke` — create spoke `{ name, description, centered_entity_id? }`
- `GET /api/spokes` — list all spokes with entity counts and centered entity names
- `GET /api/spoke/:id` — spoke detail with entity summary and centered entity
- `PUT /api/spoke/:id` — update spoke (including setting/changing centered entity)
- `DELETE /api/spoke/:id` — delete spoke (reject if entities exist unless `?force=true`)
- `PUT /api/spoke/:id/center` — set or change the centered entity for this spoke

**Migration:** All existing entities get `spoke_id: "default"`. The existing self-entity becomes the centered entity of the default spoke.

**Test:** Create "Johnson LLC" spoke. List spokes — see "default" (centered: CJ Mitchell, 96 entities) and "Johnson LLC" (centered: none, 0 entities).

---

### Build 2: Spoke-Scoped Ingestion

**What:** File uploads accept a spoke parameter. Extracted entities are tagged with that spoke. If the spoke has no centered entity yet and the extraction identifies a primary entity, auto-suggest it as the center.

**Changes:**
- `POST /api/ingest/universal` and `/api/ingest/files` — add optional `spoke_id` body param
- MCP `build_graph` tool — add optional `spoke` parameter to input schema
- Web UI upload area — spoke selector dropdown above file drop zone
- Auto-center logic: if spoke has no centered_entity_id and the extraction identifies a business entity or primary person, prompt: "Set [Entity Name] as the center of this spoke?"

**Behavior:**
- spoke_id provided → entities tagged with that spoke
- No spoke_id → entities go to "default" (backwards compatible)
- Dropdown populated from `GET /api/spokes`, "Default (Personal)" listed first
- After ingestion, if spoke center was auto-detected, the spoke's centered_entity_id gets updated

**Test:** Select "Johnson LLC" spoke. Upload a document mentioning "Johnson LLC" as a business. System auto-detects and sets Johnson LLC as the centered entity. All extracted people (Robert Johnson, Sarah Johnson, their accountant) have relationships mapped relative to Johnson LLC.

---

### Build 3: Spoke-Scoped Queries

**What:** Query engine respects spoke boundaries. When querying within a spoke, the centered entity is the default reference point — "their" means the spoke's center, not CJ.

**Changes:**
- `GET /api/query?q=...&spoke=SPOKE_ID` — filter to spoke, resolve pronouns to spoke's centered entity
- `GET /api/search?q=...&spoke=SPOKE_ID` — filter search to spoke
- MCP `query` tool — add optional `spoke` parameter
- Query context injection: when a spoke is specified, the query engine knows "the center" is that spoke's centered entity. "What's missing?" means "what's missing relative to the center."

**Pronoun resolution:**
- No spoke specified → resolve to tenant-level self-entity (current behavior, hub-level)
- Spoke specified → resolve to that spoke's centered_entity
- "Who is their accountant?" in Johnson LLC spoke → who is Johnson LLC's accountant?
- "Who is their accountant?" with no spoke → who is CJ's accountant?

**Scope rules:**
- Spoke filter → only entities within that spoke
- No filter → all entities across all spokes (hub-level view)
- Cross-spoke queries (e.g., "Which clients are missing K-1s?") → hub-level only, iterates across spokes

**Test:** Query "What's missing?" in Johnson LLC spoke → completeness relative to Johnson LLC. Same query with no spoke → completeness relative to CJ.

---

### Build 4: Spoke Browser in Web UI

**What:** Left nav gets spoke navigation. Switching spokes changes the entity browser, the upload target, AND the centered entity context.

**UI Elements:**
- Spoke switcher above entity list (tabs or pills)
- "All Spokes" shows everything with hub-level view
- Each spoke tab: name, entity count, centered entity avatar/name
- Active spoke highlighted, determines:
  - Which entities appear in the browser
  - Which spoke files upload into
  - Which centered entity resolves pronouns in the query bar
- "Create New Spoke" button → name, description, optional centered entity
- Spoke settings: rename, set center, delete

**Visual:**
```
┌─────────────────────────────────────────┐
│ SPOKES                              [+] │
│ ┌──────────────┐ ┌───────────────────┐  │
│ │ All (96)     │ │ ☀ Johnson LLC (0) │  │
│ └──────────────┘ └───────────────────┘  │
│ ┌──────────────────────┐                │
│ │ ☀ CJ Mitchell (96)  │  ← "default"   │
│ │   (Personal)         │                │
│ └──────────────────────┘                │
├─────────────────────────────────────────┤
│ CENTERED ENTITY: Johnson LLC            │
│ ☀ All relationships in this view are    │
│   relative to Johnson LLC               │
├─────────────────────────────────────────┤
│ ENTITIES                                │
│ • (empty — upload docs to populate)     │
└─────────────────────────────────────────┘
```

The ☀ symbol is the visual cue for "this is the sun of this spoke."

**Test:** Create Johnson LLC spoke. Switch to it. See "Centered Entity: none — upload docs or set manually." Upload a doc. System auto-detects Johnson LLC entity and sets it as center. Spoke tab updates to show "☀ Johnson LLC (5)". Entity browser shows only Johnson LLC entities with relationships relative to Johnson LLC.

---

## CEECEE PROMPT (copy-paste tomorrow)

```
We're building Heliocentric Hub-Spoke architecture for Context Engine. The core principle: every spoke has a "centered entity" — the sun that everything in that spoke orbits around. CJ's personal graph is just one instance where CJ is the center. A law firm client spoke centers on the client. An enterprise department spoke centers on the department. One architecture, infinite centers.

Read the existing codebase first (NEXT-SESSION.md if it exists, or scan web-demo.js, the graph/ directory, and entity data model). Understand the current self-entity feature — it becomes the centered entity of the "default" spoke.

4 builds in sequence. Complete each fully before starting the next. Each build gets its own commit.

BUILD 1: Spoke Data Model
- Add spokes.json storage (same pattern as tenants.json), stores spoke definitions per tenant
- Spoke schema: { id, name, description, centered_entity_id, centered_entity_name, created_at, updated_at }
- centered_entity_id is the "sun" of this spoke — nullable, set after creation or auto-detected on first ingestion
- Add spoke_id field to every entity on save/load. Default: "default"
- Migrate existing entities: add spoke_id: "default" where missing
- Migrate existing self-entity: becomes the centered_entity of the "default" spoke
- REST endpoints:
  POST /api/spoke — create { name, description, centered_entity_id? }
  GET /api/spokes — list all with entity counts and centered entity names
  GET /api/spoke/:id — detail with entity summary
  PUT /api/spoke/:id — update spoke
  PUT /api/spoke/:id/center — set/change centered entity
  DELETE /api/spoke/:id — reject if entities exist unless ?force=true
- All endpoints use existing tenant auth
- Commit: "feat: heliocentric spoke model with centered entity — MECE-015 Build 1"

BUILD 2: Spoke-Scoped Ingestion
- POST /api/ingest/universal and /api/ingest/files accept optional spoke_id in body
- Extracted entities get tagged with that spoke_id
- No spoke_id → entities go to "default" spoke (backwards compatible)
- MCP build_graph tool: add optional spoke parameter, pass through to API
- Web UI: spoke selector dropdown above upload area, populated from GET /api/spokes
- Auto-center detection: if spoke has no centered_entity_id and extraction finds a primary business entity or person, auto-set it as centered entity (or prompt user to confirm)
- Commit: "feat: spoke-scoped ingestion with auto-center detection — MECE-015 Build 2"

BUILD 3: Spoke-Scoped Queries
- GET /api/query and GET /api/search accept optional spoke query parameter
- When spoke specified: filter to that spoke's entities only
- When not specified: return all (hub-level, current behavior)
- Pronoun resolution: "their" / "the client" / "this entity" resolves to the spoke's centered_entity, NOT to a hardcoded user
- MCP query tool: add optional spoke parameter
- Update query-engine.js: entity loading, path finding, aggregation all respect spoke filter
- Cross-spoke queries only available at hub level (no spoke filter)
- Commit: "feat: spoke-scoped queries with centered entity resolution — MECE-015 Build 3"

BUILD 4: Spoke Browser in Web UI
- Spoke switcher in left sidebar above entity list (tabs or pills)
- "All Spokes" tab shows everything (default, hub-level)
- Each spoke tab: name, entity count, centered entity name
- Switching spokes filters entity browser AND sets upload target
- Visual indicator for centered entity (sun icon or similar)
- "Centered Entity" label shown when viewing a spoke
- "Create New Spoke" button with name + description form
- Spoke settings: rename, set/change center, delete
- Commit: "feat: spoke browser with centered entity display — MECE-015 Build 4"

After all 4 builds, verify this end-to-end flow:
1. Existing wiki works unchanged — default spoke, CJ as center
2. Create "Johnson LLC" spoke (no center yet)
3. Switch to Johnson LLC spoke (empty)
4. Upload a test document about a fictional LLC
5. System extracts entities into Johnson LLC spoke
6. System auto-detects the business entity and sets as centered entity
7. Entity browser shows only Johnson LLC entities
8. Query within spoke: "Who are the partners?" resolves relative to Johnson LLC
9. Switch to "All Spokes" — see everything across both spokes
10. Query without spoke filter: relationships relative to CJ (default behavior)

Update NEXT-SESSION.md with heliocentric architecture documentation.
```

---

## WHY THIS MATTERS

The centered entity model is what makes Context Engine a platform instead of a personal tool. Every competitor in this space — Clio, ShareFile, even Claude Memory — assumes a single fixed perspective. Context Engine lets you shift the center of gravity per context.

A law firm partner opens the dashboard and sees: "Johnson LLC: ☀ centered, 73% complete." They're not looking at their own profile — they're looking at their client's universe. Switch to Smith Estate and the sun shifts to Margaret Smith. Switch to "All Clients" and the firm itself is the sun.

Same graph. Same queries. Same completeness engine. Different center each time.

That's the product.

---

## AFTER BUILDS 1-4

| Build | What | When | Dependency |
|-------|------|------|------------|
| 5 | Meta-Schema (MECE-016) | Day 7 | Needs CJ input on "what complete looks like" per vertical |
| 6 | Completeness Engine | Day 7-8 | Depends on Build 5 schema format |
| 7 | Batch Ingestion Queue | Day 8 | Independent — CeeCee can build alone |

Build 5 is a product conversation, not just a code task. We define it together after Builds 1-4 ship.

---

*Context Architecture • MECE-015 Heliocentric • February 22, 2026*
*"The sun changes. The orbits adapt. The architecture holds."*
