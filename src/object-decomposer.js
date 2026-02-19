'use strict';

const fs = require('fs');
const path = require('path');
const { readEntity, writeEntity, listEntities, getNextCounter } = require('./graph-ops');

/**
 * Scan entities of a given type for a case-insensitive name match.
 * Returns the matching entity data and ID, or null.
 */
function findExistingByTypeAndName(graphDir, entityType, name) {
  const entities = listEntities(graphDir);
  const target = name.toLowerCase().trim();
  for (const { file, data } of entities) {
    const e = data.entity || {};
    if (e.entity_type !== entityType) continue;
    const eName = (e.name?.full || e.name?.common || '').toLowerCase().trim();
    if (eName === target) {
      return { entityId: e.entity_id || file.replace('.json', ''), data };
    }
  }
  return null;
}

/**
 * Decompose a PERSON entity into ROLE, ORGANIZATION, CREDENTIAL, and SKILL objects.
 * Runs after extraction, before the ingest pipeline returns.
 *
 * @param {object} entityData - The full person entity JSON
 * @param {string} entityId - The person's entity ID (e.g. ENT-CM-001)
 * @param {string} graphDir - Tenant-scoped graph directory
 * @returns {{ roles: number, organizations: number, credentials: number, skills: number }}
 */
function decomposePersonEntity(entityData, entityId, graphDir) {
  const counts = { roles: 0, organizations: 0, institutions: 0, credentials: 0, skills: 0 };

  // Guard: skip if not a person or no career_lite
  const entityType = entityData.entity?.entity_type;
  if (entityType !== 'person') return counts;
  const careerLite = entityData.career_lite;
  if (!careerLite) return counts;

  const now = new Date().toISOString();

  // --- Clean up previous decomposition (roles/credentials are always re-created) ---
  const prevConnected = entityData.connected_objects || [];
  for (const prev of prevConnected) {
    // Roles and credentials are 1:1 with experience/education entries — delete and recreate
    if (prev.entity_type === 'role' || prev.entity_type === 'credential') {
      const filePath = path.join(graphDir, `${prev.entity_id}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }

  // Start fresh — orgs and skills will be re-discovered via dedup
  const connectedObjects = [];

  // Track org name → entity ID for linking roles/credentials to orgs
  const orgMap = new Map();

  // --- Extract organizations from experience (companies) ---
  const companyNames = new Set();
  for (const exp of (careerLite.experience || [])) {
    if (exp.company) companyNames.add(exp.company.trim());
  }

  for (const orgName of companyNames) {
    const existing = findExistingByTypeAndName(graphDir, 'organization', orgName);
    if (existing) {
      orgMap.set(orgName.toLowerCase(), existing.entityId);
      if (!connectedObjects.find(c => c.entity_id === existing.entityId)) {
        connectedObjects.push({
          entity_id: existing.entityId,
          entity_type: 'organization',
          label: orgName,
        });
      }
    } else {
      const seq = getNextCounter(graphDir, 'organization');
      const orgId = `ENT-ORG-${String(seq).padStart(3, '0')}`;
      orgMap.set(orgName.toLowerCase(), orgId);

      const orgEntity = {
        schema_version: '2.0',
        schema_type: 'context_architecture_entity',
        extraction_metadata: {
          extracted_at: now,
          source_description: `decomposed from ${entityId}`,
          extraction_model: 'object-decomposer',
          extraction_confidence: 0.6,
          schema_version: '2.0',
        },
        entity: {
          entity_type: 'organization',
          entity_id: orgId,
          parent_entity_id: entityId,
          name: { full: orgName, common: orgName, aliases: [] },
          summary: { value: '', confidence: 0.6, facts_layer: 2 },
        },
        organization_data: { name: orgName },
        attributes: [],
        relationships: [],
        observations: [],
        provenance_chain: {
          created_at: now,
          created_by: 'object-decomposer',
          source_documents: [{ source: `decomposed from ${entityId}`, ingested_at: now }],
          merge_history: [],
        },
      };

      writeEntity(orgId, orgEntity, graphDir);
      connectedObjects.push({
        entity_id: orgId,
        entity_type: 'organization',
        label: orgName,
      });
      counts.organizations++;
    }
  }

  // --- Extract institutions from education ---
  const institutionNames = new Set();
  for (const edu of (careerLite.education || [])) {
    if (edu.institution) institutionNames.add(edu.institution.trim());
  }

  for (const instName of institutionNames) {
    // Check for existing institution OR organization (backward compat)
    const existingInst = findExistingByTypeAndName(graphDir, 'institution', instName);
    const existingOrg = !existingInst ? findExistingByTypeAndName(graphDir, 'organization', instName) : null;
    const existing = existingInst || existingOrg;
    if (existing) {
      orgMap.set(instName.toLowerCase(), existing.entityId);
      if (!connectedObjects.find(c => c.entity_id === existing.entityId)) {
        connectedObjects.push({
          entity_id: existing.entityId,
          entity_type: existing.data.entity?.entity_type || 'institution',
          label: instName,
        });
      }
    } else {
      const seq = getNextCounter(graphDir, 'institution');
      const instId = `ENT-INST-${String(seq).padStart(3, '0')}`;
      orgMap.set(instName.toLowerCase(), instId);

      const instEntity = {
        schema_version: '2.0',
        schema_type: 'context_architecture_entity',
        extraction_metadata: {
          extracted_at: now,
          source_description: `decomposed from ${entityId}`,
          extraction_model: 'object-decomposer',
          extraction_confidence: 0.6,
          schema_version: '2.0',
        },
        entity: {
          entity_type: 'institution',
          entity_id: instId,
          parent_entity_id: entityId,
          name: { full: instName, common: instName, aliases: [] },
          summary: { value: '', confidence: 0.6, facts_layer: 2 },
        },
        institution_data: { name: instName },
        attributes: [],
        relationships: [],
        observations: [],
        provenance_chain: {
          created_at: now,
          created_by: 'object-decomposer',
          source_documents: [{ source: `decomposed from ${entityId}`, ingested_at: now }],
          merge_history: [],
        },
      };

      writeEntity(instId, instEntity, graphDir);
      connectedObjects.push({
        entity_id: instId,
        entity_type: 'institution',
        label: instName,
      });
      counts.institutions++;
    }
  }

  // --- Extract roles from experience ---
  for (const exp of (careerLite.experience || [])) {
    const title = (exp.title || '').trim();
    const company = (exp.company || '').trim();
    if (!title && !company) continue;

    const label = company ? `${title} at ${company}` : title;
    const seq = getNextCounter(graphDir, 'role');
    const roleId = `ENT-ROLE-${String(seq).padStart(3, '0')}`;
    const orgId = company ? orgMap.get(company.toLowerCase()) || null : null;

    const roleEntity = {
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now,
        source_description: `decomposed from ${entityId}`,
        extraction_model: 'object-decomposer',
        extraction_confidence: 0.6,
        schema_version: '2.0',
      },
      entity: {
        entity_type: 'role',
        entity_id: roleId,
        parent_entity_id: entityId,
        name: { full: label, aliases: [] },
        summary: { value: exp.description || '', confidence: 0.6, facts_layer: 2 },
      },
      role_data: {
        title: title,
        company: company,
        organization_id: orgId,
        start_date: exp.start_date || '',
        end_date: exp.end_date || '',
        description: exp.description || '',
      },
      attributes: [],
      relationships: [],
      observations: [],
      provenance_chain: {
        created_at: now,
        created_by: 'object-decomposer',
        source_documents: [{ source: `decomposed from ${entityId}`, ingested_at: now }],
        merge_history: [],
      },
    };

    writeEntity(roleId, roleEntity, graphDir);
    connectedObjects.push({
      entity_id: roleId,
      entity_type: 'role',
      label: label,
    });
    counts.roles++;
  }

  // --- Extract credentials from education ---
  for (const edu of (careerLite.education || [])) {
    const institution = (edu.institution || '').trim();
    const degree = (edu.degree || '').trim();
    const field = (edu.field || '').trim();
    if (!institution && !degree) continue;

    const label = field
      ? `${degree} ${field}, ${institution}`
      : `${degree}, ${institution}`;
    const seq = getNextCounter(graphDir, 'credential');
    const credId = `ENT-CRED-${String(seq).padStart(3, '0')}`;
    const orgId = institution ? orgMap.get(institution.toLowerCase()) || null : null;

    const credEntity = {
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now,
        source_description: `decomposed from ${entityId}`,
        extraction_model: 'object-decomposer',
        extraction_confidence: 0.6,
        schema_version: '2.0',
      },
      entity: {
        entity_type: 'credential',
        entity_id: credId,
        parent_entity_id: entityId,
        name: { full: label, aliases: [] },
        summary: { value: '', confidence: 0.6, facts_layer: 2 },
      },
      credential_data: {
        institution: institution,
        degree: degree,
        field: field,
        start_year: edu.start_year || '',
        end_year: edu.end_year || '',
        organization_id: orgId,
      },
      attributes: [],
      relationships: [],
      observations: [],
      provenance_chain: {
        created_at: now,
        created_by: 'object-decomposer',
        source_documents: [{ source: `decomposed from ${entityId}`, ingested_at: now }],
        merge_history: [],
      },
    };

    writeEntity(credId, credEntity, graphDir);
    connectedObjects.push({
      entity_id: credId,
      entity_type: 'credential',
      label: label,
    });
    counts.credentials++;
  }

  // --- Extract skills ---
  for (const skillName of (careerLite.skills || [])) {
    const name = (skillName || '').trim();
    if (!name) continue;

    const existing = findExistingByTypeAndName(graphDir, 'skill', name);
    if (existing) {
      if (!connectedObjects.find(c => c.entity_id === existing.entityId)) {
        connectedObjects.push({
          entity_id: existing.entityId,
          entity_type: 'skill',
          label: name,
        });
      }
      continue;
    }

    const seq = getNextCounter(graphDir, 'skill');
    const skillId = `ENT-SKILL-${String(seq).padStart(3, '0')}`;

    const skillEntity = {
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now,
        source_description: `decomposed from ${entityId}`,
        extraction_model: 'object-decomposer',
        extraction_confidence: 0.6,
        schema_version: '2.0',
      },
      entity: {
        entity_type: 'skill',
        entity_id: skillId,
        parent_entity_id: entityId,
        name: { full: name, aliases: [] },
        summary: { value: '', confidence: 0.6, facts_layer: 2 },
      },
      skill_data: { name: name },
      attributes: [],
      relationships: [],
      observations: [],
      provenance_chain: {
        created_at: now,
        created_by: 'object-decomposer',
        source_documents: [{ source: `decomposed from ${entityId}`, ingested_at: now }],
        merge_history: [],
      },
    };

    writeEntity(skillId, skillEntity, graphDir);
    connectedObjects.push({
      entity_id: skillId,
      entity_type: 'skill',
      label: name,
    });
    counts.skills++;
  }

  // --- Update person entity with connected_objects ---
  entityData.connected_objects = connectedObjects;
  writeEntity(entityId, entityData, graphDir);

  return counts;
}

module.exports = { decomposePersonEntity, findExistingByTypeAndName };
