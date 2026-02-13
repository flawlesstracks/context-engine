#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { merge } = require('./merge-engine');

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

// --- Graph matching ---

function findMatchingEntity(entityName, entityType) {
  const graphFiles = fs.readdirSync(GRAPH_DIR).filter(f => f.endsWith('.json'));
  for (const file of graphFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(GRAPH_DIR, file), 'utf-8'));
      const existingType = data.entity?.entity_type;
      if (existingType !== entityType) continue;

      let existingName = '';
      if (existingType === 'person') {
        existingName = (data.entity?.name?.full || '').toLowerCase();
      } else {
        existingName = (data.entity?.name?.common || data.entity?.name?.legal || '').toLowerCase();
      }

      if (existingName && existingName === entityName.toLowerCase()) {
        return { file, data };
      }
    } catch {
      continue;
    }
  }
  return null;
}

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

  const entityType = detectEntityType(filename, config.default_entity_type);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputFilename = `${path.basename(filename, path.extname(filename))}_${timestamp}.json`;
  const outputFile = path.join(OUTPUT_DIR, outputFilename);

  log(`Processing: ${filename} (type: ${entityType})`);

  try {
    // Call context-engine.js
    await new Promise((resolve, reject) => {
      const args = [ENGINE_PATH, '--input', processingFile, '--output', outputFile, '--type', entityType, '--schema-version', '2.0'];
      execFile('node', args, {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
        timeout: 180000,
      }, (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else {
          resolve(stdout);
        }
      });
    });

    // Read the output
    const outputData = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    const entityId = outputData.entity?.entity_id || 'unknown';

    let entityName = '';
    if (entityType === 'person') {
      entityName = outputData.entity?.name?.full || '';
    } else {
      entityName = outputData.entity?.name?.common || outputData.entity?.name?.legal || '';
    }

    log(`Extracted: ${entityName} (${entityId}) → ${outputFilename}`);

    // Graph handling
    if (config.auto_merge) {
      const match = findMatchingEntity(entityName, entityType);
      if (match) {
        // Merge incoming into existing graph entity
        const { merged, error, history } = merge(match.data, outputData);
        if (error) {
          log(`Merge failed for ${entityName}: ${error} — saving as new entity`);
          const graphFilename = `${entityId}.json`;
          fs.copyFileSync(outputFile, path.join(GRAPH_DIR, graphFilename));
        } else {
          fs.writeFileSync(path.join(GRAPH_DIR, match.file), JSON.stringify(merged, null, 2) + '\n');
          const changes = history?.length || 0;
          log(`Merged into graph: ${match.file} (${changes} change${changes !== 1 ? 's' : ''})`);
        }
      } else {
        // New entity — copy to graph
        const graphFilename = `${entityId}.json`;
        fs.copyFileSync(outputFile, path.join(GRAPH_DIR, graphFilename));
        log(`Added to graph: ${graphFilename}`);
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
  console.log('  Drop .txt or .md files into watch-folder/input/ to process.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  // Initial poll
  poll();

  // Start polling
  setInterval(poll, config.poll_interval_ms);
}

main();
