const { getBundledReviewQueue } = require('./src/signalStaging');
const path = require('path');
const graphDir = path.join(__dirname, 'watch-folder/graph/tenant-eefc79c7');
const result = getBundledReviewQueue(graphDir);
console.log('Bundles:', result.bundles.length);
console.log('Standalone:', result.standalone.length);
console.log('Total:', result.total);

// Verify Bill Gates bundle
const bg = result.bundles.find(b => b.primary.name === 'Bill Gates');
if (bg) {
  console.log('\n=== Bill Gates Bundle ===');
  console.log('Summary:', bg.summary);
  console.log('Primary cluster IDs:', bg.primary.all_cluster_ids);
  console.log('Related:', bg.related.length);
  for (const r of bg.related) {
    console.log('  ' + r.name + ' (' + r.all_cluster_ids.length + ' clusters, exists=' + r.exists_in_graph + ')');
    console.log('    Relationship:', r.relationship);
  }
  // Total cluster IDs for bundle
  const allIds = [...bg.primary.all_cluster_ids];
  for (const r of bg.related) allIds.push(...r.all_cluster_ids);
  console.log('All cluster IDs in bundle:', allIds.length, allIds);
}

// Verify Elon standalone
const elon = result.standalone.find(s => s.cluster && s.cluster.signals && s.cluster.signals.names && s.cluster.signals.names[0] === 'elonmusk');
if (elon) {
  console.log('\n=== Elon (Standalone) ===');
  console.log('ID:', elon.cluster.cluster_id);
  console.log('Type:', elon.cluster.entity_type);
}
