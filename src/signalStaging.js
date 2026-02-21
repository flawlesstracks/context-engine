'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readEntity, listEntities, writeEntity, getNextCounter, getSelfEntityId, isSelfEntity } = require('./graph-ops');
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
  user_input: 0.95,        // Manual user entry — highest trust
  manual: 0.95,
  linkedin_api: 0.9,       // Proxycurl
  linkedin_proxycurl: 0.9,
  linkedin_pdf: 0.85,
  linkedin: 0.85,
  company_website: 0.8,
  about_page: 0.8,
  file_upload: 0.75,       // Resume, bio doc
  file_import: 0.75,
  uploaded_document: 0.75,
  file: 0.75,
  x: 0.6,                  // Social profiles
  instagram: 0.6,
  social: 0.6,
  social_media: 0.6,
  web: 0.5,                // Generic scraped page
  url_extract: 0.5,
  scraped_web_page: 0.5,
  generic_url: 0.5,
  entity_mention: 0.4,     // Referenced in another entity's doc
  mention: 0.4,
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

// --- STEP 2: 5-Factor Weighted Association Scoring ---

const ASSOCIATION_WEIGHTS = {
  name: 0.4,
  handle: 0.3,
  org_title: 0.15,
  location: 0.1,
  bio: 0.05,
};

// --- FIX 2: Name Rarity — common names need stronger evidence ---

const COMMON_FIRST_NAMES = new Set([
  'james','robert','john','michael','david','william','richard','joseph','thomas','charles',
  'christopher','daniel','matthew','anthony','mark','donald','steven','andrew','paul','joshua',
  'kenneth','kevin','brian','george','timothy','ronald','edward','jason','jeffrey','ryan',
  'jacob','gary','nicholas','eric','jonathan','stephen','larry','justin','scott','brandon',
  'benjamin','samuel','raymond','gregory','frank','alexander','patrick','jack','dennis','jerry',
  'tyler','aaron','jose','nathan','henry','peter','douglas','zachary','adam','harold',
  'kyle','albert','arthur','gerald','carl','roger','keith','lawrence','terry','sean',
  'austin','jesse','christian','ralph','eugene','bruce','randy','russell','harry','philip',
  'mary','patricia','jennifer','linda','barbara','elizabeth','susan','jessica','sarah','karen',
  'lisa','nancy','betty','margaret','sandra','ashley','dorothy','kimberly','emily','donna',
  'michelle','carol','amanda','melissa','deborah','stephanie','rebecca','sharon','laura','cynthia',
  'kathleen','amy','angela','shirley','anna','brenda','pamela','emma','nicole','helen',
  'samantha','katherine','christine','debra','rachel','carolyn','janet','catherine','maria','heather',
  'diane','ruth','julie','olivia','joyce','virginia','victoria','kelly','lauren','christina',
  'joan','evelyn','judith','megan','andrea','cheryl','hannah','jacqueline','martha','gloria',
  'teresa','ann','sara','madison','frances','kathryn','janice','jean','abigail','alice',
  'judy','sophia','grace','denise','amber','doris','marilyn','danielle','beverly','isabella',
  'theresa','diana','natalie','brittany','charlotte','marie','kayla','alexis','lori',
  'steve','mike','chris','dan','matt','tony','tom','bob','bill','joe','jim','tim','dave',
  'nick','ben','jeff','greg','frank','ray','sam','ed','ted','al','cj','aj','dj','tj',
]);

const COMMON_LAST_NAMES = new Set([
  'smith','johnson','williams','brown','jones','garcia','miller','davis','rodriguez','martinez',
  'hernandez','lopez','gonzalez','wilson','anderson','thomas','taylor','moore','jackson','martin',
  'lee','perez','thompson','white','harris','sanchez','clark','ramirez','lewis','robinson',
  'walker','young','allen','king','wright','scott','torres','nguyen','hill','flores',
  'green','adams','nelson','baker','hall','rivera','campbell','mitchell','carter','roberts',
  'gomez','phillips','evans','turner','diaz','parker','cruz','edwards','collins','reyes',
  'stewart','morris','morales','murphy','cook','rogers','gutierrez','ortiz','morgan','cooper',
  'peterson','bailey','reed','kelly','howard','ramos','kim','cox','ward','richardson',
  'watson','brooks','chavez','wood','james','bennett','gray','mendoza','ruiz','hughes',
  'price','alvarez','castillo','sanders','patel','myers','long','ross','foster','jimenez','powell',
]);

function assessNameRarity(name) {
  if (!name) return { rarity: 'standard', threshold: 0.3 };
  const parts = name.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { rarity: 'standard', threshold: 0.3 };

  const firstName = parts[0];
  const lastName = parts.length > 1 ? parts[parts.length - 1] : '';

  const firstCommon = COMMON_FIRST_NAMES.has(firstName);
  const lastCommon = lastName ? COMMON_LAST_NAMES.has(lastName) : false;

  if (firstCommon && lastCommon) return { rarity: 'very_common', threshold: 0.45 };
  if (firstCommon || lastCommon) return { rarity: 'common', threshold: 0.35 };
  // Check if it's a single short name (like "CJ" or "Andre") — less unique
  if (parts.length === 1 && parts[0].length <= 3) return { rarity: 'common', threshold: 0.35 };
  return { rarity: 'standard', threshold: 0.3 };
}

// --- FIX 1: Contradiction Penalty (with temporal awareness) ---

function getAttributeDate(entity, attrKey) {
  // Find the most recent date for a given attribute type
  for (const attr of (entity.attributes || [])) {
    if ((attr.key || '').toLowerCase() === attrKey.toLowerCase()) {
      return attr.observed_at || attr.extracted_at || null;
    }
  }
  // Check provenance for last update date
  const merges = entity.provenance_chain?.merge_history || [];
  if (merges.length > 0) return merges[merges.length - 1].merged_at;
  return entity.provenance_chain?.created_at || null;
}

