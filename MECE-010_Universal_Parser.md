# MECE-010: Universal Parser Specification

## Version: 1.0 | Date: 2026-02-22 | Author: CJ Mitchell + Claudine

---

## PURPOSE

Build a single function that takes ANY file and returns structured entities + relationships. No schema selection. No source type flags. No user configuration. The AI figures it out.

This is the extraction brain for the DXT MVP. Every other component depends on this.

```
parse(fileContent, filename) → { entities: [], relationships: [], metadata: {} }
```

---

## DESIGN PRINCIPLES

1. **Better than RAG**: Extracts structured entities and relationships, not just text chunks
2. **Easier than current pipeline**: No --type flag, no schema selection, no manual review
3. **Faster than manual**: One function call, any file, results in seconds

---

## ARCHITECTURE: FOUR SUB-PROBLEMS (MECE)

```
MECE-010: Universal Parser
├── P1: File Intelligence (What kind of file is this?)
│   ├── P1.1: Type Detection (extension + content sniffing)
│   ├── P1.2: Text Extraction (type-specific parsing)
│   └── P1.3: Fallback (treat as plain text)
├── P2: Entity Extraction (What entities are mentioned?)
│   ├── P2.1: PERSON (real or fictional)
│   ├── P2.2: ORGANIZATION (company, institution, group, team)
│   └── P2.3: CONCEPT (project, framework, product, topic, skill)
├── P3: Relationship Mapping (How do entities connect?)
│   ├── P3.1: Explicit relationships (stated in text)
│   ├── P3.2: Implicit relationships (co-mentioned, inferred)
│   └── P3.3: Hierarchical relationships (parent org, sub-project)
└── P4: Confidence Assignment (How sure are we?)
    ├── P4.1: Entity confidence (is this a real entity?)
    ├── P4.2: Attribute confidence (is this fact correct?)
    └── P4.3: Relationship confidence (are these connected?)
```

---

## P1: FILE INTELLIGENCE

### P1.1 Type Detection

Detect file type from extension first, content sniffing second.

| File Type | Extension | Content Signal | Priority |
|-----------|-----------|---------------|----------|
| PDF | .pdf | Binary header `%PDF` | HIGH — common in projects |
| JSON | .json | Starts with `{` or `[` | HIGH — structured data |
| Markdown | .md | Contains `#` headers, `**bold**`, `[links]()` | HIGH — common in projects |
| Plain Text | .txt | Fallback | HIGH |
| DOCX | .docx | ZIP with PK header | MEDIUM |
| CSV/TSV | .csv, .tsv | Comma/tab separated with consistent columns | MEDIUM |
| HTML | .html, .htm | Contains `<html>` or `<body>` tags | LOW |
| Chat Export | .json | JSON with `mapping` + `message` structure (ChatGPT format) | SPECIAL CASE |
| Structured Profile | .json | JSON with `entity_type` or `name` + `attributes` fields | SPECIAL CASE — direct import |

### P1.2 Text Extraction

Each file type needs a text extraction strategy:

```javascript
// PDF: use pdf-parse
const pdfParse = require('pdf-parse');
const data = await pdfParse(buffer);
const text = data.text;

// JSON: stringify with readable formatting, OR walk values
// If structured profile → direct import path (skip AI extraction)
// If chat export → ChatGPT ingest path (already built)
// Otherwise → JSON.stringify(parsed, null, 2)

// Markdown: strip formatting markers, keep structure
// Remove: **, __, `, #, [](), ![]()
// Keep: text content, list items, headers as section labels

// DOCX: use mammoth
const mammoth = require('mammoth');
const result = await mammoth.extractRawText({ buffer });
const text = result.value;

// CSV/TSV: parse with csv-parse, convert to readable text
// "Row 1: Name=John, Role=Engineer, Company=Acme"

