const fs = require('fs');
const { analyzeEntityHealth, getRelationshipTier, getTierInfo } = require('./src/health-analyzer');

// Test with CJ Mitchell
const cm = JSON.parse(fs.readFileSync('watch-folder/graph/tenant-eefc79c7/ENT-CM-001.json', 'utf8'));
console.log('=== CJ Mitchell (ENT-CM-001) ===');
const cmHealth = analyzeEntityHealth(cm);
console.log('Total connections:', cmHealth.total_connections);
console.log('Duplicate connections:', cmHealth.duplicate_connections);
if (cmHealth.duplicates.length > 0) {
  console.log('Duplicates:');
  cmHealth.duplicates.forEach(d => console.log('  -', d.merge_action));
}
console.log('Phantom entities:', cmHealth.phantom_count);
if (cmHealth.phantom_entities.length > 0) {
  console.log('Phantoms:');
  cmHealth.phantom_entities.forEach(p => console.log('  -', p.name, '|', p.reason));
}
console.log('Tier distribution:', cmHealth.tier_distribution);
console.log('Follows count:', cmHealth.follows_count);
console.log('Quality score:', cmHealth.quality_score);

// Show tier assignments for all CJ connections
console.log('\nCJ connections by tier:');
for (const r of cm.relationships || []) {
  const tier = getRelationshipTier(r);
  const info = getTierInfo(tier);
  console.log(`  T${tier} ${info.label}: ${r.name} — ${r.relationship_type}`);
}

// Test with Andre Burgin
console.log('\n=== Andre Burgin (ENT-AB-051) ===');
const ab = JSON.parse(fs.readFileSync('watch-folder/graph/tenant-eefc79c7/ENT-AB-051.json', 'utf8'));
const abHealth = analyzeEntityHealth(ab);
console.log('Total connections:', abHealth.total_connections);
console.log('Duplicate connections:', abHealth.duplicate_connections);
if (abHealth.duplicates.length > 0) {
  console.log('Duplicates:');
  abHealth.duplicates.forEach(d => console.log('  -', d.merge_action));
}
console.log('Phantom entities:', abHealth.phantom_count);
console.log('Tier distribution:', abHealth.tier_distribution);
