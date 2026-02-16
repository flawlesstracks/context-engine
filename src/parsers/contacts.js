'use strict';

const COLUMN_MAP = {
  name: ['name', 'full name'],
  firstName: ['first name', 'firstname'],
  lastName: ['last name', 'lastname'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone number'],
  company: ['company', 'organization', 'org', 'employer'],
  title: ['title', 'role', 'job title', 'position'],
};

function findColumn(headers, candidates) {
  const normalised = headers.map(h => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = normalised.findIndex(h => h.includes(candidate));
    if (idx !== -1) return headers[idx];
  }
  return null;
}

function mapContactRows(rows, sourceFilename, agentId) {
  if (!rows || rows.length === 0) return [];

  const headers = Object.keys(rows[0]);
  const cols = {
    name: findColumn(headers, COLUMN_MAP.name),
    firstName: findColumn(headers, COLUMN_MAP.firstName),
    lastName: findColumn(headers, COLUMN_MAP.lastName),
    email: findColumn(headers, COLUMN_MAP.email),
    phone: findColumn(headers, COLUMN_MAP.phone),
    company: findColumn(headers, COLUMN_MAP.company),
    title: findColumn(headers, COLUMN_MAP.title),
  };

  const entities = [];

  for (const row of rows) {
    // Resolve name
    let fullName = '';
    if (cols.name) {
      fullName = (row[cols.name] || '').trim();
    }
    if (!fullName && (cols.firstName || cols.lastName)) {
      const first = cols.firstName ? (row[cols.firstName] || '').trim() : '';
      const last = cols.lastName ? (row[cols.lastName] || '').trim() : '';
      fullName = [first, last].filter(Boolean).join(' ');
    }

    if (!fullName) continue; // Skip rows with no name

    const now = new Date().toISOString();

    // Build attributes
    const attributes = [];
    let attrSeq = 1;

    if (cols.email && row[cols.email]) {
      attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key: 'email', value: String(row[cols.email]).trim(),
        confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'objective' },
      });
    }

    if (cols.phone && row[cols.phone]) {
      attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key: 'phone', value: String(row[cols.phone]).trim(),
        confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'objective' },
      });
    }

    if (cols.company && row[cols.company]) {
      attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key: 'company', value: String(row[cols.company]).trim(),
        confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 2, layer_label: 'group' },
      });
    }

    if (cols.title && row[cols.title]) {
      attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key: 'role', value: String(row[cols.title]).trim(),
        confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'semi_stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 2, layer_label: 'group' },
      });
    }

    entities.push({
      schema_version: '2.0',
      schema_type: 'context_architecture_entity',
      extraction_metadata: {
        extracted_at: now,
        updated_at: now,
        source_description: `contact_import:${sourceFilename}`,
        extraction_model: 'direct_mapping',
        extraction_confidence: 0.8,
        schema_version: '2.0',
      },
      entity: {
        entity_type: 'person',
        name: {
          full: fullName,
          preferred: '',
          aliases: [],
          confidence: 0.8,
          facts_layer: 1,
        },
        summary: { value: '', confidence: 0, facts_layer: 2 },
      },
      attributes,
      relationships: [],
      values: [],
      key_facts: [],
      constraints: [],
      observations: [{
        observation: `Imported from contact list: ${sourceFilename}`,
        observed_at: now,
        source: 'contact_import',
        confidence: 0.8,
        confidence_label: 'STRONG',
        truth_level: 'STRONG',
        facts_layer: 'L1_OBJECTIVE',
        layer_number: 1,
        observed_by: agentId || 'file_upload',
      }],
      provenance_chain: {
        created_at: now,
        created_by: agentId || 'file_upload',
        source_documents: [{ source: `contact_import:${sourceFilename}`, ingested_at: now }],
        merge_history: [],
      },
    });
  }

  return entities;
}

module.exports = { mapContactRows };
