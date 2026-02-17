#!/usr/bin/env node
'use strict';

/**
 * One-time migration: decompose existing person entities with career_lite
 * into ROLE, ORGANIZATION, CREDENTIAL, and SKILL objects.
 *
 * Usage: node scripts/migrate-decompose.js
 */

const fs = require('fs');
const path = require('path');
const { decomposePersonEntity } = require('../src/object-decomposer');

const GRAPH_DIR = path.join(__dirname, '..', 'watch-folder', 'graph');

function run() {
  if (!fs.existsSync(GRAPH_DIR)) {
    console.log('No graph directory found at', GRAPH_DIR);
    return;
  }

  let totalPersons = 0;
  let totalRoles = 0;
  let totalOrgs = 0;
  let totalCreds = 0;
  let totalSkills = 0;

  // Scan all tenant directories + root
  const dirs = [GRAPH_DIR];
  const entries = fs.readdirSync(GRAPH_DIR);
  for (const entry of entries) {
    const fullPath = path.join(GRAPH_DIR, entry);
    if (entry.startsWith('tenant-') && fs.statSync(fullPath).isDirectory()) {
      dirs.push(fullPath);
    }
  }

  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter(f =>
      f.startsWith('ENT-') && f.endsWith('.json')
    );

    // Pre-filter to only person entity files (skip decomposed types that may be deleted mid-run)
    const personFiles = files.filter(f => {
      const filePath = path.join(dir, f);
      if (!fs.existsSync(filePath)) return false;
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return (data.entity || {}).entity_type === 'person' && data.career_lite;
      } catch { return false; }
    });

    for (const file of personFiles) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        const entityId = data.entity.entity_id || file.replace('.json', '');
        console.log(`  Decomposing ${entityId} in ${path.basename(dir)}...`);

        const counts = decomposePersonEntity(data, entityId, dir);
        totalPersons++;
        totalRoles += counts.roles;
        totalOrgs += counts.organizations;
        totalCreds += counts.credentials;
        totalSkills += counts.skills;

        console.log(`    → ${counts.roles} roles, ${counts.organizations} orgs, ${counts.credentials} credentials, ${counts.skills} skills`);
      } catch (err) {
        console.error(`  Error processing ${file}:`, err.message);
      }
    }
  }

  console.log(`\nDone. Decomposed ${totalPersons} persons → ${totalRoles} roles, ${totalOrgs} orgs, ${totalCreds} credentials, ${totalSkills} skills`);
}

run();
