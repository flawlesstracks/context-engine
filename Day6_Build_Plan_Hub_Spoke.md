# Day 6 Build Plan — Hub-Spoke Foundation for Law Firm Demo

**Date:** February 23, 2026 (tomorrow)
**Objective:** Ship Builds 1-4 in a single CeeCee session. End the day with a working spoke system visible in the web UI.
**North Star Demo:** "Create a spoke called Johnson LLC. Upload 5 docs. Ask Claude what's missing."

---

## WHAT'S SHIPPED (Days 1-5)

| MECE | What | Status |
|------|------|--------|
| 001-010 | Core engine, parsers, wiki, OAuth, Career Lite, Drive connector, sharing | ✅ |
| 011 | Query Engine (5 query types, BFS path finding, fuzzy search, < 600ms) | ✅ |
| 012 | DXT/MCPB Package (3 tools, manifest, build script, 4.5MB) | ✅ |
| 017 | Aggressive tool descriptions for Claude routing | ✅ |

---

## TOMORROW'S BUILDS (4 builds, one session)

### Build 1: Spoke Data Model (MECE-015)

**What:** Add `spoke_id` field to the entity data model. A spoke is a walled partition within a tenant.

**Endpoints:**
- `POST /api/spoke` — create a new spoke `{ name, description }`
- `GET /api/spokes` — list all spokes with entity counts
- `GET /api/spoke/:id` — get spoke details with entity summary
- `PUT /api/spoke/:id` — update spoke name/description
- `DELETE /api/spoke/:id` — delete spoke (only if empty, or with `?force=true`)

**Migration:** Every existing entity gets `spoke_id: "default"` so nothing breaks. CJ's personal graph becomes the "default" spoke automatically.

**Data structure per spoke:**
```json
{
  "id": "spoke-uuid",
  "name": "Johnson LLC",
  "description": "Tax filing client since 2019",
  "created_at": "2026-02-23T...",
  "updated_at": "2026-02-23T...",
  "entity_count": 0,
  "meta_schema_id": null
}
```

**Test:** Create "Johnson LLC" spoke via API. List spokes — see both "default" and "Johnson LLC". Existing wiki works unchanged.

---

### Build 2: Spoke-Scoped Ingestion

**What:** File uploads accept an optional `spoke` parameter. All extracted entities get tagged with that spoke_id.

**Changes:**
- `POST /api/ingest/universal` — add optional `spoke_id` body param
- `POST /api/ingest/files` — add optional `spoke_id` body param
- MCP `build_graph` tool — add optional `spoke` parameter to input schema
- Web UI upload area — add spoke selector dropdown above the file drop zone

**Behavior:**
- If spoke_id provided → all extracted entities tagged with that spoke
- If no spoke_id → entities go to "default" spoke (backwards compatible)
- Dropdown populated from `GET /api/spokes`
- "Default (Personal)" always listed first

**Test:** Select "Johnson LLC" from dropdown. Upload a test document. Verify extracted entities have `spoke_id: "spoke-johnson-llc-uuid"`.

---

### Build 3: Spoke-Scoped Queries

**What:** Query engine and search endpoints accept optional spoke filtering.

**Changes:**
- `GET /api/query?q=...&spoke=SPOKE_ID` — filter query results to spoke
- `GET /api/search?q=...&spoke=SPOKE_ID` — filter search to spoke
- MCP `query` tool — add optional `spoke` parameter
- When spoke provided → only return entities from that spoke
- When spoke absent → return entities from ALL spokes (current behavior, hub-level)

**Behavior for queries:**
- Entity lookup: only finds entities in the specified spoke
- Relationship traversal: only follows paths within the spoke
- Aggregation: counts only within spoke
- Completeness: checks only spoke entities
- Cross-spoke queries: only available without spoke filter (hub-level)

**Test:** Query "Who is in the Johnson LLC spoke?" with spoke filter → only Johnson LLC entities. Same query without filter → all entities including personal graph.

---

### Build 4: Spoke Browser in Web UI

**What:** Left nav gets a spoke switcher. The entity browser filters by selected spoke.

**UI Changes:**
- Left sidebar: new section above entity list showing spoke tabs/pills
- "All Spokes" tab (default, current behavior)
- One tab per spoke, showing: name + entity count
- Clicking a spoke filters the entity browser to that spoke only
- Upload area respects the currently selected spoke
- Spoke management: "Create New Spoke" button, inline rename, delete

**Visual:**
```
┌────────────────────────────────────┐
│ SPOKES                         [+] │
│ ┌──────────┐ ┌─────────────┐      │
│ │ All (96) │ │ Johnson (0) │      │
│ └──────────┘ └─────────────┘      │
│ ┌──────────────────┐              │
│ │ Default/Personal │              │
│ └──────────────────┘              │
├────────────────────────────────────┤
│ ENTITIES (filtered by spoke)       │
│ • CJ Mitchell                     │
│ • Steve Hughes                    │
│ • ...                             │
└────────────────────────────────────┘
```

