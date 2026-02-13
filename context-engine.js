#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { program } = require('commander');
const Anthropic = require('@anthropic-ai/sdk').default;

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- CLI Setup ---

program
  .name('context-engine')
  .description('Extract structured context from unstructured text using the Anthropic API')
  .requiredOption('--input <filepath>', 'Path to the input text file')
  .requiredOption('--output <filepath>', 'Path to write the output JSON file')
  .requiredOption('--type <type>', 'Entity type: person or business')
  .option('--schema-version <version>', 'Schema version: 1.0 or 2.0', '2.0')
  .parse();

const opts = program.opts();

// --- Validation ---

if (!['person', 'business'].includes(opts.type)) {
  console.error(`Error: --type must be "person" or "business". Got "${opts.type}".`);
  process.exit(1);
}

if (!['1.0', '2.0'].includes(opts.schemaVersion)) {
  console.error(`Error: --schema-version must be "1.0" or "2.0". Got "${opts.schemaVersion}".`);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY not found.');
  console.error('Create a .env file in the project root with:');
  console.error('  ANTHROPIC_API_KEY=your-key-here');
  console.error('See .env.example for reference.');
  process.exit(1);
}

const inputPath = path.resolve(opts.input);
if (!fs.existsSync(inputPath)) {
  console.error(`Error: Input file not found: ${inputPath}`);
  console.error('Check that the file path is correct and the file exists.');
  process.exit(1);
}

// --- V1 Schemas (backward compat) ---

