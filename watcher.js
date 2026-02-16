#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { ingestPipeline } = require('./src/ingest-pipeline');
const { normalizeFileToText } = require('./src/parsers/normalize');
const { mapContactRows } = require('./src/parsers/contacts');
const { buildLinkedInPrompt, linkedInResponseToEntity } = require('./src/parsers/linkedin');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

// --- Paths ---

const WATCH_DIR = path.join(__dirname, 'watch-folder');
const INPUT_DIR = path.join(WATCH_DIR, 'input');
const PROCESSING_DIR = path.join(WATCH_DIR, 'processing');
const PROCESSED_DIR = path.join(WATCH_DIR, 'processed');
const OUTPUT_DIR = path.join(WATCH_DIR, 'output');
const GRAPH_DIR = path.join(WATCH_DIR, 'graph');
const ERRORS_DIR = path.join(WATCH_DIR, 'errors');
const CONFIG_PATH = path.join(WATCH_DIR, 'config.json');
const ENGINE_PATH = path.join(__dirname, 'context-engine.js');

// --- Ensure dirs exist ---

[INPUT_DIR, PROCESSING_DIR, PROCESSED_DIR, OUTPUT_DIR, GRAPH_DIR, ERRORS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Config ---

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// --- Logging ---

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] ERROR: ${msg}`);
}

// --- Entity type detection ---

function detectEntityType(filename, defaultType) {
  const lower = filename.toLowerCase();
  if (lower.includes('biz') || lower.includes('business') || lower.includes('company') || lower.includes('org')) {
    return 'business';
  }
  if (lower.includes('person') || lower.includes('bio') || lower.includes('profile')) {
    return 'person';
  }
  return defaultType;
}

// File extensions that can be parsed directly (no context-engine needed)
const PARSEABLE_EXTENSIONS = new Set(['.pdf', '.docx', '.xlsx', '.xls', '.csv']);

// --- Process a single file ---

let activeCount = 0;

async function processFile(filename, config) {
  const inputFile = path.join(INPUT_DIR, filename);
  const processingFile = path.join(PROCESSING_DIR, filename);

  // Move to processing/
  try {
    fs.renameSync(inputFile, processingFile);
  } catch (err) {
    logError(`Could not move ${filename} to processing: ${err.message}`);
    return;
  }

  const ext = path.extname(filename).toLowerCase();
  log(`Processing: ${filename}`);

  try {
    if (PARSEABLE_EXTENSIONS.has(ext)) {
      // New path: parse file directly, then use ingestPipeline
      const buffer = fs.readFileSync(processingFile);
      const { text, metadata } = await normalizeFileToText(buffer, filename);

      let result;

      if (metadata.isContactList && metadata.rows) {
        const entities = mapContactRows(metadata.rows, filename, 'watcher');
        result = await ingestPipeline(entities, GRAPH_DIR, 'watcher', {
          source: `file_watcher:${filename}`,
          truthLevel: 'STRONG',
        });
        log(`Contact list: ${result.created} created, ${result.updated} updated`);

      } else if (metadata.isLinkedIn) {
        const Anthropic = require('@anthropic-ai/sdk').default;
        const client = new Anthropic();
        const prompt = buildLinkedInPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        const entity = linkedInResponseToEntity(parsed, filename, 'watcher');
        result = await ingestPipeline([entity], GRAPH_DIR, 'watcher', {
          source: `file_watcher:${filename}`,
          truthLevel: 'INFERRED',
        });
        log(`LinkedIn profile: ${result.created} created, ${result.updated} updated`);

      } else {
        // Generic text — use context-engine for extraction
        const entityType = detectEntityType(filename, config.default_entity_type);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputFilename = `${path.basename(filename, ext)}_${timestamp}.json`;
        const outputFile = path.join(OUTPUT_DIR, outputFilename);

        await new Promise((resolve, reject) => {
          const tmpTextFile = path.join(OUTPUT_DIR, `_watcher_${Date.now()}.txt`);
          fs.writeFileSync(tmpTextFile, text);
          const args = [ENGINE_PATH, '--input', tmpTextFile, '--output', outputFile, '--type', entityType, '--schema-version', '2.0'];
          execFile('node', args, {
            env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
            timeout: 180000,
          }, (err, stdout, stderr) => {
            try { fs.unlinkSync(tmpTextFile); } catch {}
            if (err) { err.stderr = stderr; reject(err); }
            else resolve(stdout);
          });
        });

        const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
        result = await ingestPipeline([outputData], GRAPH_DIR, 'watcher', {
          source: `file_watcher:${filename}`,
          truthLevel: 'INFERRED',
        });
        log(`Extracted: ${result.created} created, ${result.updated} updated`);
      }

    } else {
      // Legacy path for .txt/.md: use context-engine.js, then ingestPipeline
      const entityType = detectEntityType(filename, config.default_entity_type);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const outputFilename = `${path.basename(filename, ext)}_${timestamp}.json`;
      const outputFile = path.join(OUTPUT_DIR, outputFilename);

      await new Promise((resolve, reject) => {
        const args = [ENGINE_PATH, '--input', processingFile, '--output', outputFile, '--type', entityType, '--schema-version', '2.0'];
        execFile('node', args, {
          env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
          timeout: 180000,
        }, (err, stdout, stderr) => {
          if (err) { err.stderr = stderr; reject(err); }
          else resolve(stdout);
        });
      });

      const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
      const entityName = entityType === 'person'
        ? (outputData.entity?.name?.full || '')
        : (outputData.entity?.name?.common || outputData.entity?.name?.legal || '');
      log(`Extracted: ${entityName} (${outputData.entity?.entity_id || 'unknown'}) → ${outputFilename}`);

      if (config.auto_merge) {
        const result = await ingestPipeline([outputData], GRAPH_DIR, 'watcher', {
          source: `file_watcher:${filename}`,
          truthLevel: 'INFERRED',
        });
        log(`Graph: ${result.created} created, ${result.updated} updated, ${result.observationsAdded} observations`);
      }
    }

    // Move original to processed/
    fs.renameSync(processingFile, path.join(PROCESSED_DIR, filename));
    log(`Done: ${filename}`);

  } catch (err) {
    logError(`Failed to process ${filename}: ${err.message}`);

    // Write error log
    const errorLog = `${filename}\n${new Date().toISOString()}\n\n${err.message}\n\n${err.stderr ? err.stderr.toString() : ''}`;
    fs.writeFileSync(path.join(ERRORS_DIR, `${filename}.error.log`), errorLog);

    // Move to errors/
    try {
      fs.renameSync(processingFile, path.join(ERRORS_DIR, filename));
    } catch {
      // File may have been moved already
    }
  }
}

// --- Poll loop ---

async function poll() {
  const config = loadConfig();

  const files = fs.readdirSync(INPUT_DIR).filter(f => {
    const ext = path.extname(f).toLowerCase();
    return config.supported_extensions.includes(ext);
  });

  if (files.length === 0) return;

  log(`Found ${files.length} file(s) in input/`);

  // Process up to max_concurrent files
  const batch = files.slice(0, config.max_concurrent - activeCount);
  if (batch.length === 0) return;

  activeCount += batch.length;

  await Promise.all(batch.map(async (file) => {
    try {
      await processFile(file, config);
    } finally {
      activeCount--;
    }
  }));
}

// --- Main ---

function main() {
  const config = loadConfig();

  console.log('');
  console.log('  Context Engine — Watcher');
  console.log('  ───────────────────────────');
  console.log(`  Polling:     ${INPUT_DIR}`);
  console.log(`  Interval:    ${config.poll_interval_ms}ms`);
  console.log(`  Default type: ${config.default_entity_type}`);
  console.log(`  Auto-merge:  ${config.auto_merge}`);
  console.log(`  Concurrency: ${config.max_concurrent}`);
  console.log(`  Extensions:  ${config.supported_extensions.join(', ')}`);
  console.log('');
  console.log('  Drop files into watch-folder/input/ to process.');
  console.log('  Supported: .txt, .md, .pdf, .docx, .xlsx, .xls, .csv');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Initial poll
  poll();

  // Start polling
  setInterval(poll, config.poll_interval_ms);
}

main();
