'use strict';

function buildLinkedInPrompt(text, sourceFilename) {
  return `You are a structured data extraction engine. Analyze this LinkedIn profile export and extract the person's professional information.

Output ONLY valid JSON, no markdown fences, no commentary.

JSON schema:
{
  "name": { "full": "", "preferred": "", "aliases": [] },
  "headline": "",
  "location": "",
  "current_role": "",
  "current_company": "",
  "summary": "2-3 sentence professional summary",
  "experience": [
    {
      "title": "",
      "company": "",
      "start_date": "",
      "end_date": "",
      "description": ""
    }
  ],
  "education": [
    {
      "institution": "",
      "degree": "",
      "field": "",
      "start_year": "",
      "end_year": ""
    }
  ],
  "skills": [],
  "linkedin_url": "",
  "connections": [
    { "name": "", "relationship": "", "context": "" }
  ]
}

Important:
- linkedin_url: extract any linkedin.com/in/... URL found in the text
- Extract ALL experience entries with dates when available
- Extract ALL education entries
- Skills should be an array of skill strings
- connections: only include specifically named people mentioned in the profile
- If information is not present, use empty strings or empty arrays

Source file: ${sourceFilename}

--- LINKEDIN PROFILE TEXT ---
${text}
--- END ---`;
}

function linkedInResponseToEntity(parsed, sourceFilename, agentId) {
  const now = new Date().toISOString();
  const name = parsed.name || {};

  // Build attributes
  const attributes = [];
  let attrSeq = 1;

  if (parsed.headline) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'headline', value: parsed.headline,
      confidence: 0.6, confidence_label: 'MODERATE',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.location) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'location', value: parsed.location,
      confidence: 0.6, confidence_label: 'MODERATE',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.current_role) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'role', value: parsed.current_role,
      confidence: 0.6, confidence_label: 'MODERATE',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.current_company) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'company', value: parsed.current_company,
      confidence: 0.6, confidence_label: 'MODERATE',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'skills', value: parsed.skills.join(', '),
      confidence: 0.6, confidence_label: 'MODERATE',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  // Build key_facts from experience and education
  const keyFacts = [];
  let factSeq = 1;

  if (Array.isArray(parsed.experience)) {
    for (const exp of parsed.experience) {
      const dateRange = [exp.start_date, exp.end_date].filter(Boolean).join(' - ') || '';
      const fact = [exp.title, exp.company, dateRange].filter(Boolean).join(' at ');
      if (fact) {
        keyFacts.push({
          fact_id: `FACT-${String(factSeq++).padStart(3, '0')}`,
          fact,
          confidence: 0.6,
          confidence_label: 'MODERATE',
          source: sourceFilename,
        });
      }
    }
  }

  if (Array.isArray(parsed.education)) {
    for (const edu of parsed.education) {
      const parts = [edu.degree, edu.field, edu.institution].filter(Boolean);
      const yearRange = [edu.start_year, edu.end_year].filter(Boolean).join('-');
      if (yearRange) parts.push(`(${yearRange})`);
      const fact = parts.join(', ');
      if (fact) {
        keyFacts.push({
          fact_id: `FACT-${String(factSeq++).padStart(3, '0')}`,
          fact,
          confidence: 0.6,
          confidence_label: 'MODERATE',
          source: sourceFilename,
        });
      }
    }
  }

  // Build relationships from connections
  const relationships = [];
  if (Array.isArray(parsed.connections)) {
    let relSeq = 1;
    for (const conn of parsed.connections) {
      if (!conn.name) continue;
      relationships.push({
        relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
        name: conn.name,
        relationship_type: conn.relationship || 'connection',
        context: conn.context || '',
        sentiment: 'neutral',
        confidence: 0.6,
        confidence_label: 'MODERATE',
      });
    }
  }

  // Build observation
  const observations = [{
    observation: `LinkedIn profile imported from ${sourceFilename}`,
    observed_at: now,
    source: 'linkedin_import',
    confidence: 0.6,
    confidence_label: 'MODERATE',
    truth_level: 'INFERRED',
    facts_layer: 'L2_GROUP',
    layer_number: 2,
    observed_by: agentId || 'file_upload',
  }];

  // Career Lite structured data — preserved for wiki display
  const careerLite = {
    interface: 'career-lite',
    implements: ['Contactable', 'Identifiable', 'Experienceable'],
    headline: parsed.headline || '',
    location: parsed.location || '',
    current_role: parsed.current_role || '',
    current_company: parsed.current_company || '',
    linkedin_url: parsed.linkedin_url || '',
    experience: (parsed.experience || []).map(exp => ({
      title: exp.title || '',
      company: exp.company || '',
      start_date: exp.start_date || '',
      end_date: exp.end_date || '',
      description: exp.description || '',
    })),
    education: (parsed.education || []).map(edu => ({
      institution: edu.institution || '',
      degree: edu.degree || '',
      field: edu.field || '',
      start_year: edu.start_year || '',
      end_year: edu.end_year || '',
    })),
    skills: parsed.skills || [],
  };

  return {
    schema_version: '2.0',
    schema_type: 'context_architecture_entity',
    extraction_metadata: {
      extracted_at: now,
      updated_at: now,
      source_description: `linkedin_import:${sourceFilename}`,
      extraction_model: 'claude-sonnet-4-5-20250929',
      extraction_confidence: 0.6,
      schema_version: '2.0',
    },
    entity: {
      entity_type: 'person',
      name: {
        full: name.full || '',
        preferred: name.preferred || '',
        aliases: name.aliases || [],
        confidence: 0.6,
        facts_layer: 2,
      },
      summary: parsed.summary
        ? { value: parsed.summary, confidence: 0.6, facts_layer: 2 }
        : { value: '', confidence: 0, facts_layer: 2 },
    },
    career_lite: careerLite,
    attributes,
    relationships,
    values: [],
    key_facts: keyFacts,
    constraints: [],
    observations,
    provenance_chain: {
      created_at: now,
      created_by: agentId || 'file_upload',
      source_documents: [{ source: `linkedin_import:${sourceFilename}`, ingested_at: now }],
      merge_history: [],
    },
  };
}