function isRecent(dateStr, yearsThreshold) {
  if (!dateStr) return false; // No date = assume stale
  const d = new Date(dateStr);
  const now = new Date();
  const years = (now - d) / (1000 * 60 * 60 * 24 * 365.25);
  return years <= yearsThreshold;
}

function computeContradictionPenalty(signals, entity, factors) {
  let totalPenalty = 0;
  const contradictions = [];

  const existingHandles = getEntitySocialHandles(entity);

  // --- Handle contradiction: both have LinkedIn but different URLs ---
  if (signals.handles.linkedin && existingHandles.linkedin &&
      signals.handles.linkedin !== existingHandles.linkedin) {
    totalPenalty += 0.2;
    contradictions.push({ factor: 'handle', type: 'linkedin_url', penalty: -0.2,
      incoming: signals.handles.linkedin, existing: existingHandles.linkedin,
      note: 'Different LinkedIn URLs — strong identity conflict' });
  }
  if (signals.handles.x && existingHandles.x && signals.handles.x !== existingHandles.x) {
    totalPenalty += 0.2;
    contradictions.push({ factor: 'handle', type: 'x_handle', penalty: -0.2,
      incoming: signals.handles.x, existing: existingHandles.x,
      note: 'Different X handles' });
  }
  if (signals.handles.instagram && existingHandles.instagram &&
      signals.handles.instagram !== existingHandles.instagram) {
    totalPenalty += 0.2;
    contradictions.push({ factor: 'handle', type: 'instagram_handle', penalty: -0.2,
      incoming: signals.handles.instagram, existing: existingHandles.instagram,
      note: 'Different Instagram handles' });
  }

  // --- Name contradiction: clearly different names (low Dice AND not nickname match) ---
  if (factors.name > 0 && factors.name < 0.4) {
    // Names are present but score very low — likely different people
    const existingPrimary = entity.entity?.name?.full || entity.entity?.name?.common || '';
    const incomingPrimary = signals.names[0] || '';
    if (existingPrimary && incomingPrimary) {
      // Only penalize if namesLikelyMatch also fails (rules out nicknames)
      const existingNames = getAllNames(entity);
      if (!namesLikelyMatch(signals.names, existingNames)) {
        totalPenalty += 0.15;
        contradictions.push({ factor: 'name', penalty: -0.15,
          incoming: incomingPrimary, existing: existingPrimary,
          note: 'Names are different and not nickname variants' });
      }
    }
  }

  // --- Org contradiction: different current companies ---
  const existingProps = getEntityProperties(entity);
  if (signals.organizations.length > 0 && existingProps.company) {
    const incomingOrg = signals.organizations[0].toLowerCase();
    const existingOrg = existingProps.company.toLowerCase();
    if (incomingOrg && existingOrg && similarity(incomingOrg, existingOrg) < 0.3) {
      totalPenalty += 0.05;
      contradictions.push({ factor: 'org', penalty: -0.05,
        incoming: signals.organizations[0], existing: existingProps.company,
        note: 'Different companies (weak — people change jobs)' });
    }
  }

  // --- Location contradiction: temporal awareness ---
  if (signals.locations.length > 0) {
    const incomingLoc = signals.locations[0].toLowerCase();
    let existingLoc = '';
    let existingLocDate = null;

    // Get existing location and its date
    for (const attr of (entity.attributes || [])) {
      if (['location', 'current_location'].includes((attr.key || '').toLowerCase()) && attr.value) {
        existingLoc = attr.value.toLowerCase();
        existingLocDate = attr.observed_at || attr.extracted_at || null;
        break;
      }
    }
    if (!existingLoc && entity.career_lite?.location) {
      existingLoc = entity.career_lite.location.toLowerCase();
      existingLocDate = getAttributeDate(entity, 'location');
    }

    if (existingLoc && incomingLoc && similarity(incomingLoc, existingLoc) < 0.3) {
      // Locations clearly disagree — check temporal context
      const incomingDate = signals._extracted_at || null;
      const incomingRecent = isRecent(incomingDate, 2);
      const existingRecent = isRecent(existingLocDate, 2);

      if (incomingRecent && existingRecent) {
        // Both recent: strong contradiction
        totalPenalty += 0.15;
        contradictions.push({ factor: 'location', penalty: -0.15,
          incoming: signals.locations[0], existing: existingLoc,
          note: 'Different locations, both recent — likely different people' });
      } else {
        // One or both stale: weak contradiction (person may have moved)
        totalPenalty += 0.05;
        const reason = !incomingDate && !existingLocDate
          ? 'no date metadata — assume stale'
          : 'data age differs — person may have moved';
        contradictions.push({ factor: 'location', penalty: -0.05,
          incoming: signals.locations[0], existing: existingLoc,
          note: 'Different locations (' + reason + ')' });
      }
    }
  }

  return { totalPenalty, contradictions };
}

