/**
 * Re-score all existing signal clusters with before/after comparison.
 * Logs quadrant changes, zone classification, contradiction penalties, and name rarity.
 */
const path = require('path');
const { scoreCluster, listClusters, readCluster } = require('./src/signalStaging');

const graphDir = path.join(__dirname, 'watch-folder/graph/tenant-eefc79c7');

console.log('=== Re-scoring all signal clusters (with before/after) ===\n');

const clusters = listClusters(graphDir);
console.log(`Found ${clusters.length} clusters to re-score.\n`);

let scored = 0;
let errors = 0;
let changed = 0;

for (const cluster of clusters) {
  try {
    // Capture before state
    const before = {
      quadrant: cluster.quadrant,
      label: cluster.quadrant_label || 'Q' + cluster.quadrant,
      conf: cluster.association_confidence || cluster.confidence || 0,
      zone: cluster.match_zone || 'unknown',
    };

    const result = scoreCluster(cluster.cluster_id, graphDir);
    if (result) {
      const factors = result.association_factors || {};
      const after = {
        quadrant: result.quadrant,
        label: result.quadrant_label,
        conf: result.association_confidence || 0,
        zone: result.match_zone || 'unknown',
      };

      const quadrantChanged = before.quadrant !== after.quadrant;
      const zoneChanged = before.zone !== after.zone;
      const marker = (quadrantChanged || zoneChanged) ? ' ***CHANGED***' : '';
      if (quadrantChanged || zoneChanged) changed++;

      console.log(`${result.cluster_id}: ${after.label} [${after.zone}]${result.ambiguous ? ' AMBIGUOUS' : ''}${marker}`);
      console.log(`  name: ${result.signals?.names?.[0] || '?'} (rarity: ${result.name_rarity || 'standard'}, threshold: ${result.rarity_threshold || 0.3})`);
      console.log(`  score: ${after.conf.toFixed(3)}${result.association_raw_score ? ' (raw: ' + result.association_raw_score.toFixed(3) + ')' : ''} | penalty: -${(result.contradiction_penalty || 0).toFixed(3)}`);
      console.log(`  factors: N=${(factors.name || 0).toFixed(2)} H=${(factors.handle || 0).toFixed(2)} O=${(factors.org_title || 0).toFixed(2)} L=${(factors.location || 0).toFixed(2)} B=${(factors.bio || 0).toFixed(2)}`);
      if (result.contradictions && result.contradictions.length > 0) {
        for (const c of result.contradictions) {
          console.log(`  CONTRADICTION: ${c.factor} (${c.penalty}) — ${c.note}`);
        }
      }
      if (result.candidate_entity_name) console.log(`  candidate: ${result.candidate_entity_name} (${result.candidate_entity_id})`);
      if (result.evidence && result.evidence.length > 0) {
        console.log(`  evidence: ${result.evidence.map(e => e.factor + ':' + e.status).join(', ')}`);
      }
      if (quadrantChanged) console.log(`  BEFORE: ${before.label} [${before.zone}] → AFTER: ${after.label} [${after.zone}]`);
      console.log();
      scored++;
    } else {
      console.log(`${cluster.cluster_id}: FAILED (null result)\n`);
      errors++;
    }
  } catch (e) {
    console.error(`${cluster.cluster_id}: ERROR — ${e.message}\n`);
    errors++;
  }
}

console.log(`=== Done: ${scored} scored, ${errors} errors, ${changed} changed ===`);
