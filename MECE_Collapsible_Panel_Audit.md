# Context Architecture: MECE Workflow Audit
## Where does the "Context Pane + Working Area" pattern apply?

---

## The Pattern

Inspired by Claude.ai's UI:
- **LEFT (Context Pane):** Navigation, conversation, metadata, "the why"
- **RIGHT (Working Area):** The document, form, output, data — "the what"
- **LEFT collapses** when user needs focus on the working area
- **RIGHT expands** to fill the screen

This pattern is powerful when: the user is COMPARING input to output, reviewing AI work, or needs to toggle between "understanding context" and "doing work."

---

## MECE Workflow Inventory

### CATEGORY 1: CREATION WORKFLOWS (Building something new)

#### 1A. Template Creation (Build 27 — Template Editor)
**USE THIS PATTERN? ✅ YES — PRIMARY USE CASE**

| Left (Context) | Right (Working Area) |
|---|---|
| Uploaded source document rendered/previewed | Field cards being configured |
| Shows WHERE in the document fields were detected | Shows WHAT each field is and how it's configured |
| Collapsible when user is just editing field properties | Expandable for focused field configuration |

Current state: Already a split-screen (Build 27). But the left panel is fixed. Making it collapsible lets users focus entirely on field cards when they're in configuration mode, then expand left when they need to reference the source document.

**Enhancement:** When left is collapsed, show a thin strip with field count + document name so user retains orientation.

---

#### 1B. New Matter Creation (Flow 3)
**USE THIS PATTERN? ⚠️ PARTIAL — Modal is fine for creation, pattern applies AFTER creation**

The actual creation is a modal (client name + template + file drop). The pattern kicks in once the matter exists and the user lands on the Matter View. See 2A below.

---

#### 1C. Client Intake Design (provider configuring what clients see)
**USE THIS PATTERN? ✅ YES**

| Left (Context) | Right (Working Area) |
|---|---|
| Template field definitions (what data you need) | Preview of client-facing form (what Maria sees) |
| Provider controls: which fields, ordering, required vs optional | Live preview updating as controls change |
| Collapsible for full-screen preview | Expandable to see exactly what client experiences |

Not built yet, but when the intake designer exists, this pattern is perfect. Left = configuration, Right = live preview of the mobile form.

---

### CATEGORY 2: REVIEW WORKFLOWS (Evaluating AI output)

#### 2A. Matter Review / Verification (Build 26 — Matter View)
**USE THIS PATTERN? ✅ YES — HIGH VALUE**