function computeAssociationScore(signals, entityType, entity) {
  const existingType = entity.entity?.entity_type;
  if (!existingType) return { score: 0, factors: {}, matchType: null };

  // Type compatibility check
  if (entityType !== existingType) {
    const orgTypes = new Set(['organization', 'institution', 'business']);
    if (!orgTypes.has(entityType) || !orgTypes.has(existingType)) {
      return { score: 0, factors: {}, matchType: null };
    }
  }

  const isPerson = entityType === 'person';

  // --- Factor 1: Name match (weight: 0.4) ---
  let nameScore = 0;
  let nameMethod = null;
  const existingNames = getAllNames(entity);
  const existingPrimary = isPerson
    ? (entity.entity?.name?.full || '')
    : (entity.entity?.name?.common || entity.entity?.name?.legal || '');
  const incomingPrimary = signals.names[0] || '';

  if (incomingPrimary && existingPrimary) {
    const dice = similarity(incomingPrimary, existingPrimary);
    if (dice > 0.85) {
      nameScore = dice;
      nameMethod = 'name_high';
    } else if (isPerson && signals.names.length > 0 && existingNames.length > 0 && namesLikelyMatch(signals.names, existingNames)) {
      nameScore = 0.82;
      nameMethod = 'name_alias';
    } else if (dice > 0.5) {
      nameScore = dice;
      nameMethod = 'name_partial';
    }
  }
  // Check all name combinations for a better match
  for (const iName of signals.names) {
    for (const eName of existingNames) {
      const d = similarity(iName, eName);
      if (d > nameScore) {
        nameScore = d;
        nameMethod = d > 0.85 ? 'name_high' : 'name_partial';
      }
    }
  }
  // Org name normalization for non-person entities
  if (!isPerson && nameScore < 0.85 && incomingPrimary && existingPrimary) {
    const normIncoming = incomingPrimary.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
    const normExisting = existingPrimary.toLowerCase().replace(/[.,\-\s]+(com|inc|llc|corp|ltd)$/i, '').trim();
    if (normIncoming && normExisting) {
      const d = similarity(normIncoming, normExisting);
      if (d > nameScore) {
        nameScore = d;
        nameMethod = 'org_name_normalized';
      }
    }
  }

  // --- Factor 2: Handle match (weight: 0.3) ---
  let handleScore = 0;
  const existingHandles = getEntitySocialHandles(entity);
  const existingAliases = (entity.entity?.name?.aliases || []).map(a => a.toLowerCase().replace(/^@/, ''));

  // Exact handle matches
  if (signals.handles.x && existingHandles.x && signals.handles.x === existingHandles.x) handleScore = 1.0;
  else if (signals.handles.instagram && existingHandles.instagram && signals.handles.instagram === existingHandles.instagram) handleScore = 1.0;
  else if (signals.handles.linkedin && existingHandles.linkedin && signals.handles.linkedin === existingHandles.linkedin) handleScore = 1.0;
  // Alias cross-match
  else if (signals.handles.x && existingAliases.includes(signals.handles.x)) handleScore = 0.85;
  else if (signals.handles.instagram && existingAliases.includes(signals.handles.instagram)) handleScore = 0.85;
  else if (existingHandles.x) {
    const incomingLower = signals.names.map(n => n.toLowerCase().replace(/^@/, ''));
    if (incomingLower.includes(existingHandles.x)) handleScore = 0.85;
  }

  // --- Factor 3: Org + Title match (weight: 0.15) ---
  let orgTitleScore = 0;
  const existingProps = getEntityProperties(entity);

  let orgMatch = false;
  for (const org of signals.organizations) {
    const orgLower = org.toLowerCase();
    const existingCompany = (existingProps.company || '').toLowerCase();
    if (existingCompany && (similarity(orgLower, existingCompany) > 0.7 ||
        existingCompany.includes(orgLower) || orgLower.includes(existingCompany))) {
      orgMatch = true; break;
    }
    for (const exp of (entity.career_lite?.experience || entity.career_lite?.work_history || [])) {
      if (exp.company && similarity(orgLower, exp.company.toLowerCase()) > 0.7) {
        orgMatch = true; break;
      }
    }
    if (orgMatch) break;
  }

  let titleMatch = false;
  for (const title of signals.titles) {
    for (const attr of (entity.attributes || [])) {
      if (['headline', 'role', 'current_role'].includes((attr.key || '').toLowerCase())) {
        if (similarity(title.toLowerCase(), (attr.value || '').toLowerCase()) > 0.7) {
          titleMatch = true; break;
        }
      }
    }
    if (titleMatch) break;
    for (const exp of (entity.career_lite?.experience || entity.career_lite?.work_history || [])) {
      if (exp.title && similarity(title.toLowerCase(), exp.title.toLowerCase()) > 0.7) {
        titleMatch = true; break;
      }
    }
    if (titleMatch) break;
  }

  if (orgMatch && titleMatch) orgTitleScore = 1.0;
  else if (orgMatch) orgTitleScore = 0.5;
  else if (titleMatch) orgTitleScore = 0.3;

  // --- Factor 4: Location match (weight: 0.1) ---
  let locationScore = 0;
  for (const loc of signals.locations) {
    const locLower = loc.toLowerCase();
    const locTokens = locLower.split(/[,\s]+/).filter(Boolean);
    for (const attr of (entity.attributes || [])) {
      if (['location', 'current_location'].includes((attr.key || '').toLowerCase())) {
        const existingLoc = (attr.value || '').toLowerCase();
        if (similarity(locLower, existingLoc) > 0.7) { locationScore = 1.0; break; }
        const existingTokens = existingLoc.split(/[,\s]+/).filter(Boolean);
        const shared = locTokens.filter(t => existingTokens.some(et => et === t || similarity(t, et) > 0.8));
        if (shared.length > 0) locationScore = Math.max(locationScore, shared.length / Math.max(locTokens.length, 1));
      }
    }
    if (locationScore < 1.0 && entity.career_lite?.location) {
      const clLoc = entity.career_lite.location.toLowerCase();
      if (similarity(locLower, clLoc) > 0.7) locationScore = 1.0;
      else {
        const clTokens = clLoc.split(/[,\s]+/).filter(Boolean);
        const shared = locTokens.filter(t => clTokens.some(ct => ct === t || similarity(t, ct) > 0.8));
        if (shared.length > 0) locationScore = Math.max(locationScore, shared.length / Math.max(locTokens.length, 1));
      }
    }
    if (locationScore >= 1.0) break;
  }

  // --- Factor 5: Bio similarity (weight: 0.05) ---
  let bioScore = 0;
  const entityBios = [];
  if (entity.entity?.summary?.value) entityBios.push(entity.entity.summary.value.toLowerCase());
  for (const attr of (entity.attributes || [])) {
    if (['x_bio', 'instagram_bio', 'bio'].includes((attr.key || '').toLowerCase()) && attr.value) {
      entityBios.push(attr.value.toLowerCase());
    }
  }
  if (signals.bios.length > 0 && entityBios.length > 0) {
    const clusterWords = new Set(signals.bios.join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 3));
    const entityWords = new Set(entityBios.join(' ').split(/\s+/).filter(w => w.length > 3));
    if (clusterWords.size > 0 && entityWords.size > 0) {
      let shared = 0;
      for (const w of clusterWords) { if (entityWords.has(w)) shared++; }
      bioScore = shared / Math.max(clusterWords.size, 1);
    }
  }

  // --- Weighted composite score ---
  const rawScore = (ASSOCIATION_WEIGHTS.name * nameScore) +
                   (ASSOCIATION_WEIGHTS.handle * handleScore) +
                   (ASSOCIATION_WEIGHTS.org_title * orgTitleScore) +
                   (ASSOCIATION_WEIGHTS.location * locationScore) +
                   (ASSOCIATION_WEIGHTS.bio * bioScore);

  const factors = { name: nameScore, handle: handleScore, org_title: orgTitleScore, location: locationScore, bio: bioScore };

  // --- FIX 1: Apply contradiction penalty ---
  const { totalPenalty, contradictions } = computeContradictionPenalty(signals, entity, factors);
  const score = Math.max(0, rawScore - totalPenalty);

  // Determine primary match type from strongest factor
  let matchType = null;
  if (handleScore >= 1.0) matchType = 'social_handle';
  else if (handleScore >= 0.85) matchType = 'handle_alias_cross';
  else if (nameScore > 0.85) matchType = nameMethod || 'name_high';
  else if (nameScore > 0.5 && orgTitleScore > 0) matchType = 'name_org_title';
  else if (nameScore > 0) matchType = nameMethod || 'name_partial';

  return { score, rawScore, factors, contradictions, contradictionPenalty: totalPenalty, matchType };
}

