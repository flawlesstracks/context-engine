/**
 * Re-score all existing signal clusters using the rebuilt 5-step scoreCluster.
 * Run after scoreCluster rebuild to correct any misclassified quadrants.
 */
const path = require('path');
const { scoreCluster, listClusters } = require('./src/signalStaging');

const graphDir = path.join(__dirname, 'watch-folder/graph/tenant-eefc79c7');

console.log('=== Re-scoring all signal clusters ===\n');

const clusters = listClusters(graphDir);
console.log(`Found ${clusters.length} clusters to re-score.\n`);

let scored = 0;
let errors = 0;

for (const cluster of clusters) {
  try {
    const result = scoreCluster(cluster.cluster_id, graphDir);
    if (result) {
      const factors = result.association_factors || {};
      console.log(`${result.cluster_id}: ${result.quadrant_label || 'Q' + result.quadrant} | conf=${(result.association_confidence || 0).toFixed(3)} | novelty=${(result.data_novelty_ratio || 0).toFixed(2)} | match=${result.match_type || 'none'}`);
      console.log(`  name: ${result.signals?.names?.[0] || '?'} | factors: N=${(factors.name || 0).toFixed(2)} H=${(factors.handle || 0).toFixed(2)} O=${(factors.org_title || 0).toFixed(2)} L=${(factors.location || 0).toFixed(2)} B=${(factors.bio || 0).toFixed(2)}`);
      if (result.candidate_entity_name) console.log(`  candidate: ${result.candidate_entity_name} (${result.candidate_entity_id})`);
      if (result.data_novelty) console.log(`  novelty: ${result.data_novelty.new_signals} new / ${result.data_novelty.duplicate_signals} dup`);
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

console.log(`\n=== Done: ${scored} scored, ${errors} errors ===`);
