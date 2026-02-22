# Context Architecture — MECE Framework Registry

| The principle: MECE at the top. Infinite flexibility at the bottom. The framework never changes. Only the tactical solutions inside it evolve. Before every build: read this file. If your build touches a domain listed here, follow the framework. If your build reveals a new framework, add it here.  |
| :---- |

|  |
| :---- |

## How to Read This Document


Each MECE framework has three layers:

* **Layer 1 (MECE Framework):** The complete, exhaustive categories. Permanent. Never changes.  
* **Layer 2 (Behavioral Rules):** What the system does per category. Durable. Rarely changes.  
* **Layer 3 (Tactical):** Current implementation. Disposable. Changes often.

Only Layer 1 and Layer 2 live in this document. Layer 3 lives in the code.

All frameworks are organized under the AAA Loop — the meta-framework that governs  
everything Context Architecture builds.

|  |
| :---- |


## The AAA Loop: The Meta-Framework

The AAA Loop is to Context Intelligence what Build-Measure-Learn is to products.  
It is the continuous improvement cycle at the center of everything.

| Phase | Goal | Core Question | Time Metric |
| :---- | :---- | :---- | :---- |
| **ACQUIRE** | Relevance | Do we have the RIGHT information? | Time to Context |
| **APPLY** | Utility | Did we produce the RIGHT outcome? | Time to Utility |
| **ASSESS** | Accuracy | Were we actually RIGHT? | Time to Validation |

**Memory** is not a step in the loop. Memory is what the loop produces.  
ACQUIRE feeds INTO memory. APPLY reads FROM memory. ASSESS refines memory.  
Every spin makes memory larger, smarter, and faster.

| *The model is rented. The memory is owned.*  |
| :---- |

**North Star Metric:** Time from QUESTION to VALIDATED ANSWER.

|  |
| :---- |

## The 12 Levers of Context Intelligence

Each phase contains four levers — specific mechanisms that can be optimized.  
Together they form a complete diagnostic framework for any AI system.

### ACQUIRE — Reduce Time to Context

| Lever | Definition | Examples |
| :---- | :---- | :---- |
| **EXTRACT** | Pull from existing documents and files | PDFs, spreadsheets, email exports, chat histories |
| **INTEGRATE** | Connect to live systems | APIs, databases, Google Drive, Slack, CRMs |
| **ELICIT** | Generate through human interaction | Onboarding conversations, interviews, surveys |
| **OBSERVE** | Capture activity in real-time | Meeting transcripts, behavior logs, event streams |

MECE check: If data exists, you EXTRACT or INTEGRATE it. If it doesn't exist yet, you ELICIT or OBSERVE it.

### APPLY — Reduce Time to Utility

| Lever | Definition | Examples |
| :---- | :---- | :---- |
| **STRUCTURE** | Transform raw data into AI-ready format | Schema mapping, ontology creation, embeddings |
| **RETRIEVE** | Surface the right context at the right time | RAG, semantic search, relevance ranking |
| **REASON** | Process context to generate insight | Analysis, synthesis, inference, generation |
| **DELIVER** | Present output in the right format | Answers, reports, actions, API responses, UIs |

Every step from "I have data" to "I produced an outcome" passes through these four: prepare it, find it, think with it, output it.

### ASSESS — Reduce Time to Validation

| Lever | Definition | Examples |
| :---- | :---- | :---- |
| **VERIFY** | Check output against source/ground truth | Provenance tracking, citation matching |
| **VALIDATE** | Human confirms or rejects | SME review, thumbs up/down, corrections |
| **MEASURE** | Track quantitative outcomes | Task completion rate, accuracy scores, time saved |
| **LEARN** | Feed findings back into the system | Confidence adjustments, retraining signals |

ASSESS validates both ACQUIRE and APPLY. The LEARN lever closes the loop.

|  |
| :---- |

## The Fractal Principle

MECE frameworks are recursive. Every node in a framework can be decomposed into 
its own MECE underneath it. The structure holds at every zoom level:

AAA Loop (3 phases)
  └─ ACQUIRE (4 levers)
       └─ EXTRACT (10 levels)
            └─ Collector Agent (4 modes)
                 └─ DIRECTED mode (4 source types)
                      └─ Identity sources (specific platforms)

When building or debugging, zoom to the right level of the fractal:
- If the PROBLEM is "we're not getting enough data" → zoom to ACQUIRE levers
- If the PROBLEM is "extraction is missing things" → zoom to EXTRACT levels or Collector modes  
- If the PROBLEM is "we're getting noise" → zoom to Collection Filters
- If a MECE doesn't exist at the level you need, BUILD ONE before writing code

