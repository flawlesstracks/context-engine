# Context Architecture — Session Handoff Document

> Last updated: 2026-02-25 (end of Day 8 — Build 10.5 + Build 11 + Build 11.5)
> Server: running on port 3000
> Branch: main, pushed to origin

---

## 0. Builds Shipped Today (Day 8)

### Build 11.5 — Three-Tier Necessity Model (BLOCKING / EXPECTED / ENRICHING)
- **Schema upgrade**: Added `necessity_tier` field to every `extraction_spec` field and `entity_role.required_fields` entry across 3 new-format templates. Version bumped to 1.1.0.
  - `financial_review.json`: 136 fields annotated (B:25 / E:22 / EN:89)
  - `tax_preparation.json`: 80 fields annotated (B:47 / E:25 / EN:8)
  - `personal_injury.json`: 116 fields annotated (B:48 / E:47 / EN:21)
  - Total: 332 fields annotated, zero missing
- **Three-tier scoring in `scoreDocumentFields()`**: Returns `filing_readiness` (% BLOCKING extracted), `quality_score` (% BLOCKING+EXPECTED), `completeness` (% ALL). Backward-compatible single `score` preserved.
- **Tier adjustments**: Per-spoke `tier_adjustments` object allows overriding any field's tier (e.g., promote ENRICHING→BLOCKING for a specific client). PATCH /api/spokes/:id/tier-adjustments endpoint.
- **`analyzeGaps()` upgraded**: Now returns `filing_readiness`, `quality_score`, `completeness`, `tier_counts`, `missing_by_tier` in gap analysis output.
- **Dashboard API upgraded**: GET /api/dashboard returns `filing_readiness_pct`, `quality_score_pct`, `completeness_score_pct` per spoke. New stats: `filing_not_ready`, `filing_ready`. New filter chips: "Filing Not Ready", "Low Quality (<70%)".
- **Dashboard UI upgraded**: Table now shows 3 mini-bars per client (Filing Ready / Quality / Complete) with color-coded progress. Sortable by all three tier columns. Summary stats header shows Filing Not Ready / Filing Ready counts.
- **Legacy compatibility**: Templates without `necessity_tier` default to EXPECTED. Legacy templates (estate_planning, corporate_formation, general) continue to work unchanged.
- **36 verification tests passed**: Field counts, tier distribution, three-tier scoring, tier adjustments, cross-doc rules unchanged, backward compat.

### Build 10.5 — New Extraction Spec Templates
- **Financial Statement Review template** (`data/templates/financial_review.json`): 3 document types (Income Statement: 49 fields, Balance Sheet: 37 fields, Cash Flow: 43 fields), 2 entity roles, 3 cross-doc rules (net_income_match, cash_position_match, balance_sheet_equation — all CRITICAL)
- **W-9 + W-8BEN added to tax_preparation template**: W-9 (9 extraction fields), W-8BEN (12 extraction fields), 3 new cross-doc rules (mutual_exclusion, expiration, classification_consistency). Total tax cross-doc rules: 7
- **Sample extraction fixture**: `data/sample-extractions/financial_statements_sample.json` (real extraction output from income statement)
- **All templates loaded and verified**: financial_review, tax_preparation (with W-9/W-8BEN), personal_injury, estate_planning, corporate_formation, general
- **Signal classification working**: Form_W9 → w9_form, Balance_Sheet → balance_sheet, CashFlow → cash_flow, P&L → income_statement, W-8BEN → w8ben_form

### Build 11 — Firm Dashboard + Onboarding + Template Filters
- **GET /api/dashboard**: Returns spoke summaries with completeness, review status, entity count, missing docs, cross-doc violations, dynamic filter chips. Single API call populates entire view.
- **POST /api/onboard**: One-click client creation (name + template + file upload). Creates spoke, binds template, ingests files, runs gap analysis, returns complete state.
- **Dashboard UI**: Sortable table (6 columns), color-coded completeness bars (red/yellow/green), summary stats header (total/critical/in-progress/complete/fully-reviewed).
- **Template-aware filter chips**: Dynamic chips generated from active templates. Tax → "Missing W-2", "Missing K-1", "Missing W-9". Financial → "Missing Income Statement", "Missing Balance Sheet", "Cross-Doc Violations". PI → "Missing Medical Records", "Ready for Demand". Universal → "Critical (<50%)", "Needs Review", "Complete".
- **New Client onboarding modal**: Client name, template dropdown (all 6 templates), drag-and-drop file zone. Auto-redirects to client workspace after creation.

