'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readEntity, listEntities, writeEntity, getNextCounter } = require('./graph-ops');
const { similarity, getAllNames, namesLikelyMatch, propertyOverlapCount, countSharedRelationships, getEntityProperties, merge } = require('../merge-engine');
const { decomposePersonEntity } = require('./object-decomposer');

// --- Directory helpers ---

function getClustersDir(graphDir) {
  const dir = path.join(graphDir, 'signal_clusters');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readCluster(clusterId, graphDir) {
  const filePath = path.join(getClustersDir(graphDir), `${clusterId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeCluster(clusterId, data, graphDir) {
  const dir = getClustersDir(graphDir);
  fs.writeFileSync(path.join(dir, `${clusterId}.json`), JSON.stringify(data, null, 2) + '\n');
}

function deleteCluster(clusterId, graphDir) {
  const filePath = path.join(getClustersDir(graphDir), `${clusterId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function listClusters(graphDir) {
  const dir = getClustersDir(graphDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        return data;
      } catch { return null; }
    })
    .filter(Boolean);
}

// --- Normalize extracted data into signal cluster ---

// --- Confidence Scoring System ---

// Base source weights: how trustworthy is this source type?
const SOURCE_WEIGHTS = {
  linkedin_api: 0.9,       // Proxycurl
  linkedin_proxycurl: 0.9,
  linkedin_pdf: 0.85,
  linkedin: 0.85,
  company_website: 0.8,
  about_page: 0.8,
  file_upload: 0.75,       // Resume, bio doc
  file: 0.75,
  x: 0.6,                  // Social profiles
  instagram: 0.6,
  social: 0.6,
  web: 0.5,                // Generic scraped page
  url_extract: 0.5,
  mention: 0.4,            // Mentioned in someone else's data
  unknown: 0.4,
};

function getSourceWeight(sourceType) {
  if (!sourceType) return SOURCE_WEIGHTS.unknown;
  const key = sourceType.toLowerCase().replace(/[^a-z_]/g, '');
  return SOURCE_WEIGHTS[key] || SOURCE_WEIGHTS.unknown;
}

// Recency modifier: applies to "current state" attributes (title, company, location)
// NOT to historical facts (education, past jobs)
const VOLATILE_KEYS = new Set([
  'headline', 'role', 'current_role', 'company', 'current_company',
  'location', 'current_location', 'x_bio', 'instagram_bio',
  'x_followers', 'instagram_followers',
]);

function recencyModifier(capturedDate, attrKey) {
  // Only apply to volatile/current-state attributes
  if (!VOLATILE_KEYS.has((attrKey || '').toLowerCase())) return 1.0;
  if (!capturedDate) return 0.85; // Unknown date = assume moderate staleness

  const captured = new Date(capturedDate);
  const now = new Date();
  const monthsAgo = (now - captured) / (1000 * 60 * 60 * 24 * 30);

  if (monthsAgo <= 6) return 1.0;
  if (monthsAgo <= 12) return 0.95;
  if (monthsAgo <= 24) return 0.85;
  if (monthsAgo <= 60) return 0.7;
  return 0.5;
}

// Corroboration multiplier: more independent sources = higher confidence
function corroborationMultiplier(sourceCount) {
  if (sourceCount <= 1) return 1.0;
  if (sourceCount === 2) return 1.3;
  return 1.5; // 3+ sources — capped
}

// Compute attribute-level confidence
function computeAttributeConfidence(baseWeight, capturedDate, attrKey, sourceCount) {
  const base = baseWeight || SOURCE_WEIGHTS.unknown;
  const recency = recencyModifier(capturedDate, attrKey);
  const corr = corroborationMultiplier(sourceCount || 1);
  return Math.min(1.0, base * recency * corr); // Cap at 1.0
}

// Compute entity-level confidence: weighted average of all attribute confidences
function computeEntityConfidence(entity) {
  const attrs = entity.attributes || [];
  if (attrs.length === 0) return 0;

  let totalConf = 0;
  let count = 0;
  for (const attr of attrs) {
    const conf = attr.confidence || 0.5;
    totalConf += conf;
    count++;
  }
  return count > 0 ? totalConf / count : 0;
}

// Entity confidence tier label
function confidenceTier(conf) {
  if (conf < 0.5) return 'thin';
  if (conf <= 0.8) return 'developing';
  return 'strong';
}

// Create a signal value object with confidence and source trail
function signalValue(value, confidence, clusterId) {
  return { value, confidence: confidence || 0.5, sources: clusterId ? [clusterId] : [] };
}

// --- Signal extraction ---

function extractSignals(entityData) {
  const entity = entityData.entity || {};
  const entityType = entity.entity_type || 'person';
  const signals = {
    names: [],
    handles: { x: null, instagram: null, linkedin: null },
    titles: [],
    organizations: [],
    locations: [],
    bios: [],
    skills: [],
    education: [],
    raw_text: '',
  };

  // Names
  if (entityType === 'person') {
    if (entity.name?.full) signals.names.push(entity.name.full);
    if (entity.name?.preferred) signals.names.push(entity.name.preferred);
  } else {
    if (entity.name?.common) signals.names.push(entity.name.common);
    if (entity.name?.legal) signals.names.push(entity.name.legal);
  }
  for (const alias of (entity.name?.aliases || [])) {
    if (alias) signals.names.push(alias);
  }

  // Attributes → handles, titles, orgs, locations, bios, skills
  for (const attr of (entityData.attributes || [])) {
    const key = (attr.key || '').toLowerCase();
    const val = (attr.value || '').trim();
    if (!val) continue;

    if (key === 'x_handle' || key === 'twitter_handle') signals.handles.x = val.replace(/^@/, '').toLowerCase();
    if (key === 'instagram_handle') signals.handles.instagram = val.replace(/^@/, '').toLowerCase();
    if (key === 'x_url' || key === 'twitter_url') {
      const m = val.match(/(?:x\.com|twitter\.com)\/(@?\w+)/i);
      if (m) signals.handles.x = signals.handles.x || m[1].replace(/^@/, '').toLowerCase();
    }
    if (key === 'instagram_url') {
      const m = val.match(/instagram\.com\/(@?\w+)/i);
      if (m) signals.handles.instagram = signals.handles.instagram || m[1].replace(/^@/, '').toLowerCase();
    }
    if (key === 'linkedin_url') signals.handles.linkedin = val.replace(/\/+$/, '').toLowerCase();
    if (key === 'headline' || key === 'role' || key === 'current_role') signals.titles.push(val);
    if (key === 'company' || key === 'current_company') signals.organizations.push(val);
    if (key === 'location' || key === 'current_location') signals.locations.push(val);
    if (key === 'x_bio' || key === 'instagram_bio') signals.bios.push(val);
    if (key === 'skills') signals.skills.push(...val.split(/,\s*/).filter(Boolean));
  }

  // Career lite
  if (entityData.career_lite) {
    const cl = entityData.career_lite;
    if (cl.current_role) signals.titles.push(cl.current_role);
    if (cl.current_company) signals.organizations.push(cl.current_company);
    if (cl.location) signals.locations.push(cl.location);
    if (cl.linkedin_url) signals.handles.linkedin = signals.handles.linkedin || cl.linkedin_url.replace(/\/+$/, '').toLowerCase();
    if (cl.skills?.length) signals.skills.push(...cl.skills);
    for (const exp of (cl.experience || [])) {
      if (exp.company) signals.organizations.push(exp.company);
      if (exp.title) signals.titles.push(exp.title);
    }
    for (const edu of (cl.education || [])) {
      if (edu.institution) signals.education.push(edu.institution);
    }
  }

  // Summary as bio
  if (entity.summary?.value) signals.bios.push(entity.summary.value);

  // Observations as raw text
  signals.raw_text = (entityData.observations || []).map(o => o.observation || '').join(' ');

  // Dedup arrays
  signals.names = [...new Set(signals.names.filter(Boolean))];
  signals.titles = [...new Set(signals.titles.filter(Boolean))];
  signals.organizations = [...new Set(signals.organizations.filter(Boolean))];
  signals.locations = [...new Set(signals.locations.filter(Boolean))];
  signals.bios = [...new Set(signals.bios.filter(Boolean))];
  signals.skills = [...new Set(signals.skills.filter(Boolean))];
  signals.education = [...new Set(signals.education.filter(Boolean))];

  return signals;
}

// --- Function 1: stageSignalCluster ---

function stageSignalCluster(extractedData, source, graphDir) {
  const now = new Date().toISOString();
  const clusterId = 'SIG-' + crypto.randomUUID().slice(0, 12);

  const entityType = extractedData.entity?.entity_type || 'person';
  const signals = extractSignals(extractedData);

  // Compute source-level confidence (Signal Confidence — level 1)
  const sourceWeight = getSourceWeight(source.type);
  const capturedDate = now.slice(0, 10);

  // Build confident signal values (per-signal confidence + source trail)
  const confSignals = {
    names: signals.names.map(n => signalValue(n, sourceWeight, clusterId)),
    handles: {
      x: signals.handles.x ? signalValue(signals.handles.x, sourceWeight, clusterId) : null,
      instagram: signals.handles.instagram ? signalValue(signals.handles.instagram, sourceWeight, clusterId) : null,
      linkedin: signals.handles.linkedin ? signalValue(signals.handles.linkedin, sourceWeight, clusterId) : null,
    },
    titles: signals.titles.map(t => signalValue(t, computeAttributeConfidence(sourceWeight, capturedDate, 'current_role', 1), clusterId)),
    organizations: signals.organizations.map(o => signalValue(o, computeAttributeConfidence(sourceWeight, capturedDate, 'company', 1), clusterId)),
    locations: signals.locations.map(l => signalValue(l, computeAttributeConfidence(sourceWeight, capturedDate, 'location', 1), clusterId)),
    bios: signals.bios.map(b => signalValue(b, sourceWeight * 0.9, clusterId)),
    skills: signals.skills.map(s => signalValue(s, sourceWeight, clusterId)),
    education: signals.education.map(e => signalValue(e, sourceWeight, clusterId)),
    raw_text: signals.raw_text,
  };

  const cluster = {
    cluster_id: clusterId,
    entity_type: entityType,
    source: {
      type: source.type || 'web',
      url: source.url || '',
      extracted_at: now,
      description: source.description || '',
      weight: sourceWeight,
    },
    state: 'unresolved',
    confidence: 0.0,
    signal_confidence: sourceWeight,
    candidate_entity_id: null,
    candidate_entity_name: null,
    quadrant: null,
    match_type: null,
    signals,
    confident_signals: confSignals,
    // Keep the full entity data for later promotion/merge
    _entity_data: extractedData,
    created_at: now,
    resolved_at: null,
  };

  writeCluster(clusterId, cluster, graphDir);
  return cluster;
}

// --- Scoring helpers ---

function getEntitySocialHandles(entity) {
  const handles = { x: null, instagram: null, linkedin: null };
  for (const attr of (entity.attributes || [])) {
    const key = (attr.key || '').toLowerCase();
    const val = (attr.value || '').trim();
    if (!val) continue;
    if (key === 'x_handle' || key === 'twitter_handle') handles.x = val.replace(/^@/, '').toLowerCase();
    if (key === 'instagram_handle') handles.instagram = val.replace(/^@/, '').toLowerCase();
    if (key === 'x_url' || key === 'twitter_url') {
      const m = val.match(/(?:x\.com|twitter\.com)\/(@?\w+)/i);
      if (m && !handles.x) handles.x = m[1].replace(/^@/, '').toLowerCase();
    }
    if (key === 'instagram_url') {
      const m = val.match(/instagram\.com\/(@?\w+)/i);
      if (m && !handles.instagram) handles.instagram = m[1].replace(/^@/, '').toLowerCase();
    }
    if (key === 'linkedin_url') handles.linkedin = val.replace(/\/+$/, '').toLowerCase();
  }
  if (entity.career_lite?.linkedin_url) {
    handles.linkedin = handles.linkedin || entity.career_lite.linkedin_url.replace(/\/+$/, '').toLowerCase();
  }
  return handles;
}

function scoreEntityMatch(signals, entityType, entity) {
  const existingType = entity.entity?.entity_type;
  if (!existingType) return { confidence: 0, matchType: null };

  // Type compatibility check
  if (entityType !== existingType) {
    const orgTypes = new Set(['organization', 'institution', 'business']);
    if (!orgTypes.has(entityType) || !orgTypes.has(existingType)) {
      return { confidence: 0, matchType: null };
    }
  }

  // 1. Email match
  const existingProps = getEntityProperties(entity);
  const incomingEmail = signals.names.length ? null : null; // emails from attributes
  // Check email from _entity_data if available
  // (handled via property overlap below)

  // 2. Social handle match
  const existingHandles = getEntitySocialHandles(entity);
  const existingAliases = (entity.entity?.name?.aliases || []).map(a => a.toLowerCase().replace(/^@/, ''));
  const existingNames = getAllNames(entity);

  // X handle match
  if (signals.handles.x && existingHandles.x && signals.handles.x === existingHandles.x) {
    return { confidence: 0.90, matchType: 'social_handle_x' };
  }
  // Instagram handle match
  if (signals.handles.instagram && existingHandles.instagram && signals.handles.instagram === existingHandles.instagram) {
    return { confidence: 0.90, matchType: 'social_handle_instagram' };
  }
  // LinkedIn URL match
  if (signals.handles.linkedin && existingHandles.linkedin && signals.handles.linkedin === existingHandles.linkedin) {
    return { confidence: 0.90, matchType: 'social_url_linkedin' };
  }

  // 3. Handle ↔ alias cross-match: incoming handle found in existing aliases
  if (signals.handles.x && existingAliases.includes(signals.handles.x)) {
    return { confidence: 0.85, matchType: 'handle_alias_cross' };
  }
  if (signals.handles.instagram && existingAliases.includes(signals.handles.instagram)) {
    return { confidence: 0.85, matchType: 'handle_alias_cross' };
  }
  // Reverse: existing handle found in incoming names/aliases
  if (existingHandles.x) {
    const incomingLower = signals.names.map(n => n.toLowerCase().replace(/^@/, ''));
    if (incomingLower.includes(existingHandles.x)) {
      return { confidence: 0.85, matchType: 'handle_alias_cross' };
    }
  }

  // 4. Name matching
  const isPerson = entityType === 'person';
  const incomingNames = signals.names;

  // Get primary name for Dice comparison
  let existingPrimaryName = '';
  if (isPerson) {
    existingPrimaryName = entity.entity?.name?.full || '';
  } else {
    existingPrimaryName = entity.entity?.name?.common || entity.entity?.name?.legal || '';
  }
  const incomingPrimaryName = incomingNames[0] || '';

  // High name similarity (Dice > 0.85)
  if (incomingPrimaryName && existingPrimaryName && similarity(incomingPrimaryName, existingPrimaryName) > 0.85) {
    return { confidence: 0.85, matchType: 'name_high' };
  }

  if (isPerson) {
    // Names-likely-match (alias/initials/token subset)
    if (incomingNames.length > 0 && existingNames.length > 0 && namesLikelyMatch(incomingNames, existingNames)) {
      return { confidence: 0.82, matchType: 'name_alias' };
    }

    // Build a fake entity for property/relationship comparison
    const fakeIncoming = {
      entity: { entity_type: 'person', name: { full: incomingPrimaryName, aliases: incomingNames.slice(1) } },
      attributes: [],
      relationships: [],
    };

    // Moderate name + 2 property overlaps
    const nameSim = incomingPrimaryName ? similarity(incomingPrimaryName, existingPrimaryName) : 0;
    if (nameSim > 0.5) {
      // Build minimal entity for propertyOverlapCount
      const overlap = propertyOverlapCount(entity, fakeIncoming);
      if (overlap >= 2) return { confidence: 0.75, matchType: 'name_properties' };

      // Shared relationships
      const sharedRels = countSharedRelationships(entity, fakeIncoming);
      if (sharedRels >= 1) return { confidence: 0.70, matchType: 'name_shared_rels' };
    }
  } else {
    // Org name normalization (strip Inc, LLC, etc.)
    if (incomingPrimaryName && existingPrimaryName) {
      const normIncoming = incomingPrimaryName.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
      const normExisting = existingPrimaryName.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
      if (normIncoming && normExisting && similarity(normIncoming, normExisting) > 0.85) {
        return { confidence: 0.85, matchType: 'org_name_normalized' };
      }
    }
  }

  return { confidence: 0, matchType: null };
}

function computeSignalOverlap(signals, existingEntity) {
  // Check how much of the incoming signal data already exists on the entity
  let totalSignals = 0;
  let matchedSignals = 0;

  const existingProps = getEntityProperties(existingEntity);
  const existingHandles = getEntitySocialHandles(existingEntity);

  // Handles
  if (signals.handles.x) { totalSignals++; if (existingHandles.x === signals.handles.x) matchedSignals++; }
  if (signals.handles.instagram) { totalSignals++; if (existingHandles.instagram === signals.handles.instagram) matchedSignals++; }
  if (signals.handles.linkedin) { totalSignals++; if (existingHandles.linkedin === signals.handles.linkedin) matchedSignals++; }

  // Titles
  for (const title of signals.titles) {
    totalSignals++;
    // Check against existing attributes
    for (const attr of (existingEntity.attributes || [])) {
      if (['headline', 'role', 'current_role'].includes((attr.key || '').toLowerCase())) {
        if (similarity(title, attr.value || '') > 0.85) { matchedSignals++; break; }
      }
    }
  }

  // Organizations
  for (const org of signals.organizations) {
    totalSignals++;
    if (existingProps.company && (similarity(org.toLowerCase(), existingProps.company) > 0.7 ||
        existingProps.company.includes(org.toLowerCase()) || org.toLowerCase().includes(existingProps.company))) {
      matchedSignals++;
    }
  }

  // Skills
  for (const skill of signals.skills) {
    totalSignals++;
    if (existingProps.skills.some(s => similarity(skill.toLowerCase(), s) > 0.85)) matchedSignals++;
  }

  // Bios (check against existing observations)
  const existingObsTexts = (existingEntity.observations || []).map(o => (o.observation || '').toLowerCase());
  for (const bio of signals.bios) {
    totalSignals++;
    if (existingObsTexts.some(obs => similarity(bio.toLowerCase(), obs) > 0.7)) matchedSignals++;
  }

  if (totalSignals === 0) return 0;
  return matchedSignals / totalSignals;
}

// --- Function 2: scoreCluster ---

function scoreCluster(clusterId, graphDir) {
  const cluster = readCluster(clusterId, graphDir);
  if (!cluster) return null;

  const signals = cluster.signals;
  const entityType = cluster.entity_type;

  // Score against existing confirmed entities
  const existingEntities = listEntities(graphDir);
  let bestMatch = { confidence: 0, entityId: null, entityName: null, matchType: null };

  for (const { file, data } of existingEntities) {
    const existingType = data.entity?.entity_type;
    if (!existingType) continue;

    const { confidence, matchType } = scoreEntityMatch(signals, entityType, data);
    if (confidence > bestMatch.confidence) {
      const eid = data.entity?.entity_id || file.replace('.json', '');
      const ename = existingType === 'person'
        ? (data.entity?.name?.full || '')
        : (data.entity?.name?.common || data.entity?.name?.legal || '');
      bestMatch = { confidence, entityId: eid, entityName: ename, matchType };
    }
  }

  // Determine quadrant
  let quadrant = null;
  let state = 'unresolved';

  if (bestMatch.confidence >= 0.5) {
    // Matched an existing entity — check signal overlap (Q2 vs Q4)
    const existingEntity = readEntity(bestMatch.entityId, graphDir);
    const signalOverlap = existingEntity ? computeSignalOverlap(signals, existingEntity) : 0;

    if (signalOverlap > 0.6) {
      // Most signals already exist on entity → Q4 (Duplicate Data + Existing Entity)
      quadrant = 4;
      state = 'provisional';
    } else {
      // New signals for existing entity → Q2 (New Data + Existing Entity)
      quadrant = 2;
      state = 'provisional';
    }

    cluster.candidate_entity_id = bestMatch.entityId;
    cluster.candidate_entity_name = bestMatch.entityName;
  } else {
    // No entity match — check for unresolved cluster matches (Q1 vs Q3)
    const unresolvedClusters = listClusters(graphDir).filter(c =>
      c.cluster_id !== clusterId && c.state !== 'confirmed' && c.entity_type === entityType
    );

    let clusterMatches = 0;
    for (const other of unresolvedClusters) {
      // Check name overlap between clusters
      const otherNames = other.signals?.names || [];
      for (const name of signals.names) {
        for (const otherName of otherNames) {
          if (similarity(name, otherName) > 0.85) { clusterMatches++; break; }
        }
        if (clusterMatches > 0) break;
      }
    }

    // Also check for unresolved mentions across existing entity observations
    let unresolvedMentions = 0;
    const primaryName = signals.names[0] || '';
    if (primaryName) {
      for (const { data } of existingEntities) {
        for (const obs of (data.observations || [])) {
          if ((obs.observation || '').toLowerCase().includes(primaryName.toLowerCase())) {
            unresolvedMentions++;
          }
        }
        for (const rel of (data.relationships || [])) {
          if (similarity(rel.name || '', primaryName) > 0.85) {
            unresolvedMentions++;
          }
        }
      }
    }

    if (clusterMatches > 0 || unresolvedMentions >= 2) {
      // Q3 (Duplicate Data + New Entity) — data already referenced elsewhere
      quadrant = 3;
      state = 'provisional';
      cluster.related_mentions = unresolvedMentions;
      cluster.related_clusters = clusterMatches;
    } else {
      // Q1 (New Data + New Entity)
      quadrant = 1;
      state = 'unresolved';
    }
  }

  cluster.confidence = bestMatch.confidence;
  cluster.match_type = bestMatch.matchType;
  cluster.quadrant = quadrant;
  cluster.state = state;

  writeCluster(clusterId, cluster, graphDir);
  return cluster;
}

// --- Function 3: resolveCluster ---

function resolveCluster(clusterId, action, graphDir, agentId) {
  const cluster = readCluster(clusterId, graphDir);
  if (!cluster) return { error: 'Cluster not found' };

  const now = new Date().toISOString();
  const entityData = cluster._entity_data;

  if (action === 'hold') {
    cluster.state = 'unresolved';
    cluster.resolved_at = null;
    writeCluster(clusterId, cluster, graphDir);
    return { action: 'hold', cluster_id: clusterId };
  }

  if (action === 'skip') {
    // Q4: data already captured. Add source attribution, strengthen confidence.
    cluster.state = 'confirmed';
    cluster.resolved_at = now;
    writeCluster(clusterId, cluster, graphDir);

    if (cluster.candidate_entity_id) {
      const existing = readEntity(cluster.candidate_entity_id, graphDir);
      if (existing) {
        // Add provenance
        if (!existing.provenance_chain) {
          existing.provenance_chain = { created_at: now, created_by: agentId || 'signal-staging', source_documents: [], merge_history: [] };
        }
        existing.provenance_chain.source_documents = existing.provenance_chain.source_documents || [];
        existing.provenance_chain.source_documents.push({
          source: cluster.source.description || cluster.source.url || 'signal_cluster',
          url: cluster.source.url,
          ingested_at: now,
          note: 'Duplicate data confirmed via signal staging Q4',
        });

        // Q4 confidence effect: recalculate corroboration on matching attributes
        // Count total independent sources on this entity
        const totalSources = (existing.provenance_chain.source_documents || []).length;
        for (const attr of (existing.attributes || [])) {
          // Bump confidence with corroboration multiplier
          const baseConf = attr._base_confidence || attr.confidence || 0.5;
          attr.confidence = Math.min(1.0, baseConf * corroborationMultiplier(totalSources));
          if (!attr._source_clusters) attr._source_clusters = [];
          attr._source_clusters.push(clusterId);
        }

        writeEntity(cluster.candidate_entity_id, existing, graphDir);
      }
    }

    deleteCluster(clusterId, graphDir);
    return { action: 'skip', cluster_id: clusterId, entity_id: cluster.candidate_entity_id, message: 'Source added. No new data created.' };
  }

  if (action === 'merge') {
    // Q2: New data for existing entity. Merge via ingest pipeline logic.
    if (!cluster.candidate_entity_id || !entityData) {
      return { error: 'No candidate entity to merge with' };
    }

    const existing = readEntity(cluster.candidate_entity_id, graphDir);
    if (!existing) return { error: 'Candidate entity not found: ' + cluster.candidate_entity_id };

    const entityType = entityData.entity?.entity_type;
    const source = cluster.source.description || cluster.source.url || 'signal_cluster_merge';

    // Build incoming for merge
    const incoming = {
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now,
        source_description: source,
        extraction_model: entityData.extraction_metadata?.extraction_model || 'signal-staging',
        extraction_confidence: entityData.extraction_metadata?.extraction_confidence || 0.6,
        schema_version: '2.0',
      },
      entity: {
        entity_type: entityType,
        entity_id: cluster.candidate_entity_id,
        name: entityData.entity.name,
        summary: entityData.entity.summary || existing.entity?.summary || { value: '', confidence: 0, facts_layer: 2 },
      },
      attributes: entityData.attributes || [],
      relationships: entityData.relationships || [],
      values: entityData.values || [],
      key_facts: entityData.key_facts || [],
      constraints: entityData.constraints || [],
      observations: [],
      provenance_chain: {
        created_at: now,
        created_by: agentId || 'signal-staging',
        source_documents: [{ source, ingested_at: now, url: cluster.source.url }],
        merge_history: [],
      },
    };

    if (entityData.career_lite) incoming.career_lite = entityData.career_lite;
    if (entityData.structured_attributes) incoming.structured_attributes = entityData.structured_attributes;

    // Merge structured data
    const { merged } = merge(existing, incoming);
    const result = merged || existing;

    // Career lite: incoming wins if it has experience data
    if (entityData.career_lite?.experience?.length > 0) {
      result.career_lite = entityData.career_lite;
      result.career_lite.interface = 'career-lite';
    }

    // Profile mode: structured_attributes always win from profile source
    if (entityData.structured_attributes?.interface === 'profile') {
      result.structured_attributes = entityData.structured_attributes;
    }

    // Append observations (dedup by lowercase text)
    if (!result.observations) result.observations = [];
    const existingObsTexts = new Set(result.observations.map(o => (o.observation || '').toLowerCase().trim()));
    const newObservations = (entityData.observations || []).map(obs => ({
      ...obs,
      truth_level: obs.truth_level || 'INFERRED',
    }));
    let obsAdded = 0;
    for (const obs of newObservations) {
      if (!obs.observation) continue;
      if (existingObsTexts.has(obs.observation.toLowerCase().trim())) continue;
      const seq = String(result.observations.length + 1).padStart(3, '0');
      const tsCompact = (obs.observed_at || now).replace(/[-:T]/g, '').slice(0, 14);
      obs.observation_id = `OBS-${cluster.candidate_entity_id}-${tsCompact}-${seq}`;
      result.observations.push(obs);
      existingObsTexts.add(obs.observation.toLowerCase().trim());
      obsAdded++;
    }

    // Provenance
    if (!result.provenance_chain) {
      result.provenance_chain = { created_at: now, created_by: agentId || 'signal-staging', source_documents: [], merge_history: [] };
    }
    result.provenance_chain.source_documents = result.provenance_chain.source_documents || [];
    result.provenance_chain.source_documents.push({
      source: source,
      url: cluster.source.url,
      ingested_at: now,
    });
    result.provenance_chain.merge_history = result.provenance_chain.merge_history || [];
    result.provenance_chain.merge_history.push({
      merged_at: now,
      merged_by: agentId || 'signal-staging',
      changes: [`Signal cluster ${clusterId}: merged data and ${obsAdded} observations`],
    });

    // Q2 confidence effect: corroborate matching attributes
    const totalSources = (result.provenance_chain.source_documents || []).length;
    for (const attr of (result.attributes || [])) {
      const baseConf = attr._base_confidence || attr.confidence || 0.5;
      // Check if this attribute key appears in the incoming data
      const incomingKeys = (entityData.attributes || []).map(a => (a.key || '').toLowerCase());
      if (incomingKeys.includes((attr.key || '').toLowerCase())) {
        // Corroborated by new source
        attr.confidence = Math.min(1.0, baseConf * corroborationMultiplier(totalSources));
        if (!attr._source_clusters) attr._source_clusters = [];
        if (!attr._source_clusters.includes(clusterId)) attr._source_clusters.push(clusterId);
      }
    }

    writeEntity(cluster.candidate_entity_id, result, graphDir);

    // Decompose if person
    if (entityType === 'person') {
      decomposePersonEntity(result, cluster.candidate_entity_id, graphDir);
    }

    // Mark cluster as confirmed and remove
    cluster.state = 'confirmed';
    cluster.resolved_at = now;
    writeCluster(clusterId, cluster, graphDir);
    deleteCluster(clusterId, graphDir);

    return {
      action: 'merge',
      cluster_id: clusterId,
      entity_id: cluster.candidate_entity_id,
      entity_name: cluster.candidate_entity_name,
      observations_added: obsAdded,
    };
  }

  if (action === 'create_new') {
    // Q1 or Q3: Promote cluster to new entity
    if (!entityData) return { error: 'No entity data in cluster' };

    const entityType = entityData.entity?.entity_type;
    if (!entityType || !['person', 'business', 'institution'].includes(entityType)) {
      return { error: 'Invalid entity type: ' + entityType };
    }

    const displayName = entityType === 'person'
      ? (entityData.entity?.name?.full || '')
      : (entityData.entity?.name?.common || entityData.entity?.name?.legal || '');

    let initials;
    if (entityType === 'person') {
      initials = displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
    } else if (entityType === 'institution') {
      initials = 'INST-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
    } else {
      initials = 'BIZ-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
    }
    const seq = getNextCounter(graphDir, entityType);
    const entityId = `ENT-${initials}-${String(seq).padStart(3, '0')}`;

    entityData.entity.entity_id = entityId;

    // Set observation IDs
    const newObservations = (entityData.observations || []).map((obs, idx) => {
      const tsCompact = (obs.observed_at || now).replace(/[-:T]/g, '').slice(0, 14);
      return {
        ...obs,
        observation_id: `OBS-${entityId}-${tsCompact}-${String(idx + 1).padStart(3, '0')}`,
        truth_level: obs.truth_level || 'INFERRED',
      };
    });
    entityData.observations = newObservations;

    // Ensure provenance chain
    if (!entityData.provenance_chain) {
      entityData.provenance_chain = {
        created_at: now,
        created_by: agentId || 'signal-staging',
        source_documents: [{ source: cluster.source.url || 'signal_cluster', ingested_at: now }],
        merge_history: [],
      };
    }

    // Q1 confidence: stamp each attribute with source-weighted confidence
    const srcWeight = cluster.source.weight || getSourceWeight(cluster.source.type);
    const capDate = cluster.source.extracted_at ? cluster.source.extracted_at.slice(0, 10) : now.slice(0, 10);
    for (const attr of (entityData.attributes || [])) {
      attr._base_confidence = attr.confidence || srcWeight;
      attr.confidence = computeAttributeConfidence(srcWeight, capDate, attr.key, 1);
      attr._source_clusters = [clusterId];
    }

    writeEntity(entityId, entityData, graphDir);

    // Decompose if person
    if (entityType === 'person') {
      decomposePersonEntity(entityData, entityId, graphDir);
    }

    // Mark cluster as confirmed and remove
    cluster.state = 'confirmed';
    cluster.resolved_at = now;
    writeCluster(clusterId, cluster, graphDir);
    deleteCluster(clusterId, graphDir);

    return {
      action: 'create_new',
      cluster_id: clusterId,
      entity_id: entityId,
      entity_name: displayName,
    };
  }

  return { error: 'Unknown action: ' + action };
}

// --- Batch helper: stage + score multiple entities from an extraction ---

function stageAndScoreExtraction(entities, source, graphDir) {
  const results = [];
  for (const entityData of entities) {
    const entityType = entityData.entity?.entity_type;
    if (!entityType || !['person', 'business', 'institution'].includes(entityType)) continue;

    const displayName = entityType === 'person'
      ? (entityData.entity?.name?.full || '')
      : (entityData.entity?.name?.common || entityData.entity?.name?.legal || '');
    if (!displayName) continue;

    const cluster = stageSignalCluster(entityData, source, graphDir);
    const scored = scoreCluster(cluster.cluster_id, graphDir);
    results.push(scored);
  }
  return results;
}

// --- Get review queue (all unresolved + provisional clusters) ---

function getReviewQueue(graphDir) {
  const clusters = listClusters(graphDir);
  return clusters
    .filter(c => c.state === 'unresolved' || c.state === 'provisional')
    .sort((a, b) => (a.confidence || 0) - (b.confidence || 0)); // Lowest confidence first
}

module.exports = {
  stageSignalCluster,
  scoreCluster,
  resolveCluster,
  stageAndScoreExtraction,
  getReviewQueue,
  listClusters,
  readCluster,
  writeCluster,
  deleteCluster,
  getEntitySocialHandles,
  extractSignals,
  // Confidence scoring
  getSourceWeight,
  SOURCE_WEIGHTS,
  recencyModifier,
  corroborationMultiplier,
  computeAttributeConfidence,
  computeEntityConfidence,
  confidenceTier,
};
