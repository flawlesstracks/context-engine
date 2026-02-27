# Context Architecture — Session Handoff Document

> Last updated: 2026-02-26 (end of Day 9 — Builds 15-21)
> Server: running on port 3000
> Branch: main, pushed to origin

---

## 0. Builds Shipped Today (Day 9)

### Build 19 — Form Field Matching Engine
- **POST /api/formfill/match**: Three-tier matching engine for form fields against extracted entities.
  - **Tier 1 — Direct mapping**: Dice coefficient bigram matching on field_id/display_name vs attribute keys. Exact and fuzzy (>=0.7 threshold). Uses original extraction confidence.
  - **Tier 2 — Entity-type inference**: Matches by entity_type + field_type patterns (EIN: XX-XXXXXXX, SSN: XXX-XX-XXXX, dates, currency, email, phone, address). Confidence penalized ×0.85.
  - **Tier 3 — AI-assisted**: Sends unmatched fields + unused data points to Claude for reasoning-based matching. Confidence penalized ×0.8, flagged as "AI-inferred".
- **Conflict detection**: When multiple observations match the same field, returns alternatives array with all options.
- **Unmatched fields**: Returned with `status: "missing"` and `confidence: 0` for manual entry in UI.

### Build 20 — Output Generation
- **POST /api/formfill/generate-pdf**: Dual-approach PDF filling via pdf-lib.
  - Approach A: Fillable field detection + name matching + value injection (for IRS/government forms).
  - Approach B: Text overlay page with all extracted values (for non-fillable forms).
- **POST /api/formfill/generate-csv**: CSV export with provenance columns (Field, Value, Confidence, Status, Match Method, Source File, Source Text, Entity).
- **POST /api/formfill/generate-json**: Machine-readable JSON export with full match data.
- **POST /api/formfill/generate-provenance**: Styled HTML provenance report — confidence badges, source snippets, match method for every field. Instrument Serif + DM Sans typography.
- **POST /api/formfill/analyze-form**: Upload blank form → AI extracts field map (reuses template generator pipeline).
- **POST /api/formfill/extract-sources**: Upload source docs → extract entities with provenance (multi-file, PDF/DOCX/XLSX/text).