// HTML: strip tags
const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Plain Text: use as-is
```

### P1.3 Fallback

If type detection fails or extraction errors out:
- Treat content as plain text
- Pass raw content to entity extraction
- Log warning: `"Could not determine file type for {filename}, treating as plain text"`

**CRITICAL RULE**: Never fail silently. Never return empty results without trying. Always attempt extraction even on unknown types.

---

## P2: ENTITY EXTRACTION

### Entity Types (Three-Tier)

**Tier 1 — Core Entities (always extract):**

| Type | Code | What It Captures | Examples |
|------|------|-----------------|----------|
| PERSON | `PERSON` | Any named individual, real or fictional | Steve Hughes, CJ Mitchell, Tony Stark |
| ORGANIZATION | `ORG` | Any named collective — company, school, team, agency, group | Amazon, Howard University, BDAT Group |
| CONCEPT | `CONCEPT` | Any named intangible — project, product, framework, skill, topic | Context Architecture, MECE Framework, Python |

**Tier 2 — Contextual (extract as attributes, promote if rich enough):**

| Type | Code | When Promoted to Entity | Default Behavior |
|------|------|------------------------|-----------------|
| PLACE | `PLACE` | Referenced by 3+ entities OR has own attributes beyond name | Stored as `location` attribute on Person/Org |
| EVENT | `EVENT` | Has attendees + outcomes + date (connects multiple entities) | Stored as observation: "Met at Q3 Board Meeting" |

**Promotion Rule**: After extraction, scan all attributes. If a PLACE or EVENT value appears across 3+ different entities, auto-promote it to a Tier 1 entity and convert the attribute references to relationships.

**NOT entities (captured differently):**

| Concept | How It Is Captured |
|---------|-------------------|
| Actions | Relationship: `CJ → [emailed] → Steve` |
| Tangible Objects | Attribute/observation: `"Drives a 1995 Honda Civic"` |

### Extraction Prompt

Send this to Claude API (Sonnet for speed, Opus for complex files):

```
You are an entity extraction system. Analyze the following content and extract all entities and relationships.

CONTENT SOURCE: {filename}
CONTENT:
{extracted_text}

INSTRUCTIONS:
1. Extract every named entity mentioned in this content
2. For each entity, determine its type: PERSON, ORG, or CONCEPT
3. For each entity, extract all attributes mentioned (role, location, age, description, dates, etc)
4. For every pair of entities that have a relationship, describe the connection
5. Assign confidence to each extraction based on how explicitly it appears in the text

RESPOND IN THIS EXACT JSON FORMAT:
{
  "entities": [
    {
      "name": "Full Name or Title",
      "type": "PERSON | ORG | CONCEPT",
      "attributes": {
        "key": "value"
      },
      "evidence": "The exact text that mentions this entity"
    }
  ],
  "relationships": [
    {
      "source": "Entity Name A",
      "target": "Entity Name B",
      "relationship": "description of connection",
      "direction": "A_TO_B | B_TO_A | BIDIRECTIONAL",
      "evidence": "The text establishing this relationship"
    }
  ],
  "file_summary": "One sentence describing what this file is about"
}