This is the core thinking pattern: decompose until you find the right layer, 
then solve at that layer without disturbing the layers above or below it.


## Framework Registry

Each framework below maps to one or more levers. This is how the MECE Funnel  
connects to the product.

| ID | Framework | Primary Lever(s) | Categories | Added |
| :---- | :---- | :---- | :---- | :---- |
| MECE-001 | Data Lifecycle | EXTRACT, STRUCTURE | 3 states, 4 quadrants | 2026-02-20 |
| MECE-002 | Confidence Scoring | VERIFY, VALIDATE, LEARN | 3 levels | 2026-02-20 |
| MECE-003 | Entity Hierarchy | STRUCTURE | 3 tiers | 2026-02-20 |
| MECE-004 | EXTRACT Levels | EXTRACT | 10 levels | 2026-02-19 |
| MECE-005 | Agent Architecture | EXTRACT, INTEGRATE | 3 agents, 4 quadrants | 2026-02-21 |
| MECE-006 | Collection Intelligence | EXTRACT | 4 modes, 4 source types, 4 filters | 2026-02-21 |
| MECE-007 | Entity Rendering | DELIVER | 4 types, 4 densities, 6 lenses | 2026-02-21 |
| MECE-010 | Universal Parser | EXTRACT, STRUCTURE | 4 sub-problems, 3 entity tiers, 3 parse strategies | 2026-02-22 |
| MECE-011 | Query Engine | RETRIEVE, REASON, DELIVER | 5 query types, 4 graph ops, 5 synthesis functions | 2026-02-22 |
| MECE-012 | Network Schema | STRUCTURE | 3 ownership tiers, 4 schema fields | 2026-02-22 |
| MECE-014 | Remote MCP Endpoint | DELIVER, INTEGRATE | 2 transports, 3 tools, 4 JSON-RPC methods | 2026-02-22 |

|  |
| :---- |

## MECE-001: Data Lifecycle

**Primary Levers:** EXTRACT, STRUCTURE  
**Domain:** How data enters, sits, resolves, and evolves in the system.

### Layer 1: Three Data States (MECE)

Every piece of data exists in exactly one of three states:

| State | Definition | Behavior |
| :---- | :---- | :---- |
| UNRESOLVED | Raw signal. No entity association. | Staging area. Awaits scoring or user action. |
| PROVISIONAL | Scored. Candidate match suggested. | Review Queue. User confirms, rejects, or holds. |
| CONFIRMED | User-verified or auto-confirmed (\>0.95). | Canonical record. Assembled from signal clusters. |

### Layer 1 (continued): Four Quadrants

Every incoming signal falls into one of four quadrants:

|  | New Entity | Existing Entity |
| :---- | :---- | :---- |
| **New Data** | Q1: CREATE — First signal, first entity. Held for user review. | Q2: ENRICH — New signal appends to existing. Nothing overwritten. |
| **Duplicate Data** | Q3: PROMOTE — Unresolved clusters consolidate. Corroboration immediate. | Q4: CONFIRM — Redundant signal strengthens confidence. No duplication. |

### Layer 2: Behavioral Rules

* All extraction paths feed through stageSignalCluster → scoreCluster → Review Queue  
* No entity auto-created without user confirmation (except \>0.95 auto-merge)  
* Q1: UNRESOLVED → "Create New Entity" action  
* Q2: PROVISIONAL → "Merge into \[Entity\]" action  
* Q3: Multiple unresolved clusters referencing same name → consolidation prompt  
* Q4: Source attribution added, confidence boosted, nothing new created

|  |
| :---- |

## MECE-002: Confidence Scoring

**Primary Levers:** VERIFY, VALIDATE, LEARN  
**Domain:** How the system measures trustworthiness of data.

### Layer 1: Three Confidence Levels (MECE)

| Level | What It Measures | When Set |
| :---- | :---- | :---- |
| Signal Confidence | How trustworthy is this data point by source? | Once, at extraction. |
| Association Confidence | How sure this cluster belongs to an entity? | During scoreCluster(). |
| Attribute Confidence | How sure a specific fact is true? | Recalculated on every merge/confirmation. |

### Layer 2: The Formula

| attribute\_confidence \= base\_source\_weight × recency\_modifier × corroboration\_multiplier |
| :---- |

**Base source weights:**

