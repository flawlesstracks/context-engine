#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// --- Relationship type normalization ---

function normalizeRelationshipType(type) {
  const t = (type || '').toLowerCase().trim();
  const familyMap = {
    family: ['sister', 'brother', 'sibling', 'mother', 'father', 'parent', 'daughter', 'son', 'child',
             'aunt', 'uncle', 'cousin', 'niece', 'nephew', 'grandmother', 'grandfather', 'grandparent',
             'wife', 'husband', 'spouse', 'partner', 'ex-wife', 'ex-husband', 'ex-spouse',
             'in-law', 'step-', 'half-'],
    friend: ['friend', 'close friend', 'best friend', 'childhood friend', 'family friend'],
    professional: ['colleague', 'coworker', 'co-worker', 'manager', 'boss', 'mentor', 'mentee',
                   'report', 'supervisor'],
  };
  for (const [category, keywords] of Object.entries(familyMap)) {
    for (const kw of keywords) {
      if (t.includes(kw)) return category;
    }
  }
  return t;
}

// --- String similarity (Dice coefficient on bigrams) ---

function bigrams(str) {
  const s = str.toLowerCase().replace(/\s+/g, ' ').trim();
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a.toLowerCase() === b.toLowerCase()) return 1.0;
  const biA = bigrams(a);
  const biB = bigrams(b);
  if (biA.size === 0 || biB.size === 0) return 0;
  let intersection = 0;
  for (const bi of biA) {
    if (biB.has(bi)) intersection++;
  }
  return (2 * intersection) / (biA.size + biB.size);
}

// --- Name & property helpers for enhanced matching ---

/**
 * Collect all known names for an entity (full, preferred, aliases).
 */
