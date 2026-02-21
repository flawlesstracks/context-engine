## Architecture Bible — MECE.md
Read MECE.md before every build session. It contains the AAA Loop, the 12 Levers
scorecard, and every MECE framework that governs how this product works.
If your build touches a domain defined there, follow the framework.
If your build reveals a new framework, add it before committing.
If your build changes a lever score, update the scorecard.

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
| `src/scrapingdog.js` | ScrapingDog LinkedIn API — scrapeLinkedInProfile + transformScrapingDogProfile |
| `src/parsers/linkedin.js` | LinkedIn PDF extraction — Career Lite prompt, entity builder |
| `src/parsers/normalize.js` | File parser + auto-detection (LinkedIn PDF, contact list, profile) |
| `src/health-analyzer.js` | Connection Intelligence — duplicate detection, tier classification, phantom entity detection |
| `src/graph-ops.js` | Graph CRUD operations (readEntity, writeEntity, etc.) |
| `watch-folder/graph/tenant-eefc79c7/` | CJ's entity JSON files (120 entities) |
| `watch-folder/graph/tenant-7105d791/` | Acme Corp demo tenant (34 entities) |
| `watch-folder/graph/tenants.config.json` | Tenant registry — IDs, API keys, self_entity_id (tracked) |
| `watch-folder/graph/tenants.state.json` | Tenant runtime — OAuth tokens, session data (gitignored) |
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
| POST | /api/extract-url | Smart URL router: LinkedIn→ScrapingDog, X/IG→meta scraper, other→generic (all through signal staging) |
| POST | /api/discover-entity | Point Agent v1: name→LinkedIn discovery→Career Lite extraction→signal staging (DIRECTED mode) |
| POST | /api/discover-entity/select | Resolve disambiguation by selecting a specific candidate from discovery results |
| POST | /api/extract-linkedin | Extract from LinkedIn PDF (flows through signal staging) |
| POST | /api/ingest/files | File upload extraction (flows through signal staging) |
| GET | /api/review-queue | List unresolved/provisional signal clusters |
| GET | /api/clusters/:id | Get signal cluster detail |
| POST | /api/clusters/resolve | Resolve cluster: create_new, merge, skip, hold |
| POST | /api/share | Generate public Career Lite share link |
| POST | /api/dedup-relationships | Deduplicate relationships |
| POST | /api/entities/bulk-delete | Bulk delete entities |
| GET | /api/entity/{id}/health | Connection intelligence: duplicates, phantoms, tier distribution, quality score |

## Tenant Keys
- CJ's tenant (eefc79c7): Check tenants.config.json for API key
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

### scoreCluster — 5-Step Provisioner Scoring
1. **STEP 1: Signal Confidence** — per-signal base_source_weight from SOURCE_WEIGHTS table (user_input: 0.95, linkedin_api: 0.9, linkedin_pdf: 0.85, company_website: 0.8, file: 0.75, social: 0.6, web: 0.5, mention: 0.4)
2. **STEP 2: Association Confidence** — 5-factor weighted composite matching against all existing entities:
   - name_match: 0.4 weight (Dice coefficient + namesLikelyMatch for nicknames)
   - handle_match: 0.3 weight (LinkedIn URL, X handle, Instagram handle — exact match)
   - org_title_match: 0.15 weight (company + title fuzzy match)
   - location_match: 0.1 weight (city/state token overlap)
   - bio_similarity: 0.05 weight (keyword overlap on summary/bio)
   - Entity with highest score > 0.3 threshold = candidate_entity_id
3. **STEP 3: Data Novelty** — per-signal check against candidate entity. >50% new = NEW DATA, >50% duplicate = DUPLICATE DATA. Stored as data_novelty_ratio.
4. **STEP 4: Quadrant Assignment** — entity existence (score > 0.3) × data novelty (>50% new):
   - Q1_CREATE: New Data + New Entity
   - Q2_ENRICH: New Data + Existing Entity
   - Q3_CONSOLIDATE: Duplicate Data + New Entity
   - Q4_CONFIRM: Duplicate Data + Existing Entity