| Source | Weight |
| :---- | :---- |
| LinkedIn API (Proxycurl) | 0.9 |
| LinkedIn PDF | 0.85 |
| Company website | 0.8 |
| Uploaded document | 0.75 |
| Social media (X, Instagram) | 0.6 |
| Scraped web page | 0.5 |
| Mention in another doc | 0.4 |

**Recency modifier** (current-state attributes only, NOT historical facts):

| Age | Modifier |
| :---- | :---- |
| Within 6 months | 1.0 |
| 6-12 months | 0.95 |
| 1-2 years | 0.85 |
| 2-5 years | 0.7 |
| 5+ years | 0.5 |

**Corroboration multiplier:**

| Sources | Multiplier |
| :---- | :---- |
| 1 source | 1.0 |
| 2 independent sources | 1.3 |
| 3+ independent sources | 1.5 (cap) |

**Entity health:** Weighted average of all attribute confidences.

* Below 0.5 \= THIN (surfaces in Review Queue)  
* 0.5-0.8 \= DEVELOPING (functional, needs signal)  
* Above 0.8 \= STRONG (canonical record)

**Quadrant effects:**

* Q1: All attributes at floor (source weight × recency × 1.0)  
* Q2: New attributes added. Existing corroborated attributes bump to 1.3.  
* Q3: Shared attributes across clusters inherit corroboration immediately.  
* Q4: No new attributes. Confidence recalculates. Source added.

|  |
| :---- |

## MECE-003: Entity Hierarchy

**Primary Lever:** STRUCTURE  
**Domain:** How entities are classified and protected in the graph.

### Layer 1: Three Entity Tiers (MECE)

| Tier | Definition | Count | Protection |
| :---- | :---- | :---- | :---- |
| SELF | The graph owner. Center of the graph. | Exactly 1 per tenant. | Immutable. Cannot be deleted or overwritten by automation. |
| INNER | Entities with direct relationships to Self. | Variable. | Standard. Created/enriched through extraction. |
| OUTER | Entities with no direct Self relationship yet. | Variable. | Minimal. May connect through future discovery. |

### Layer 2: Behavioral Rules

* Self entity ID stored in tenant config (\_self.json)  
* Self entity cannot be deleted, overwritten, or modified by extraction pipelines  
* New signal about Self routes through staging as Q2 (enrich), never replaces  
* "My Profiles" sidebar renders from Self entity — hardcoded, not queried  
* Extraction, cleanup, migration scripts check entity\_tier before modifying  
* Self interfaces: Overview, Career Lite, Executive Brief, Creator Profile, Values & Identity

|  |
| :---- |

## MECE-004: EXTRACT Levels

**Primary Lever:** EXTRACT  
**Domain:** The 10-level capability scale for extraction.

### Layer 1: The 10 Levels (MECE)

| Level | Name | What It Eats |
| :---- | :---- | :---- |
| 1 | Single File | One file type (PDF only) |
| 2 | Multi-Format | PDF, DOCX, XLSX, CSV, TXT, JSON |
| 3 | Smart Detection | Multi-format \+ auto-detect document type |
| 4 | Multi-Source Merge | Second file enriches, not duplicates |
| 5 | Public URL | Paste any URL → entities extracted |
| 6 | Social Profiles | LinkedIn, X, Instagram, YouTube bios \+ metadata |
| 7 | Social Content | Posts, tweets, videos, engagement patterns |
| 8 | Web Intelligence | Company sites, blogs, news, press releases |
| 9 | Multi-Modal | Images, audio, video, podcasts, meetings |
| 10 | Universal Extraction | Any data, any format, any modality, any language |

### Layer 2: Behavioral Rules

* Levels 1-4 \= table stakes  
* Levels 5-7 \= differentiators  
* Levels 8-10 \= moats  
* Every level feeds through the Data Lifecycle (MECE-001) staging layer  
* Every extraction produces signal clusters, not finished entities  
* Current level: 6 (LinkedIn PDF auto-detect live, social profiles active)
* Levels 1-4 consolidated by universal parser (MECE-010): single function, any file, no type flags

|  |
| :---- |

## MECE-005: Agent Architecture

**Primary Levers:** EXTRACT, INTEGRATE
**Domain:** How data enters the system — which agent handles the interaction.

### Layer 1: Three Agents (MECE)

Every data acquisition interaction is handled by exactly one agent:

