/**
 * Health Analyzer — Connection Intelligence Module
 * Analyzes entity relationships for: duplicates, tier classification, phantom entities
 */

// Relationship tier mapping (MECE: every relationship resolves to exactly one tier)
const TIER_KEYWORDS = {
  5: { // FAMILY
    label: 'Family',
    color: '#ef4444',
    keywords: ['spouse', 'wife', 'husband', 'son', 'daughter', 'sister', 'brother',
      'mother', 'father', 'parent', 'child', 'ex-spouse', 'ex-wife', 'ex-husband',
      'godparent', 'godmother', 'godfather', 'godson', 'goddaughter', 'sibling',
      'uncle', 'aunt', 'cousin', 'nephew', 'niece', 'family', 'in-law'],
  },
  4: { // FRIEND
    label: 'Friend',
    color: '#f59e0b',
    keywords: ['friend', 'close friend', 'best friend', 'groomsman', 'bridesmaid',
      'homie', 'mba homie', 'buddy', 'confidant', 'collaborator', 'trivia'],
  },
  3: { // COLLEAGUE
    label: 'Colleague',
    color: '#3b82f6',
    keywords: ['colleague', 'coworker', 'professional contact', 'professional',
      'architect', 'engineer', 'manager', 'director', 'works at', 'same company',
      'employer', 'employed', 'team', 'peer', 'mba peer', 'business'],
  },
  2: { // ACQUAINTANCE
    label: 'Acquaintance',
    color: '#8b5cf6',
    keywords: ['school', 'from your school', 'met during', 'acquaintance',
      'classmate', 'alumni', 'met at', 'introduced', 'generic'],
  },
  1: { // FOLLOW
    label: 'Follow',
    color: '#9ca3af',
    keywords: ['following', 'follow', '3rd degree', '2nd degree', '1st degree',
      'connection', 'follower', 'linkedin'],
  },
};

// Phantom entity detection signals
const PHANTOM_SIGNALS = {
  names: ['blossom', 'buttercup', 'claudine', 'gemma ai', 'chatgpt', 'claude ai'],
  nameFragments: ['(blossom)', '(buttercup)', '(bubbles)'],
  contextKeywords: ['ai assistant', 'ai collaborator', 'ai agent', 'language model'],
  typeKeywords: ['ai assistant/collaborator', 'ai assistant', 'ai collaborator'],
};

/**
 * Classify a relationship into a tier (1-5)
 */
function getRelationshipTier(rel) {
  const type = (rel.relationship_type || '').toLowerCase();
  const context = (rel.context || '').toLowerCase();
  const combined = ' ' + type + ' ' + context + ' ';

  // Check tiers from highest to lowest using word-boundary matching
  for (const tier of [5, 4, 3, 2, 1]) {
    const { keywords } = TIER_KEYWORDS[tier];
    for (const kw of keywords) {
      // Multi-word keywords: use indexOf (they're specific enough)
      // Single-word keywords: use word boundary regex to avoid substring false positives
      if (kw.indexOf(' ') !== -1) {
        if (combined.indexOf(kw) !== -1) return tier;
      } else {
        const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
        if (re.test(combined)) return tier;
      }
    }
  }

  // Default: acquaintance (tier 2) for unknown types
  return 2;
}

/**
 * Get tier metadata for display
 */
function getTierInfo(tier) {
  const info = TIER_KEYWORDS[tier] || TIER_KEYWORDS[2];
  return { tier, label: info.label, color: info.color };
}

/**
 * Normalize a name for fuzzy matching
 */