**Test:** Create "Johnson LLC" spoke. Switch to it. Entity list shows empty. Upload a doc. Entity list populates. Switch to "All" — see everything.

---

## CEECEE PROMPT (copy-paste this tomorrow)

```
We're building Hub-Spoke architecture for Context Engine. This is 4 builds in sequence — complete each one fully before starting the next. Each build should have its own commit.

Read the existing codebase (NEXT-SESSION.md if it exists, or scan web-demo.js, the graph/ directory structure, and the entity data model) to understand the current architecture before making changes.

BUILD 1: Spoke Data Model
- Add a spokes.json storage file (same pattern as tenants.json) that stores spoke definitions per tenant
- Each spoke: { id, name, description, created_at, updated_at }
- Add spoke_id field to every entity when saved/loaded. Default value: "default"
- Migrate all existing entities: add spoke_id: "default" if missing
- New REST endpoints:
  POST /api/spoke — create spoke { name, description } → returns spoke with generated id
  GET /api/spokes — list all spokes with entity counts per spoke
  GET /api/spoke/:id — get spoke with entity count
  PUT /api/spoke/:id — update spoke
  DELETE /api/spoke/:id — delete spoke (reject if entities exist unless ?force=true)
- All spoke endpoints use existing tenant auth middleware
- Commit: "feat: spoke data model and CRUD endpoints — MECE-015 Build 1"

BUILD 2: Spoke-Scoped Ingestion
- POST /api/ingest/universal and POST /api/ingest/files accept optional spoke_id in request body
- When spoke_id provided, all extracted entities get that spoke_id
- When not provided, entities get spoke_id: "default" (backwards compatible)
- MCP build_graph tool: add optional spoke parameter to input schema and pass through to API
- Web UI: add a spoke selector dropdown above the file upload area, populated from GET /api/spokes, defaulting to "Default (Personal)"
- Selected spoke_id sent with upload requests
- Commit: "feat: spoke-scoped ingestion — MECE-015 Build 2"

BUILD 3: Spoke-Scoped Queries
- GET /api/query accepts optional spoke query parameter
- GET /api/search accepts optional spoke query parameter
- When spoke provided, filter results to only entities with matching spoke_id
- When not provided, return all entities (current behavior — hub-level view)
- MCP query tool: add optional spoke parameter to input schema, pass through
- Update query-engine.js: all entity loading functions respect spoke filter
- Commit: "feat: spoke-scoped queries — MECE-015 Build 3"

BUILD 4: Spoke Browser in Web UI
- Add spoke switcher UI in the left sidebar above the entity list
- "All Spokes" shows everything (default). Individual spoke tabs filter the entity list.
- Each spoke tab shows name and entity count
- Clicking a spoke updates the entity browser AND the upload spoke selector
- Add "Create New Spoke" button (opens inline form or modal)
- Spoke pills/tabs styled to match existing wiki theme
- Commit: "feat: spoke browser UI — MECE-015 Build 4"

After all 4 builds, test this flow:
1. Create a spoke called "Johnson LLC"
2. Switch to it (empty)
3. Upload a test document with the Johnson LLC spoke selected
4. See extracted entities appear in the Johnson LLC spoke only
5. Switch to "All Spokes" — see both personal entities and Johnson LLC entities
6. Query with spoke filter — only Johnson LLC results
7. Query without filter — everything

Update NEXT-SESSION.md with the new architecture (spoke model, endpoints, UI changes).
```

---

## AFTER BUILDS 1-4: WHAT COMES NEXT

| Build | What | When | Why |
|-------|------|------|-----|
| 5 | Meta-Schema Data Model (MECE-016) | Day 7 | Defines "what complete looks like" per spoke. Needs CJ input on schema format. |
| 6 | Completeness Engine | Day 7-8 | The killer feature: "Johnson LLC is 73% complete. Missing: spouse SSN, K-1." |
| 7 | Batch Ingestion Queue | Day 8 | Drop 50 files at once. Progress bar. Error handling per file. |

**Build 5 needs your input before CeeCee can build it.** The meta-schema format determines what "complete" means for a law firm client. I'll draft that spec once Builds 1-4 are shipped — we'll define it together based on what Justin's contacts actually need.

---

## THE DEMO THAT CLOSES JUSTIN

When Builds 1-7 are done:

```
"Create a spoke called Johnson LLC."
→ Spoke created.

"Upload their 5 documents."
→ 5 files processed. 23 entities extracted into Johnson LLC spoke.

"What's the entity structure for Johnson LLC?"
→ Query returns full entity map within the spoke.

"What's missing from the Johnson LLC filing?"
→ Completeness engine: "73% complete. Missing: spouse SSN, 
   2024 K-1 from holding company, operating agreement."

"Which clients are missing K-1s?"
→ Cross-spoke aggregation at hub level.
```

That's the pitch deck. That's the YouTube video. That's the first consulting conversation.

---

*Context Architecture • MECE-015 • CJ Mitchell • February 22, 2026*
*"Build the container tonight. Improve what's inside it forever."*