const V1_PERSON_SCHEMA = `{
  "entity_type": "person",
  "name": { "full": "", "preferred": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "attributes": { "role": "", "location": "", "expertise": [] },
  "relationships": [{ "name": "", "relationship": "", "context": "" }],
  "values": [],
  "communication_style": { "tone": "", "preferences": [] },
  "active_projects": [{ "name": "", "status": "", "description": "" }],
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

const V1_BUSINESS_SCHEMA = `{
  "entity_type": "business",
  "name": { "legal": "", "common": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "industry": "",
  "products_services": [],
  "key_people": [{ "name": "", "role": "", "context": "" }],
  "values": [],
  "customers": { "target": "", "segments": [] },
  "competitive_position": "",
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

// --- V2 Schemas ---

const V2_PERSON_SCHEMA = `{
  "schema_version": "2.0",
  "schema_type": "context_architecture_entity",
  "extraction_metadata": {
    "extracted_at": "ISO-8601 timestamp",
    "source_text_hash": "SHA-256 of input text",
    "source_description": "Brief description of source document",
    "extraction_model": "claude-sonnet-4-5-20250929",
    "extraction_confidence": 0.85,
    "word_count": 0,
    "extraction_notes": []
  },
  "entity": {
    "entity_type": "person",
    "entity_id": "ENT-[INITIALS]-[3-DIGIT-NUMBER]",
    "name": {
      "full": "",
      "preferred": "",
      "aliases": [],
      "confidence": 0.95,
      "facts_layer": 1
    },
    "summary": {
      "value": "2-3 sentence synthesis",
      "confidence": 0.80,
      "facts_layer": 2
    }
  },
  "attributes": [
    {
      "attribute_id": "ATTR-001",
      "key": "role",
      "value": "",
      "confidence": 0.90,
      "confidence_label": "VERIFIED|STRONG|MODERATE|SPECULATIVE|UNCERTAIN",
      "time_decay": {
        "stability": "permanent|stable|semi_stable|volatile|ephemeral",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 180
      },
      "source_attribution": {
        "origin": "description of where this came from",
        "facts_layer": 1,
        "layer_label": "objective|group|personal"
      },
      "constraint_linkages": [],
      "actions": []
    }
  ],
  "relationships": [
    {
      "relationship_id": "REL-001",
      "name": "",
      "entity_id_ref": null,
      "relationship_type": "spouse|child|parent|colleague|friend|mentor|ex|business_partner",
      "relationship_label": "",
      "context": "",
      "sentiment": "positive|neutral|strained|complex|unknown",
      "confidence": 0.80,
      "confidence_label": "STRONG",
      "time_decay": {
        "stability": "stable",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 365
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      },
      "constraint_linkages": [],
      "actions": []
    }
  ],
  "values": [
    {
      "value_id": "VAL-001",
      "value": "",
      "interpretation": "How this value manifests in behavior",
      "confidence": 0.85,
      "confidence_label": "STRONG",
      "time_decay": {
        "stability": "stable",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 365
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 3,
        "layer_label": "personal"
      }
    }
  ],
  "communication_style": {
    "tone": "",
    "preferences": [],
    "confidence": 0.75,
    "source_attribution": {
      "origin": "",
      "facts_layer": 2,
      "layer_label": "group"
    },
    "actions": []
  },
  "active_projects": [
    {
      "project_id": "PROJ-001",
      "name": "",
      "status": "active|paused|completed|planned",
      "description": "",
      "confidence": 0.80,
      "time_decay": {
        "stability": "volatile",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 60
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      },
      "constraint_linkages": [],
      "actions": []
    }
  ],
  "key_facts": [
    {
      "fact_id": "FACT-001",
      "fact": "",
      "confidence": 0.90,
      "confidence_label": "VERIFIED",
      "time_decay": {
        "stability": "permanent",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": null
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "translations": [
    {
      "translation_id": "TRANS-001",
      "literal_input": "What this person typically says",
      "true_intent": "What they actually mean",
      "not_intent": "What they do NOT mean",
      "confidence": 0.70,
      "source_attribution": {
        "origin": "behavioral observation from source text",
        "facts_layer": 3,
        "layer_label": "personal"
      },
      "actions": []
    }
  ],
  "constraints": [
    {
      "constraint_id": "CON-EXT-001",
      "name": "",
      "type": "absolute|conditional|contextual|behavioral",
      "description": "What boundary or rule applies",
      "trigger_condition": "When this activates",
      "violation_response": "What AI should do if violated",
      "confidence": 0.85,
      "source_attribution": {
        "origin": "",
        "facts_layer": 3,
        "layer_label": "personal"
      }
    }
  ],
  "provenance_chain": {
    "created_at": "ISO-8601",
    "created_by": "context-engine-v2",
    "source_documents": [
      {
        "source_id": "SRC-001",
        "filename": "",
        "content_hash": "",
        "extraction_date": ""
      }
    ],
    "merge_history": []
  }
}`;

const V2_BUSINESS_SCHEMA = `{
  "schema_version": "2.0",
  "schema_type": "context_architecture_entity",
  "extraction_metadata": {
    "extracted_at": "ISO-8601 timestamp",
    "source_text_hash": "SHA-256 of input text",
    "source_description": "",
    "extraction_model": "claude-sonnet-4-5-20250929",
    "extraction_confidence": 0.85,
    "word_count": 0,
    "extraction_notes": []
  },
  "entity": {
    "entity_type": "business",
    "entity_id": "ENT-BIZ-[ABBREV]-[3-DIGIT-NUMBER]",
    "name": {
      "legal": "",
      "common": "",
      "aliases": [],
      "confidence": 0.95,
      "facts_layer": 1
    },
    "summary": {
      "value": "",
      "confidence": 0.80,
      "facts_layer": 2
    }
  },
  "attributes": [
    {
      "attribute_id": "ATTR-001",
      "key": "industry",
      "value": "",
      "confidence": 0.90,
      "confidence_label": "VERIFIED",
      "time_decay": {
        "stability": "stable",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 365
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "products_services": [
    {
      "product_id": "PROD-001",
      "name": "",
      "description": "",
      "status": "active|planned|deprecated",
      "confidence": 0.85,
      "time_decay": {
        "stability": "semi_stable",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 180
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "key_people": [
    {
      "person_id": "PERSON-001",
      "name": "",
      "entity_id_ref": null,
      "role": "",
      "context": "",
      "confidence": 0.85,
      "time_decay": {
        "stability": "semi_stable",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": 180
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "values": [
    {
      "value_id": "VAL-001",
      "value": "",
      "interpretation": "",
      "confidence": 0.75,
      "source_attribution": {
        "origin": "",
        "facts_layer": 2,
        "layer_label": "group"
      }
    }
  ],
  "customers": {
    "target_market": "",
    "segments": [
      {
        "segment_id": "SEG-001",
        "name": "",
        "description": "",
        "confidence": 0.80,
        "source_attribution": {
          "origin": "",
          "facts_layer": 2,
          "layer_label": "group"
        }
      }
    ]
  },
  "competitive_position": {
    "summary": "",
    "differentiators": [],
    "confidence": 0.70,
    "source_attribution": {
      "origin": "",
      "facts_layer": 2,
      "layer_label": "group"
    }
  },
  "key_facts": [
    {
      "fact_id": "FACT-001",
      "fact": "",
      "confidence": 0.90,
      "confidence_label": "VERIFIED",
      "time_decay": {
        "stability": "permanent",
        "captured_date": "YYYY-MM-DD",
        "refresh_interval_days": null
      },
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "constraints": [
    {
      "constraint_id": "CON-BIZ-001",
      "name": "",
      "type": "regulatory|operational|strategic|financial",
      "description": "",
      "confidence": 0.80,
      "source_attribution": {
        "origin": "",
        "facts_layer": 1,
        "layer_label": "objective"
      }
    }
  ],
  "provenance_chain": {
    "created_at": "ISO-8601",
    "created_by": "context-engine-v2",
    "source_documents": [],
    "merge_history": []
  }
}`;

// --- Prompt Builders ---

function buildV1Prompt(type, text, sourceFilename) {
  const schema = type === 'person' ? V1_PERSON_SCHEMA : V1_BUSINESS_SCHEMA;

  return `You are a structured data extraction engine. Given unstructured text about a ${type}, extract all relevant information into the following JSON structure. Fill in every field you can from the text. Leave fields as empty strings, empty arrays, or reasonable defaults if the information is not present. Do not invent information that is not in the text.

Output ONLY valid JSON, no markdown fences, no commentary.

JSON schema:
${schema}

Important:
- metadata.source should be "${sourceFilename}"
- metadata.generated should be the current timestamp in ISO 8601 format: "${new Date().toISOString()}"
- metadata.version should be "1.0"
- summary should be a 2-3 sentence synthesis of the most important information

Text to extract from:
---
${text}
---`;
}

function buildV2Prompt(type, text, sourceFilename, textHash, wordCount) {
  const schema = type === 'person' ? V2_PERSON_SCHEMA : V2_BUSINESS_SCHEMA;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  return `You are a structured data extraction engine for Context Architecture v2. You extract WHAT exists in the text AND assess HOW MUCH TO TRUST IT, WHEN IT EXPIRES, WHERE IT CAME FROM, and WHAT TO DO WITH IT.

Every data node you extract must carry metadata layers. This is what makes Context Architecture a methodology, not just a JSON converter.

Output ONLY valid JSON, no markdown fences, no commentary.

## CONFIDENCE SCORE FRAMEWORK — assign one to EVERY claim:
0.90-1.00 = VERIFIED    → Factual, documented, explicitly stated
0.75-0.89 = STRONG      → Direct assessment or reliable source
0.50-0.74 = MODERATE    → Multi-point inference, likely accurate
0.25-0.49 = SPECULATIVE → Single-point inference, treat with caution
0.00-0.24 = UNCERTAIN   → Barely supported, flag for validation
If you cannot determine confidence, default to 0.50 and add a note in extraction_notes.

## TIME DECAY — assign stability to every data point:
permanent     → Never expires (birthdate, birthplace, legal name)
stable        → 365 day refresh (personality type, core values, education)
semi_stable   → 180 day refresh (current job, current city, active projects)
volatile      → 60 day refresh (current goals, active stressors)
ephemeral     → 14 day refresh (this week's priorities, current deadlines)

## SOURCE ATTRIBUTION — THE 3 FACTS LAYERS:
Layer 1 "objective"  → True regardless of observer. Treat as fact.
Layer 2 "group"      → True within a culture/org/group. Respect context.
Layer 3 "personal"   → True only to this individual. Never argue. Never override.

## ENTITY ID CONVENTION:
- Person: ENT-[INITIALS]-001 (e.g. ENT-CJM-001 for CJ Mitchell)
- Business: ENT-BIZ-[ABBREV]-001 (e.g. ENT-BIZ-CA-001 for Context Architecture)
- Generate a unique entity_id for the main entity and use entity_id_ref for referenced entities when possible.

## RELATIONSHIPS:
- Assign a relationship_type from: spouse, child, parent, colleague, friend, mentor, ex, business_partner
- Assign a sentiment from: positive, neutral, strained, complex, unknown
- Add action suggestions where appropriate (e.g. for strained relationships: "approach with care, verify before referencing")

## TRANSLATIONS:
- If the text reveals communication patterns where someone says one thing but means another, extract these as translations.
- Only extract translations if the text explicitly or strongly implies them. If none are evident, return an empty array.

## CONSTRAINTS:
- Extract any boundaries, rules, or non-negotiables mentioned or strongly implied.
- For persons use type: absolute, conditional, contextual, or behavioral.
- For businesses use type: regulatory, operational, strategic, or financial.
- If none are evident, return an empty array.

## ACTIONS:
- Where appropriate, suggest what an AI should DO with information (ai_behavior instructions).
- Only add actions when the data naturally implies behavioral guidance.

## REQUIRED VALUES:
- extraction_metadata.extracted_at: "${now}"
- extraction_metadata.source_text_hash: "${textHash}"
- extraction_metadata.source_description: "Extracted from ${sourceFilename}"
- extraction_metadata.extraction_model: "claude-sonnet-4-5-20250929"
- extraction_metadata.word_count: ${wordCount}
- All captured_date fields: "${today}"
- provenance_chain.created_at: "${now}"
- provenance_chain.created_by: "context-engine-v2"
- provenance_chain.source_documents[0].source_id: "SRC-DOC-001"
- provenance_chain.source_documents[0].filename: "${sourceFilename}"
- provenance_chain.source_documents[0].content_hash: "${textHash}"
- provenance_chain.source_documents[0].extraction_date: "${now}"

## JSON SCHEMA:
${schema}

## IMPORTANT RULES:
- Extract ALL attributes as individual objects in the attributes array with sequential ATTR-001, ATTR-002, etc.
- Extract ALL relationships with sequential REL-001, REL-002, etc.
- Extract ALL values with sequential VAL-001, VAL-002, etc.
- Extract ALL key facts with sequential FACT-001, FACT-002, etc.
- Extract ALL projects with sequential PROJ-001, PROJ-002, etc.
- Do NOT invent information not in the text.
- If a field has no data, use empty string, empty array, or null as appropriate.
- Set extraction_metadata.extraction_confidence to the average confidence across all extracted data points.

Text to extract from:
---
${text}
---`;
}

// --- API Call ---

async function callClaude(prompt, retries = 1) {
  const client = new Anthropic();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      });

      return message.content[0].text;
    } catch (err) {
      if (attempt < retries) {
        console.warn(`API call failed (attempt ${attempt + 1}), retrying...`);
        continue;
      }
      throw err;
    }
  }
}