---

## What's Next

| Build | Name | Description |
|-------|------|-------------|
| 12 | Template Builder UI | Visual template editor for creating custom extraction specs |
| 13 | Doc Request + Client Upload | Generate document request lists, client-facing upload portal |
| 14 | Cross-Spoke Intelligence | Cross-client analytics, duplicate entity detection across spokes |

### Notes for Next Session
- 3 new extraction spec templates now loaded: financial_review, enhanced tax_preparation (W-9/W-8BEN), existing PI and corporate_formation
- Sample extraction fixture at `data/sample-extractions/financial_statements_sample.json` for testing cross-doc validation
- Dashboard endpoint returns `filter_chips` array — frontend renders them dynamically from template document_types
- Onboarding endpoint supports multipart file upload via multer

---

## 1. Architecture Overview

### File Tree

```
context-architecture/
├── web-demo.js              # Express server — API, wiki UI, shared views (~5200 lines)
├── context-engine.js        # CLI extraction tool — reads text, calls Claude, outputs JSON
├── merge-engine.js          # Entity dedup & merge — bigram similarity, property overlap
├── watcher.js               # File system watcher — monitors watch-folder/input
├── demo.js                  # Quick demo script for CLI extraction
├── src/
│   ├── auth.js              # Google OAuth 2.0 router — login, callback, sessions, tenants
│   ├── drive.js             # Google Drive — list, search, download, export Google Docs/Sheets
│   ├── graph-ops.js         # Entity CRUD — readEntity, writeEntity, listEntities, counters
│   ├── ingest-pipeline.js   # Unified ingestion — dedup, merge, create, multi-source
│   └── parsers/
│       ├── normalize.js     # File format detection — PDF, DOCX, XLSX, CSV, TXT → text
│       ├── linkedin.js      # LinkedIn profile → Career Lite entity with experience/education
│       └── contacts.js      # Spreadsheet contact rows → person entities
├── watch-folder/
│   ├── config.json          # API key, model, poll interval, supported extensions
│   └── graph/               # Entity database root (tenant dirs inside)
│       ├── tenant-{id}/     # Per-tenant entity storage
│       │   ├── ENT-*.json   # Entity files
│       │   ├── _counter.json
│       │   └── shares.json  # Share link records
│       └── tenants.json     # Tenant registry (gitignored — contains OAuth tokens)
├── samples/                 # Sample input text files for testing
├── output/                  # Historical extraction outputs
├── openapi-spec.json        # REST API spec (v2.0)
├── render.yaml              # Render.com deployment config (1GB persistent disk)
├── custom-gpt-system-prompt.md  # ChatGPT system prompt for Context Engine agent
└── package.json             # Dependencies: express, anthropic-sdk, googleapis, helmet, express-rate-limit, etc.
```

### How Files Connect

```
User → web-demo.js (Express)
         ├─ /auth/* → src/auth.js (Google OAuth → tenant creation)
         ├─ /api/* → apiAuth middleware → src/graph-ops.js (entity CRUD)
         ├─ /api/ingest/* → src/parsers/normalize.js → src/ingest-pipeline.js
         │                   ├─ LinkedIn detected → src/parsers/linkedin.js
         │                   └─ Contact sheet detected → src/parsers/contacts.js
         ├─ /api/drive/* → src/drive.js (browse/download) → ingest pipeline
         ├─ /api/share → loadShares/saveShares (shares.json per tenant)
         ├─ /shared/:id → public view (no auth, scans all tenant dirs)
         ├─ /wiki → inline HTML SPA (dark theme dashboard)
         └─ / → inline HTML SPA (original extraction UI)

Dedup: ingest-pipeline.js calls merge-engine.js for every incoming entity
CLI:   context-engine.js runs standalone (no Express), calls Claude directly
Watch: watcher.js polls watch-folder/input, routes to parsers, calls context-engine
```

### Entity Schema (v2.0)