### Build 21 — FormFill Single-Page UI
- **GET /formfill**: Standalone single-page product at `/formfill`.
- **Design**: Linear meets Notion — Instrument Serif headlines + DM Sans body. Warm white (#FAFAF9), deep blue accent (#2563EB), semantic confidence colors.
- **Three-step flow**:
  1. Drop zone for blank form → AI analyzes → shows field count + chip preview
  2. Drop zone for source docs (multi-file) → AI extracts → shows data point count per file
  3. "Fill My Form" button → progress animation → results table
- **Results table**: Matched fields (confidence badges, expandable source snippets, edit buttons) + Unmatched fields (manual input). Section grouping with staggered row animations.
- **Sticky download bar**: Filled PDF (primary), CSV (secondary), Provenance Report (tertiary).
- **Mobile-responsive**: Stacked layout, responsive typography.
- **No auth required** for the base flow.



### Build 15 — AI Template Generation from Uploaded Forms
- **POST /api/templates/generate**: Accepts file upload (PDF, DOCX, XLSX, CSV, TXT, images) or `text_input` with plain text requirements. Optional `name`, `description`, `practice_area` metadata.
- **Multi-format parsing**: PDF (pdf-parse), DOCX (mammoth), XLSX/XLS (xlsx → CSV), CSV/TXT (pass-through), images (Claude vision API with base64 encoding).
- **AI extraction prompt**: Structured prompt extracts document_types with extraction_specs, entity_roles with required_fields, cross_doc_rules — all with necessity_tiers, sensitivity levels, field types, auto_approve flags.
- **Template preview mode**: Generated template loads into Template Builder UI with AI preview banner: "AI-generated template from [filename]. Review and adjust before saving." Fields tagged with `ai_generated: true`.
- **POST /api/templates/generate/save**: Save reviewed AI-generated template to data/templates/.
- **Plain text support**: Bullet points like "Client name and DOB, Date of accident, Police report" → full template with inferred field types, tiers, and entity roles.
- **Frontend**: "AI Generate from Form" button in sidebar, drag-and-drop upload zone, text input area, loading spinner during generation.

### Build 16 — Client-Facing Smart Form
- **GET /api/spoke/:id/form**: Generates form schema from template — ordered sections (from document_types), fields with types/labels/required flags, upload zones.
- **GET /form/:shareToken**: Public mobile-first multi-step wizard form. No auth required.
  - One section visible at a time, progress bar at top
  - Field types: text, date, SSN (masked XXX-XX-XXXX with Show toggle), EIN (masked XX-XXXXXXX), phone (auto-format), email, currency, number, address (multi-field), boolean (toggle)
  - BLOCKING fields show red asterisk, EXPECTED fields shown without asterisk, ENRICHING fields hidden
  - Conditional logic engine: `show_if` and `hide_if` based on other field values
  - Auto-save every 2 seconds via POST /shared/:token/form-save
  - Resume on return — form state persisted to spoke
- **POST /shared/:token/form-submit**: Full submission with file uploads via FormData. Creates `form_submissions` entry on spoke, saves uploaded files, logs activity, invalidates gap cache.
- **Submission pipeline**: Fields saved as `form_state`, files saved to `spoke_files/`, activity logged as `form_submission`.
- **Share integration**: "Send Smart Form" button in Share tab generates form link.

### Build 17 — Event & Timeline Tracking
- **Event data model**: Events stored on spoke as `events[]` array. Each event: event_id, type, title, date, end_date, description, related_entities, related_documents, metadata (type-specific), source, created_at, created_by.
- **Event types**: medical_visit, payment, court_date, filing, deadline, treatment, communication, custom.
- **CRUD endpoints**: POST/GET/PUT/DELETE /api/spoke/:id/events. GET supports filters: `?type=`, `?from=`, `?to=`, `?sort=asc|desc`.
- **Payment summary**: GET /events returns `payment_summary` with total and breakdown by payment_method (lien, insurance, out_of_pocket, attorney_funded).
- **Deadline tracking**: `next_deadline` and `overdue_deadlines` count in events response.
- **Timeline tab**: New tab in client workspace. Vertical timeline with color-coded event cards (medical=blue, payment=green, court=red, deadline=orange, filing=purple). Filter chips by event type.
- **Payment summary widget**: Shows total costs, breakdown by method when payment events exist.
- **Overdue/upcoming deadline badges**: Red badge for overdue, orange for upcoming (7 days).
- **Add Event modal**: Type selector with type-specific fields (payment: amount + method, medical: provider + facility).
- **Dashboard enrichment**: Each spoke now returns `next_deadline`, `overdue_deadlines`, `event_count`, `last_event`. New filter chips: "Upcoming Deadlines (7d)", "Overdue Deadlines".

### Build 18 — Conversational Intake Agent
- **POST /api/spoke/:id/conversation**: Authenticated conversation endpoint. Template-driven AI walks through BLOCKING fields first, then EXPECTED. Returns `{ response, captured_fields, progress, is_complete }`.
- **GET /chat/:shareToken**: Public mobile-first chat interface. No auth required.
  - Clean chat bubbles (AI left, client right)
  - Text input with send button
  - Progress indicator: "X of Y required items"
  - File upload button for mid-conversation document uploads
  - "Switch to Form" link → opens /form/:shareToken pre-populated with captured data
- **POST /chat/:shareToken/message**: Public message endpoint. Each turn sends template context + captured fields to Claude. AI captures field values from natural language responses.
- **POST /chat/:shareToken/upload**: File upload during chat. Saves to spoke_files/, logs activity.
- **Field capture pipeline**: Captured fields stored in conversation session + synced to spoke `form_state` for form ↔ chat handoff.
- **Voice input**: Microphone button uses browser Web Speech API (SpeechRecognition). Feature-detected — only appears in supporting browsers. Pulsing red indicator when recording. Auto-sends transcribed text.
- **Conversation persistence**: Sessions stored in memory (keyed by session_id). Client can close and return.
- **Share integration**: "Send Conversation Link" button in Share tab generates chat link.

---

## Three Client-Facing Channels

| Channel | Route | Auth | Build |
|---------|-------|------|-------|
| Document Upload Portal | /shared/:token | No | 13 |
| Smart Form (wizard) | /form/:shareToken | No | 16 |
| Conversational Intake | /chat/:shareToken | No | 18 |

All three share the same spoke share token. Captured data flows to the same spoke. Form ↔ Chat handoff via shared `form_state`.

---

## What's Next

### Priorities for Next Session
- Full UX/UI overhaul of the main Context Architecture platform (5-screen redesign)
- FormFill enhancements: Integration connectors (pull source docs from Drive/ShareFile), form template library (pre-loaded IRS forms), batch mode (fill 20 forms at once), history/saved sessions
- Clio/ShareFile connector activation (sync client data from practice management)
- OCR for scanned PDFs (pdf-parse only extracts text layers; scanned images need OCR)
- Multi-user auth/RBAC (firm admin, attorney, paralegal, client roles)
- Event extraction from documents (medical records → medical_visit events, bills → payment events)

---

## Architecture Summary

### Key Files
| File | Purpose | Lines |
|------|---------|-------|
| `web-demo.js` | ALL routes + HTML templates | ~27K |
| `src/gap-analysis.js` | Template system, gap scoring | ~400 |
| `src/spoke-ops.js` | Hub-spoke management | ~200 |
| `src/signalStaging.js` | Confidence scoring, review queue | ~800 |
| `src/ingest-pipeline.js` | Entity ingestion | ~300 |
| `query-engine.js` | NL queries | ~36K |
| `universal-parser.js` | Multi-format parser | ~32K |

### Templates Available (6+)
- financial_review (v1.1.0) — 129 fields, 3 cross-doc rules
- tax_preparation (v1.1.0) — 80+ fields, 7 cross-doc rules
- personal_injury — 116 fields, 5 cross-doc rules
- estate_planning, corporate_formation, general
- Plus any AI-generated templates from Build 15

### All Public Routes (no auth)
| Route | Purpose |
|-------|---------|
| GET /shared/:shareId | Career Lite profile or client portal |
| POST /shared/:token/upload | Client file upload |
| POST /shared/:token/form-save | Save form progress |
| POST /shared/:token/form-submit | Submit completed form |
| GET /form/:shareToken | Smart form wizard |
| GET /chat/:shareToken | Conversational intake chat |
| POST /chat/:shareToken/message | Chat message endpoint |
| POST /chat/:shareToken/upload | Chat file upload |
| GET /formfill | FormFill single-page product |
| POST /api/formfill/analyze-form | Upload blank form → field map |
| POST /api/formfill/extract-sources | Upload source docs → entities |
| POST /api/formfill/match | Three-tier field matching |
| POST /api/formfill/generate-pdf | Download filled PDF |
| POST /api/formfill/generate-csv | Download CSV with provenance |
| POST /api/formfill/generate-json | Download JSON export |
| POST /api/formfill/generate-provenance | Download HTML provenance report |