// --- STEP 3: Data Novelty Check ---

function computeDataNovelty(signals, entity) {
  if (!entity) return { ratio: 1.0, newSignals: 0, duplicateSignals: 0, details: [] };

  let newSignals = 0;
  let duplicateSignals = 0;
  const details = [];

  const existingHandles = getEntitySocialHandles(entity);
  const existingProps = getEntityProperties(entity);

  // Handles
  if (signals.handles.x) {
    if (existingHandles.x === signals.handles.x) { duplicateSignals++; details.push({ key: 'x_handle', status: 'duplicate' }); }
    else { newSignals++; details.push({ key: 'x_handle', status: 'new' }); }
  }
  if (signals.handles.instagram) {
    if (existingHandles.instagram === signals.handles.instagram) { duplicateSignals++; details.push({ key: 'instagram_handle', status: 'duplicate' }); }
    else { newSignals++; details.push({ key: 'instagram_handle', status: 'new' }); }
  }
  if (signals.handles.linkedin) {
    if (existingHandles.linkedin === signals.handles.linkedin) { duplicateSignals++; details.push({ key: 'linkedin_url', status: 'duplicate' }); }
    else { newSignals++; details.push({ key: 'linkedin_url', status: 'new' }); }
  }

  // Titles
  for (const title of signals.titles) {
    let isDup = false;
    for (const attr of (entity.attributes || [])) {
      if (['headline', 'role', 'current_role'].includes((attr.key || '').toLowerCase())) {
        if (similarity(title, attr.value || '') > 0.85) { isDup = true; break; }
      }
    }
    if (!isDup) {
      for (const exp of (entity.career_lite?.experience || entity.career_lite?.work_history || [])) {
        if (exp.title && similarity(title, exp.title) > 0.85) { isDup = true; break; }
      }
    }
    details.push({ key: 'title', value: title, status: isDup ? 'duplicate' : 'new' });
    if (isDup) duplicateSignals++; else newSignals++;
  }

  // Organizations
  for (const org of signals.organizations) {
    let isDup = false;
    const orgLower = org.toLowerCase();
    if (existingProps.company && (similarity(orgLower, existingProps.company) > 0.7 ||
        existingProps.company.includes(orgLower) || orgLower.includes(existingProps.company))) {
      isDup = true;
    }
    if (!isDup) {
      for (const exp of (entity.career_lite?.experience || entity.career_lite?.work_history || [])) {
        if (exp.company && similarity(orgLower, exp.company.toLowerCase()) > 0.7) { isDup = true; break; }
      }
    }
    details.push({ key: 'organization', value: org, status: isDup ? 'duplicate' : 'new' });
    if (isDup) duplicateSignals++; else newSignals++;
  }

  // Locations
  for (const loc of signals.locations) {
    let isDup = false;
    for (const attr of (entity.attributes || [])) {
      if (['location', 'current_location'].includes((attr.key || '').toLowerCase())) {
        if (similarity(loc, attr.value || '') > 0.7) { isDup = true; break; }
      }
    }
    if (!isDup && entity.career_lite?.location) {
      if (similarity(loc.toLowerCase(), entity.career_lite.location.toLowerCase()) > 0.7) isDup = true;
    }
    details.push({ key: 'location', value: loc, status: isDup ? 'duplicate' : 'new' });
    if (isDup) duplicateSignals++; else newSignals++;
  }

  // Skills
  for (const skill of signals.skills) {
    const isDup = existingProps.skills.some(s => similarity(skill.toLowerCase(), s) > 0.85);
    details.push({ key: 'skill', value: skill, status: isDup ? 'duplicate' : 'new' });
    if (isDup) duplicateSignals++; else newSignals++;
  }

  // Education
  for (const edu of signals.education) {
    let isDup = false;
    for (const e of (entity.career_lite?.education || [])) {
      if (e.institution && similarity(edu.toLowerCase(), e.institution.toLowerCase()) > 0.85) { isDup = true; break; }
    }
    details.push({ key: 'education', value: edu, status: isDup ? 'duplicate' : 'new' });
    if (isDup) duplicateSignals++; else newSignals++;
  }

  const total = newSignals + duplicateSignals;
  return { ratio: total > 0 ? newSignals / total : 1.0, newSignals, duplicateSignals, details };
}

