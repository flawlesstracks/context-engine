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
| EXTRACT | ACQUIRE | 9.0 | 2026-02-21 | LinkedIn PDF auto-detect live, Proxycurl next |
| INTEGRATE | ACQUIRE | 5 | 2026-02-18 | ChatGPT history import |
| ELICIT | ACQUIRE | 1 | 2026-02-18 | GPT follow-up questions for thin entities |
| OBSERVE | ACQUIRE | 0.5 | 2026-02-18 | GPT auto-observe (write-back) |
| STRUCTURE | APPLY | 9 | 2026-02-20 | Signal staging up, entity tiers next |
| RETRIEVE | APPLY | 5 | 2026-02-18 | Semantic search (embeddings) |
| REASON | APPLY | 7 | 2026-02-18 | Multi-entity reasoning |
| DELIVER | APPLY | 8 | 2026-02-18 | Profile mode \+ visual tiers live |
| VERIFY | ASSESS | 3 | 2026-02-20 | Confidence scoring live, cross-source next |
| VALIDATE | ASSESS | 5.5 | 2026-02-20 | Review Queue live, thumbs up/down next |
| MEASURE | ASSESS | 0 | 2026-02-18 | Query metrics dashboard |
| LEARN | ASSESS | 0.5 | 2026-02-20 | Confidence auto-adjustment on Q2/Q4 |

**Overall: \~6.8 / 10**

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