| Agent | Trigger | What It Does | Primary Lever |
| :---- | :---- | :---- | :---- |
| **Connect Agent** | User links an OAuth account (Google, LinkedIn, Slack) | Continuous crawl. Pulls new data on schedule. Maps connected accounts to entity graph. | INTEGRATE |
| **Point Agent** | User provides a name, URL, or handle | Fan-out across public sources (web, social, news). On-demand or monitor mode. | EXTRACT |
| **Paste Agent** | User uploads a file or pastes text | Extract entities and signals from provided content. Resolve against existing graph. | EXTRACT |

MECE check: Every way data enters the system is either connected (Connect), pointed at (Point), or handed over (Paste). No gaps. No overlaps.

### Layer 1 (continued): Agent Quadrant

|  | **Reactive (user-triggered)** | **Proactive (system-triggered)** |
| :---- | :---- | :---- |
| **Your Data** | Paste Agent — file/text upload, extract and resolve | Connect Agent — OAuth accounts, continuous crawl |
| **Public Data** | Point Agent (on-demand) — name/URL, fan-out search | Point Agent (monitor mode) — scheduled re-crawl of watched entities |

### Layer 2: Behavioral Rules

* Connect Agent sessions persist across logins. Re-crawl cadence configurable per source.
* Point Agent on-demand is single-shot: user provides target, system returns signals.
* Point Agent monitor mode is recurring: system re-checks watched targets on schedule.
* Paste Agent is always single-shot: user provides content, system extracts and resolves.
* All three agents feed through the Data Lifecycle (MECE-001) staging layer — no agent creates entities directly.
* All three agents produce signal clusters scored by Confidence Scoring (MECE-002).

|  |
| :---- |

## 12 Levers Scorecard (Living)

Track current state. Update after every build session.

| Lever | Phase | Current Score | Last Updated | Next Move |
| :---- | :---- | :---- | :---- | :---- |
| EXTRACT | ACQUIRE | 10 | 2026-02-22 | Universal parser live — any file type, smart detection, structured import, AI extraction, chunking |
| INTEGRATE | ACQUIRE | 6 | 2026-02-22 | ChatGPT history import + MCP protocol (Claude Desktop DXT + claude.ai Custom Connectors) |
| ELICIT | ACQUIRE | 1 | 2026-02-18 | GPT follow-up questions for thin entities |
| OBSERVE | ACQUIRE | 0.5 | 2026-02-18 | GPT auto-observe (write-back) |
| STRUCTURE | APPLY | 10 | 2026-02-22 | Universal parser + network schema: ownership tiers (self/owned/referenced), access rules, projection config, perspectives on every entity |
| RETRIEVE | APPLY | 8 | 2026-02-22 | Query engine: fuzzy search, BFS path finding, neighborhood queries, attribute filtering — graph traversal, not just text search |
| REASON | APPLY | 8.5 | 2026-02-22 | Query engine: 5 query types with answer synthesis — entity lookup, relationship traversal, aggregation, completeness analysis, contradiction detection |
| DELIVER | APPLY | 9 | 2026-02-22 | Query results in web UI + MCP protocol (DXT desktop + remote Streamable HTTP for claude.ai) — answer cards, path visualization, gap reports, conflict cards, entity links, programmatic tool access |
| VERIFY | ASSESS | 3 | 2026-02-20 | Confidence scoring live, cross-source next |
| VALIDATE | ASSESS | 5.5 | 2026-02-20 | Review Queue live, thumbs up/down next |
| MEASURE | ASSESS | 0 | 2026-02-18 | Query metrics dashboard |
| LEARN | ASSESS | 0.5 | 2026-02-20 | Confidence auto-adjustment on Q2/Q4 |

**Overall: \~7.7 / 10**

|  |
| :---- |


## MECE-006: Collection Intelligence

**Primary Lever:** EXTRACT
**Domain:** How the Collector agent acquires signal (not noise) across all sources.
**Parent in fractal:** Sits inside MECE-005 Agent Architecture → Collector Agent

### Layer 1: Four Collection Modes (MECE)

Every collection task operates in exactly one mode:

| Mode | Trigger | Intelligence Required | Autonomous? |
|------|---------|----------------------|-------------|
| DIRECTED | User says "learn about X" | Source discovery — WHERE to look | No — user-initiated |
| ENRICHMENT | Graph flags entity as THIN (<0.5 health) | Gap analysis — WHAT is missing | Yes — triggered by entity health |
| MONITORING | Schedule or event trigger | Change detection — WHAT changed | Yes — runs on schedule |
| EXPANSION | Entity references unknown entity | Relationship threading — WHO connects | Yes — triggered by graph analysis |

An adequate Collector does DIRECTED only. A beast does all four, 
and the last three are fully autonomous.

### Layer 1 (continued): Source Taxonomy