// --- STEP 5: Projected Attribute Confidence ---

function computeProjectedConfidences(cluster, candidateEntity) {
  const sourceWeight = cluster.source.weight || getSourceWeight(cluster.source.type);
  const capturedDate = cluster.source.extracted_at || new Date().toISOString();

  // Count existing sources on candidate (for corroboration)
  let existingSourceCount = 0;
  if (candidateEntity) {
    existingSourceCount = (candidateEntity.provenance_chain?.source_documents || []).length;
  }

  const confSignals = cluster.confident_signals;
  if (!confSignals) return;

  function project(attrKey, isHistorical) {
    const recency = isHistorical ? 1.0 : recencyModifier(capturedDate, attrKey);
    const corr = corroborationMultiplier(existingSourceCount + 1);
    return Math.min(1.0, sourceWeight * recency * corr);
  }

  // Names (historical — no recency decay)
  if (confSignals.names) {
    for (const s of confSignals.names) s.projected_confidence = project('name', true);
  }
  // Handles (historical)
  if (confSignals.handles) {
    for (const key of ['x', 'instagram', 'linkedin']) {
      if (confSignals.handles[key]) confSignals.handles[key].projected_confidence = project(key + '_handle', true);
    }
  }
  // Titles (volatile — current state)
  if (confSignals.titles) {
    for (const s of confSignals.titles) s.projected_confidence = project('current_role', false);
  }
  // Organizations (volatile — current company)
  if (confSignals.organizations) {
    for (const s of confSignals.organizations) s.projected_confidence = project('company', false);
  }
  // Locations (volatile)
  if (confSignals.locations) {
    for (const s of confSignals.locations) s.projected_confidence = project('location', false);
  }
  // Bios (historical)
  if (confSignals.bios) {
    for (const s of confSignals.bios) s.projected_confidence = project('bio', true);
  }
  // Skills (historical)
  if (confSignals.skills) {
    for (const s of confSignals.skills) s.projected_confidence = project('skill', true);
  }
  // Education (historical — no recency decay)
  if (confSignals.education) {
    for (const s of confSignals.education) s.projected_confidence = project('education', true);
  }
}

// --- Function 2: scoreCluster (5-Step Provisioner Scoring) ---