RULES:
- Extract EVERY entity, even if mentioned briefly
- Include full names when available, not just first names
- Attributes should be factual (role, location, dates) not interpretive
- Relationships should be specific: "works_at" not "is related to"
- If unsure about a fact, still extract it but note uncertainty in evidence
- Do NOT invent entities or relationships not present in the text
- Return valid JSON only, no markdown formatting
```

### Handling Large Files

If extracted text exceeds 100,000 characters:
1. Split into chunks of ~80,000 characters at paragraph boundaries
2. Process each chunk through the extraction prompt
3. Merge results: deduplicate entities by name (case-insensitive fuzzy match)
4. Combine attributes from multiple chunks for same entity
5. Union all relationships

### Handling Structured JSON

If P1 detects the file is already a structured profile (has `entity_type` or `name` + `type` fields):
- Skip AI extraction
- Map directly to entity schema
- Set confidence to HIGH (0.9) — user explicitly structured this data

If P1 detects ChatGPT export format:
- Route to existing ChatGPT ingest pipeline
- Already built and tested

---

## P3: RELATIONSHIP MAPPING

### Relationship Categories

Relationships are freeform strings, NOT a fixed enum. Let the AI describe naturally. Common patterns:

| Category | Example Relationships |
|----------|----------------------|
| Employment | works_at, employed_by, manages, reports_to, founded |
| Social | friend_of, married_to, parent_of, sibling_of, mentor_of |
| Education | attended, graduated_from, studied_at, taught_at |
| Project | created, contributes_to, owns, leads, member_of |
| Affiliation | belongs_to, member_of, affiliated_with, sponsors |
| Reference | mentions, discusses, cites, references |

### Relationship Properties

Each relationship should capture:

```javascript
{
  source: "Entity Name A",
  target: "Entity Name B", 
  relationship: "works_at",           // freeform string
  direction: "A_TO_B",               // A_TO_B | B_TO_A | BIDIRECTIONAL
  evidence: "CJ works at Amazon...",  // source text
  confidence: 0.8,                    // how sure
  temporal: {                         // optional
    start: "2023-01",
    end: null,                        // null = current/ongoing
    status: "active"                  // active | ended | unknown
  }
}
```

### Post-Processing

After extraction:
1. Normalize entity names (trim whitespace, title case for people)
2. Merge duplicate entities (fuzzy match with Dice coefficient > 0.8)
3. Merge duplicate relationships (same source + target + similar relationship type)
4. Resolve pronoun references where possible ("he" → most recently mentioned person)

---

## P4: CONFIDENCE ASSIGNMENT

### Entity Confidence

| Signal | Score |
|--------|-------|
| Named explicitly with multiple attributes | HIGH (0.85-1.0) |
| Named explicitly with minimal context | MEDIUM (0.6-0.8) |
| Named once in passing | LOW-MEDIUM (0.4-0.6) |
| Inferred but not named explicitly | LOW (0.2-0.4) |

### Attribute Confidence

| Signal | Score |
|--------|-------|
| Stated as fact: "Steve works at Meta" | HIGH (0.85) |
| Stated with qualifier: "Steve apparently works at Meta" | MEDIUM (0.6) |
| Inferred from context | LOW (0.4) |
| From structured source (JSON profile, CSV) | VERY HIGH (0.9) |

### Relationship Confidence

| Signal | Score |
|--------|-------|
| Explicitly stated: "CJ and Steve are friends" | HIGH (0.85) |
| Implied by context: both mentioned at same event | MEDIUM (0.5) |
| Inferred from co-mention in same paragraph | LOW (0.3) |

### Multi-File Boost

When the same entity appears across multiple files:
- 2 files agree → boost confidence by 0.1
- 3+ files agree → boost confidence by 0.15
- Cap at 0.95 (never 1.0 — only manual confirmation = 1.0)

When files CONTRADICT:
- Flag as conflict
- Keep both values with their individual confidences
- Do NOT auto-resolve — surface for user review

---

## OUTPUT SCHEMA

### parse() Return Format

```javascript
{
  // Metadata about the parsing job
  metadata: {
    filename: "steve-hughes-profile.json",
    file_type: "json",
    file_size: 4200,
    parse_strategy: "structured_import",  // or "ai_extraction" or "chat_import"
    parse_duration_ms: 1840,
    model_used: "claude-sonnet-4-5-20250929",  // or "direct_import" if structured
    chunk_count: 1,
    timestamp: "2026-02-22T12:00:00Z"
  },

  // Extracted entities
  entities: [
    {
      name: "Steve Hughes",
      type: "PERSON",
      attributes: {
        preferred_name: "Steve",
        full_name: "Steven W. Hughes",
        age: "40",
        location: "Atlanta, GA",
        date_of_birth: "1985-05-24",
        zodiac: "Gemini"
      },
      confidence: 0.9,
      evidence: "Steven W. Hughes, preferred name Steve, age 40..."
    }
  ],

  // Extracted relationships
  relationships: [
    {
      source: "Steve Hughes",
      target: "Meta",
      relationship: "works_at",
      direction: "A_TO_B",
      confidence: 0.85,
      evidence: "Steve works at Meta",
      temporal: { start: null, end: null, status: "active" }
    }
  ],

  // File-level summary
  summary: "Detailed psychological and relationship profile of Steve Hughes, including MBTI, enneagram, family details, and relationship dynamics with CJ Mitchell."
}
```

---

## IMPLEMENTATION PLAN

### File: `universal-parser.js`

```
Module Exports:
  parse(fileContent, filename) → { entities, relationships, metadata }
  
Internal Functions:
  detectFileType(fileContent, filename) → string
  extractText(fileContent, fileType) → string  
  extractEntities(text, filename) → { entities, relationships, summary }
  assignConfidence(entities, relationships) → { entities, relationships }
  postProcess(entities, relationships) → { entities, relationships }