Within any mode, the Collector selects from four source types, 
prioritized in this order:

| Priority | Source Type | What It Reveals | Signal Quality | Cost |
|----------|------------|----------------|---------------|------|
| 1 | Identity sources | WHO — name, title, education, credentials | High (structured) | Low |
| 2 | Relationship sources | WHO THEY KNOW — connections, emails, meetings | High (behavioral) | High |
| 3 | Activity sources | WHAT THEY DO — posts, content, projects | Medium (noisy) | Medium |
| 4 | Context sources | WHERE THEY OPERATE — industry, company, news | Medium (broad) | Low |

Identity first because disambiguation must happen before fan-out.
Relationship second because it drives EXPANSION mode (graph growth).

### Layer 2: Signal Filters (applied before cluster creation)

| Order | Filter | Question | Kills |
|-------|--------|----------|-------|
| 1 | Relevance | Is this actually about our target entity? | Wrong person, tangential mentions, SEO spam |
| 2 | Novelty | Do we already have this? | Duplicates that would hit Q4 anyway |
| 3 | Completeness | Does this fill a gap? | Nice-to-know that doesn't improve entity health |
| 4 | Reliability | Is this source trustworthy for this claim? | Low-confidence claims from weak sources |

### Layer 2 (continued): Stop Conditions

| Condition | Meaning |
|-----------|---------|
| Entity health reaches STRONG (>0.8) | Enough corroborated signal — diminishing returns |
| All source types exhausted | Nothing left to check |
| 3 consecutive sources added zero new attributes | Diminishing returns detected |
| Rate limit or budget threshold hit | Cost control |
| User explicitly stops | Override |

### Layer 2 (continued): Entity Type Awareness

Not all entities enrich the same way:

| Entity Type | Primary Enrichment Path | Why |
|------------|------------------------|-----|
| Public professional | Outside-in: LinkedIn → X → company site → news | Rich public footprint |
| Private individual | Inside-out: ELICIT (ask user) → relationship signals | No public presence to scrape |
| Organization | Outside-in: website → news → SEC → job boards | Public by nature |
| Project/concept | Inside-out: documents → conversations → related entities | Exists in user's context, not public web |

|  |
| :---- |

## MECE-007: Entity Rendering

**Primary Lever:** DELIVER
**Domain:** How entities display in the wiki based on type, data density, and user perspective.
**Parent in fractal:** AAA Loop → APPLY → DELIVER → Entity Card

### Rendering Formula
```
Entity Type → determines WHICH sections are possible
Data Density → determines HOW MUCH renders
Profile Lens → determines WHAT perspective the user sees
```

All three dimensions are MECE. Every entity resolves to exactly one Type, one Density level, and one active Lens.

### Dimension 1: Entity Type

Each type defines a different card layout because they represent fundamentally different things.

| Type | Core Card Fields | Available Sections |
|------|-----------------|-------------------|
| PERSON | Name, headline, photo/initials, location, social links | Career, Education, Skills, Connections, Observations, Sources |
| ORGANIZATION | Name, type, industry, website, logo | People, Description, Roles, Connected Orgs, Observations |
| PROJECT | Name, status, description | Team, Timeline, Connected Entities, Observations |
| INSTITUTION | Name, type, location | Alumni/Members, Programs, Connected People, Observations |

### Dimension 2: Data Density

Determined by attribute coverage and source count. Thresholds:

| Density | Definition | Threshold | Rendering Strategy |
|---------|-----------|-----------|-------------------|
| SKELETON | Name + type only | <3 attributes filled | Minimal card. Prominent "Enrich" CTA. Show what's MISSING. |
| PARTIAL | Some attributes, gaps visible | 3-8 attributes, 1 source | Show what exists, gray out missing sections. Suggest next enrichment. |
| RICH | Most attributes, multiple sources | 8+ attributes, 2+ sources | Full card with all sections. Confidence indicators per section. |
| COMPREHENSIVE | Corroborated across sources, high confidence | 12+ attributes, 3+ sources, avg confidence >0.7 | Full card + provenance + confidence breakdown + change history |

### Dimension 3: Profile Lenses

Lenses are perspectives on the same underlying data. A lens ONLY appears in the sidebar when sufficient data exists to support it. No "SOON" badges — either the data supports it or the lens doesn't render.