function scoreCluster(clusterId, graphDir) {
  const cluster = readCluster(clusterId, graphDir);
  if (!cluster) return null;

  const signals = cluster.signals;
  const entityType = cluster.entity_type;

  // ═══ STEP 1: SIGNAL CONFIDENCE ═══
  // Per-signal confidence set during staging. Verify source weight is recorded.
  const sourceWeight = cluster.source.weight || getSourceWeight(cluster.source.type);
  cluster.signal_confidence = sourceWeight;

  // ═══ STEP 2: ASSOCIATION CONFIDENCE (5-factor weighted matching) ═══
  const existingEntities = listEntities(graphDir);
  let bestMatch = { score: 0, rawScore: 0, entityId: null, entityName: null, matchType: null, factors: {}, contradictions: [], contradictionPenalty: 0 };

  for (const { file, data } of existingEntities) {
    const result = computeAssociationScore(signals, entityType, data);
    if (result.score > bestMatch.score) {
      const eid = data.entity?.entity_id || file.replace('.json', '');
      const existingType = data.entity?.entity_type;
      const ename = existingType === 'person'
        ? (data.entity?.name?.full || '')
        : (data.entity?.name?.common || data.entity?.name?.legal || '');
      bestMatch = { score: result.score, rawScore: result.rawScore, entityId: eid, entityName: ename, matchType: result.matchType, factors: result.factors, contradictions: result.contradictions, contradictionPenalty: result.contradictionPenalty };
    }
  }

  // ═══ FIX 2: Name Rarity Threshold ═══
  const primaryName = signals.names[0] || '';
  const { rarity, threshold: rarityThreshold } = assessNameRarity(primaryName);

  // ═══ FIX 3: Three-Zone Classification ═══
  let matchZone;
  if (bestMatch.score > 0.6) {
    matchZone = 'HIGH_CONFIDENCE_MATCH';
  } else if (bestMatch.score > rarityThreshold) {
    matchZone = 'AMBIGUOUS_MATCH';
  } else {
    matchZone = 'NO_MATCH';
  }

  // ═══ STEP 3: DATA NOVELTY CHECK ═══
  const isExistingEntity = matchZone !== 'NO_MATCH'; // Either HIGH or AMBIGUOUS
  let novelty = { ratio: 1.0, newSignals: 0, duplicateSignals: 0, details: [] };
  let candidateEntity = null;

  if (isExistingEntity) {
    candidateEntity = readEntity(bestMatch.entityId, graphDir);
    if (candidateEntity) {
      novelty = computeDataNovelty(signals, candidateEntity);
    }
  }

  // ═══ STEP 4: QUADRANT ASSIGNMENT (with three-zone awareness) ═══
  const isNewData = novelty.ratio > 0.5;
  let quadrant, quadrantLabel, state;
  const isAmbiguous = matchZone === 'AMBIGUOUS_MATCH';

  // Build evidence panel for ambiguous matches
  let evidence = null;
  if (isAmbiguous && candidateEntity) {
    evidence = [];
    // Name evidence
    if (bestMatch.factors.name > 0.7) evidence.push({ factor: 'Name', value: primaryName, status: 'match', icon: 'check' });
    else if (bestMatch.factors.name > 0.4) evidence.push({ factor: 'Name', value: primaryName, status: 'partial', icon: 'warn' });
    else if (bestMatch.factors.name > 0) evidence.push({ factor: 'Name', value: primaryName, status: 'weak', icon: 'warn' });
    // Handle evidence
    if (bestMatch.factors.handle > 0) evidence.push({ factor: 'Handle', value: 'social handle', status: 'match', icon: 'check' });
    // Org evidence
    if (bestMatch.factors.org_title > 0.5) evidence.push({ factor: 'Org+Title', value: signals.organizations[0] || '', status: 'match', icon: 'check' });
    else if (signals.organizations.length > 0) evidence.push({ factor: 'Org', value: signals.organizations[0], status: 'no_match', icon: 'warn' });
    // Location evidence
    if (bestMatch.factors.location > 0.5) evidence.push({ factor: 'Location', value: signals.locations[0] || '', status: 'match', icon: 'check' });
    else if (signals.locations.length > 0) evidence.push({ factor: 'Location', value: signals.locations[0], status: 'no_match', icon: 'warn' });
    // Contradictions
    for (const c of (bestMatch.contradictions || [])) {
      evidence.push({ factor: c.factor, value: c.incoming + ' vs ' + c.existing, status: 'conflict', icon: 'conflict', note: c.note });
    }
  }

  if (isExistingEntity) {
    cluster.candidate_entity_id = bestMatch.entityId;
    cluster.candidate_entity_name = bestMatch.entityName;

    // Self entity: always Q2 (user always reviews their own data)
    if (isSelfEntity(bestMatch.entityId, graphDir)) {
      quadrant = 2;
      quadrantLabel = 'Q2_ENRICH';
      state = 'provisional';
    } else if (isNewData) {
      // New Data + Existing Entity = Q2 ENRICH
      quadrant = 2;
      quadrantLabel = 'Q2_ENRICH';
      state = 'provisional';
    } else {
      // Duplicate Data + Existing Entity = Q4 CONFIRM
      quadrant = 4;
      quadrantLabel = 'Q4_CONFIRM';
      state = 'provisional';
    }
  } else {
    // No entity match — check for related clusters/mentions (Q1 vs Q3)
    const unresolvedClusters = listClusters(graphDir).filter(c =>
      c.cluster_id !== clusterId && c.state !== 'confirmed' && c.entity_type === entityType
    );

    let clusterMatches = 0;
    for (const other of unresolvedClusters) {
      const otherNames = other.signals?.names || [];
      for (const name of signals.names) {
        for (const otherName of otherNames) {
          if (similarity(name, otherName) > 0.85) { clusterMatches++; break; }
        }
        if (clusterMatches > 0) break;
      }
    }

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
      // Duplicate Data + New Entity = Q3 CONSOLIDATE
      quadrant = 3;
      quadrantLabel = 'Q3_CONSOLIDATE';
      state = 'provisional';
      cluster.related_mentions = unresolvedMentions;
      cluster.related_clusters = clusterMatches;
    } else {
      // New Data + New Entity = Q1 CREATE
      quadrant = 1;
      quadrantLabel = 'Q1_CREATE';
      state = 'unresolved';
    }
  }

  // ═══ STEP 5: PROJECTED ATTRIBUTE CONFIDENCE ═══
  computeProjectedConfidences(cluster, candidateEntity);

  // ═══ STORE RESULTS ═══
  cluster.confidence = bestMatch.score;
  cluster.association_confidence = bestMatch.score;
  cluster.association_raw_score = bestMatch.rawScore;
  cluster.association_factors = bestMatch.factors;
  cluster.contradiction_penalty = bestMatch.contradictionPenalty;
  cluster.contradictions = bestMatch.contradictions;
  cluster.match_type = bestMatch.matchType;
  cluster.match_zone = matchZone;
  cluster.name_rarity = rarity;
  cluster.rarity_threshold = rarityThreshold;
  cluster.ambiguous = isAmbiguous;
  cluster.evidence = evidence;
  cluster.quadrant = quadrant;
  cluster.quadrant_label = quadrantLabel;
  cluster.state = state;
  cluster.data_novelty_ratio = novelty.ratio;
  cluster.data_novelty = {
    ratio: novelty.ratio,
    new_signals: novelty.newSignals,
    duplicate_signals: novelty.duplicateSignals,
    details: novelty.details,
  };

  writeCluster(clusterId, cluster, graphDir);
  return cluster;
}

// --- Conflict Detection Layer ---
// Runs BEFORE merge/enrich resolution. Compares incoming cluster signals
// against existing entity attributes to detect FACTUAL, TEMPORAL, and IDENTITY conflicts.

const VOLATILE_ATTR_KEYS = new Set(['title', 'role', 'headline', 'company', 'organization', 'current_title', 'current_company']);

