'use strict';

const fs = require('fs');
const path = require('path');
const { listEntities, readEntity } = require('./graph-ops');
const { getSpoke, loadSpokes } = require('./spoke-ops');

// ---------------------------------------------------------------------------
// Template CRUD (Build 10 — supports new extraction spec schema + backward compat)
// ---------------------------------------------------------------------------

const TEMPLATES_PATH = path.resolve(__dirname, '..', 'data', 'matter-templates.json');
const TEMPLATES_DIR = path.resolve(__dirname, '..', 'data', 'templates');

/**
 * Load all templates from both the legacy flat file and the new templates directory.
 * New-format templates in data/templates/ override legacy templates with the same key.
 * All templates are normalized into the new schema format with backward-compat fields.
 */
function loadTemplates() {
  const templates = {};

  // 1. Load legacy flat file
  const dir = path.dirname(TEMPLATES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(TEMPLATES_PATH)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf-8'));
      for (const [key, tmpl] of Object.entries(legacy)) {
        templates[key] = normalizeTemplate(key, tmpl);
      }
    } catch (err) {
      console.warn('Failed to load matter templates:', err.message);
    }
  }

  // 2. Load new-format templates from data/templates/ directory (override legacy)
  if (fs.existsSync(TEMPLATES_DIR)) {
    try {
      const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8'));
          const key = raw.template_id || file.replace('.json', '');
          templates[key] = normalizeTemplate(key, raw);
        } catch (err) {
          console.warn(`Failed to load template ${file}:`, err.message);
        }
      }
    } catch (err) {
      console.warn('Failed to scan templates directory:', err.message);
    }
  }

  return templates;
}

/**
 * Normalize any template (old or new format) into a unified schema that
 * supports both the new extraction spec fields AND the legacy fields
 * that existing code (buildSpokeExportData, scoreEntities, etc.) relies on.
 */
function normalizeTemplate(key, tmpl) {
  // Detect new-format: has document_types array
  const isNewFormat = Array.isArray(tmpl.document_types);

  if (isNewFormat) {
    // New format → generate backward-compat fields
    const result = { ...tmpl };
    result.label = tmpl.display_name || tmpl.label || key;

    // Generate required_documents from document_types (backward compat)
    if (!result.required_documents) {
      const catMap = {};
      for (const dt of (tmpl.document_types || [])) {
        const cat = (dt.category || 'other').toLowerCase().replace(/\s+/g, '_');
        if (!catMap[cat]) catMap[cat] = [];
        catMap[cat].push(dt.type_id);
      }
      result.required_documents = Object.entries(catMap).map(([category, items]) => ({ category, items }));
    }

    // Generate required_entities from entity_roles (backward compat)
    if (!result.required_entities && tmpl.entity_roles) {
      result.required_entities = tmpl.entity_roles.map(role => ({
        role: role.role_id || role.role,
        type: role.type || 'person',
        required_fields: (role.required_fields || []).map(f =>
          typeof f === 'string' ? f : (f.field_id ? f.field_id.split('.').pop() : f.display_name)
        ),
        optional: role.optional || false,
        min_count: role.min_count || undefined
      }));
    }

    return result;
  }

  // Old format → auto-wrap into new schema with defaults
  const result = { ...tmpl };
  result.label = tmpl.label || key;
  result.template_id = key;
  result.version = '0.1.0';
  result.display_name = tmpl.label || key;

  // Generate document_types from required_documents
  if (!result.document_types && tmpl.required_documents) {
    result.document_types = [];
    for (const cat of tmpl.required_documents) {
      for (const item of (cat.items || [])) {
        result.document_types.push({
          type_id: item,
          display_name: _formatLabel(item),
          category: _formatLabel(cat.category),
          priority: getCategoryPriority(cat.category).toUpperCase(),
          classification_signals: [item.replace(/_/g, ' ')],
          extraction_spec: []
        });
      }
    }
  }

  // Generate entity_roles from required_entities
  if (!result.entity_roles && tmpl.required_entities) {
    result.entity_roles = tmpl.required_entities.map(role => ({
      role_id: role.role,
      display_name: _formatLabel(role.role),
      type: role.type || 'person',
      optional: role.optional || false,
      min_count: role.min_count,
      required_fields: (role.required_fields || []).map(f => {
        if (typeof f === 'object') return f;
        const sensitivity = _inferSensitivity(f);
        return {
          field_id: `${role.role}.${f}`,
          display_name: _formatLabel(f),
          field_type: 'text',
          sensitivity: sensitivity
        };
      })
    }));
  }

  // No cross-doc rules for legacy templates
  if (!result.cross_doc_rules) result.cross_doc_rules = [];

  return result;
}