| Lens | Shows | Minimum Data Required | Applies To |
|------|-------|----------------------|-----------|
| Overview | Dashboard — stats, coverage gaps, recent activity, sources | Always available (shows gaps for Skeleton) | All types |
| Career Lite | Professional timeline, education, skills | work_history array has 1+ entries | PERSON |
| Network Map | Visual connections to other entities | 3+ connections | All types |
| Intelligence Brief | Pre-meeting card — personality, communication, key context | 5+ observations from 2+ sources | PERSON |
| Org Brief | Company intelligence — size, industry, key people, news | 3+ attributes + 1+ connected person | ORGANIZATION |
| Source Provenance | Where every data point came from, when, confidence level | Always available (shows extraction history) | All types |

### Adaptive Rendering Rules

1. Sidebar lenses appear/disappear dynamically based on data density
2. Empty sections show "missing data" prompts with specific enrichment suggestions, not blank space
3. Confidence badges render on every section that has source attribution
4. Entity type determines the card template; density determines how much fills in
5. The Overview lens is always first and always available — it's the "what do we know and what's missing" view

### Entity Type → Density → Lens Examples

**Andre Burgin (PERSON, PARTIAL, Career Lite)**
- Has: name, headline, company, location, LinkedIn URL, 1 source
- Missing: work_history array, education details, skills list, social handles
- Career Lite shows: current company only, with prompt "Enrich from LinkedIn for full history"
- Overview shows: data coverage grid with Professional partially filled, Social/Personal empty

**Amazon (ORGANIZATION, RICH, Org Brief)**  
- Has: name, type, industry, website, 5 connected people, multiple sources
- Org Brief shows: full company card with people who work there, industry context
- Network Map shows: connections to CJ, Andre, other employees in graph

**Steven W. Hughes (PERSON, SKELETON, Overview only)**
- Has: name, relationship to Andre (son)
- Overview shows: minimal card, "Enrich" button, most sections empty with suggestions
- No other lenses available — insufficient data

## MECE-010: Universal Parser

**Primary Levers:** EXTRACT, STRUCTURE
**Domain:** How any file becomes structured entities and relationships in one function call.
**Parent in fractal:** AAA Loop → ACQUIRE → EXTRACT → File Intelligence

### Layer 1: Four Sub-Problems (MECE)

Every parse job decomposes into exactly four sub-problems:

| Sub-Problem | Question | Output |
|-------------|----------|--------|
| P1: File Intelligence | What kind of file is this? | file_type (pdf, json, markdown, docx, csv, tsv, html, plaintext, structured_profile, chat_export) |
| P2: Entity Extraction | What entities are mentioned? | PERSON, ORG, CONCEPT entities with attributes and evidence |
| P3: Relationship Mapping | How do entities connect? | Freeform relationship strings with direction and evidence |
| P4: Confidence Assignment | How sure are we? | Entity confidence (0.2-1.0), relationship confidence (0.3-0.85) |

### Layer 1 (continued): Three Parse Strategies (MECE)

Every file routes to exactly one strategy:

| Strategy | When | AI Call? | Confidence Floor |
|----------|------|----------|-----------------|
| structured_import | File has entity_type or name+attributes fields | No — direct mapping | 0.9 |
| chat_import | File has ChatGPT mapping+message structure | Routed to existing pipeline | Varies |
| ai_extraction | All other files | Yes — Claude Sonnet | Scored by P4 rules |

### Layer 1 (continued): Three Entity Tiers (MECE)

| Tier | Types | Extraction Rule |
|------|-------|----------------|
| Tier 1 — Core | PERSON, ORG, CONCEPT | Always extracted |
| Tier 2 — Contextual | PLACE, EVENT | Extracted as attributes; promoted to entity if referenced by 3+ entities |
| Not entities | Actions, tangible objects | Captured as relationships or observations |

### Layer 2: Behavioral Rules

* `parse(fileContent, filename)` is the single entry point — no type flags, no schema selection
* P1 runs extension detection first, content sniffing second, plaintext fallback third
* P1 NEVER fails silently — always attempts extraction, logs warning on unknown types
* P2 structured profiles skip AI entirely — direct field mapping at 0.9 confidence
* P2 large files (>100K chars) chunk at paragraph boundaries (~80K) and merge results
* P2 chunk merging deduplicates entities by name (case-insensitive)
* P3 relationships are freeform strings, not a fixed enum
* P4 confidence scores entities by attribute count + evidence length, relationships by verb specificity
* Post-processing: normalize names (title case for PERSON), dedup entities (Dice > 0.8), dedup relationships, promote PLACE/EVENT
* Output feeds into signal staging (MECE-001) — no entity created directly
* Module is standalone — importable with no global state

## MECE-011: Query Engine

