'use strict';

const fs = require('fs');
const path = require('path');
const { listEntities, readEntity } = require('./graph-ops');
const { getSpoke, loadSpokes } = require('./spoke-ops');

// ---------------------------------------------------------------------------
// Template CRUD
// ---------------------------------------------------------------------------

const TEMPLATES_PATH = path.resolve(__dirname, '..', 'data', 'matter-templates.json');

function loadTemplates() {
  const dir = path.dirname(TEMPLATES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(TEMPLATES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TEMPLATES_PATH, 'utf-8'));
  } catch (err) {
    console.warn('Failed to load matter templates:', err.message);
    return {};
  }
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
  ssn: ['ssn', 'social_security', 'social_security_number'],
  address: ['address', 'home_address', 'residence', 'location', 'mailing_address', 'principal_address', 'registered_address'],
  contact_info: ['phone', 'email', 'contact', 'address', 'contact_info', 'phone_number', 'email_address'],
  relationship: ['relationship', 'relation', 'connection_type'],
  ownership_percentage: ['ownership', 'percentage', 'equity', 'interest', 'ownership_percentage', 'membership_interest'],
  filing_status: ['filing_status', 'tax_status'],
  ein: ['ein', 'tax_id', 'employer_id', 'employer_identification_number', 'federal_tax_id'],
  entity_type: ['entity_type', 'business_type', 'organization_type', 'llc', 'corporation', 'partnership', 'sole_proprietorship'],
  state_of_formation: ['state_of_formation', 'state_of_incorporation', 'formation_state', 'organized_in', 'incorporated_in'],
  fiscal_year_end: ['fiscal_year_end', 'year_end', 'fiscal_year', 'tax_year_end', 'accounting_period'],
  ptin: ['ptin', 'preparer_tax_id', 'preparer_identification'],
};

// ---------------------------------------------------------------------------
// Priority assignment based on document category
// ---------------------------------------------------------------------------

const HIGH_PRIORITY_CATEGORIES = new Set([
  'identification', 'legal', 'financial', 'medical', 'incident',
  'incorporation', 'financial_statements', 'payroll'
]);

const LOW_PRIORITY_CATEGORIES = new Set([
  'supporting'
]);

function getCategoryPriority(category) {
  if (HIGH_PRIORITY_CATEGORIES.has(category)) return 'high';
  if (LOW_PRIORITY_CATEGORIES.has(category)) return 'low';
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
// LLM Document Classification
// ---------------------------------------------------------------------------

async function classifyDocuments(spokeId, graphDir) {
  // Collect entities from spoke
  const allEnts = listEntities(graphDir);
  const spokeEntities = allEnts
    .filter(({ data }) => (data.spoke_id || 'default') === spokeId)
    .map(({ data }) => data);

  const docMap = extractSourceDocuments(spokeEntities);

  // Safety: limit to first 100 source docs
  const filenames = Array.from(docMap.keys()).slice(0, 100);

  if (filenames.length === 0) {
    return { classifications: [], unclassified: [] };
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
      unclassified: parsed.unclassified || []
    };
  } catch (err) {
    console.warn('Document classification failed:', err.message);
    return { classifications: [], unclassified: filenames };
  }
}

// ---------------------------------------------------------------------------
// Scoring: Document Score (40%)
// ---------------------------------------------------------------------------

function scoreDocuments(template, classifications) {
  const totalItems = [];
  const foundItems = [];
  const missing = [];
  const found = [];

  for (const cat of (template.required_documents || [])) {
    for (const item of cat.items) {
      totalItems.push({ category: cat.category, item });

      // Check if any classification detected this item
      const match = classifications.find(c =>
        c.detected_items && c.detected_items.includes(item)
      );

      if (match) {
        foundItems.push({ category: cat.category, item });
        found.push({
          category: cat.category,
          item,
          source_file: match.filename
        });
      } else {
        missing.push({
          category: cat.category,
          item,
          priority: getCategoryPriority(cat.category)
        });
      }
    }
  }

  const score = totalItems.length > 0 ? foundItems.length / totalItems.length : 1;
  return { score, missing, found };
}

// ---------------------------------------------------------------------------
// Scoring: Entity Score (40%)
// ---------------------------------------------------------------------------

