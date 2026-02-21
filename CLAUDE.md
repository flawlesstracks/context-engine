# Context Architecture — Project Memory

## Identity
You are **CeeCee**, CJ Mitchell's build agent for the Context Architecture project. You work fast, confirm before destructive actions, and push to git after every feature.

## Stack
- **Runtime:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JS (no React, no build tools)
- **Data:** JSON files on disk (no database)
- **Deploy:** Render.com (auto-deploys from `main` branch)
- **Repo:** github.com/flawlesstracks/context-engine
- **Local path:** ~/context-architecture

## Key Files
| File | Purpose |
|------|---------|
| `web-demo.js` | Main Express server — ALL routes live here |
| `merge-engine.js` | Entity extraction, merging, dedup logic |
| `src/signalStaging.js` | Signal Staging Layer — four-quadrant resolution + confidence scoring |
| `src/ingest-pipeline.js` | Ingest pipeline for file-based entity creation |
| `src/graph-ops.js` | Graph CRUD operations (readEntity, writeEntity, etc.) |
| `watch-folder/graph/tenant-eefc79c7/` | CJ's entity JSON files (120 entities) |
| `watch-folder/graph/tenant-7105d791/` | Acme Corp demo tenant (34 entities) |
| `watch-folder/graph/tenants.json` | Tenant registry + API keys |
| `openai-actions-spec.yaml` | OpenAPI spec served at /openai-actions-spec.yaml |
| `.env` | API keys (Anthropic, Proxycurl, tenant keys) |

## Architecture
- Multi-tenant: each tenant gets own directory under `watch-folder/graph/`
- API auth: `X-Context-API-Key` header on every request, maps to tenant directory
- Entity IDs: `ENT-{initials}-{number}.json` (e.g., ENT-SH-052.json = Steve Hughes)
- Primary user entity: `ENT-CM-001.json` (CJ Mitchell) — DO NOT DELETE
- Entity schema: dual-layer (5 machine dimensions + human descriptor text)

## API Endpoints (Current)
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/search?q={query}&type={type} | Fuzzy search (Dice coefficient) |
| GET | /api/entity/{id} | Full entity detail |
| GET | /api/entities/category/{category} | List by category |
| GET | /api/entity/{id}/context | Weighted observations + relationships |
| POST | /api/entity | Create entity |
| PUT | /api/entity/{id} | Update entity |
| DELETE | /api/entity/{id} | Delete entity |
| POST | /api/observe | Add observation to entity |
| POST | /api/extract | Extract entities from uploaded file |
| POST | /api/extract-url | Extract entities from URL (flows through signal staging) |
| POST | /api/extract-linkedin | Extract from LinkedIn PDF (flows through signal staging) |
| POST | /api/ingest/files | File upload extraction (flows through signal staging) |
| GET | /api/review-queue | List unresolved/provisional signal clusters |
| GET | /api/clusters/:id | Get signal cluster detail |
| POST | /api/clusters/resolve | Resolve cluster: create_new, merge, skip, hold |
| POST | /api/share | Generate public Career Lite share link |
| POST | /api/dedup-relationships | Deduplicate relationships |
| POST | /api/entities/bulk-delete | Bulk delete entities |

## Tenant Keys
- CJ's tenant (eefc79c7): Check tenants.json for API key
- Custom GPT uses CJ's tenant key (NOT the admin key)
- Admin/root graph has 3 orphan files — ignore them

## Git Workflow
1. Build feature on localhost
2. Test manually
3. `git add -A && git commit -m "descriptive message" && git push origin main`
4. Wait for Render deploy (~2 min)
5. Verify on https://context-engine-nw4l.onrender.com

## Signal Staging Layer (Built Day 5)
All extraction paths (URL paste, LinkedIn, X/IG, file upload) flow through signal staging before entity creation. No entity is auto-created — user always decides.

### Four-Quadrant Model
| Quadrant | Data State | Entity State | Default Action |
|----------|-----------|--------------|----------------|
| Q1 | New Data | New Entity | Create New |
| Q2 | New Data | Existing Entity | Merge (if conf >= 0.8) |
| Q3 | Duplicate Data | New Entity (across sources) | Create New |
| Q4 | Duplicate Data | Existing Entity | Skip (add source) |

### Three Data States
- **UNRESOLVED** → initial state, no matches found yet
- **PROVISIONAL** → scored with candidate match, awaiting user decision
- **CONFIRMED** → user resolved (created, merged, skipped)

### Confidence Scoring (Three Levels)
1. **Signal Confidence** — source weight (LinkedIn API: 0.9, X/IG: 0.6, Web: 0.5, File: 0.7)
2. **Association Confidence** — match score (social_handle: 0.90, name_high: 0.85, org_normalized: 0.85)
3. **Attribute Confidence** — base × recency × corroboration (2 sources: ×1.3, 3+: ×1.5 cap)

### Entity Matching Priority
| Priority | Match Type | Confidence |
|----------|------------|------------|
| 1 | social_handle (x, instagram, linkedin) | 0.90 |
| 2 | handle_alias_cross | 0.85 |
| 3 | name_high (Dice > 0.85) | 0.85 |
| 4 | name_alias (namesLikelyMatch) | 0.82 |
| 5 | name + 2 properties | 0.75 |
| 6 | name + shared rels | 0.70 |
| 7 | org name normalized | 0.85 |

### Signal Clusters
Stored in `{graphDir}/signal_clusters/SIG-{uuid}.json`. Deleted on resolution.
Per-signal values carry: `{value, confidence, sources}` format.

### Test Results (Feb 21, 2026)
- **Q3 PASS**: Two Amazon extractions from different URLs → both scored Q3 → cluster 1 promoted to entity → cluster 2 re-scored as Q2 (0.85 name_high) → merged. Corroboration multiplier applied (industry attr: 0.7 × 1.3 = 0.91), both source URLs in provenance.
- **Q2/Q4 PASS**: x.com/putchuon extracted → Q1 (no prior handle link) → user linked to ENT-CM-001 → merged (x_handle, x_url added). Re-extracted → Q4 with 0.90 confidence via social_handle_x match → skipped (source attribution added, no duplicate entity).
- **Bug fixes**: Failed fetch no longer leaves stale preview data. confirmPreview() routes through signal staging (not direct ingest).

## Current State (End of Day 5 — Feb 21, 2026)
- 120 entities in CJ's tenant (people, orgs, mixed)
- Wiki: profile mode, visual tiers (Gold/Green/Neutral/Muted), entity cards, sidebar nav
- Custom GPT: working, calls API, synthesizes pre-meeting briefings
- Google Drive picker: working with JSON support
- Career Lite + share links: working
- Overview page: working (ENT-CM-001 restored)
- OpenAPI spec: served at /openai-actions-spec.yaml
- Signal Staging Layer: working — all extraction paths gated through staging
- Review Queue: working — sidebar badge shows pending cluster count
- Confidence scoring: working — three-level system with corroboration multiplier
- Social handle matching: working — X, Instagram, LinkedIn handle/URL matching

## Known Issues
- 3 orphan entity files in graph root (outside any tenant) — not accessible via API
- MEASURE lever: nothing built (no metrics tracking)
- First-time social handle extraction scores Q1 (no way to match handle to name without prior data) — user must manually link on first encounter

## Rules
- Always `git push` after completing a feature
- Always test on localhost before pushing
- Never delete ENT-CM-001.json (primary user entity)
- Use preview/approval mode for bulk operations
- Source-attribute every observation (type, url, extracted_at)
- Reuse existing extraction pipeline — don't rebuild what works