**Primary Levers:** RETRIEVE, REASON, DELIVER
**Domain:** How natural language questions become graph traversals and structured answers.
**Parent in fractal:** AAA Loop → APPLY → RETRIEVE/REASON → Graph Query

### Layer 1: Five Query Types (MECE)

Every natural language question maps to exactly one type:

| Type | Pattern | Graph Operation |
|------|---------|----------------|
| ENTITY_LOOKUP | "Who is X", "Tell me about X" | Load entity, return profile |
| RELATIONSHIP | "How does X connect to Y" | BFS path finding between two entities |
| AGGREGATION | "How many", "List all", "Who are" | Filter + count/collect |
| COMPLETENESS | "What's missing", "What gaps" | Coverage analysis per entity |
| CONTRADICTION | "Any conflicts", "What disagrees" | Attribute comparison across sources |

### Layer 1 (continued): Four Graph Operations (MECE)

Every graph query uses one or more of these operations:

| Operation | Input | Output | Algorithm |
|-----------|-------|--------|-----------|
| searchEntities | query string + options | ranked entity matches | Dice coefficient fuzzy matching |
| findPaths | sourceId, targetId, index | shortest paths | BFS on bidirectional adjacency list |
| getNeighborhood | entityId, depth | concentric rings | BFS with depth tracking |
| filterEntities | attribute filters | matching entities | Predicate evaluation with dot notation |

### Layer 1 (continued): Five Synthesis Functions (MECE)

Each query type has a dedicated synthesis function:

| Function | Query Type | Output |
|----------|-----------|--------|
| synthesizeEntityAnswer | ENTITY_LOOKUP | Profile summary + attributes + relationship count |
| synthesizePathAnswer | RELATIONSHIP | Path narrative + hop count + intermediaries |
| synthesizeAggregationAnswer | AGGREGATION | Count + type breakdown + name listing |
| synthesizeCompletenessAnswer | COMPLETENESS | Coverage % + gap list + suggestions |
| synthesizeContradictionAnswer | CONTRADICTION | Conflict list + attribute comparison |

### Layer 2: Behavioral Rules

* `query(question, graphDir)` is the single entry point — classifies, resolves entities, traverses graph, synthesizes answer
* Classification uses keyword regex first (< 5ms) — no AI call for classification
* Entity resolution extracts names from questions using stop-word filtering + multi-word phrase matching
* Relationship index is bidirectional — `works_at` creates forward edge AND `employs` reverse edge
* Path finding respects maxDepth (default 4 hops) with visited set to prevent cycles
* Answer synthesis is template-based (< 10ms) — no AI call for synthesis in v1
* API endpoint: `GET /api/query?q=` returns full response schema with timing metadata
* Web UI search bar auto-detects questions and routes to query engine vs entity search
* All graph operations are pure traversal — no AI needed, completes in < 100ms

## MECE-012: Network Schema

**Primary Lever:** STRUCTURE
**Domain:** How entities declare ownership, access, and multi-perspective rendering in a networked graph.
**Parent in fractal:** AAA Loop → APPLY → STRUCTURE → Entity Schema

### Layer 1: Three Ownership Tiers (MECE)

Every entity in the graph has exactly one ownership state:

| Tier | Value | Set When | Meaning |
|------|-------|----------|---------|
| SELF | `"self"` | POST /api/self-entity designates the entity | This is the graph owner. Immutable core. Protected from automation. |
| OWNED | `"owned"` | POST /api/entity (manual creation) | User explicitly created this entity. Full editorial control. |
| REFERENCED | `"referenced"` | Signal staging create_new, universal parser output | Entity was extracted or discovered. User has data, not authorship. |

MECE check: Every entity is either the user themselves (SELF), something the user deliberately created (OWNED), or something the system found (REFERENCED). No gaps. No overlaps.

### Layer 1 (continued): Four Network Schema Fields (MECE)

Every entity carries four inert schema fields that enable future multi-tenant and multi-perspective features:

| Field | Type | Default | Future Purpose |
|-------|------|---------|---------------|
| `ownership` | string | `"referenced"` | Ownership tier (self/owned/referenced). Controls protection level. |
| `access_rules` | object | `{ visibility: "private", shared_with: [] }` | Who can see this entity. Enables shared graphs and team workspaces. |
| `projection_config` | object | `{ lenses: ["default"] }` | Which rendering lenses apply. Enables role-based views (recruiter vs investor). |
| `perspectives` | array | `[]` | Multiple viewpoints on the same entity from different observers. |

