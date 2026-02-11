#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIVIDER = '─'.repeat(56);

function run(cmd) {
  execSync(cmd, { stdio: 'inherit', cwd: __dirname });
}

function printHeader(text) {
  console.log(`\n${DIVIDER}`);
  console.log(`  ${text}`);
  console.log(DIVIDER);
}

const start = Date.now();

console.log('\n' + '═'.repeat(56));
console.log('  CONTEXT ENGINE v1 - LIVE DEMO');
console.log('═'.repeat(56));

// --- Person extraction ---

printHeader('1. Extracting person context: CJ Mitchell');

run('node context-engine.js --input samples/cj-deep.txt --output output/demo-person.json --type person');

const person = JSON.parse(fs.readFileSync(path.join(__dirname, 'output/demo-person.json'), 'utf-8'));

printHeader('Person Results');
console.log(`  Name:            ${person.name?.full || 'N/A'}`);
console.log(`  Role:            ${person.attributes?.role || 'N/A'}`);
console.log(`  Relationships:   ${person.relationships?.length || 0}`);
console.log(`  Active Projects: ${person.active_projects?.length || 0}`);
console.log(`  Values:          ${person.values?.length || 0}`);

// --- Business extraction ---

printHeader('2. Extracting business context: Context Architecture');

run('node context-engine.js --input samples/context-architecture-biz.txt --output output/demo-business.json --type business');

const biz = JSON.parse(fs.readFileSync(path.join(__dirname, 'output/demo-business.json'), 'utf-8'));

printHeader('Business Results');
console.log(`  Company:            ${biz.name?.common || biz.name?.legal || 'N/A'}`);
console.log(`  Industry:           ${biz.industry || 'N/A'}`);
console.log(`  Products/Services:  ${biz.products_services?.length || 0}`);
console.log(`  Customer Segments:  ${biz.customers?.segments?.length || 0}`);
console.log(`  Competitive Pos.:   ${biz.competitive_position || 'N/A'}`);

// --- Done ---

const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log(`\n${DIVIDER}`);
console.log(`  Done. Total time: ${elapsed}s`);
console.log(DIVIDER + '\n');