/**
 * Generate org entities for each unique company in the LinkedIn experience.
 * Each org gets a worked_at relationship back to the person.
 */
function linkedInExperienceToOrgs(parsed, personName, sourceFilename, agentId) {
  const now = new Date().toISOString();
  const seen = new Set();
  const orgs = [];

  for (const exp of (parsed.experience || [])) {
    const company = (exp.company || '').trim();
    if (!company || seen.has(company.toLowerCase())) continue;
    seen.add(company.toLowerCase());

    orgs.push({
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now, updated_at: now,
        source_description: `linkedin_import:${sourceFilename}`,
        extraction_model: 'claude-sonnet-4-5-20250929',
        extraction_confidence: 0.6, schema_version: '2.0',
      },
      entity: {
        entity_type: 'business',
        name: { common: company, legal: company, aliases: [], confidence: 0.6, facts_layer: 2 },
        summary: { value: `${company} — employer of ${personName}`, confidence: 0.5, facts_layer: 2 },
      },
      attributes: [],
      relationships: [{
        relationship_id: 'REL-001',
        name: personName,
        relationship_type: 'employed',
        context: `${personName} worked at ${company}` + (exp.title ? ` as ${exp.title}` : ''),
        sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
      }],
      values: [], key_facts: [], constraints: [],
      observations: [{
        observation: `${personName} worked here as ${exp.title || 'employee'}` +
          (exp.start_date ? ` (${exp.start_date}` + (exp.end_date ? ` - ${exp.end_date}` : ' - Present') + ')' : ''),
        observed_at: now,
        source: 'linkedin_import',
        source_url: parsed.linkedin_url || '',
        confidence: 0.6, confidence_label: 'MODERATE',
        truth_level: 'INFERRED',
        facts_layer: 'L2_GROUP', layer_number: 2,
        observed_by: agentId || 'file_upload',
      }],
      org_dimensions: {
        relationship_to_primary: 'employer',
        org_category: 'career',
        org_status: exp.end_date ? 'former' : 'current',
        primary_user_role: exp.title || '',
      },
      provenance_chain: {
        created_at: now, created_by: agentId || 'file_upload',
        source_documents: [{ source: `linkedin_import:${sourceFilename}`, ingested_at: now }],
        merge_history: [],
      },
    });
  }

  return orgs;
}

module.exports = { buildLinkedInPrompt, linkedInResponseToEntity, linkedInExperienceToOrgs };
