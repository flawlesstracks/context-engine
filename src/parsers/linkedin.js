'use strict';

function buildLinkedInPrompt(text, sourceFilename) {
  return `You are a structured data extraction engine. Analyze this LinkedIn profile export and extract the person's professional information mapped to the Career Lite schema.

Output ONLY valid JSON, no markdown fences, no commentary.

The Career Lite schema has three interfaces:
- Contactable: name, email, location, linkedin_url, phone
- Identifiable: headline, summary, current_title, current_company
- Experienceable: work_history, education, skills

JSON schema:
{
  "name": { "full": "", "preferred": "", "aliases": [] },
  "email": "",
  "phone": "",
  "headline": "",
  "location": "",
  "linkedin_url": "",
  "summary": "2-3 sentence professional summary",
  "current_title": "",
  "current_company": "",
  "work_history": [
    {
      "company": "",
      "title": "",
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
      "year": ""
    }
  ],
  "skills": [],
  "connections": [
    { "name": "", "relationship": "", "context": "" }
  ]
}

Important:
- linkedin_url: extract any linkedin.com/in/... URL found in the text
- email: extract if present in Contact section
- phone: extract if present in Contact section
- current_title and current_company: the most recent/current role
- work_history: extract ALL experience entries with dates when available
- education: extract ALL education entries, use year for graduation/end year
- skills: array of skill strings
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

  // Normalize: support both old schema (experience/current_role) and new Career Lite (work_history/current_title)
  const workHistory = parsed.work_history || parsed.experience || [];
  const currentTitle = parsed.current_title || parsed.current_role || '';
  const currentCompany = parsed.current_company || '';

  // Build attributes
  const attributes = [];
  let attrSeq = 1;

  if (parsed.headline) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'headline', value: parsed.headline,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.location) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'location', value: parsed.location,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (currentTitle) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'role', value: currentTitle,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (currentCompany) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'company', value: currentCompany,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.email) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'email', value: parsed.email,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.phone) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'phone', value: parsed.phone,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (parsed.linkedin_url) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'linkedin_url', value: parsed.linkedin_url,
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  if (Array.isArray(parsed.skills) && parsed.skills.length > 0) {
    attributes.push({
      attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
      key: 'skills', value: parsed.skills.join(', '),
      confidence: 0.85, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 2, layer_label: 'group' },
    });
  }

  // Build key_facts from work_history and education
  const keyFacts = [];
  let factSeq = 1;

  for (const exp of workHistory) {
    const dateRange = [exp.start_date, exp.end_date].filter(Boolean).join(' - ') || '';
    const fact = [exp.title, exp.company, dateRange].filter(Boolean).join(' at ');
    if (fact) {
      keyFacts.push({
        fact_id: `FACT-${String(factSeq++).padStart(3, '0')}`,
        fact,
        confidence: 0.85,
        confidence_label: 'HIGH',
        source: sourceFilename,
      });
    }
  }

  if (Array.isArray(parsed.education)) {
    for (const edu of parsed.education) {
      const parts = [edu.degree, edu.field, edu.institution].filter(Boolean);
      const year = edu.year || [edu.start_year, edu.end_year].filter(Boolean).join('-');
      if (year) parts.push(`(${year})`);
      const fact = parts.join(', ');
      if (fact) {
        keyFacts.push({
          fact_id: `FACT-${String(factSeq++).padStart(3, '0')}`,
          fact,
          confidence: 0.85,
          confidence_label: 'HIGH',
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
    // Contactable
    name: name.full || '',
    email: parsed.email || '',
    location: parsed.location || '',
    linkedin_url: parsed.linkedin_url || '',
    phone: parsed.phone || '',
    // Identifiable
    headline: parsed.headline || '',
    summary: parsed.summary || '',
    current_title: currentTitle,
    current_company: currentCompany,
    // Legacy aliases
    current_role: currentTitle,
    // Experienceable
    work_history: workHistory.map(exp => ({
      company: exp.company || '',
      title: exp.title || '',
      start_date: exp.start_date || '',
      end_date: exp.end_date || '',
      description: exp.description || '',
    })),
    experience: workHistory.map(exp => ({
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
      year: edu.year || edu.end_year || '',
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

  for (const exp of (parsed.work_history || parsed.experience || [])) {
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