function getAllNames(entity) {
  const names = [];
  const e = entity.entity || {};
  if (e.name?.full) names.push(e.name.full);
  if (e.name?.preferred) names.push(e.name.preferred);
  for (const alias of (e.name?.aliases || [])) {
    if (alias) names.push(alias);
  }
  // Deduplicate (case-insensitive)
  const seen = new Set();
  return names.filter(n => {
    const key = n.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Check if two sets of names likely refer to the same person.
 * Handles: alias cross-matching, token subsets, initials (CJ = Clarence James).
 */
function namesLikelyMatch(namesA, namesB) {
  for (const a of namesA) {
    for (const b of namesB) {
      // Direct high similarity on any name pair
      if (similarity(a, b) > 0.85) return true;

      const tokensA = a.toLowerCase().split(/[\s()]+/).filter(Boolean);
      const tokensB = b.toLowerCase().split(/[\s()]+/).filter(Boolean);

      // Token subset: "Clarence Mitchell" ⊆ "Clarence James Mitchell"
      if (tokensA.length >= 2 && tokensB.length >= 2) {
        const aInB = tokensA.every(t => tokensB.some(tb => similarity(t, tb) > 0.85));
        const bInA = tokensB.every(t => tokensA.some(ta => similarity(t, ta) > 0.85));
        if (aInB || bInA) return true;
      }

      // Initials matching: "CJ Mitchell" vs "Clarence James Mitchell"
      if (tokensA.length >= 2 && tokensB.length >= 2) {
        const lastA = tokensA[tokensA.length - 1];
        const lastB = tokensB[tokensB.length - 1];
        // Last names must match
        if (similarity(lastA, lastB) > 0.85) {
          const firstA = tokensA.slice(0, -1);
          const firstB = tokensB.slice(0, -1);
          // Check if first part of A is initials of B's first parts
          if (firstA.length === 1 && firstA[0].length <= 4 && firstB.length >= 1) {
            const candidate = firstA[0].toUpperCase();
            const initials = firstB.map(t => t[0]).join('').toUpperCase();
            if (candidate === initials) return true;
          }
          // Reverse check
          if (firstB.length === 1 && firstB[0].length <= 4 && firstA.length >= 1) {
            const candidate = firstB[0].toUpperCase();
            const initials = firstA.map(t => t[0]).join('').toUpperCase();
            if (candidate === initials) return true;
          }
        }
      }

      // Standalone nickname is initials: "CJ" (single token) vs "Clarence James Mitchell"
      if (tokensA.length === 1 && tokensA[0].length <= 4 && tokensB.length >= 2) {
        const candidate = tokensA[0].toUpperCase();
        const firstParts = tokensB.slice(0, -1);
        const initials = firstParts.map(t => t[0]).join('').toUpperCase();
        if (candidate === initials) return true;
      }
      if (tokensB.length === 1 && tokensB[0].length <= 4 && tokensA.length >= 2) {
        const candidate = tokensB[0].toUpperCase();
        const firstParts = tokensA.slice(0, -1);
        const initials = firstParts.map(t => t[0]).join('').toUpperCase();
        if (candidate === initials) return true;
      }
    }
  }
  return false;
}

/**
 * Extract comparable properties from an entity for overlap checking.
 */
function getEntityProperties(entity) {
  const props = { company: '', location: '', email: '', linkedinUrl: '', skills: [] };

  // From attributes
  for (const attr of (entity.attributes || [])) {
    const key = (attr.key || '').toLowerCase();
    const val = (attr.value || '').trim();
    if (!val) continue;
    if ((key === 'company' || key === 'current_role') && !props.company) {
      // Extract company name from "role at Company" or just company
      const atMatch = val.match(/at\s+(.+)/i);
      props.company = (atMatch ? atMatch[1] : val).toLowerCase();
    }
    if ((key === 'location' || key === 'current_location') && !props.location) {
      props.location = val.toLowerCase();
    }
    if (key === 'email' && !props.email) props.email = val.toLowerCase();
    if (key === 'linkedin_url' && !props.linkedinUrl) props.linkedinUrl = val.toLowerCase();
    if (key === 'skills' && props.skills.length === 0) {
      props.skills = val.split(/,\s*/).map(s => s.toLowerCase().trim()).filter(Boolean);
    }
  }

  // From career_lite (fallback)
  const cl = entity.career_lite;
  if (cl) {
    if (cl.current_company && !props.company) props.company = cl.current_company.toLowerCase();
    if (cl.location && !props.location) props.location = cl.location.toLowerCase();
    if (cl.linkedin_url && !props.linkedinUrl) props.linkedinUrl = cl.linkedin_url.toLowerCase();
    if (cl.skills && cl.skills.length > 0 && props.skills.length === 0) {
      props.skills = cl.skills.map(s => s.toLowerCase().trim());
    }
  }

  return props;
}

/**
 * Count how many properties overlap between two entities.
 * Checks: company, LinkedIn URL, email, location, skills (3+).
 */
function propertyOverlapCount(base, incoming) {
  const bp = getEntityProperties(base);
  const ip = getEntityProperties(incoming);
  let count = 0;

  // Company (fuzzy — "Amazon" matches "Amazon (Relay)")
  if (bp.company && ip.company) {
    if (similarity(bp.company, ip.company) > 0.7 ||
        bp.company.includes(ip.company) || ip.company.includes(bp.company)) {
      count++;
    }
  }

  // LinkedIn URL (exact, ignoring trailing slash)
  if (bp.linkedinUrl && ip.linkedinUrl) {
    if (bp.linkedinUrl.replace(/\/+$/, '') === ip.linkedinUrl.replace(/\/+$/, '')) count++;
  }

  // Email (exact)
  if (bp.email && ip.email && bp.email === ip.email) count++;

  // Location (fuzzy — "Atlanta, Georgia" matches "Atlanta, GA")
  if (bp.location && ip.location) {
    if (similarity(bp.location, ip.location) > 0.6 ||
        bp.location.includes(ip.location) || ip.location.includes(bp.location)) {
      count++;
    }
  }

  // Skills (3+ matches)
  if (bp.skills.length > 0 && ip.skills.length > 0) {
    let skillMatches = 0;
    for (const skill of bp.skills) {
      if (ip.skills.some(s => similarity(skill, s) > 0.85)) skillMatches++;
    }
    if (skillMatches >= 3) count++;
  }

  return count;
}

// --- Match check ---

function entitiesMatch(base, incoming) {
  // Explicit entity_id match
  if (base.entity?.entity_id && base.entity.entity_id === incoming.entity?.entity_id) {
    return true;
  }

  // Email match (exact)
  const baseEmail = getEntityProperties(base).email;
  const incomingEmail = getEntityProperties(incoming).email;
  if (baseEmail && incomingEmail && baseEmail === incomingEmail) return true;

  // Must be same entity type (institution and organization are compatible)
  const type = base.entity?.entity_type;
  const incomingType = incoming.entity?.entity_type;
  if (type && incomingType && type !== incomingType) {
    const orgTypes = new Set(['organization', 'institution']);
    if (!orgTypes.has(type) || !orgTypes.has(incomingType)) return false;
  }

  // Get primary names
  let baseName = '';
  let incomingName = '';
  if (type === 'person') {
    baseName = base.entity?.name?.full || '';
    incomingName = incoming.entity?.name?.full || '';
  } else {
    baseName = base.entity?.name?.common || base.entity?.name?.legal || '';
    incomingName = incoming.entity?.name?.common || incoming.entity?.name?.legal || '';
  }

  // High name similarity (original threshold)
  if (similarity(baseName, incomingName) > 0.85) return true;

  // Enhanced matching for persons: nickname awareness + property overlap + shared relationships
  if (type === 'person') {
    const baseNames = getAllNames(base);
    const incomingNames = getAllNames(incoming);

    // Nickname/alias-aware name match
    if (namesLikelyMatch(baseNames, incomingNames)) {
      return true;
    }

    // Property-heavy match: 2+ property overlaps AND moderate name similarity (>0.5)
    if (similarity(baseName, incomingName) > 0.5 && propertyOverlapCount(base, incoming) >= 2) {
      return true;
    }

    // Shared relationship match: fuzzy name + 1 shared relationship, or different name + 2 shared relationships
    const sharedRels = countSharedRelationships(base, incoming);
    if (similarity(baseName, incomingName) > 0.5 && sharedRels >= 1) {
      return true;
    }
    if (sharedRels >= 2) {
      return true;
    }
  }

  // Enhanced org matching: handle common abbreviations
  if (type !== 'person' && baseName && incomingName) {
    const normBase = baseName.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
    const normIncoming = incomingName.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
    if (normBase && normIncoming && similarity(normBase, normIncoming) > 0.85) return true;
  }

  return false;
}

function countSharedRelationships(base, incoming) {
  const baseRels = (base.relationships || []).map(r => (r.name || '').toLowerCase().trim()).filter(Boolean);
  const incomingRels = (incoming.relationships || []).map(r => (r.name || '').toLowerCase().trim()).filter(Boolean);
  if (baseRels.length === 0 || incomingRels.length === 0) return 0;
  let count = 0;
  for (const br of baseRels) {
    for (const ir of incomingRels) {
      if (br === ir || similarity(br, ir) > 0.85) {
        count++;
        break;
      }
    }
  }
  return count;
}

// --- Merge functions ---

function mergeAttributes(baseAttrs, incomingAttrs) {
  const merged = [...baseAttrs];
  const history = [];

  for (const incoming of incomingAttrs) {
    const existing = merged.find(a => a.key === incoming.key);
    if (existing) {
      if (incoming.confidence > existing.confidence) {
        // Incoming wins — archive existing
        history.push({
          type: 'attribute_replaced',
          attribute_id: existing.attribute_id,
          key: existing.key,
          old_value: existing.value,
          old_confidence: existing.confidence,
          new_value: incoming.value,
          new_confidence: incoming.confidence,
          timestamp: new Date().toISOString(),
        });
        Object.assign(existing, incoming);
      } else if (incoming.confidence === existing.confidence) {
        // Equal confidence — keep newer (incoming) if value differs
        if (incoming.value !== existing.value) {
          const incomingDate = incoming.time_decay?.captured_date || '';
          const existingDate = existing.time_decay?.captured_date || '';
          if (incomingDate >= existingDate) {
            history.push({
              type: 'attribute_replaced_same_confidence',
              attribute_id: existing.attribute_id,
              key: existing.key,
              old_value: existing.value,
              new_value: incoming.value,
              confidence: incoming.confidence,
              timestamp: new Date().toISOString(),
            });
            Object.assign(existing, incoming);
          }
        }
      }
      // else: existing has higher confidence, keep it
    } else {
      // New attribute — assign next ID
      const maxNum = merged.reduce((max, a) => {
        const num = parseInt((a.attribute_id || '').replace('ATTR-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.attribute_id = `ATTR-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return { merged, history };
}

function mergeRelationships(baseRels, incomingRels) {
  const merged = [...baseRels];
  const history = [];

  for (const incoming of incomingRels) {
    // Deduplicate by name + normalized relationship category
    const existing = merged.find(r =>
      similarity(r.name || '', incoming.name || '') > 0.85 &&
      normalizeRelationshipType(r.relationship_type) === normalizeRelationshipType(incoming.relationship_type)
    );

    if (existing) {
      // Keep the version with more context detail, or higher confidence
      const existingDetail = (existing.context || '').length + (existing.relationship_type || '').length;
      const incomingDetail = (incoming.context || '').length + (incoming.relationship_type || '').length;
      if (incomingDetail > existingDetail || incoming.confidence > existing.confidence) {
        const oldId = existing.relationship_id;
        const oldSentiment = existing.sentiment;
        Object.assign(existing, incoming);
        existing.relationship_id = oldId;
        if (incoming.sentiment && incoming.sentiment !== oldSentiment) {
          history.push({
            type: 'relationship_sentiment_changed',
            relationship_id: existing.relationship_id,
            name: existing.name,
            old_sentiment: oldSentiment,
            new_sentiment: incoming.sentiment,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } else {
      // New relationship
      const maxNum = merged.reduce((max, r) => {
        const num = parseInt((r.relationship_id || '').replace('REL-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.relationship_id = `REL-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return { merged, history };
}

function mergeKeyFacts(baseFacts, incomingFacts) {
  const merged = [...baseFacts];
  const history = [];

  for (const incoming of incomingFacts) {
    // Deduplicate by semantic similarity >90%
    const existing = merged.find(f => similarity(f.fact || '', incoming.fact || '') > 0.90);

    if (existing) {
      if (incoming.confidence > existing.confidence) {
        history.push({
          type: 'fact_replaced',
          fact_id: existing.fact_id,
          old_fact: existing.fact,
          old_confidence: existing.confidence,
          new_fact: incoming.fact,
          new_confidence: incoming.confidence,
          timestamp: new Date().toISOString(),
        });
        const oldId = existing.fact_id;
        Object.assign(existing, incoming);
        existing.fact_id = oldId;
      }
    } else {
      // New fact
      const maxNum = merged.reduce((max, f) => {
        const num = parseInt((f.fact_id || '').replace('FACT-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.fact_id = `FACT-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return { merged, history };
}

function mergeValues(baseVals, incomingVals) {
  const merged = [...baseVals];

  for (const incoming of incomingVals) {
    const existing = merged.find(v => similarity(v.value || '', incoming.value || '') > 0.85);
    if (existing) {
      if (incoming.confidence > existing.confidence) {
        const oldId = existing.value_id;
        Object.assign(existing, incoming);
        existing.value_id = oldId;
      }
    } else {
      const maxNum = merged.reduce((max, v) => {
        const num = parseInt((v.value_id || '').replace('VAL-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.value_id = `VAL-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return merged;
}

function mergeProjects(baseProj, incomingProj) {
  const merged = [...baseProj];

  for (const incoming of incomingProj) {
    const existing = merged.find(p => similarity(p.name || '', incoming.name || '') > 0.85);
    if (existing) {
      if (incoming.confidence > existing.confidence) {
        const oldId = existing.project_id;
        Object.assign(existing, incoming);
        existing.project_id = oldId;
      }
    } else {
      const maxNum = merged.reduce((max, p) => {
        const num = parseInt((p.project_id || '').replace('PROJ-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.project_id = `PROJ-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return merged;
}

function mergeProductsServices(baseProd, incomingProd) {
  const merged = [...baseProd];

  for (const incoming of incomingProd) {
    const existing = merged.find(p => similarity(p.name || '', incoming.name || '') > 0.85);
    if (existing) {
      if (incoming.confidence > existing.confidence) {
        const oldId = existing.product_id;
        Object.assign(existing, incoming);
        existing.product_id = oldId;
      }
    } else {
      const maxNum = merged.reduce((max, p) => {
        const num = parseInt((p.product_id || '').replace('PROD-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.product_id = `PROD-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return merged;
}

function mergeKeyPeople(basePeople, incomingPeople) {
  const merged = [...basePeople];

  for (const incoming of incomingPeople) {
    const existing = merged.find(p => similarity(p.name || '', incoming.name || '') > 0.85);
    if (existing) {
      if (incoming.confidence > existing.confidence) {
        const oldId = existing.person_id;
        Object.assign(existing, incoming);
        existing.person_id = oldId;
      }
    } else {
      const maxNum = merged.reduce((max, p) => {
        const num = parseInt((p.person_id || '').replace('PERSON-', ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.person_id = `PERSON-${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return merged;
}

function mergeConstraints(baseCon, incomingCon) {
  const merged = [...baseCon];

  for (const incoming of incomingCon) {
    const existing = merged.find(c => similarity(c.name || '', incoming.name || '') > 0.85);
    if (!existing) {
      const prefix = incoming.constraint_id?.startsWith('CON-BIZ') ? 'CON-BIZ-' : 'CON-EXT-';
      const maxNum = merged.reduce((max, c) => {
        const num = parseInt((c.constraint_id || '').replace(/CON-(BIZ|EXT)-/, ''), 10);
        return isNaN(num) ? max : Math.max(max, num);
      }, 0);
      incoming.constraint_id = `${prefix}${String(maxNum + 1).padStart(3, '0')}`;
      merged.push(incoming);
    }
  }

  return merged;
}

// --- Main merge function ---

function merge(base, incoming, options = {}) {
  if (!entitiesMatch(base, incoming)) {
    return { merged: null, error: 'Entities do not match' };
  }

  const now = new Date().toISOString();
  const mergeHistory = [];
  const result = JSON.parse(JSON.stringify(base)); // deep clone
  const isSelf = options.isSelfEntity || false;

  // Entity-level: higher confidence summary wins (skip for self entity)
  if (!isSelf && incoming.entity?.summary?.confidence > (result.entity?.summary?.confidence || 0)) {
    result.entity.summary = incoming.entity.summary;
  }

  // Name: merge aliases
  if (result.entity?.name && incoming.entity?.name) {
    const allAliases = new Set([
      ...(result.entity.name.aliases || []),
      ...(incoming.entity.name.aliases || []),
    ]);
    result.entity.name.aliases = [...allAliases];

    // Higher confidence name wins (skip name.full/preferred for self entity)
    if (!isSelf && incoming.entity.name.confidence > (result.entity.name.confidence || 0)) {
      result.entity.name.full = incoming.entity.name.full || result.entity.name.full;
      result.entity.name.preferred = incoming.entity.name.preferred || result.entity.name.preferred;
      result.entity.name.confidence = incoming.entity.name.confidence;
    }
  }

  // Attributes
  const attrResult = mergeAttributes(result.attributes || [], incoming.attributes || []);
  result.attributes = attrResult.merged;
  mergeHistory.push(...attrResult.history);

  // Relationships
  const relResult = mergeRelationships(result.relationships || [], incoming.relationships || []);
  result.relationships = relResult.merged;
  mergeHistory.push(...relResult.history);

  // Key Facts
  const factResult = mergeKeyFacts(result.key_facts || [], incoming.key_facts || []);
  result.key_facts = factResult.merged;
  mergeHistory.push(...factResult.history);

  // Values
  result.values = mergeValues(result.values || [], incoming.values || []);

  // Communication style: higher confidence wins
  if (result.communication_style && incoming.communication_style) {
    if ((incoming.communication_style.confidence || 0) > (result.communication_style.confidence || 0)) {
      result.communication_style = incoming.communication_style;
    }
  }

  // Type-specific merges
  const entityType = result.entity?.entity_type;

  if (entityType === 'person') {
    result.active_projects = mergeProjects(result.active_projects || [], incoming.active_projects || []);
    result.translations = mergeConstraints(result.translations || [], incoming.translations || []);
  }

  if (entityType === 'business') {
    result.products_services = mergeProductsServices(result.products_services || [], incoming.products_services || []);
    result.key_people = mergeKeyPeople(result.key_people || [], incoming.key_people || []);

    // Customers: merge segments
    if (result.customers && incoming.customers) {
      const baseSegs = result.customers.segments || [];
      const incomingSegs = incoming.customers.segments || [];
      for (const seg of incomingSegs) {
        const exists = baseSegs.find(s => similarity(s.name || '', seg.name || '') > 0.85);
        if (!exists) {
          const maxNum = baseSegs.reduce((max, s) => {
            const num = parseInt((s.segment_id || '').replace('SEG-', ''), 10);
            return isNaN(num) ? max : Math.max(max, num);
          }, 0);
          seg.segment_id = `SEG-${String(maxNum + 1).padStart(3, '0')}`;
          baseSegs.push(seg);
        }
      }
      result.customers.segments = baseSegs;
      if (incoming.customers.target_market && !result.customers.target_market) {
        result.customers.target_market = incoming.customers.target_market;
      }
    }

    // Competitive position: higher confidence wins
    if (incoming.competitive_position && result.competitive_position) {
      if ((incoming.competitive_position.confidence || 0) > (result.competitive_position.confidence || 0)) {
        result.competitive_position = incoming.competitive_position;
      }
    }
  }

  if (entityType === 'institution') {
    result.key_people = mergeKeyPeople(result.key_people || [], incoming.key_people || []);
  }

  // Constraints
  result.constraints = mergeConstraints(result.constraints || [], incoming.constraints || []);

  // Relationship dimensions: existing wins unless absent
  if (incoming.relationship_dimensions && !result.relationship_dimensions) {
    result.relationship_dimensions = incoming.relationship_dimensions;
  }
  if (incoming.descriptor && !result.descriptor) {
    result.descriptor = incoming.descriptor;
  }
  if (incoming.org_dimensions && !result.org_dimensions) {
    result.org_dimensions = incoming.org_dimensions;
  }
  if (incoming.structured_attributes && !result.structured_attributes) {
    result.structured_attributes = incoming.structured_attributes;
  }
  if (incoming.wiki_page && !result.wiki_page) {
    result.wiki_page = incoming.wiki_page;
  }
  if (incoming.wiki_section && !result.wiki_section) {
    result.wiki_section = incoming.wiki_section;
  }

  // Provenance chain: append, never delete
  if (!result.provenance_chain) {
    result.provenance_chain = { created_at: now, created_by: 'context-engine-v2', source_documents: [], merge_history: [] };
  }

  const incomingSources = incoming.provenance_chain?.source_documents || [];
  const existingHashes = new Set((result.provenance_chain.source_documents || []).map(s => s.content_hash));
  for (const src of incomingSources) {
    if (src.content_hash && !existingHashes.has(src.content_hash)) {
      result.provenance_chain.source_documents.push(src);
    }
  }

  // Add merge event to history
  result.provenance_chain.merge_history = result.provenance_chain.merge_history || [];
  result.provenance_chain.merge_history.push({
    merged_at: now,
    merged_by: 'merge-engine-v1',
    incoming_source: incoming.extraction_metadata?.source_description || 'unknown',
    incoming_hash: incoming.extraction_metadata?.source_text_hash || 'unknown',
    changes: mergeHistory,
  });

  // Extraction metadata: update confidence ceiling
  if (result.extraction_metadata && incoming.extraction_metadata) {
    result.extraction_metadata.extraction_confidence = Math.max(
      result.extraction_metadata.extraction_confidence || 0,
      incoming.extraction_metadata.extraction_confidence || 0
    );
  }

  return { merged: result, history: mergeHistory };
}

// --- Exports for use as module ---

module.exports = {
  merge, entitiesMatch, similarity, normalizeRelationshipType,
  getAllNames, namesLikelyMatch, propertyOverlapCount,
  countSharedRelationships, getEntityProperties,
};

// --- CLI ---

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length < 4) {
    console.log('Usage: node merge-engine.js --base <file> --incoming <file> [--output <file>]');
    console.log('');
    console.log('Merges two v2 entity JSON files. If --output is omitted, overwrites --base.');
    process.exit(0);
  }

  const baseIdx = args.indexOf('--base');
  const incomingIdx = args.indexOf('--incoming');
  const outputIdx = args.indexOf('--output');

  if (baseIdx === -1 || incomingIdx === -1) {
    console.error('Error: --base and --incoming are required.');
    process.exit(1);
  }

  const basePath = path.resolve(args[baseIdx + 1]);
  const incomingPath = path.resolve(args[incomingIdx + 1]);
  const outputPath = outputIdx !== -1 ? path.resolve(args[outputIdx + 1]) : basePath;

  if (!fs.existsSync(basePath)) {
    console.error(`Error: Base file not found: ${basePath}`);
    process.exit(1);
  }
  if (!fs.existsSync(incomingPath)) {
    console.error(`Error: Incoming file not found: ${incomingPath}`);
    process.exit(1);
  }

  const base = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
  const incoming = JSON.parse(fs.readFileSync(incomingPath, 'utf-8'));

  const { merged, error, history } = merge(base, incoming);

  if (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }

  fs.writeFileSync(outputPath, JSON.stringify(merged, null, 2) + '\n');

  const entityType = merged.entity?.entity_type;
  let name = '';
  if (entityType === 'person') {
    name = merged.entity?.name?.full || 'N/A';
  } else {
    name = merged.entity?.name?.common || merged.entity?.name?.legal || 'N/A';
  }

  console.log(`Merged: ${name} (${merged.entity?.entity_id || 'N/A'})`);
  console.log(`Output: ${outputPath}`);
  console.log(`Attributes: ${merged.attributes?.length || 0}`);
  console.log(`Relationships: ${merged.relationships?.length || 0}`);
  console.log(`Key Facts: ${merged.key_facts?.length || 0}`);
  console.log(`Provenance sources: ${merged.provenance_chain?.source_documents?.length || 0}`);
  console.log(`Merge changes: ${history?.length || 0}`);
}