/**
 * Infer sensitivity level from field name for auto-wrapping legacy templates.
 */
function _inferSensitivity(fieldName) {
  const lower = (fieldName || '').toLowerCase();
  if (['ssn', 'social_security', 'social_security_number'].includes(lower)) return 'CRITICAL';
  if (['ein', 'tax_id', 'employer_identification_number'].includes(lower)) return 'CRITICAL';
  if (['full_name', 'legal_name', 'date_of_birth', 'dob'].includes(lower)) return 'HIGH';
  if (['address', 'contact_info', 'phone', 'email'].includes(lower)) return 'STANDARD';
  return 'STANDARD';
}

function getTemplate(type) {
  const templates = loadTemplates();
  return templates[type] || null;
}

function saveTemplates(data) {
  const dir = path.dirname(TEMPLATES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TEMPLATES_PATH, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Field Aliases — deterministic (no LLM) field matching
// ---------------------------------------------------------------------------

const FIELD_ALIASES = {
  full_name: ['full_name', 'name', 'legal_name'],
  legal_name: ['legal_name', 'full_name', 'name', 'company_name', 'business_name', 'entity_name'],
  date_of_birth: ['date_of_birth', 'dob', 'birthday', 'birth_date'],
  ssn: ['ssn', 'social_security', 'social_security_number', 'ssn_last_4', 'ssn_last_four', 'tin'],
  address: ['address', 'home_address', 'residence', 'location', 'mailing_address', 'principal_address', 'registered_address', 'street_address'],
  contact_info: ['phone', 'email', 'contact', 'address', 'contact_info', 'phone_number', 'email_address'],
  relationship: ['relationship', 'relation', 'connection_type'],
  ownership_percentage: ['ownership', 'percentage', 'equity', 'interest', 'ownership_percentage', 'membership_interest'],
  filing_status: ['filing_status', 'tax_status'],
  ein: ['ein', 'tax_id', 'employer_id', 'employer_identification_number', 'federal_tax_id'],
  entity_type: ['entity_type', 'business_type', 'organization_type', 'llc', 'corporation', 'partnership', 'sole_proprietorship'],
  state_of_formation: ['state_of_formation', 'state_of_incorporation', 'formation_state', 'organized_in', 'incorporated_in'],
  fiscal_year_end: ['fiscal_year_end', 'year_end', 'fiscal_year', 'tax_year_end', 'accounting_period'],
  ptin: ['ptin', 'preparer_tax_id', 'preparer_identification'],
  // PI-specific aliases (Build 10)
  insurance_info: ['insurance_info', 'insurance', 'insurance_policy', 'policy_number', 'coverage'],
  policy_number: ['policy_number', 'policy', 'policy_no', 'claim_number'],
  npi: ['npi', 'national_provider_identifier', 'provider_npi'],
  bar_number: ['bar_number', 'bar_no', 'attorney_number', 'bar_id'],
  specialty: ['specialty', 'specialization', 'practice_area'],
  lien_amount: ['lien_amount', 'lien', 'lien_balance'],
  lien_type: ['lien_type', 'lien_category'],
  account_number: ['account_number', 'account_no', 'patient_account', 'account'],
  claim_number: ['claim_number', 'claim_no', 'claim'],
  adjuster_name: ['adjuster_name', 'adjuster', 'claims_adjuster'],
  firm_name: ['firm_name', 'law_firm', 'firm'],
  phone: ['phone', 'phone_number', 'telephone', 'mobile'],
  insurance_carrier: ['insurance_carrier', 'insurer', 'insurance_company'],
};

// ---------------------------------------------------------------------------
// Priority assignment based on document category
// ---------------------------------------------------------------------------

const HIGH_PRIORITY_CATEGORIES = new Set([
  'identification', 'legal', 'financial', 'medical', 'incident',
  'incorporation', 'financial_statements', 'payroll',
  'liability', 'insurance'
]);

const LOW_PRIORITY_CATEGORIES = new Set([
  'supporting'
]);

function getCategoryPriority(category) {
  if (HIGH_PRIORITY_CATEGORIES.has((category || '').toLowerCase())) return 'high';
  if (LOW_PRIORITY_CATEGORIES.has((category || '').toLowerCase())) return 'low';
  return 'medium';
}

// ---------------------------------------------------------------------------
// Source Document Extraction — cascading lookup
// ---------------------------------------------------------------------------

function _stripSourcePrefix(source) {
  if (!source || typeof source !== 'string') return null;
  const idx = source.indexOf(':');
  return idx >= 0 ? source.substring(idx + 1).trim() : source.trim();
}

function extractSourceDocuments(entities) {
  const docMap = new Map(); // filename → { entity_ids: [], observation_snippets: [] }

  for (const ent of entities) {
    const entityId = ent.entity?.entity_id || ent.entity_id || '';
    const sources = new Set();

    // 1. source_ref (newer ingests)
    if (ent.source_ref) {
      sources.add(ent.source_ref);
    }

    // 2. provenance_chain.source_documents[].source
    const provDocs = ent.provenance_chain?.source_documents || [];
    for (const doc of provDocs) {
      const s = _stripSourcePrefix(doc.source);
      if (s) sources.add(s);
    }

    // 3. observations[].source
    const observations = ent.observations || [];
    for (const obs of observations) {
      const s = _stripSourcePrefix(obs.source);
      if (s) sources.add(s);
    }

    // Add to map with snippets
    for (const filename of sources) {
      if (!docMap.has(filename)) {
        docMap.set(filename, { entity_ids: [], observation_snippets: [] });
      }
      const entry = docMap.get(filename);
      if (!entry.entity_ids.includes(entityId)) {
        entry.entity_ids.push(entityId);
      }
      // Collect snippets from observations that match this source
      for (const obs of observations) {
        const s = _stripSourcePrefix(obs.source);
        if (s === filename && obs.observation) {
          const snippet = obs.observation.substring(0, 200);
          if (entry.observation_snippets.length < 10) {
            entry.observation_snippets.push(snippet);
          }
        }
      }
    }
  }

  return docMap;
}

// ---------------------------------------------------------------------------
// Signal-Based Document Classification (Build 10)
// ---------------------------------------------------------------------------

/**
 * Classify a filename + snippets against a template's document_types using
 * classification_signals. Returns the best-matching type_id or null.
 */
function classifyBySignals(filename, snippets, documentTypes) {
  if (!documentTypes || documentTypes.length === 0) return null;
  const text = ((filename || '') + ' ' + (snippets || []).join(' ')).toLowerCase();

  let bestMatch = null;
  let bestScore = 0;

  for (const dt of documentTypes) {
    const signals = dt.classification_signals || [];
    let matches = 0;
    for (const sig of signals) {
      if (text.includes(sig.toLowerCase())) matches++;
    }
    const score = signals.length > 0 ? matches / signals.length : 0;
    if (score > bestScore && matches >= 1) {
      bestScore = score;
      bestMatch = dt.type_id;
    }
  }

  return bestMatch;
}

// ---------------------------------------------------------------------------
// LLM Document Classification (legacy + enhanced)
// ---------------------------------------------------------------------------

async function classifyDocuments(spokeId, graphDir, template) {
  // Collect entities from spoke
  const allEnts = listEntities(graphDir);
  const spokeEntities = allEnts
    .filter(({ data }) => (data.spoke_id || 'default') === spokeId)
    .map(({ data }) => data);

  const docMap = extractSourceDocuments(spokeEntities);

  // Safety: limit to first 100 source docs
  const filenames = Array.from(docMap.keys()).slice(0, 100);

  if (filenames.length === 0) {
    return { classifications: [], unclassified: [], signal_classifications: {} };
  }

  // Build signal-based classifications first (no LLM, instant)
  const signalClassifications = {};
  const documentTypes = template?.document_types || [];
  for (const fn of filenames) {
    const entry = docMap.get(fn);
    const typeId = classifyBySignals(fn, entry.observation_snippets, documentTypes);
    if (typeId) {
      signalClassifications[fn] = typeId;
    }
  }

  // Build snippet context
  const fileContext = filenames.map(fn => {
    const entry = docMap.get(fn);
    const snippets = (entry.observation_snippets || [])
      .map(s => s.substring(0, 200))
      .join('; ');
    return `- ${fn}: ${snippets || '(no snippets)'}`;
  }).join('\n');

  // Get all category+item lists from all templates
  const templates = loadTemplates();
  const allCategories = [];
  for (const [key, tmpl] of Object.entries(templates)) {
    for (const cat of (tmpl.required_documents || [])) {
      allCategories.push({
        template: key,
        category: cat.category,
        items: cat.items
      });
    }
  }

  // Also include document_types from new-format templates
  for (const [key, tmpl] of Object.entries(templates)) {
    for (const dt of (tmpl.document_types || [])) {
      const cat = (dt.category || 'other').toLowerCase();
      if (!allCategories.some(c => c.items.includes(dt.type_id))) {
        allCategories.push({ template: key, category: cat, items: [dt.type_id] });
      }
    }
  }

  const categoryList = allCategories.map(c =>
    `${c.category}: ${c.items.join(', ')}`
  ).join('\n');

  try {
    const Anthropic = require('@anthropic-ai/sdk').default;
    const client = new Anthropic();

    const prompt = `You are a legal document classifier. Given a list of filenames with observation snippets from a legal matter, classify each file into document categories.

DOCUMENT CATEGORIES AND ITEMS:
${categoryList}

FILES TO CLASSIFY:
${fileContext}

For each file, determine which document categories and specific items it likely represents.

Respond with ONLY valid JSON (no markdown fences):
{
  "classifications": [
    { "filename": "example.pdf", "detected_categories": ["identification"], "detected_items": ["government_id"], "confidence": 0.85 }
  ],
  "unclassified": ["unknown_file.txt"]
}`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawResponse = message.content[0].text;
    const cleaned = rawResponse.replace(/^```json?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    const parsed = JSON.parse(cleaned);

    return {
      classifications: parsed.classifications || [],
      unclassified: parsed.unclassified || [],
      signal_classifications: signalClassifications
    };
  } catch (err) {
    console.warn('Document classification failed:', err.message);
    return { classifications: [], unclassified: filenames, signal_classifications: signalClassifications };
  }
}

// ---------------------------------------------------------------------------
// Scoring: Document Score
// ---------------------------------------------------------------------------

function scoreDocuments(template, classifications, signalClassifications) {
  const totalItems = [];
  const foundItems = [];
  const missing = [];
  const found = [];

  // Use document_types if available (new format), otherwise required_documents (legacy)
  if (template.document_types && template.document_types.length > 0) {
    for (const dt of template.document_types) {
      totalItems.push({ type_id: dt.type_id, display_name: dt.display_name, category: dt.category, priority: dt.priority });

      // Check signal classifications first
      const signalMatch = Object.entries(signalClassifications || {}).find(([fn, typeId]) => typeId === dt.type_id);
      // Then check LLM classifications
      const llmMatch = classifications.find(c =>
        c.detected_items && (c.detected_items.includes(dt.type_id) || c.detected_items.some(i => dt.classification_signals && dt.classification_signals.some(s => i.toLowerCase().includes(s.toLowerCase()))))
      );

      if (signalMatch || llmMatch) {
        foundItems.push({ type_id: dt.type_id, category: dt.category });
        found.push({
          type_id: dt.type_id,
          display_name: dt.display_name,
          category: dt.category,
          source_file: signalMatch ? signalMatch[0] : (llmMatch ? llmMatch.filename : null)
        });
      } else {
        missing.push({
          type_id: dt.type_id,
          display_name: dt.display_name,
          category: dt.category,
          priority: dt.priority || getCategoryPriority(dt.category).toUpperCase()
        });
      }
    }
  } else {
    // Legacy format
    for (const cat of (template.required_documents || [])) {
      for (const item of cat.items) {
        totalItems.push({ category: cat.category, item });
        const match = classifications.find(c =>
          c.detected_items && c.detected_items.includes(item)
        );
        if (match) {
          foundItems.push({ category: cat.category, item });
          found.push({ category: cat.category, item, source_file: match.filename });
        } else {
          missing.push({ category: cat.category, item, priority: getCategoryPriority(cat.category) });
        }
      }
    }
  }

  const score = totalItems.length > 0 ? foundItems.length / totalItems.length : 1;
  return { score, missing, found };
}

// ---------------------------------------------------------------------------
// Scoring: Field-Level within Documents (Build 10 + Build 11.5 three-tier)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective necessity_tier for a field, applying per-spoke overrides.
 * tier_adjustments: { "income.net_income": "BLOCKING", ... }
 */
function _resolveFieldTier(field, tierAdjustments) {
  if (tierAdjustments && tierAdjustments[field.field_id]) {
    return tierAdjustments[field.field_id];
  }
  return field.necessity_tier || 'EXPECTED'; // default if not annotated
}

/**
 * Score field-level extraction within found document types.
 * Returns three-tier scores (Build 11.5):
 *   filing_readiness  — % of BLOCKING fields extracted
 *   quality_score     — % of (BLOCKING + EXPECTED) fields extracted
 *   completeness      — % of ALL fields extracted
 * Plus legacy single score for backward compat.
 *
 * @param {object} template - Normalized template
 * @param {Array} foundDocTypes - Document types that were found (from scoreDocuments)
 * @param {Array} spokeEntities - All entities in the spoke
 * @param {object} tierAdjustments - Optional per-spoke field_id → tier overrides
 */
function scoreDocumentFields(template, foundDocTypes, spokeEntities, tierAdjustments) {
  const docTypes = template.document_types || [];
  if (docTypes.length === 0) return {
    score: 1, missing_fields: [], total: 0, extracted: 0,
    filing_readiness: 1, quality_score: 1, completeness: 1,
    tier_counts: { BLOCKING: { total: 0, extracted: 0 }, EXPECTED: { total: 0, extracted: 0 }, ENRICHING: { total: 0, extracted: 0 } },
    missing_by_tier: { BLOCKING: [], EXPECTED: [], ENRICHING: [] }
  };

  let totalFields = 0;
  let extractedFields = 0;
  const missingFields = [];

  // Three-tier counters
  const tierCounts = {
    BLOCKING:  { total: 0, extracted: 0 },
    EXPECTED:  { total: 0, extracted: 0 },
    ENRICHING: { total: 0, extracted: 0 }
  };
  const missingByTier = { BLOCKING: [], EXPECTED: [], ENRICHING: [] };

  // Build a set of found type_ids
  const foundTypeIds = new Set((foundDocTypes || []).map(d => d.type_id));

  // Collect all entity attribute keys + observation text for matching
  const allAttrKeys = new Set();
  const allText = [];
  for (const ent of spokeEntities) {
    for (const attr of (ent.attributes || [])) {
      allAttrKeys.add((attr.key || '').toLowerCase().replace(/\s+/g, '_'));
      allText.push(((attr.key || '') + ' ' + (attr.value || '')).toLowerCase());
    }
    for (const obs of (ent.observations || [])) {
      allText.push(((obs.observation || '') + ' ' + (obs.value || '')).toLowerCase());
    }
  }
  const fullText = allText.join(' ');

  for (const dt of docTypes) {
    // Only check fields for documents that are present
    if (!foundTypeIds.has(dt.type_id)) continue;

    for (const field of (dt.extraction_spec || [])) {
      const tier = _resolveFieldTier(field, tierAdjustments);
      totalFields++;
      if (tierCounts[tier]) tierCounts[tier].total++;

      // Check if this field was extracted: look for field_id suffix or display_name in entity data
      const fieldKey = (field.field_id || '').split('.').pop().toLowerCase().replace(/\s+/g, '_');
      const displayKey = (field.display_name || '').toLowerCase().replace(/\s+/g, '_');
      const aliases = FIELD_ALIASES[fieldKey] || [fieldKey, displayKey];

      const found = aliases.some(a => allAttrKeys.has(a) || fullText.includes(a.replace(/_/g, ' ')));

      if (found) {
        extractedFields++;
        if (tierCounts[tier]) tierCounts[tier].extracted++;
      } else {
        const missingEntry = {
          field_id: field.field_id,
          display_name: field.display_name,
          sensitivity: field.sensitivity,
          necessity_tier: tier,
          from_document_type: dt.type_id
        };
        missingFields.push(missingEntry);
        if (missingByTier[tier]) missingByTier[tier].push(missingEntry);
      }
    }
  }

  // Legacy single score (backward compat)
  const score = totalFields > 0 ? extractedFields / totalFields : 1;

  // Three-tier scores (Build 11.5)
  const bTotal = tierCounts.BLOCKING.total;
  const bExtracted = tierCounts.BLOCKING.extracted;
  const eTotal = tierCounts.EXPECTED.total;
  const eExtracted = tierCounts.EXPECTED.extracted;

  const filingReadiness = bTotal > 0 ? bExtracted / bTotal : 1;
  const qualityScore = (bTotal + eTotal) > 0 ? (bExtracted + eExtracted) / (bTotal + eTotal) : 1;
  const completenessScore = score; // same as legacy

  return {
    score, missing_fields: missingFields, total: totalFields, extracted: extractedFields,
    filing_readiness: Math.round(filingReadiness * 100) / 100,
    quality_score: Math.round(qualityScore * 100) / 100,
    completeness: Math.round(completenessScore * 100) / 100,
    tier_counts: tierCounts,
    missing_by_tier: missingByTier
  };
}

// ---------------------------------------------------------------------------
// Cross-Doc Rule Checking (Build 10 — new)
// ---------------------------------------------------------------------------

/**
 * Check cross-document rules against extracted data in spoke entities.
 * Returns violations where conflicting values are detected.
 */
function checkCrossDocRules(template, spokeEntities) {
  const rules = template.cross_doc_rules || [];
  if (rules.length === 0) return [];

  // Build a field-value map from all entity attributes
  const fieldValues = {}; // fieldKey → [{value, entity_id, source}]
  for (const ent of spokeEntities) {
    const entityId = ent.entity?.entity_id || ent.entity_id || '';
    for (const attr of (ent.attributes || [])) {
      const key = (attr.key || '').toLowerCase().replace(/\s+/g, '_');
      if (!fieldValues[key]) fieldValues[key] = [];
      fieldValues[key].push({
        value: attr.value,
        entity_id: entityId,
        source: attr.provenance?.source || ''
      });
    }
  }

  const violations = [];

  for (const rule of rules) {
    if (rule.validation === 'exact') {
      // Collect all values for the rule's fields
      const values = [];
      for (const fieldRef of (rule.fields || [])) {
        const fieldKey = fieldRef.split('.').pop().toLowerCase().replace(/\s+/g, '_');
        // Check direct match and aliases
        const aliases = FIELD_ALIASES[fieldKey] || [fieldKey];
        for (const alias of aliases) {
          if (fieldValues[alias]) {
            for (const v of fieldValues[alias]) {
              values.push({ field_id: fieldRef, ...v });
            }
          }
        }
      }

      // Check if values conflict
      if (values.length >= 2) {
        const uniqueValues = [...new Set(values.map(v => (v.value || '').toString().trim().toLowerCase()))];
        if (uniqueValues.length > 1) {
          violations.push({
            rule_id: rule.rule_id,
            description: rule.description,
            severity: rule.severity,
            conflicting_values: values.map(v => ({
              field_id: v.field_id,
              value: v.value,
              source: v.entity_id
            }))
          });
        }
      }
    }
    // comparison and fuzzy rules: only flag if we have data for both sides
    else if (rule.validation === 'comparison' || rule.validation === 'fuzzy') {
      // Collect values for comparison
      const valueGroups = {};
      for (const fieldRef of (rule.fields || [])) {
        const fieldKey = fieldRef.split('.').pop().toLowerCase().replace(/\s+/g, '_');
        const aliases = FIELD_ALIASES[fieldKey] || [fieldKey];
        for (const alias of aliases) {
          if (fieldValues[alias]) {
            if (!valueGroups[fieldRef]) valueGroups[fieldRef] = [];
            valueGroups[fieldRef].push(...fieldValues[alias]);
          }
        }
      }
      // Only flag if multiple field groups have data and they differ
      const groupsWithData = Object.entries(valueGroups).filter(([, vals]) => vals.length > 0);
      if (groupsWithData.length >= 2) {
        if (rule.validation === 'fuzzy') {
          // Fuzzy: check if any pair of values is dissimilar
          const allVals = groupsWithData.flatMap(([fid, vals]) => vals.map(v => ({ field_id: fid, ...v })));
          const lowerVals = allVals.map(v => (v.value || '').toString().trim().toLowerCase());
          const hasMismatch = lowerVals.some((v, i) => lowerVals.some((v2, j) => i !== j && !v.includes(v2) && !v2.includes(v)));
          if (hasMismatch) {
            violations.push({
              rule_id: rule.rule_id,
              description: rule.description,
              severity: rule.severity,
              conflicting_values: allVals.map(v => ({ field_id: v.field_id, value: v.value, source: v.entity_id }))
            });
          }
        }
        // comparison: would need numeric parsing — skip automated flagging for now
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Scoring: Entity Score
// ---------------------------------------------------------------------------

function _entityHasField(entity, fieldName) {
  // fieldName can be a string (legacy) or extracted from field_id
  const key = typeof fieldName === 'string' ? fieldName : (fieldName.field_id || '').split('.').pop();
  const aliases = FIELD_ALIASES[key] || [key];

  // 1. Check attributes[].key
  const attrs = entity.attributes || [];
  for (const attr of attrs) {
    const attrKey = (attr.key || '').toLowerCase();
    if (aliases.some(a => attrKey.includes(a))) return true;
  }

  // 2. Check entity.name for name fields
  if (key === 'full_name' || key === 'legal_name' || key === 'name') {
    const name = entity.entity?.name || entity.name || {};
    if (name.full || name.common || name.preferred) return true;
  }

  // 3. Fallback: scan observations text for keywords
  const observations = entity.observations || [];
  for (const obs of observations) {
    const text = ((obs.observation || '') + ' ' + (obs.value || '')).toLowerCase();
    if (aliases.some(a => text.includes(a.replace(/_/g, ' ')))) return true;
  }

  return false;
}

// Map template role types to entity_type values used in the graph
const TYPE_ALIASES = {
  organization: ['organization', 'business', 'institution'],
  business: ['business', 'organization', 'institution'],
  person: ['person'],
  institution: ['institution', 'organization', 'business'],
};

function _matchEntityToRole(role, entities) {
  // Find entities that match the role type (with alias support)
  const validTypes = TYPE_ALIASES[role.type] || [role.type];
  const candidates = entities.filter(ent => {
    const eType = ent.entity?.entity_type || ent.entity_type || '';
    return validTypes.includes(eType);
  });

  if (candidates.length === 0) return [];

  // For roles like "beneficiary", check relationships
  const roleKeywords = [role.role.replace(/_/g, ' ')];

  // Try to find entities with matching role in relationships or observations
  const matched = candidates.filter(ent => {
    const rels = ent.relationships || [];
    const obs = ent.observations || [];
    const allText = [
      ...rels.map(r => (r.relationship || '') + ' ' + (r.context || '')),
      ...obs.map(o => (o.observation || '') + ' ' + (o.value || ''))
    ].join(' ').toLowerCase();

    return roleKeywords.some(kw => allText.includes(kw));
  });

  return matched.length > 0 ? matched : [candidates[0]]; // Fallback to first candidate of matching type
}

function scoreEntities(template, spokeEntities) {
  let totalFields = 0;
  let filledFields = 0;
  const missingFields = [];

  for (const role of (template.required_entities || [])) {
    const matched = _matchEntityToRole(role, spokeEntities);

    if (matched.length === 0) {
      if (!role.optional) {
        // All fields are missing
        for (const field of (role.required_fields || [])) {
          totalFields++;
          const fieldName = typeof field === 'string' ? field : (field.field_id || field.display_name || '').split('.').pop();
          missingFields.push({ role: role.role, entity: null, missing: fieldName });
        }
      }
      continue;
    }

    for (const entity of matched) {
      const entityName = entity.entity?.name?.full || entity.entity?.name?.common ||
                         entity.entity?.name?.preferred || entity.name?.full ||
                         entity.name?.common || '(unknown)';

      for (const field of (role.required_fields || [])) {
        totalFields++;
        const fieldName = typeof field === 'string' ? field : (field.field_id || field.display_name || '').split('.').pop();
        if (_entityHasField(entity, fieldName)) {
          filledFields++;
        } else {
          missingFields.push({
            role: role.role,
            entity: entityName,
            missing: fieldName
          });
        }
      }
    }
  }

  const score = totalFields > 0 ? filledFields / totalFields : 1;
  return { score, missingFields };
}

// ---------------------------------------------------------------------------
// Scoring: Relationship Score
// ---------------------------------------------------------------------------

function scoreRelationships(template, spokeEntities) {
  const requiredRoles = (template.required_entities || [])
    .filter(r => !r.optional)
    .map(r => r.role);

  if (requiredRoles.length === 0) return { score: 1, missing: [] };

  let foundRoles = 0;
  const missing = [];

  for (const role of requiredRoles) {
    const roleKeyword = role.replace(/_/g, ' ');

    // Check if any entity has a relationship that mentions this role
    const found = spokeEntities.some(ent => {
      const rels = ent.relationships || [];
      const obs = ent.observations || [];
      const allText = [
        ...rels.map(r => (r.relationship || '') + ' ' + (r.context || '')),
        ...obs.map(o => (o.observation || '') + ' ' + (o.attribute || '') + ' ' + (o.value || ''))
      ].join(' ').toLowerCase();

      return allText.includes(roleKeyword);
    });

    // Also check if there's a matching entity type at minimum
    const hasType = spokeEntities.some(ent => {
      const eType = ent.entity?.entity_type || ent.entity_type || '';
      const templateRole = (template.required_entities || []).find(r => r.role === role);
      if (!templateRole) return false;
      const validTypes = TYPE_ALIASES[templateRole.type] || [templateRole.type];
      return validTypes.includes(eType);
    });

    if (found || hasType) {
      foundRoles++;
    } else {
      missing.push({
        from: 'matter',
        expected: role.replace(/_/g, ' '),
        to: '(not found)'
      });
    }
  }

  const score = requiredRoles.length > 0 ? foundRoles / requiredRoles.length : 1;
  return { score, missing };
}

// ---------------------------------------------------------------------------
// Suggestions — deterministic from missing items
// ---------------------------------------------------------------------------

function _formatLabel(item) {
  return (item || '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function generateSuggestions(missingDocs, missingFields, missingRels, missingDocFields) {
  const suggestions = [];

  for (const doc of (missingDocs || []).slice(0, 5)) {
    const label = doc.display_name || _formatLabel(doc.item || doc.type_id || '');
    suggestions.push(`Request ${label} from client`);
  }

  for (const field of (missingFields || []).slice(0, 5)) {
    const missing = field.display_name || _formatLabel(field.missing || '');
    suggestions.push(`Obtain ${missing} for ${(field.role || '').replace(/_/g, ' ')}`);
  }

  for (const field of (missingDocFields || []).slice(0, 3)) {
    const label = field.display_name || _formatLabel(field.field_id || '');
    const docLabel = _formatLabel(field.from_document_type || '');
    suggestions.push(`Extract ${label} from ${docLabel}`);
  }

  for (const rel of (missingRels || []).slice(0, 3)) {
    suggestions.push(`Identify and add ${rel.expected} to the matter`);
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Main Orchestrator — analyzeGaps (Build 10 + Build 11.5 three-tier scoring)
// ---------------------------------------------------------------------------

async function analyzeGaps(spokeId, graphDir, templateType, tierAdjustments) {
  const template = getTemplate(templateType);
  if (!template) {
    throw new Error(`Unknown template type: ${templateType}. Available: ${Object.keys(loadTemplates()).join(', ')}`);
  }

  const spoke = getSpoke(graphDir, spokeId);
  const spokeName = spoke?.name || spokeId;

  // Load per-spoke tier adjustments (override param > spoke data)
  const effectiveAdjustments = tierAdjustments || spoke?.tier_adjustments || null;

  // Collect spoke entities
  const allEnts = listEntities(graphDir);
  const spokeEntities = allEnts
    .filter(({ data }) => (data.spoke_id || 'default') === spokeId)
    .map(({ data }) => data);

  // Extract source documents
  const docMap = extractSourceDocuments(spokeEntities);
  const sourceDocuments = Array.from(docMap.keys());

  // Document classification (LLM + signal-based)
  let classifications = [];
  let signalClassifications = {};
  try {
    const result = await classifyDocuments(spokeId, graphDir, template);
    classifications = result.classifications || [];
    signalClassifications = result.signal_classifications || {};
  } catch (err) {
    console.warn('Classification failed, scoring with empty classifications:', err.message);
  }

  // Score documents (document-level)
  const docResult = scoreDocuments(template, classifications, signalClassifications);

  // Score fields within found documents (field-level — Build 10 + three-tier — Build 11.5)
  const fieldResult = scoreDocumentFields(template, docResult.found, spokeEntities, effectiveAdjustments);

  // Score entities
  const entityResult = scoreEntities(template, spokeEntities);

  // Score relationships
  const relResult = scoreRelationships(template, spokeEntities);

  // Check cross-doc rules (Build 10)
  const crossDocViolations = checkCrossDocRules(template, spokeEntities);

  // Two-level completeness score (Build 10):
  // (docs_present / docs_required * 0.5) + (fields_extracted / fields_required * 0.5)
  const hasDocTypes = (template.document_types || []).length > 0;
  let overallScore;
  if (hasDocTypes) {
    overallScore = Math.round(
      (docResult.score * 0.5 + fieldResult.score * 0.5) * 100
    ) / 100;
  } else {
    // Legacy: weighted average of 3 dimensions
    overallScore = Math.round(
      (docResult.score * 0.4 + entityResult.score * 0.4 + relResult.score * 0.2) * 100
    ) / 100;
  }

  const suggestions = generateSuggestions(
    docResult.missing,
    entityResult.missingFields,
    relResult.missing,
    fieldResult.missing_fields
  );

  return {
    spoke_id: spokeId,
    spoke_name: spokeName,
    template_type: templateType,
    template_name: template.label || template.display_name,
    template_version: template.version || '0.1.0',
    overall_score: overallScore,
    document_score: Math.round(docResult.score * 100) / 100,
    field_score: Math.round(fieldResult.score * 100) / 100,
    entity_score: Math.round(entityResult.score * 100) / 100,
    relationship_score: Math.round(relResult.score * 100) / 100,
    // Build 11.5 — three-tier scores
    filing_readiness: fieldResult.filing_readiness,
    quality_score: fieldResult.quality_score,
    completeness: fieldResult.completeness,
    tier_counts: fieldResult.tier_counts,
    missing_by_tier: fieldResult.missing_by_tier,
    // Existing fields
    missing_documents: docResult.missing,
    missing_fields: fieldResult.missing_fields,
    missing_entity_fields: entityResult.missingFields,
    missing_relationships: relResult.missing,
    cross_doc_violations: crossDocViolations,
    found_documents: docResult.found,
    suggestions,
    source_documents: sourceDocuments,
    entity_count: spokeEntities.length,
    tier_adjustments_applied: effectiveAdjustments ? Object.keys(effectiveAdjustments).length : 0,
    analyzed_at: new Date().toISOString()
  };
}

module.exports = {
  loadTemplates,
  getTemplate,
  saveTemplates,
  normalizeTemplate,
  extractSourceDocuments,
  classifyDocuments,
  classifyBySignals,
  scoreDocumentFields,
  checkCrossDocRules,
  analyzeGaps,
  FIELD_ALIASES,
  TYPE_ALIASES,
};
