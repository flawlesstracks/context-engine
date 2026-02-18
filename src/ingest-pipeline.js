'use strict';

const { readEntity, writeEntity, listEntities, getNextCounter } = require('./graph-ops');
const { merge, similarity, entitiesMatch } = require('../merge-engine');
const { decomposePersonEntity } = require('./object-decomposer');

/**
 * Unified ingest pipeline — all extraction sources go through here.
 *
 * @param {Array} entities - v2 entity objects (may lack entity_ids)
 * @param {string} graphDir - tenant-scoped graph directory
 * @param {string} agentId - who's ingesting
 * @param {object} options - { source: string, truthLevel: "INFERRED"|"STRONG" }
 * @returns {{ created: number, updated: number, observationsAdded: number }}
 */
async function ingestPipeline(entities, graphDir, agentId, options = {}) {
  const { source = 'unknown', truthLevel = 'INFERRED' } = options;

  let created = 0;
  let updated = 0;
  let observationsAdded = 0;

  for (const entityData of entities) {
    const entityType = entityData.entity?.entity_type;
    if (!entityType || !['person', 'business'].includes(entityType)) continue;

    const displayName = entityType === 'person'
      ? (entityData.entity?.name?.full || '')
      : (entityData.entity?.name?.common || entityData.entity?.name?.legal || '');
    if (!displayName) continue;

    // Stamp truth_level on all observations
    const newObservations = (entityData.observations || []).map(obs => ({
      ...obs,
      truth_level: obs.truth_level || truthLevel,
    }));

    // Search for existing entity with similar name
    const existingEntities = listEntities(graphDir);
    let matchedData = null;
    let matchedId = null;

    console.log(`[ingest] Matching "${displayName}" (${entityType}) against ${existingEntities.length} existing entities`);

    for (const { file, data } of existingEntities) {
      const e = data.entity || {};
      if (e.entity_type !== entityType) continue;
      if (entitiesMatch(data, entityData)) {
        matchedData = data;
        matchedId = e.entity_id || file.replace('.json', '');
        break;
      }
    }

    if (matchedData) {
      // --- UPDATE existing entity via merge ---
      console.log(`[ingest] MERGE: "${displayName}" matched existing ${matchedId}`);
      const now = new Date().toISOString();
      const incoming = {
        schema_version: '2.0',
        schema_type: 'context_architecture_entity',
        extraction_metadata: {
          extracted_at: now,
          source_description: source,
          extraction_model: entityData.extraction_metadata?.extraction_model || 'claude-sonnet-4-5-20250929',
          extraction_confidence: entityData.extraction_metadata?.extraction_confidence || 0.6,
          schema_version: '2.0',
        },
        entity: {
          entity_type: entityType,
          entity_id: matchedId,
          name: entityData.entity.name,
          summary: entityData.entity.summary || matchedData.entity?.summary || { value: '', confidence: 0, facts_layer: 2 },
        },
        attributes: entityData.attributes || [],
        relationships: entityData.relationships || [],
        values: entityData.values || [],
        key_facts: entityData.key_facts || [],
        constraints: entityData.constraints || [],
        observations: [],
        provenance_chain: {
          created_at: now,
          created_by: agentId,
          source_documents: [{ source, ingested_at: now }],
          merge_history: [],
        },
      };

      // Forward career_lite so decomposePersonEntity gets new data
      if (entityData.career_lite) {
        incoming.career_lite = entityData.career_lite;
      }

      // Merge structured data
      const { merged } = merge(matchedData, incoming);
      const result = merged || matchedData;

      // Merge career_lite: incoming wins if it has experience data
      if (entityData.career_lite && entityData.career_lite.experience && entityData.career_lite.experience.length > 0) {
        result.career_lite = entityData.career_lite;
        result.career_lite.interface = 'career-lite';
      }

      // Append observations (dedup by lowercase text)
      if (!result.observations) result.observations = [];
      const existingObsTexts = new Set(
        result.observations.map(o => (o.observation || '').toLowerCase().trim())
      );
      for (const obs of newObservations) {
        if (!obs.observation) continue;
        if (existingObsTexts.has(obs.observation.toLowerCase().trim())) continue;
        const seq = String(result.observations.length + 1).padStart(3, '0');
        const tsCompact = (obs.observed_at || now).replace(/[-:T]/g, '').slice(0, 14);
        obs.observation_id = `OBS-${matchedId}-${tsCompact}-${seq}`;
        result.observations.push(obs);
        existingObsTexts.add(obs.observation.toLowerCase().trim());
        observationsAdded++;
      }

      // Provenance
      if (!result.provenance_chain) {
        result.provenance_chain = { created_at: now, created_by: agentId, source_documents: [], merge_history: [] };
      }
      result.provenance_chain.merge_history = result.provenance_chain.merge_history || [];
      result.provenance_chain.merge_history.push({
        merged_at: now,
        merged_by: agentId,
        changes: [`${source}: merged data and ${newObservations.length} observations`],
      });

      writeEntity(matchedId, result, graphDir);

      console.log(`[ingest] MERGE stats: ${observationsAdded} new observations, career_lite=${!!result.career_lite}`);

      // Decompose person entity into connected objects
      if (entityType === 'person') {
        decomposePersonEntity(result, matchedId, graphDir);
      }

      updated++;
    } else {
      // --- CREATE new entity ---
      console.log(`[ingest] CREATE: "${displayName}" as new entity`);
      let initials;
      if (entityType === 'person') {
        initials = displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
      } else {
        initials = 'BIZ-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
      }
      const seq = getNextCounter(graphDir, entityType);
      const entityId = `ENT-${initials}-${String(seq).padStart(3, '0')}`;
      const now = new Date().toISOString();

      // Set entity_id
      entityData.entity.entity_id = entityId;

      // Set observation IDs
      newObservations.forEach((obs, idx) => {
        const tsCompact = (obs.observed_at || now).replace(/[-:T]/g, '').slice(0, 14);
        obs.observation_id = `OBS-${entityId}-${tsCompact}-${String(idx + 1).padStart(3, '0')}`;
      });
      entityData.observations = newObservations;

      // Ensure provenance chain exists
      if (!entityData.provenance_chain) {
        entityData.provenance_chain = {
          created_at: now,
          created_by: agentId,
          source_documents: [{ source, ingested_at: now }],
          merge_history: [],
        };
      }

      writeEntity(entityId, entityData, graphDir);

      // Decompose person entity into connected objects
      if (entityType === 'person') {
        decomposePersonEntity(entityData, entityId, graphDir);
      }

      created++;
      observationsAdded += newObservations.length;
    }
  }

  return { created, updated, observationsAdded };
}

module.exports = { ingestPipeline };
