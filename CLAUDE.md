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

## Current State (End of Day 4 — Feb 20, 2026)
- 120 entities in CJ's tenant (people, orgs, mixed)
- Wiki: profile mode, visual tiers (Gold/Green/Neutral/Muted), entity cards, sidebar nav
- Custom GPT: working, calls API, synthesizes pre-meeting briefings
- Google Drive picker: working with JSON support
- Career Lite + share links: working
- Overview page: working (ENT-CM-001 restored)
- OpenAPI spec: served at /openai-actions-spec.yaml

## Known Issues
- 3 orphan entity files in graph root (outside any tenant) — not accessible via API
- File purpose gate NOT built — self-profile docs create spurious entities
- Identity resolution is fuzzy name matching only (no semantic)
- MEASURE lever: nothing built (no metrics tracking)

## Day 5 Build Plan
See: CA_EXTRACT_Upgrade_Spec_Day5.docx (CJ will provide)
Priority: Push EXTRACT from Level 3 to Level 8
Builds: URL paste, LinkedIn PDF detection, Proxycurl integration, X/IG bios, company auto-enrich, GPT spec update

## Rules
- Always `git push` after completing a feature
- Always test on localhost before pushing
- Never delete ENT-CM-001.json (primary user entity)
- Use preview/approval mode for bulk operations
- Source-attribute every observation (type, url, extracted_at)
- Reuse existing extraction pipeline — don't rebuild what works