function detectConflicts(entity, incomingCluster) {
  const conflicts = [];
  const entityId = entity.entity?.entity_id || null;
  const signals = incomingCluster.signals || {};
  const incomingSource = incomingCluster.source?.description || incomingCluster.source?.url || 'unknown';
  const incomingDate = incomingCluster.source?.extracted_at || new Date().toISOString();

  // Helper: find existing attribute value + source + date from entity attributes
  function findExistingAttr(key) {
    for (const attr of (entity.attributes || [])) {
      if ((attr.key || '').toLowerCase() === key.toLowerCase()) {
        return {
          value: attr.value,
          source: attr.source_attribution?.source || entity.extraction_metadata?.source_description || 'existing',
          date: attr.time_decay?.captured_date || attr.observed_at || entity.extraction_metadata?.extracted_at || null
        };
      }
    }
    return null;
  }

  // Helper: create a conflict record
  function makeConflict(attribute, valueA, sourceA, dateA, valueB, sourceB, dateB, conflictType) {
    return {
      conflict_id: 'CONF-' + crypto.randomUUID().slice(0, 8),
      entity_id: entityId,
      attribute,
      value_a: valueA,
      source_a: sourceA,
      date_a: dateA,
      value_b: valueB,
      source_b: sourceB,
      date_b: dateB,
      conflict_type: conflictType,
      auto_resolved: false,
      resolution: null,
      detected_at: new Date().toISOString()
    };
  }

  // Helper: classify as TEMPORAL or FACTUAL based on date recency
  function classifyByRecency(existingDate, incomingDateStr) {
    const existingRecent = isRecent(existingDate, 2);
    const incomingRecent = isRecent(incomingDateStr, 2);
    if (existingRecent && incomingRecent) return 'FACTUAL';
    return 'TEMPORAL';
  }

  // --- Check titles/roles ---
  if (signals.titles && signals.titles.length > 0) {
    const incomingTitle = typeof signals.titles[0] === 'object' ? signals.titles[0].value : signals.titles[0];
    if (incomingTitle) {
      // Check attributes first
      const existing = findExistingAttr('title') || findExistingAttr('role') || findExistingAttr('headline');
      if (existing && similarity(incomingTitle.toLowerCase(), existing.value.toLowerCase()) < 0.5) {
        const type = classifyByRecency(existing.date, incomingDate);
        conflicts.push(makeConflict('title', existing.value, existing.source, existing.date,
          incomingTitle, incomingSource, incomingDate, type));
      }
      // Check career_lite headline/title if no attribute match found
      if (!existing && entity.career_lite) {
        const clTitle = entity.career_lite.headline || entity.career_lite.current_title;
        if (clTitle && similarity(incomingTitle.toLowerCase(), clTitle.toLowerCase()) < 0.5) {
          const clDate = entity.career_lite.extracted_at || entity.extraction_metadata?.extracted_at;
          const type = classifyByRecency(clDate, incomingDate);
          conflicts.push(makeConflict('title', clTitle, 'career_lite', clDate,
            incomingTitle, incomingSource, incomingDate, type));
        }
      }
    }
  }

  // --- Check organizations ---
  if (signals.organizations && signals.organizations.length > 0) {
    const incomingOrg = typeof signals.organizations[0] === 'object' ? signals.organizations[0].value : signals.organizations[0];
    if (incomingOrg) {
      const existing = findExistingAttr('company') || findExistingAttr('organization');
      if (existing && similarity(incomingOrg.toLowerCase(), existing.value.toLowerCase()) < 0.3) {
        const type = classifyByRecency(existing.date, incomingDate);
        conflicts.push(makeConflict('organization', existing.value, existing.source, existing.date,
          incomingOrg, incomingSource, incomingDate, type));
      }
      // Check career_lite company
      if (!existing && entity.career_lite?.current_company) {
        const clCompany = entity.career_lite.current_company;
        if (similarity(incomingOrg.toLowerCase(), clCompany.toLowerCase()) < 0.3) {
          const clDate = entity.career_lite.extracted_at || entity.extraction_metadata?.extracted_at;
          const type = classifyByRecency(clDate, incomingDate);
          conflicts.push(makeConflict('organization', clCompany, 'career_lite', clDate,
            incomingOrg, incomingSource, incomingDate, type));
        }
      }
    }
  }

  // --- Check location (IDENTITY indicator when both recent) ---
  if (signals.locations && signals.locations.length > 0) {
    const incomingLoc = typeof signals.locations[0] === 'object' ? signals.locations[0].value : signals.locations[0];
    if (incomingLoc) {
      const existing = findExistingAttr('location') || findExistingAttr('current_location');
      const locVal = existing ? existing.value : (entity.career_lite?.location || null);
      const locDate = existing ? existing.date : (entity.career_lite?.extracted_at || entity.extraction_metadata?.extracted_at);
      const locSource = existing ? existing.source : 'career_lite';

      if (locVal && similarity(incomingLoc.toLowerCase(), locVal.toLowerCase()) <= 0.3) {
        const existingRecent = isRecent(locDate, 2);
        const incomingRecent = isRecent(incomingDate, 2);
        if (existingRecent && incomingRecent) {
          // Both recent locations disagree → possible wrong merge
          conflicts.push(makeConflict('location', locVal, locSource, locDate,
            incomingLoc, incomingSource, incomingDate, 'IDENTITY'));
        } else {
          // Person likely moved
          conflicts.push(makeConflict('location', locVal, locSource, locDate,
            incomingLoc, incomingSource, incomingDate, 'TEMPORAL'));
        }
      }
    }
  }

  // --- Check social handles (strong IDENTITY indicator) ---
  const existingHandles = getEntitySocialHandles(entity);
  if (signals.handles) {
    for (const platform of ['linkedin', 'x', 'instagram']) {
      if (signals.handles[platform] && existingHandles[platform] &&
          signals.handles[platform] !== existingHandles[platform]) {
        conflicts.push(makeConflict(
          platform + '_handle',
          existingHandles[platform], 'existing_entity', null,
          signals.handles[platform], incomingSource, incomingDate,
          'IDENTITY'
        ));
      }
    }
  }

  return conflicts;
}

// Auto-resolve TEMPORAL conflicts: most recent source wins for current-state attributes.
// Returns { autoResolved: [...], factual: [...], identity: [...] }
function categorizeConflicts(conflicts) {
  const autoResolved = [];
  const factual = [];
  const identity = [];
  const now = new Date().toISOString();

  for (const c of conflicts) {
    if (c.conflict_type === 'TEMPORAL') {
      // Most recent wins — determine winner
      const dateA = c.date_a ? new Date(c.date_a).getTime() : 0;
      const dateB = c.date_b ? new Date(c.date_b).getTime() : 0;
      const winner = dateB >= dateA ? 'B' : 'A';
      c.auto_resolved = true;
      c.resolution = {
        resolved_at: now,
        resolved_by: 'auto_temporal',
        winner: winner,
        winning_value: winner === 'A' ? c.value_a : c.value_b,
        reason: 'Most recent source wins for current-state attribute (career progression)'
      };
      autoResolved.push(c);
    } else if (c.conflict_type === 'IDENTITY') {
      identity.push(c);
    } else {
      // FACTUAL
      factual.push(c);
    }
  }

  return { autoResolved, factual, identity };
}

