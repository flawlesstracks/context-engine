#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
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
  .parse();

const opts = program.opts();

// --- Validation ---

if (!['person', 'business'].includes(opts.type)) {
  console.error(`Error: --type must be "person" or "business". Got "${opts.type}".`);
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

// --- Prompts ---

const PERSON_SCHEMA = `{
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

const BUSINESS_SCHEMA = `{
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

function buildPrompt(type, text, sourceFilename) {
  const schema = type === 'person' ? PERSON_SCHEMA : BUSINESS_SCHEMA;

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

// --- API Call ---

async function callClaude(prompt, retries = 1) {
  const client = new Anthropic();

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 4096,
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

  console.log(`Reading input: ${inputPath}`);
  console.log(`Entity type: ${opts.type}`);
  console.log(`Sending to Claude API...`);

  let rawResponse;
  try {
    const prompt = buildPrompt(opts.type, inputText, sourceFilename);
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

main();