5. **STEP 5: Projected Confidence** — per-signal: base_source_weight × recency_modifier × corroboration_multiplier. Recency only decays volatile attributes (headline, role, company, location). Historical facts (education, past roles) always 1.0.

### Confidence Scoring (Three Levels)
1. **Signal Confidence** — source weight set once at scoring time
2. **Association Confidence** — 5-factor weighted composite (threshold: 0.3)
3. **Attribute Confidence** — base × recency × corroboration (2 sources: ×1.3, 3+: ×1.5 cap)

### Signal Clusters
Stored in `{graphDir}/signal_clusters/SIG-{uuid}.json`. Deleted on resolution.
Per-signal values carry: `{value, confidence, sources, projected_confidence}` format.
Cluster stores: signal_confidence, association_confidence, association_factors, data_novelty_ratio, data_novelty, quadrant, quadrant_label, candidate_entity_id.

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
- LinkedIn PDF auto-detection: working — detectLinkedInPDF checks 3+ of 5 signals (linkedin.com, Experience/Education/Skills/Contact headers). Career Lite extraction with Contactable/Identifiable/Experienceable schema. Output flows through stageSignalCluster → scoreCluster → Review Queue. Source type 'linkedin_pdf', signal_confidence 0.85. Non-LinkedIn PDFs fall through to generic extraction.
- LinkedIn URL extraction: working — smart URL router in extract-url. Paste linkedin.com/in/ URL → ScrapingDog API → Career Lite entity + org entities → signal staging. Source type 'linkedin_api', signal_confidence 0.9. Falls back to generic web extraction if ScrapingDog fails.
- Name-and-Learn (Point Agent v1): working — DIRECTED collection mode (MECE-006). Type a person's name + optional context → Anthropic predicts LinkedIn slugs → ScrapingDog fetches profiles → Career Lite pipeline → signal staging. Handles disambiguation with candidate picker. Upload page has "Or search by name" input field.
- Adaptive entity rendering (MECE-007): working — getEntityDensity scores SKELETON/PARTIAL/RICH/COMPREHENSIVE. Dynamic lens sidebar (no SOON badges). Enrichment prompts for sparse entities. Density badge in hero cards.
- Connection Intelligence: working — src/health-analyzer.js. Duplicate detection (exact name, fuzzy first+last initial, entity_id). Relationship tiers T1-T5 (Follow→Family) with word-boundary matching. Phantom entity detection (AI assistants: Blossom, Buttercup, Claudine, etc). Tier-grouped connections UI with collapsed Follows toggle. Health banner shows duplicate/phantom/follows counts. GET /api/entity/:id/health endpoint.

## Known Issues
- 3 orphan entity files in graph root (outside any tenant) — not accessible via API
- MEASURE lever: nothing built (no metrics tracking)
- First-time social handle extraction scores Q1 (no way to match handle to name without prior data) — user must manually link on first encounter

## Agent System (MECE-005)
Three specialized agents map to the Data Lifecycle (MECE-001) states:

| Agent | Role | Owns | Data State |
|-------|------|------|------------|
| **collector** | Extraction & signal clustering | `src/scrapingdog.js`, `src/parsers/*`, extraction prompts | UNRESOLVED |
| **provisioner** | Scoring & matching | `src/signalStaging.js` (scoreCluster), matching algorithms | PROVISIONAL |
| **confirmer** | Resolution & graph writes | `src/signalStaging.js` (resolveCluster), `merge-engine.js`, `src/graph-ops.js` | CONFIRMED |

Pipeline: collector → provisioner → confirmer. No agent skips a state. See `.claude/agents.json` for full descriptions.

## Rules
- Always `git push` after completing a feature
- Always test on localhost before pushing
- Never delete ENT-CM-001.json (primary user entity)
- Use preview/approval mode for bulk operations
- Source-attribute every observation (type, url, extracted_at)
- Reuse existing extraction pipeline — don't rebuild what works