### Layer 2: Behavioral Rules

* Every entity creation path stamps all four fields with defaults — no entity exists without them
* `POST /api/entity` sets ownership to `"owned"` + `owner_tenant_id` from auth context
* `POST /api/self-entity` upgrades the designated entity to `ownership: "self"`
* Signal staging `create_new` sets ownership to `"referenced"` — user discovered, not authored
* Universal parser output includes all four fields on every extracted entity
* All fields are currently INERT — no access control logic, no projection filtering, no perspective merging
* Fields exist so future features (shared graphs, team views, multi-perspective) don't require schema migration
* `owner_tenant_id` is set on SELF and OWNED entities, null on REFERENCED

|  |
| :---- |

## MECE-014: Remote MCP Endpoint

**Primary Levers:** DELIVER, INTEGRATE
**Domain:** How Claude (Desktop and web) connects to the Context Engine graph via the Model Context Protocol.
**Parent in fractal:** AAA Loop → APPLY → DELIVER → Programmatic Access

### Layer 1: Two Transports (MECE)

Every MCP connection uses exactly one transport:

| Transport | Protocol | Client | Deployment |
|-----------|----------|--------|------------|
| stdio | JSON-RPC over stdin/stdout | Claude Desktop (DXT package) | Local — runs on user's machine |
| Streamable HTTP | JSON-RPC over HTTP POST | claude.ai Custom Connectors | Remote — runs on Render server |

MECE check: MCP defines exactly two transports. Desktop apps use stdio. Web/cloud apps use HTTP. No gaps. No overlaps.

### Layer 1 (continued): Three Tools (MECE)

Every MCP interaction invokes exactly one tool:

| Tool | AAA Phase | Input | Output | Internal Path |
|------|-----------|-------|--------|---------------|
| build_graph | ACQUIRE | files[] (filename + content), source | entities staged, file results, graph count | universalParse → stageAndScoreExtraction |
| query | APPLY | question (natural language) | answer, query_type, entities, paths, gaps, conflicts, confidence, timing | queryEngine (MECE-011) |
| update | APPLY | action (add_observation, add_relationship, get_entity, list_entities) + params | action-specific result | graph-ops CRUD (readEntity, writeEntity, listEntities) |

MECE check: You either ADD data (build_graph), ASK about data (query), or MODIFY data (update). All graph operations fall into one of these three.

### Layer 1 (continued): Four JSON-RPC Methods (MECE)

Every MCP message is one of four method types:

| Method | Direction | Purpose |
|--------|-----------|---------|
| initialize | Client → Server | Handshake — negotiate protocol version, exchange capabilities |
| tools/list | Client → Server | Discovery — client learns available tools and their schemas |
| tools/call | Client → Server | Execution — invoke a tool with arguments, get result |
| ping | Client → Server | Health check — verify server is alive |

### Layer 2: Behavioral Rules

* stdio transport (DXT): MCP SDK handles framing. Server calls Render API over HTTP. Runs locally via Claude Desktop.
* Streamable HTTP transport (remote): Express route at `POST /mcp` handles JSON-RPC directly. No SDK needed server-side.
* Remote endpoint calls internal functions directly — no HTTP self-calls, no localhost fetch loops
* Auth: `X-Context-API-Key` header required on all `POST /mcp` requests. Same apiAuth middleware as REST endpoints.
* Discovery: `GET /.well-known/mcp.json` returns auto-discovery manifest. `GET /mcp` returns server metadata + tool list.
* Tool schemas are identical across both transports — same inputSchema definitions in DXT manifest and remote endpoint
* Notifications (e.g., `notifications/initialized`) are acknowledged silently — no response needed per JSON-RPC spec
* Error responses use standard JSON-RPC error codes: -32601 (method not found), -32602 (invalid params), -32603 (internal error)
* All tool handlers are async — `build_graph` runs universal parser, `query` awaits queryEngine, `update` reads/writes graph files
* MCP protocol version: `2024-11-05` — returned in initialize handshake

|  |
| :---- |

## Adding a New MECE Framework

When a build session reveals a new domain that needs MECE coverage:

1. Identify which AAA Loop lever(s) it maps to  
2. Define Layer 1: What are ALL the possible categories? Mutually exclusive? Collectively exhaustive?  
3. Define Layer 2: What does the system DO for each category?  
4. Add to the Registry table with lever mapping  
5. Do NOT include Layer 3 — that lives in the code  
6. Update the 12 Levers Scorecard if the build changed any scores  
7. Commit MECE.md as part of the same commit as the build

