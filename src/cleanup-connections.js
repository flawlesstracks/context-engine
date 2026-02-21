/**
 * Connection Cleanup Script
 * Fixes: duplicates, phantoms, name fragments, LinkedIn tier artifacts
 * Usage: node src/cleanup-connections.js [entity-id] [graph-dir]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readEntity, writeEntity } = require('./graph-ops');

// --- Phantom detection patterns ---
const PHANTOM_NAMES = ['blossom', 'buttercup', 'mojo jojo', 'claudine (blossom)', 'gemma (buttercup)'];
const PHANTOM_CONTEXT = ['ai assistant', 'ai collaborator', 'context interface protocol'];
const TEST_CONTEXT = ['example recipient', 'test data', 'demonstration', 'example entity'];

// --- LinkedIn artifact relationship types ---
const FOLLOW_TYPES = ['following', '3rd degree', '2nd degree connection', '2nd degree', '3rd degree connection'];

function cleanupConnections(entityId, graphDir) {
  const entity = readEntity(entityId, graphDir);
  if (!entity) { console.error('Entity not found:', entityId); return null; }

  const rels = entity.relationships || [];
  const log = [];
  console.log(`\n=== Cleanup: ${entityId} (${rels.length} connections) ===\n`);

  // --- STEP A: Phantom Removal ---
  const keepAfterPhantom = [];
  for (const r of rels) {
    const nameLower = (r.name || '').toLowerCase();
    const ctxLower = (r.context || '').toLowerCase();

    // Check phantom names
    if (PHANTOM_NAMES.some(p => nameLower.includes(p))) {
      log.push(`PHANTOM REMOVED: "${r.name}" (matched phantom name pattern)`);
      continue;
    }
    // Check phantom context
    if (PHANTOM_CONTEXT.some(p => ctxLower.includes(p))) {
      log.push(`PHANTOM REMOVED: "${r.name}" (context: "${r.context?.substring(0, 50)}")`);
      continue;
    }
    keepAfterPhantom.push(r);
  }

  // --- STEP B: Test Data Removal ---
  const keepAfterTest = [];
  for (const r of keepAfterPhantom) {
    const ctxLower = (r.context || '').toLowerCase();
    const nameParts = (r.name || '').trim().split(/\s+/);

    // Single first name with test context
    if (nameParts.length === 1 && TEST_CONTEXT.some(t => ctxLower.includes(t))) {
      log.push(`TEST DATA REMOVED: "${r.name}" (single name + test context: "${r.context?.substring(0, 50)}")`);
      continue;
    }
    keepAfterTest.push(r);
  }

  // --- STEP C: Name Fragment Merge ---
  // Find single-word names that are substrings of multi-word names
  const keepAfterFragment = [];
  const mergedFragments = new Set();

  for (let i = 0; i < keepAfterTest.length; i++) {
    const r = keepAfterTest[i];
    if (mergedFragments.has(i)) continue;

    const nameParts = (r.name || '').trim().split(/\s+/);
    if (nameParts.length > 1) {
      keepAfterFragment.push(r);
      continue;
    }

    // Single-word name — look for a multi-word name that contains it
    const singleName = (r.name || '').trim().toLowerCase();
    let merged = false;

    for (let j = 0; j < keepAfterTest.length; j++) {
      if (i === j || mergedFragments.has(j)) continue;
      const other = keepAfterTest[j];
      const otherParts = (other.name || '').trim().split(/\s+/);
      if (otherParts.length <= 1) continue;

      const otherLower = (other.name || '').toLowerCase();
      // Check if single name is a substring of the multi-word name
      if (otherLower.includes(singleName)) {
        // Merge: keep the multi-word name, combine relationship types and context
        const types = new Set();
        if (other.relationship_type) other.relationship_type.split(',').map(t => t.trim()).forEach(t => types.add(t));
        if (r.relationship_type) r.relationship_type.split(',').map(t => t.trim()).forEach(t => types.add(t));
        other.relationship_type = [...types].join(', ');

        // Preserve entity_id from either
        if (!other.target_entity_id && r.target_entity_id) {
          other.target_entity_id = r.target_entity_id;
        }

        // Merge context if different
        if (r.context && other.context && !other.context.includes(r.context)) {
          other.context = other.context + '; ' + r.context;
        }

        log.push(`NAME FRAGMENT MERGED: "${r.name}" into "${other.name}"`);
        merged = true;
        break;
      }
    }

    if (!merged) {
      keepAfterFragment.push(r);
    }
  }

  // --- STEP D: Duplicate Detection + Merge ---
  // Normalize names: strip parenthetical aliases for grouping
  function normalizeNameKey(name) {
    return (name || '').toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
  }
  const byName = {};
  for (const r of keepAfterFragment) {
    const key = normalizeNameKey(r.name);
    if (!byName[key]) byName[key] = [];
    byName[key].push(r);
  }

  const keepAfterDedup = [];
  for (const [name, entries] of Object.entries(byName)) {
    if (entries.length === 1) {
      keepAfterDedup.push(entries[0]);
      continue;
    }

    // Merge duplicates — prefer longest name (has alias)
    entries.sort((a, b) => (b.name || '').length - (a.name || '').length);
    const merged = entries[0];
    const types = new Set();
    if (merged.relationship_type) merged.relationship_type.split(',').map(t => t.trim()).forEach(t => types.add(t));

    for (let i = 1; i < entries.length; i++) {
      const dupe = entries[i];
      if (dupe.relationship_type) dupe.relationship_type.split(',').map(t => t.trim()).forEach(t => types.add(t));
      if (!merged.target_entity_id && dupe.target_entity_id) merged.target_entity_id = dupe.target_entity_id;
      if (dupe.context && merged.context && !merged.context.includes(dupe.context)) {
        merged.context = merged.context + '; ' + dupe.context;
      }
      // Keep highest confidence
      if ((dupe.confidence || 0) > (merged.confidence || 0)) {
        merged.confidence = dupe.confidence;
        merged.confidence_label = dupe.confidence_label;
      }
      log.push(`DUPLICATE MERGED: "${dupe.name}" (type=${dupe.relationship_type}) into existing "${merged.name}"`);
    }
    merged.relationship_type = [...types].join(', ');
    keepAfterDedup.push(merged);
  }

  // --- STEP E: Relationship Re-Tiering ---
  for (const r of keepAfterDedup) {
    const typeLower = (r.relationship_type || '').toLowerCase();
    if (FOLLOW_TYPES.some(f => typeLower.includes(f))) {
      const oldType = r.relationship_type;
      r.relationship_type = 'Following';
      r.sentiment = r.sentiment || 'neutral';
      log.push(`RE-TIERED: "${r.name}" from "${oldType}" to "Following" (T1_FOLLOW)`);
    }
  }

  // --- Apply changes ---
  entity.relationships = keepAfterDedup;

  // Log summary
  console.log('Changes:');
  for (const entry of log) console.log('  ' + entry);
  console.log(`\nResult: ${rels.length} → ${keepAfterDedup.length} connections (removed ${rels.length - keepAfterDedup.length})`);

  return { entity, log, before: rels.length, after: keepAfterDedup.length };
}

// --- CLI execution ---
if (require.main === module) {
  const entityId = process.argv[2] || 'ENT-CM-001';
  const graphDir = process.argv[3] || path.join(__dirname, '..', 'watch-folder/graph/tenant-eefc79c7');

  const result = cleanupConnections(entityId, graphDir);
  if (result) {
    writeEntity(entityId, result.entity, graphDir);
    console.log('\nSaved cleaned entity:', entityId);
  }
}

module.exports = { cleanupConnections };