```json
{
  "schema_version": "2.0",
  "entity": { "entity_type": "person|business", "entity_id": "ENT-XX-001", "name": {}, "summary": {} },
  "attributes": [{ "key": "", "value": "", "confidence": 0.8, "time_decay": {}, "source_attribution": {} }],
  "relationships": [{ "name": "", "relationship_type": "", "confidence": 0.6, "context": "" }],
  "observations": [{ "observation_id": "", "fact": "", "confidence": 0.8, "facts_layer": "", "timestamp": "" }],
  "career_lite": { "interface": "career-lite", "experience": [], "education": [], "skills": [] }
}
```

---

## 2. Features Shipped

### Session 1-2: Core Engine
- **CLI extraction** (`context-engine.js`): text → Claude → structured JSON entity
- **File watcher** (`watcher.js`): monitors input folder, auto-processes files
- **Merge engine**: bigram Dice similarity, nickname/alias matching, initials detection, property overlap (company, email, LinkedIn URL, skills)
- **Entity ID generation**: `ENT-{initials}-{seq}` (person), `ENT-BIZ-{initials}-{seq}` (business)

### Session 3: Multi-Tenant + Connectors
- **Google OAuth**: login → auto-provision tenant → JWT session cookie (7-day TTL)
  - Scopes: openid, email, profile, drive.readonly, gmail.readonly
  - Tenant dir: `graph/tenant-{4-byte-hex}/`
- **File parsers**: PDF, DOC, DOCX (mammoth), XLSX/XLS (xlsx), CSV (csv-parse), TXT, MD, JSON
  - LinkedIn detection: 2+ markers → special extraction prompt → Career Lite entity
  - Contact sheet detection: column name fuzzy match → batch person entities
- **Google Drive connector**: browse folders, search, download files, export Google Docs→DOCX / Sheets→XLSX
  - Token refresh with `withTokenRefresh()` wrapper
- **Ingest pipeline**: unified path for all sources — dedup against existing, merge or create
- **ChatGPT import**: parse conversation exports, batch extraction, NDJSON streaming progress