// Resolve a single conflict on an entity
function resolveConflict(entityId, conflictId, resolution, graphDir) {
  const entity = readEntity(entityId, graphDir);
  if (!entity) return { error: 'Entity not found: ' + entityId };

  const conflicts = entity.conflicts || [];
  const idx = conflicts.findIndex(c => c.conflict_id === conflictId);
  if (idx === -1) return { error: 'Conflict not found: ' + conflictId };

  const conflict = conflicts[idx];
  const now = new Date().toISOString();

  // resolution: 'keep_a', 'keep_b', 'keep_both'
  conflict.auto_resolved = false;
  conflict.resolution = {
    resolved_at: now,
    resolved_by: 'user',
    winner: resolution === 'keep_a' ? 'A' : resolution === 'keep_b' ? 'B' : 'BOTH',
    winning_value: resolution === 'keep_a' ? conflict.value_a : resolution === 'keep_b' ? conflict.value_b : 'both retained',
    reason: resolution === 'keep_both' ? 'User confirmed not a conflict' : 'User selected preferred value'
  };

  // If keep_a or keep_b, update the entity attribute to the winning value
  if (resolution === 'keep_a' || resolution === 'keep_b') {
    const winningValue = resolution === 'keep_a' ? conflict.value_a : conflict.value_b;
    const attrKey = conflict.attribute.replace('_handle', '');
    for (const attr of (entity.attributes || [])) {
      if ((attr.key || '').toLowerCase() === attrKey.toLowerCase()) {
        attr.value = winningValue;
        attr.time_decay = attr.time_decay || {};
        attr.time_decay.captured_date = now.slice(0, 10);
        break;
      }
    }
  }

  // Move from active conflicts to resolved_conflicts
  conflicts.splice(idx, 1);
  entity.conflicts = conflicts;
  if (!entity.resolved_conflicts) entity.resolved_conflicts = [];
  entity.resolved_conflicts.push(conflict);

  writeEntity(entityId, entity, graphDir);
  return { success: true, conflict_id: conflictId, resolution: conflict.resolution, remaining: conflicts.length };
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

    // --- CONFLICT DETECTION: run BEFORE merge ---
    const detectedConflicts = detectConflicts(existing, cluster);
    if (detectedConflicts.length > 0) {
      const { autoResolved, factual, identity } = categorizeConflicts(detectedConflicts);

      // IDENTITY conflicts: block the merge, return evidence to user (unless user already confirmed)
      if (identity.length > 0 && !cluster._identity_confirmed) {
        return {
          action: 'conflict_blocked',
          cluster_id: clusterId,
          entity_id: cluster.candidate_entity_id,
          conflict_type: 'IDENTITY',
          conflicts: identity,
          message: 'These might be different people. Review the evidence and confirm or cancel.',
          evidence: identity.map(c => ({
            attribute: c.attribute,
            existing_value: c.value_a,
            incoming_value: c.value_b,
            existing_source: c.source_a,
            incoming_source: c.source_b
          }))
        };
      }

      // TEMPORAL conflicts: auto-resolve, store in resolved_conflicts
      if (autoResolved.length > 0) {
        if (!existing.resolved_conflicts) existing.resolved_conflicts = [];
        existing.resolved_conflicts.push(...autoResolved);
      }

      // FACTUAL conflicts: add to active conflicts array (merge still proceeds)
      if (factual.length > 0) {
        if (!existing.conflicts) existing.conflicts = [];
        existing.conflicts.push(...factual);
      }

      // Write conflict state to entity before merge
      if (autoResolved.length > 0 || factual.length > 0) {
        writeEntity(cluster.candidate_entity_id, existing, graphDir);
      }
    }

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

    // Merge structured data (protect self entity name/summary)
    const isSelf = isSelfEntity(cluster.candidate_entity_id, graphDir);
    const { merged } = merge(existing, incoming, { isSelfEntity: isSelf });
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

  if (action === 'confirm_merge') {
    // User overrode IDENTITY conflict block — force merge with identity conflicts stored
    if (!cluster.candidate_entity_id || !entityData) {
      return { error: 'No candidate entity to merge with' };
    }
    const existing = readEntity(cluster.candidate_entity_id, graphDir);
    if (!existing) return { error: 'Candidate entity not found: ' + cluster.candidate_entity_id };

    // Store identity conflicts as resolved (user confirmed same person)
    const detectedConflicts = detectConflicts(existing, cluster);
    if (detectedConflicts.length > 0) {
      const { autoResolved, factual, identity } = categorizeConflicts(detectedConflicts);
      if (!existing.resolved_conflicts) existing.resolved_conflicts = [];
      if (autoResolved.length > 0) existing.resolved_conflicts.push(...autoResolved);
      for (const ic of identity) {
        ic.auto_resolved = false;
        ic.resolution = { resolved_at: now, resolved_by: 'user_confirm_merge', winner: 'BOTH', winning_value: 'both retained', reason: 'User confirmed same person despite identity conflict' };
        existing.resolved_conflicts.push(ic);
      }
      if (factual.length > 0) {
        if (!existing.conflicts) existing.conflicts = [];
        existing.conflicts.push(...factual);
      }
      writeEntity(cluster.candidate_entity_id, existing, graphDir);
    }

    // Set flag to skip identity block on delegated merge
    cluster._identity_confirmed = true;
    writeCluster(clusterId, cluster, graphDir);
    return resolveCluster(clusterId, 'merge', graphDir, agentId);
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
  // Conflict detection
  detectConflicts,
  categorizeConflicts,
  resolveConflict,
};