| Left (Context) | Right (Working Area) |
|---|---|
| Source documents list + document viewer | Extracted data table with approve/correct/reject |
| Shows the ORIGINAL document text | Shows what the AI EXTRACTED from it |
| Collapsible when bulk-approving (don't need source) | Expandable for focused field-by-field review |

This is the "comparing input to output with context" use case you described. The left shows what Maria submitted. The right shows what the AI made of it. When Jada is bulk-approving 12 low-risk fields, she collapses the left. When she's verifying a critical SSN extraction, she expands the left to see the source document side by side.

**This solves the "too busy" problem from Build 26.** Instead of three fixed panels always visible, the left (documents) and right (missing items) become collapsible context panes, with the center (extracted data) as the permanent working area.

**Revised Matter View layout:**
- LEFT (collapsible): Documents received + document viewer
- CENTER (always visible): Extracted data with inline review — THE working area
- RIGHT (collapsible): What's missing + Review Queue

User can collapse both sides for pure data review focus, or expand either side for context.

---

#### 2B. Conflict Resolution (Flow 7 — two sources disagree)
**USE THIS PATTERN? ✅ YES**

| Left (Context) | Right (Working Area) |
|---|---|
| Source A document viewer | Source B document viewer |
| OR: Both sources shown as context | Resolution interface: pick A, pick B, or enter correct value |

When two documents disagree on a value, the user needs to see both sources and make a decision. Left = source evidence. Right = resolution workspace. Collapse left after deciding to move through remaining conflicts quickly.

---

#### 2C. FormFill Results Review (Flows 1 & 2)
**USE THIS PATTERN? ✅ YES — STRONG FIT**

| Left (Context) | Right (Working Area) |
|---|---|
| Original blank form / template | Filled results table with provenance |
| Shows WHAT was asked for | Shows WHAT was extracted + matched |
| Collapsible after confirming results look right | Expandable for download + conversion zone |

This is literally "comparing input to output." The user uploaded a blank W-9 (left) and source documents. The right shows every field filled with confidence scores. Collapse the left when you're satisfied and ready to download.

**For Mode 2 (Document Generate):** Left shows the original template with [VARIABLE] placeholders. Right shows Old Value → New Value replacements. Perfect comparison view.

---

### CATEGORY 3: TRIAGE WORKFLOWS (Quick decisions across many items)

#### 3A. Dashboard / Portfolio Triage (Build 25)
**USE THIS PATTERN? ❌ NO**

The dashboard is a single-panel execution engine. There's no "source vs. output" comparison happening. The user is scanning a list and taking inline actions. The hero stats + blocking tray + matter list is the right pattern here.

The right panel (Review Queue) on the dashboard IS collapsible — but the main dashboard content doesn't benefit from expanding further. Keep the current layout with the collapsible Review Queue from Build 30.

---

#### 3B. Cross-Matter Review Queue (Screen P5)
**USE THIS PATTERN? ⚠️ PARTIAL**

| Left (Context) | Right (Working Area) |
|---|---|
| Queue of items across all matters | Selected item: full provenance detail |
| List view with priority sorting | Deep-dive on one field at a time |
| Always visible as navigation | Expandable for focused review |

The left here is navigation (the queue), not collapsible context. The right is the detail view. This is more of a master-detail pattern than a context-vs-working-area pattern. Left stays fixed as the queue; right shows the selected item.

---

### CATEGORY 4: CLIENT-FACING WORKFLOWS (Maria's experience)

#### 4A. Client Smart Form (Build 28 — Intake)
**USE THIS PATTERN? ❌ NO**

Mobile-first, one question per screen. No split panel. No context pane. The entire screen IS the working area. This is a single-column wizard — adding a collapsible panel would break the mobile-first simplicity.

---

#### 4B. Client Conversation Path (AI chat intake)
**USE THIS PATTERN? ❌ NO**

Same reasoning as 4A. Chat is a single-column experience. The AI conversation IS the interface. No split needed.

---

### CATEGORY 5: GENERATION WORKFLOWS (Producing output documents)

#### 5A. Document Generation Preview (Mode 2 output)
**USE THIS PATTERN? ✅ YES — STRONG FIT**

| Left (Context) | Right (Working Area) |
|---|---|
| Source documents that fed the generation | Generated document preview (demand letter, contract) |
| Provenance panel: where each value came from | The actual output with highlighted replacements |
| Collapsible for focused document reading | Expandable for full-screen document review |

When Jada generates a demand letter, she wants to READ the output document. But she also needs to spot-check that the medical billing total came from the right source. Left = provenance context. Right = the generated document. Collapse left for reading mode, expand left to verify a specific number.

---

#### 5B. Export / Report Generation
**USE THIS PATTERN? ❌ NO**

Export is a button click → download. No comparison interface needed.

---

### CATEGORY 6: CONFIGURATION WORKFLOWS (System setup)

#### 6A. Clio/ShareFile Connector Setup (INTEGRATE lever)
**USE THIS PATTERN? ❌ NO**

Settings/configuration screens are forms. Single-column or tabbed. No comparison.

---

#### 6B. Firm Settings / User Management
**USE THIS PATTERN? ❌ NO**

Same as 6A. Admin screens don't benefit from this pattern.

---

## SUMMARY: Where the Pattern Applies

| Workflow | Pattern? | Left (Context) | Right (Working Area) |
|---|---|---|---|
| **Template Creation** | ✅ YES | Source document | Field cards |
| **Matter Review** | ✅ YES | Source documents | Extracted data table |
| **Conflict Resolution** | ✅ YES | Both source docs | Resolution interface |
| **FormFill Results (Mode 1)** | ✅ YES | Original blank form | Filled results |
| **FormFill Results (Mode 2)** | ✅ YES | Original template | Generated doc + replacements |
| **Document Generation Preview** | ✅ YES | Source provenance | Generated output |
| **Intake Designer (future)** | ✅ YES | Field configuration | Live client preview |
| **Cross-Matter Queue** | ⚠️ Partial | Queue navigation | Item detail |
| **New Matter Creation** | ⚠️ Partial | Modal → then Matter View |  |
| **Dashboard** | ❌ NO | Single execution engine | |
| **Client Intake** | ❌ NO | Mobile single-column | |
| **Client Chat** | ❌ NO | Chat single-column | |
| **Export** | ❌ NO | Button click | |
| **Settings** | ❌ NO | Forms | |

**Score: 6 strong YES, 2 partial, 6 NO.**

The pattern applies to every workflow where the user is COMPARING input to output, or REVIEWING AI work against source material. It does NOT apply to triage (dashboard), mobile (client intake), or configuration (settings).

---

## ARCHITECTURAL IMPLICATION

This means the collapsible context/working area split should be a **reusable component**, not bespoke per screen. Build it once with:

1. A left pane that accepts any content (document viewer, source list, field definitions)
2. A right pane that accepts any content (data table, field cards, generated document)
3. A collapse toggle with 300ms ease-in-out animation (matching Claude's pattern)
4. localStorage persistence of collapse state per screen
5. A thin collapsed strip showing orientation info (document name, field count, etc.)

Then every ✅ screen above just plugs its content into the left and right slots.

---

## RECOMMENDED BUILD ORDER FOR STREAMLINING

1. **Build the reusable split-panel component** with collapse behavior
2. **Retrofit Matter View (Build 26)** — this is the "too busy" screen. Replace three fixed panels with collapsible left (docs) + center working area (data) + collapsible right (missing/review)
3. **Retrofit Template Editor (Build 27)** — already split-screen, just add collapse
4. **Retrofit FormFill Results (Build 29)** — add left panel showing original form when results display
5. **Leave Dashboard, Client Intake, and Settings as-is** — they don't benefit from this pattern