### Session 4: Wiki UI + Career Lite + Sharing
- **Wiki dashboard** (`/wiki`): light-theme SaaS UI with CSS custom properties (Linear/Notion aesthetic)
  - White/light-gray backgrounds (#f5f5f7 body, #fff cards), dark text, subtle borders and shadows
  - Purple accent preserved for logo, buttons, links, gradients
  - Entity sidebar with search, entity detail view, observation management
  - Career Lite renderer for LinkedIn-imported profiles (avatar, experience, education, skills)
- **Profile sharing system**:
  - Share modal with per-section toggles (summary, experience, education, skills, connections)
  - Configurable expiry (7/30/90/365 days)
  - Public route `GET /shared/:shareId` — no auth, server-rendered, light theme
  - Share records in `shares.json` per tenant
  - Revoke support, active shares listing
- **Dedup improvements**: nickname-aware matching, property overlap scoring, Drive folder search
- **Security hardening**:
  - helmet middleware: HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, etc.
  - Rate limiting: 100 req/15min on `/api/*`, 10 req/min on `POST /api/share`, 30 req/min on `GET /shared/:shareId`
  - Input validation on `POST /api/share`: entityId format regex, sections whitelist, expiresInDays whitelist (7/30/90/365)
  - File upload limits already enforced: 50MB per file, 20 files max, extension whitelist
- **File handling fixes**:
  - JSON upload auto-detects ChatGPT `conversations.json` format (array with `mapping` + `title`), otherwise raw text extraction
  - DOC (legacy Word) support via mammoth with fallback to raw text
  - Drive search: local filter on typing, full Drive search (no parent filter) on Enter
  - Drive folders: checkbox to select for import, click name/icon to navigate into folder
  - Breadcrumb navigation with clickable segments (`My Drive › folder › subfolder`)

---

## 3. API Endpoints

### Authentication Routes (src/auth.js, mounted at /auth)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/google` | None | Initiates Google OAuth flow with CSRF state token |
| GET | `/auth/google/callback` | None | OAuth callback — exchanges code, creates/updates tenant, sets session cookie |
| GET | `/auth/me` | Cookie | Returns current session user info (tenant_id, email, name, picture) |
| POST | `/auth/logout` | None | Clears session cookie |

### Entity API (apiAuth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/search?q=` | Fuzzy search entities by name/attributes/summary (`q=*` for all) |
| GET | `/api/entity/:id` | Get full entity JSON |
| GET | `/api/entity/:id/summary` | Get entity summary (type, name, confidence, counts) |
| GET | `/api/entity/:id/context` | Entity profile + top 20 observations weighted by relevance |
| POST | `/api/entity` | Create new entity (validates name uniqueness >0.85 similarity) |
| PATCH | `/api/entity/:id` | Merge-update entity fields |
| DELETE | `/api/entity/:id` | Delete entity |

### Observations API (apiAuth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/observe` | Add observation to entity (body: entity_id, observation, confidence_label, facts_layer) |
| DELETE | `/api/observe/:id` | Delete observation by ID |

### Ingestion API (apiAuth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/ingest/chatgpt` | Import ChatGPT conversation export (streams NDJSON progress) |
| POST | `/api/ingest/files` | Upload files for extraction (multipart, streams NDJSON progress) |
| POST | `/api/extract` | Extract entity from raw text via Claude, auto-add to graph |

### Drive API (apiAuth required)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/drive/files?folderId=&q=` | List Drive folder contents or search files |
| POST | `/api/drive/ingest` | Download + ingest selected Drive files (streams NDJSON progress) |

### Share API (apiAuth required)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/share` | Create share link (body: entityId, sections, expiresInDays) |
| GET | `/api/shares/:entityId` | List non-expired shares for an entity |
| DELETE | `/api/share/:shareId` | Revoke a share link |

### Admin API (apiAuth + adminOnly)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/tenant` | Create new tenant (admin only) |
| GET | `/api/graph/stats` | Knowledge graph health check (entity counts, merges, last updated) |

### Public Routes (no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Original extraction UI (HTML SPA) |
| GET | `/wiki` | Wiki dashboard (HTML SPA, dark theme) |
| GET | `/ingest` | ChatGPT import UI |
| GET | `/shared/:shareId` | Public shared profile view (server-rendered, light theme) |
| POST | `/extract` | Public extraction endpoint (text + type → entity JSON) |

---

## 4. Environment Variables

```bash
# Required — Claude API for entity extraction
ANTHROPIC_API_KEY=sk-ant-...

# Required for OAuth login and Drive integration
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

# Required — JWT signing key for session cookies
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=<64-char-hex>

# Production only (set in render.yaml)
NODE_ENV=production
RENDER_DISK_PATH=/var/data
```

Without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, the server starts but OAuth endpoints return 503. Without `ANTHROPIC_API_KEY`, extraction endpoints fail. Without `SESSION_SECRET`, a random one is generated per boot (invalidates all sessions on restart).

---

## 5. What's Left to Build

### Session 5: Interface Composer (full implementation)

Career Lite was the first interface — a fixed layout for LinkedIn-imported profiles. The Interface Composer generalizes this:

- **Interface registry**: define reusable interfaces (Contactable, Experienceable, Summarizable, etc.)
- **Compose interfaces per entity**: attach/detach interfaces, each with its own schema and renderer
- **Dynamic rendering**: wiki detail view dispatches to the correct renderer based on attached interfaces
- **Custom interface builder**: UI for defining new interfaces with field schemas
- **Truth level projection**: interfaces control what's visible at each truth level (self, trusted, public)

### Session 6: Orchestration Layer

- **Agent protocol**: standardized request/response format for AI agents to query the knowledge graph
- **Context window management**: smart entity selection based on relevance to current conversation
- **Multi-agent coordination**: agents can create observations, update entities, trigger merges
- **Streaming context delivery**: real-time entity updates pushed to connected agents
- **Rate limiting and quotas**: per-tenant API usage tracking

### Session 7: Security & Hardening

Already done (Session 4):
- ~~Security headers (helmet)~~
- ~~Rate limiting on API, share creation, shared view~~
- ~~Input validation on POST /api/share~~
- ~~File upload size/count/extension validation~~

Still needed:
- **Input validation on remaining routes**: JSON schema validation on POST /api/entity, PATCH /api/entity, POST /api/observe, etc.
- **Per-tenant rate limiting**: current limits are per-IP, not per-tenant
- **Audit logging**: track all entity reads/writes/shares with timestamps and actor
- **Share link hardening**: HMAC signatures, IP-based restrictions, view counting
- **CSRF protection**: on all state-mutating endpoints (currently only on OAuth)
- **Content Security Policy**: currently disabled for inline scripts — needs refactor to external JS
- **Secrets management**: rotate API keys, tenant keys, session secrets

### Session 8: Student Test / Integration Test Suite

- **End-to-end tests**: OAuth flow → entity creation → merge → share → public view
- **Unit tests**: merge-engine similarity, ingest pipeline dedup, parser detection
- **Load testing**: concurrent tenant operations, large file ingestion
- **Student scenario**: fresh user onboarding, ChatGPT import, Drive ingest, Career Lite creation, share with recruiter

---

## 6. Known Issues & Shortcuts

### Technical Debt

| Issue | Location | Severity | Notes |
|-------|----------|----------|-------|
| Inline HTML templates | web-demo.js (entire file) | Medium | ~5200 lines in one file. Wiki UI, Career Lite renderer, shared view all built via string concatenation. No templating engine. |
| Hardcoded model name | Multiple files | Low | `claude-sonnet-4-5-20250929` hardcoded in 5+ places. Should be config-driven. |
| Partial input validation | Most API routes | Medium | POST /api/share validated; other routes (POST /api/entity, PATCH, POST /api/observe) still lack schema validation. |
| Per-IP rate limiting only | All API routes | Medium | Rate limiting added via express-rate-limit but keyed by IP, not tenant. Shared IPs (corporate NAT) could hit limits unfairly. |
| Silent 50KB truncation | web-demo.js:633,888 | Medium | Large documents truncated without warning to user. |
| Drive tokens in-memory only | web-demo.js | Medium | Drive access tokens stored in memory — lost on server restart. Users must re-authorize. |
| No session refresh | src/auth.js | Low | JWT sessions expire in 7 days with no sliding window. User must re-login. |
| Mixed HTML escaping | web-demo.js | Low | Client-side uses `esc()` (DOM-based), server-side uses `escHtml()` (regex-based). Both work but inconsistent. |
| Share brute-force | web-demo.js | Low | 72-bit entropy is strong. Rate limited to 30 req/min but no per-IP tracking across restarts. |
| No test suite | package.json | High | `npm test` exits with error. Zero tests exist. |
| Observation ID collisions | src/ingest-pipeline.js | Low | Timestamp precision to seconds — multiple observations in same second get sequential suffix but pattern is fragile. |
| Fragile company extraction | merge-engine.js:127 | Low | Parses "at {company}" from role string. English-only, breaks on other patterns. |

### Shortcuts Taken Today (Session 4)

1. **Share scanning is O(tenants)**: `GET /shared/:shareId` reads every `tenant-*/shares.json` to find the matching share. Fine for small deployments, won't scale.
2. **No share link pagination**: `GET /api/shares/:entityId` returns all active shares. No limit.
3. **Shared view is fully server-rendered**: No client-side JS. Intentional for simplicity but limits interactivity.
4. **Share modal uses escaped single quotes in onclick handlers**: Works but fragile — a shareId or URL containing `'` would break. Base64url encoding prevents this in practice.

---

## 7. How to Run Locally

```bash
# Clone and install
git clone https://github.com/flawlesstracks/context-engine.git context-architecture
cd context-architecture
npm install

# Configure environment
cp .env.example .env
# Edit .env — add your keys:
#   ANTHROPIC_API_KEY (required for extraction)
#   GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (required for OAuth/Drive)
#   SESSION_SECRET (required for sessions — generate a random hex string)

# Start server
node web-demo.js

# Output:
#   UI:     http://localhost:3000
#   Wiki:   http://localhost:3000/wiki
#   Import: http://localhost:3000/ingest
#   API:    http://localhost:3000/api/graph/stats
#   Share:  http://localhost:3000/shared/:shareId
#   Auth:   http://localhost:3000/auth/google

# Alternative: file watcher mode (processes files dropped into watch-folder/input)
node watcher.js

# CLI extraction (standalone, no server)
node context-engine.js --input samples/cj-mitchell.txt --output output/cj.json --type person
```

### Quick Verification

```bash
# Check API health (needs API key from watch-folder/config.json)
curl -H "X-Context-API-Key: ctx-dev-key-001" http://localhost:3000/api/graph/stats

# Search all entities
curl -H "X-Context-API-Key: ctx-dev-key-001" "http://localhost:3000/api/search?q=*"

# Open wiki in browser
open http://localhost:3000/wiki
```

### Production Deployment

Deployed on Render.com via `render.yaml`. Persistent disk at `/var/data` (1GB). Entity data at `/var/data/graph/`. Set all env vars in Render dashboard.