// --- Main ---

async function main() {
  const inputText = fs.readFileSync(inputPath, 'utf-8').trim();
  const sourceFilename = path.basename(inputPath);

  if (!inputText) {
    console.error('Error: Input file is empty.');
    process.exit(1);
  }

  const schemaVersion = opts.schemaVersion;
  console.log(`Reading input: ${inputPath}`);
  console.log(`Entity type: ${opts.type}`);
  console.log(`Schema version: ${schemaVersion}`);
  console.log(`Sending to Claude API...`);

  let prompt;
  if (schemaVersion === '1.0') {
    prompt = buildV1Prompt(opts.type, inputText, sourceFilename);
  } else {
    const textHash = crypto.createHash('sha256').update(inputText).digest('hex');
    const wordCount = inputText.split(/\s+/).length;
    prompt = buildV2Prompt(opts.type, inputText, sourceFilename, textHash, wordCount);
  }

  let rawResponse;
  try {
    rawResponse = await callClaude(prompt);
  } catch (err) {
    console.error(`API Error: ${err.message}`);
    process.exit(1);
  }

  // Strip markdown code fences if the model wraps the JSON
  const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('Error: Failed to parse API response as JSON.');
    console.error('Raw response:');
    console.error(rawResponse);
    process.exit(1);
  }

  const outputPath = path.resolve(opts.output);
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(parsed, null, 2) + '\n');
  console.log(`Output written to: ${outputPath}`);

  // Print summary
  console.log('\n--- Summary ---');

  if (schemaVersion === '2.0') {
    const entity = parsed.entity || {};
    const meta = parsed.extraction_metadata || {};
    console.log(`Entity ID: ${entity.entity_id || 'N/A'}`);
    console.log(`Extraction Confidence: ${meta.extraction_confidence || 'N/A'}`);
    console.log(`Word Count: ${meta.word_count || 'N/A'}`);

    if (opts.type === 'person') {
      console.log(`Name: ${entity.name?.full || 'N/A'}`);
      console.log(`Attributes: ${parsed.attributes?.length || 0}`);
      console.log(`Relationships: ${parsed.relationships?.length || 0}`);
      console.log(`Values: ${parsed.values?.length || 0}`);
      console.log(`Active Projects: ${parsed.active_projects?.length || 0}`);
      console.log(`Key Facts: ${parsed.key_facts?.length || 0}`);
      console.log(`Translations: ${parsed.translations?.length || 0}`);
      console.log(`Constraints: ${parsed.constraints?.length || 0}`);
    } else {
      console.log(`Name: ${entity.name?.common || entity.name?.legal || 'N/A'}`);
      console.log(`Attributes: ${parsed.attributes?.length || 0}`);
      console.log(`Products/Services: ${parsed.products_services?.length || 0}`);
      console.log(`Key People: ${parsed.key_people?.length || 0}`);
      console.log(`Values: ${parsed.values?.length || 0}`);
      console.log(`Key Facts: ${parsed.key_facts?.length || 0}`);
      console.log(`Constraints: ${parsed.constraints?.length || 0}`);
    }

    console.log(`Summary: ${entity.summary?.value || 'N/A'}`);
    if (meta.extraction_notes?.length > 0) {
      console.log(`Notes: ${meta.extraction_notes.join('; ')}`);
    }
  } else {
    // v1 summary
    if (opts.type === 'person') {
      console.log(`Name: ${parsed.name?.full || 'N/A'}`);
      console.log(`Role: ${parsed.attributes?.role || 'N/A'}`);
      console.log(`Location: ${parsed.attributes?.location || 'N/A'}`);
      console.log(`Relationships: ${parsed.relationships?.length || 0}`);
      console.log(`Active Projects: ${parsed.active_projects?.length || 0}`);
      console.log(`Key Facts: ${parsed.key_facts?.length || 0}`);
    } else {
      console.log(`Name: ${parsed.name?.common || parsed.name?.legal || 'N/A'}`);
      console.log(`Industry: ${parsed.industry || 'N/A'}`);
      console.log(`Products/Services: ${parsed.products_services?.length || 0}`);
      console.log(`Key People: ${parsed.key_people?.length || 0}`);
      console.log(`Key Facts: ${parsed.key_facts?.length || 0}`);
    }
    console.log(`Summary: ${parsed.summary || 'N/A'}`);
  }
}

main();