function _entityHasField(entity, fieldName) {
  const aliases = FIELD_ALIASES[fieldName] || [fieldName];

  // 1. Check attributes[].key
  const attrs = entity.attributes || [];
  for (const attr of attrs) {
    const key = (attr.key || '').toLowerCase();
    if (aliases.some(a => key.includes(a))) return true;
  }

  // 2. Check entity.name for name fields
  if (fieldName === 'full_name' || fieldName === 'legal_name') {
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
          missingFields.push({ role: role.role, entity: null, missing: field });
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
        if (_entityHasField(entity, field)) {
          filledFields++;
        } else {
          missingFields.push({
            role: role.role,
            entity: entityName,
            missing: field
          });
        }
      }
    }
  }

  const score = totalFields > 0 ? filledFields / totalFields : 1;
  return { score, missingFields };
}

// ---------------------------------------------------------------------------
// Scoring: Relationship Score (20%)
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
  return item.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function generateSuggestions(missingDocs, missingFields, missingRels) {
  const suggestions = [];

  for (const doc of (missingDocs || []).slice(0, 5)) {
    suggestions.push(`Request ${_formatLabel(doc.item)} from client`);
  }

  for (const field of (missingFields || []).slice(0, 5)) {
    if (field.entity) {
      suggestions.push(`Obtain ${_formatLabel(field.missing)} for ${field.role.replace(/_/g, ' ')}`);
    } else {
      suggestions.push(`Obtain ${_formatLabel(field.missing)} for ${field.role.replace(/_/g, ' ')}`);
    }
  }

  for (const rel of (missingRels || []).slice(0, 3)) {
    suggestions.push(`Identify and add ${rel.expected} to the matter`);
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Main Orchestrator — analyzeGaps
// ---------------------------------------------------------------------------

async function analyzeGaps(spokeId, graphDir, templateType) {
  const template = getTemplate(templateType);
  if (!template) {
    throw new Error(`Unknown template type: ${templateType}. Available: ${Object.keys(loadTemplates()).join(', ')}`);
  }

  const spoke = getSpoke(graphDir, spokeId);
  const spokeName = spoke?.name || spokeId;

  // Collect spoke entities
  const allEnts = listEntities(graphDir);
  const spokeEntities = allEnts
    .filter(({ data }) => (data.spoke_id || 'default') === spokeId)
    .map(({ data }) => data);

  // Extract source documents
  const docMap = extractSourceDocuments(spokeEntities);
  const sourceDocuments = Array.from(docMap.keys());

  // LLM document classification
  let classifications = [];
  try {
    const result = await classifyDocuments(spokeId, graphDir);
    classifications = result.classifications || [];
  } catch (err) {
    console.warn('Classification failed, scoring with empty classifications:', err.message);
  }

  // Score all three dimensions
  const docResult = scoreDocuments(template, classifications);
  const entityResult = scoreEntities(template, spokeEntities);
  const relResult = scoreRelationships(template, spokeEntities);

  // Weighted average
  const overallScore = Math.round(
    (docResult.score * 0.4 + entityResult.score * 0.4 + relResult.score * 0.2) * 100
  ) / 100;

  const suggestions = generateSuggestions(
    docResult.missing,
    entityResult.missingFields,
    relResult.missing
  );

  return {
    spoke_id: spokeId,
    spoke_name: spokeName,
    template_type: templateType,
    template_name: template.label,
    overall_score: overallScore,
    document_score: Math.round(docResult.score * 100) / 100,
    entity_score: Math.round(entityResult.score * 100) / 100,
    relationship_score: Math.round(relResult.score * 100) / 100,
    missing_documents: docResult.missing,
    missing_entity_fields: entityResult.missingFields,
    missing_relationships: relResult.missing,
    found_documents: docResult.found,
    suggestions,
    source_documents: sourceDocuments,
    entity_count: spokeEntities.length,
    analyzed_at: new Date().toISOString()
  };
}

module.exports = {
  loadTemplates,
  getTemplate,
  saveTemplates,
  extractSourceDocuments,
  classifyDocuments,
  analyzeGaps,
  FIELD_ALIASES,
  TYPE_ALIASES,
};