function normalizeName(name) {
  return (name || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Get first name + last initial for fuzzy matching
 */
function nameKey(name) {
  const parts = normalizeName(name).split(' ').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[parts.length - 1][0];
}

/**
 * Analyze connections for duplicates
 * Returns: { duplicates: [{name, count, indices, merge_action}], duplicate_count }
 */
function analyzeConnections(entity) {
  const rels = entity.relationships || [];
  if (rels.length === 0) return { duplicates: [], duplicate_count: 0 };

  // Group by normalized name, entity_id, and fuzzy key
  const byExactName = {};
  const byEntityId = {};
  const byFuzzyKey = {};

  for (let i = 0; i < rels.length; i++) {
    const r = rels[i];
    const norm = normalizeName(r.name);
    const fkey = nameKey(r.name);
    const eid = r.target_entity_id || null;

    // Exact name
    if (norm) {
      if (!byExactName[norm]) byExactName[norm] = [];
      byExactName[norm].push({ index: i, rel: r });
    }

    // Entity ID
    if (eid) {
      if (!byEntityId[eid]) byEntityId[eid] = [];
      byEntityId[eid].push({ index: i, rel: r });
    }

    // Fuzzy key (first name + last initial)
    if (fkey) {
      if (!byFuzzyKey[fkey]) byFuzzyKey[fkey] = [];
      byFuzzyKey[fkey].push({ index: i, rel: r });
    }
  }

  // Find duplicates (2+ entries for same person)
  const seen = new Set();
  const duplicates = [];

  // Check exact name matches first
  for (const [name, entries] of Object.entries(byExactName)) {
    if (entries.length >= 2 && !seen.has(name)) {
      seen.add(name);
      const displayName = entries[0].rel.name || name;
      duplicates.push({
        name: displayName,
        count: entries.length,
        indices: entries.map(e => e.index),
        contexts: entries.map(e => e.rel.context || '').filter(Boolean),
        merge_action: `Merge ${entries.length} "${displayName}" connections into 1 with combined relationship context`,
      });
    }
  }

  // Check fuzzy key matches (catches "CJ" vs "CJ Mitchell")
  for (const [key, entries] of Object.entries(byFuzzyKey)) {
    if (entries.length >= 2) {
      // Check if any of these were already caught by exact match
      const names = [...new Set(entries.map(e => normalizeName(e.rel.name)))];
      if (names.length > 1 && !names.some(n => seen.has(n))) {
        const displayName = entries[0].rel.name || key;
        const allNames = [...new Set(entries.map(e => e.rel.name))].join(', ');
        duplicates.push({
          name: displayName,
          variant_names: allNames,
          count: entries.length,
          indices: entries.map(e => e.index),
          contexts: entries.map(e => e.rel.context || '').filter(Boolean),
          merge_action: `Merge ${entries.length} connections (${allNames}) into 1 — likely the same person`,
        });
        names.forEach(n => seen.add(n));
      }
    }
  }

  // Check entity ID matches
  for (const [eid, entries] of Object.entries(byEntityId)) {
    if (entries.length >= 2) {
      const name = entries[0].rel.name || eid;
      if (!seen.has(normalizeName(name))) {
        duplicates.push({
          name: name,
          entity_id: eid,
          count: entries.length,
          indices: entries.map(e => e.index),
          merge_action: `Merge ${entries.length} connections for ${name} (${eid})`,
        });
      }
    }
  }

  return {
    duplicates,
    duplicate_count: duplicates.reduce((sum, d) => sum + d.count - 1, 0),
  };
}

/**
 * Detect phantom entities in relationships
 * Returns: [{name, reason, suggested_action}]
 */
function detectPhantomEntities(entity) {
  const rels = entity.relationships || [];
  const phantoms = [];

  for (const r of rels) {
    const name = (r.name || '').toLowerCase();
    const type = (r.relationship_type || '').toLowerCase();
    const context = (r.context || '').toLowerCase();

    let isPhantom = false;
    let reason = '';

    // Check name signals
    for (const pName of PHANTOM_SIGNALS.names) {
      if (name.indexOf(pName) !== -1) {
        isPhantom = true;
        reason = `Name contains "${pName}"`;
        break;
      }
    }

    // Check name fragments like "(Blossom)"
    if (!isPhantom) {
      for (const frag of PHANTOM_SIGNALS.nameFragments) {
        if (name.indexOf(frag) !== -1) {
          isPhantom = true;
          reason = `Name contains AI alias "${frag}"`;
          break;
        }
      }
    }

    // Check relationship type
    if (!isPhantom) {
      for (const kw of PHANTOM_SIGNALS.typeKeywords) {
        if (type.indexOf(kw) !== -1) {
          isPhantom = true;
          reason = `Relationship type "${r.relationship_type}" indicates AI entity`;
          break;
        }
      }
    }

    // Check context
    if (!isPhantom) {
      for (const kw of PHANTOM_SIGNALS.contextKeywords) {
        if (context.indexOf(kw) !== -1) {
          isPhantom = true;
          reason = `Context mentions "${kw}"`;
          break;
        }
      }
    }

    if (isPhantom) {
      phantoms.push({
        name: r.name,
        relationship_type: r.relationship_type,
        reason: reason,
        suggested_action: 'Archive or delete — this is an AI assistant, not a human connection',
      });
    }
  }

  return phantoms;
}

/**
 * Compute tier distribution for connections
 */
function computeTierDistribution(entity) {
  const rels = entity.relationships || [];
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rels) {
    const tier = getRelationshipTier(r);
    dist[tier]++;
  }
  return dist;
}

/**
 * Full entity health analysis
 */
function analyzeEntityHealth(entity) {
  const connections = analyzeConnections(entity);
  const phantoms = detectPhantomEntities(entity);
  const tierDist = computeTierDistribution(entity);
  const rels = entity.relationships || [];

  return {
    total_connections: rels.length,
    duplicate_connections: connections.duplicate_count,
    duplicates: connections.duplicates,
    phantom_entities: phantoms,
    phantom_count: phantoms.length,
    tier_distribution: tierDist,
    follows_count: tierDist[1],
    quality_score: rels.length > 0
      ? Math.round(((tierDist[5] * 5 + tierDist[4] * 4 + tierDist[3] * 3 + tierDist[2] * 2 + tierDist[1] * 1) / rels.length) * 20)
      : 0,
  };
}

module.exports = {
  getRelationshipTier,
  getTierInfo,
  analyzeConnections,
  detectPhantomEntities,
  computeTierDistribution,
  analyzeEntityHealth,
  TIER_KEYWORDS,
};