```

### Dependencies

```json
{
  "pdf-parse": "^1.1.1",
  "mammoth": "^1.6.0",
  "csv-parse": "^5.5.0",
  "@anthropic-ai/sdk": "latest"
}
```

### Build Order

| Step | What | Test | Est. Time |
|------|------|------|-----------|
| 1 | Scaffold `universal-parser.js` with exports and type detection | `detectFileType()` correctly identifies 8+ file types | 20 min |
| 2 | Implement text extraction for each file type | `extractText()` returns clean text from PDF, JSON, MD, TXT, DOCX, CSV, HTML | 45 min |
| 3 | Build extraction prompt and Claude API call | `extractEntities()` returns entities + relationships from sample text | 30 min |
| 4 | Implement confidence assignment | `assignConfidence()` scores entities and relationships | 20 min |
| 5 | Implement post-processing (dedup, normalize, merge) | `postProcess()` merges duplicate entities, normalizes names | 30 min |
| 6 | Integration test: run 10 different file types through full pipeline | All return valid entities and relationships | 30 min |
| 7 | Wire into web-demo.js upload endpoint | Upload file via UI → entities appear in graph | 30 min |
| 8 | Wire into Render API `/api/ingest/universal` endpoint | POST file to API → entities in tenant graph | 20 min |

**Total estimated: ~3.5 hours**

### Test Files (Use Existing Project Files)

| File | Type | Expected Entities | Expected Relationships |
|------|------|-------------------|----------------------|
| ENT_STEVEN_HUGHES_001_v1_1.json | Structured JSON (direct import) | 1 PERSON (Steve), 1+ ORG (Meta) | Steve→Meta (works_at), Steve→CJ (friend_of) |
| CJ_Unified_Profile_v3_2_merged.json | Structured JSON | 1 PERSON (CJ), 5+ ORGs | Multiple employment, education, social |
| AI_Infrastructure_Investment_Thesis_2025-2027.md | Markdown | 10+ ORGs (Astera Labs, OKLO, etc), 5+ CONCEPTs | Company→Sector relationships |
| Context_Architecture_Build_Plan_v1.docx | DOCX | 3+ PERSONs, 5+ ORGs, 3+ CONCEPTs | Employment, product relationships |
| CJ_Carrie_Relationship_Timeline_2012_2021.json | Structured JSON | 2 PERSONs (CJ, Carrie) | married_to, parent_of (London) |
| Crossing_the_uncanny_valley_of_conversational_voice.pdf | PDF | 5+ ORGs, 10+ CONCEPTs | Technology relationships |
| Bloomberg_Sentence_Game_v1.md | Markdown | 5+ PERSONs, 3+ ORGs | Professional relationships |

---

## INTEGRATION POINTS

### With Existing Context Engine

The universal parser feeds INTO the existing pipeline:

```
User drops file
  → universal-parser.js: parse(content, filename)
  → Returns { entities, relationships }
  → Each entity → signalStaging.js: createCluster()
  → Provisioner scores clusters
  → User reviews in pipeline panel (or auto-confirms for DXT)
  → Confirmer merges into graph
```

### With DXT (Future)

```
DXT tool: build_graph()
  → Reads all project files from Claude context
  → For each file: universal-parser.js: parse(content, filename)
  → Merge all results into in-memory graph
  → Store graph as JSON in tool state
  → Claude can now query the graph
```

### With Render API (Future)

```
POST /api/ingest/universal
  Headers: X-Context-API-Key: ctx-xxxxx
  Body: { filename: "doc.pdf", content: base64_encoded_content }
  → universal-parser.js: parse(decoded_content, filename)
  → Merge into tenant graph
  → Return { entities_created: 5, relationships_created: 12 }
```

---

## SUCCESS CRITERIA

The universal parser is DONE when:

1. ✅ Accepts any file type (PDF, JSON, TXT, MD, DOCX, CSV, HTML) without configuration
2. ✅ Returns structured entities with type, attributes, and confidence scores
3. ✅ Returns relationships with source, target, type, and confidence
4. ✅ Handles structured JSON profiles via direct import (no AI call needed)
5. ✅ Handles ChatGPT exports via existing pipeline
6. ✅ Handles large files via chunking
7. ✅ Post-processes: deduplicates entities, normalizes names, merges attributes
8. ✅ Integrates with existing signal staging pipeline
9. ✅ Works as a standalone module (importable, no global state)
10. ✅ Tested with 7+ different file types from actual project data

---

## WHAT THIS SPEC DOES NOT COVER (Parked for Later)

- URL scraping / web extraction (ScrapingDog integration — separate module)
- Real-time monitoring / folder watching (already built, just needs parser swap)
- Graph query layer (MECE-011)
- DXT packaging (MECE-012)
- Multi-file cross-referencing (handled by merge engine, not parser)
- Conflict resolution UI (handled by pipeline panel)
