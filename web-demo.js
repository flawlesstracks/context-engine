#!/usr/bin/env node

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;
const { merge, normalizeRelationshipType } = require('./merge-engine');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const { readEntity, writeEntity, listEntities, listEntitiesByType, getNextCounter, loadConnectedObjects, deleteEntity } = require('./src/graph-ops');
const { ingestPipeline } = require('./src/ingest-pipeline');
const { normalizeFileToText } = require('./src/parsers/normalize');
const { buildLinkedInPrompt, linkedInResponseToEntity, linkedInExperienceToOrgs } = require('./src/parsers/linkedin');
const { mapContactRows } = require('./src/parsers/contacts');
const auth = require('./src/auth');
const drive = require('./src/drive');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.set('trust proxy', 1); // MUST be first — Render terminates HTTPS at load balancer
app.set('etag', false);

// --- Security headers ---
app.use(helmet({
  contentSecurityPolicy: false,  // inline scripts in HTML templates
  crossOriginEmbedderPolicy: false,
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Context-API-Key, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: '200mb' }));
app.use(cookieParser());

// --- Rate limiting ---
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many share requests, please try again later.' },
});

const sharedViewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please try again in a minute.',
});

app.use('/api/', apiLimiter);

// --- Shared extraction logic ---

const PERSON_SCHEMA = `{
  "entity_type": "person",
  "name": { "full": "", "preferred": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "attributes": { "role": "", "location": "", "expertise": [] },
  "relationships": [{ "name": "", "relationship": "", "context": "" }],
  "values": [],
  "communication_style": { "tone": "", "preferences": [] },
  "active_projects": [{ "name": "", "status": "", "description": "" }],
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

const BUSINESS_SCHEMA = `{
  "entity_type": "business",
  "name": { "legal": "", "common": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "industry": "",
  "products_services": [],
  "key_people": [{ "name": "", "role": "", "context": "" }],
  "values": [],
  "customers": { "target": "", "segments": [] },
  "competitive_position": "",
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

const INSTITUTION_SCHEMA = `{
  "entity_type": "institution",
  "name": { "legal": "", "common": "", "aliases": [] },
  "summary": "2-3 sentence synthesis",
  "institution_type": "university|school|government|hospital|public_service",
  "key_people": [{ "name": "", "role": "", "context": "" }],
  "values": [],
  "key_facts": [],
  "metadata": { "source": "", "generated": "", "version": "1.0" }
}`;

function buildPrompt(type, text) {
  const schema = type === 'person' ? PERSON_SCHEMA : (type === 'institution' ? INSTITUTION_SCHEMA : BUSINESS_SCHEMA);
  return `You are a structured data extraction engine. Given unstructured text about a ${type}, extract all relevant information into the following JSON structure. Fill in every field you can from the text. Leave fields as empty strings, empty arrays, or reasonable defaults if the information is not present. Do not invent information that is not in the text.

Output ONLY valid JSON, no markdown fences, no commentary.

JSON schema:
${schema}

Important:
- metadata.source should be "web-demo"
- metadata.generated should be the current timestamp in ISO 8601 format: "${new Date().toISOString()}"
- metadata.version should be "1.0"
- summary should be a 2-3 sentence synthesis of the most important information

Text to extract from:
---
${text}
---`;
}

async function callClaude(prompt) {
  const client = new Anthropic();
  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text;
}

// --- Web UI extract endpoint (v2, no auth) ---

app.post('/extract', async (req, res) => {
  const { text, type } = req.body;

  if (!text || !type) {
    return res.status(400).json({ error: 'Missing text or type' });
  }
  if (!['person', 'business', 'institution'].includes(type)) {
    return res.status(400).json({ error: 'Type must be person, business, or institution' });
  }

  try {
    const { execFile } = require('child_process');
    const tmpIn = path.join(__dirname, 'watch-folder', 'output', `_web_input_${Date.now()}.txt`);
    const tmpOut = path.join(__dirname, 'watch-folder', 'output', `_web_output_${Date.now()}.json`);

    fs.writeFileSync(tmpIn, text);

    await new Promise((resolve, reject) => {
      execFile('node', [
        path.join(__dirname, 'context-engine.js'),
        '--input', tmpIn, '--output', tmpOut, '--type', type, '--schema-version', '2.0',
      ], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
        timeout: 180000,
      }, (err) => err ? reject(err) : resolve());
    });

    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));
    fs.unlinkSync(tmpIn);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Graph API ---

const IS_PRODUCTION = process.env.RENDER || process.env.NODE_ENV === 'production';
const LOCAL_GRAPH_DIR = path.join(__dirname, 'watch-folder', 'graph');
const CONFIG_PATH = path.join(__dirname, 'watch-folder', 'config.json');

// Resolve graph directory — try persistent disk candidates, fall back to local
let GRAPH_DIR = LOCAL_GRAPH_DIR;
let GRAPH_IS_PERSISTENT = false;
if (IS_PRODUCTION) {
  const candidates = [
    process.env.RENDER_DISK_PATH && path.join(process.env.RENDER_DISK_PATH, 'graph'),
    '/var/data/graph',
    '/data/graph',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const parentDir = path.dirname(candidate);
      if (!fs.existsSync(parentDir)) continue;
      if (!fs.existsSync(candidate)) {
        fs.mkdirSync(candidate, { recursive: true });
      }
      // Test write access
      const testFile = path.join(candidate, '.write-test');
      fs.writeFileSync(testFile, '');
      fs.unlinkSync(testFile);

      // Seed from repo on first boot (root JSON files)
      const existing = fs.readdirSync(candidate).filter(f => f.endsWith('.json'));
      if (existing.length === 0) {
        const seedFiles = fs.readdirSync(LOCAL_GRAPH_DIR).filter(f => f.endsWith('.json'));
        for (const file of seedFiles) {
          fs.copyFileSync(path.join(LOCAL_GRAPH_DIR, file), path.join(candidate, file));
        }
        console.log(`  Seeded ${seedFiles.length} entity file(s) to ${candidate}`);
      }

      // Merge repo tenants into persistent disk (repo is source of truth for api_keys)
      const persistentTenants = path.join(candidate, 'tenants.json');
      const localTenants = path.join(LOCAL_GRAPH_DIR, 'tenants.json');
      if (fs.existsSync(localTenants)) {
        const repoTenants = JSON.parse(fs.readFileSync(localTenants, 'utf-8'));
        let diskTenants = {};
        if (fs.existsSync(persistentTenants)) {
          try { diskTenants = JSON.parse(fs.readFileSync(persistentTenants, 'utf-8')); } catch {}
        }
        let updated = 0;
        for (const [id, tenant] of Object.entries(repoTenants)) {
          if (!diskTenants[id]) {
            diskTenants[id] = tenant;
            updated++;
          } else {
            // Merge: repo fields fill in gaps, disk preserves runtime tokens
            for (const [key, val] of Object.entries(tenant)) {
              if (!diskTenants[id][key]) {
                diskTenants[id][key] = val;
              }
            }
            // API key from repo always wins (so external consumers like GPTs can use known keys)
            if (tenant.api_key && diskTenants[id].api_key !== tenant.api_key) {
              diskTenants[id].api_key = tenant.api_key;
              updated++;
            }
          }
        }
        if (updated > 0 || !fs.existsSync(persistentTenants)) {
          fs.writeFileSync(persistentTenants, JSON.stringify(diskTenants, null, 2) + '\n');
          console.log(`  Merged tenants.json: ${updated} tenant(s) updated from repo`);
        }
      }

      // Sync tenant directories from repo if missing on persistent disk
      const localEntries = fs.readdirSync(LOCAL_GRAPH_DIR, { withFileTypes: true });
      for (const entry of localEntries) {
        if (entry.isDirectory() && entry.name.startsWith('tenant-')) {
          const destDir = path.join(candidate, entry.name);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
            const srcDir = path.join(LOCAL_GRAPH_DIR, entry.name);
            const entityFiles = fs.readdirSync(srcDir);
            for (const ef of entityFiles) {
              fs.copyFileSync(path.join(srcDir, ef), path.join(destDir, ef));
            }
            console.log(`  Synced tenant dir ${entry.name} (${entityFiles.length} files) to persistent disk`);
          }
        }
      }
      GRAPH_DIR = candidate;
      GRAPH_IS_PERSISTENT = true;
      break;
    } catch {
      continue;
    }
  }
  if (!GRAPH_IS_PERSISTENT) {
    console.warn('  WARNING: No writable persistent disk found');
    console.warn('  Falling back to local graph: ' + LOCAL_GRAPH_DIR);
    console.warn('  Set RENDER_DISK_PATH env var to your disk mount path');
  }
}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// --- Tenant management ---

const TENANTS_PATH = path.join(GRAPH_DIR, 'tenants.json');

function loadTenants() {
  if (!fs.existsSync(TENANTS_PATH)) return {};
  return JSON.parse(fs.readFileSync(TENANTS_PATH, 'utf-8'));
}

function saveTenants(tenants) {
  fs.writeFileSync(TENANTS_PATH, JSON.stringify(tenants, null, 2) + '\n');
}

// --- Share helpers ---

function loadShares(tenantDir) {
  const sharesPath = path.join(tenantDir, 'shares.json');
  if (!fs.existsSync(sharesPath)) return [];
  return JSON.parse(fs.readFileSync(sharesPath, 'utf-8'));
}

function saveShares(tenantDir, shares) {
  fs.writeFileSync(path.join(tenantDir, 'shares.json'), JSON.stringify(shares, null, 2) + '\n');
}

// --- Google OAuth routes ---

auth.init({ graphDir: GRAPH_DIR, loadTenants, saveTenants });
app.use('/auth', auth.router);

// --- ChatGPT Ingest Helpers ---

function parseChatGPTExport(input) {
  let conversations;
  if (typeof input === 'string') {
    conversations = JSON.parse(input);
  } else if (Array.isArray(input)) {
    conversations = input;
  } else {
    throw new Error('Expected an array of conversations or a JSON string');
  }

  return conversations.map(conv => {
    const title = conv.title || 'Untitled';
    const createTime = conv.create_time
      ? new Date(conv.create_time * 1000).toISOString()
      : new Date().toISOString();
    const userMessages = [];

    if (conv.mapping) {
      const nodes = Object.values(conv.mapping);
      nodes.sort((a, b) => (a.message?.create_time || 0) - (b.message?.create_time || 0));
      for (const node of nodes) {
        const msg = node.message;
        if (!msg || !msg.author || msg.author.role !== 'user') continue;
        const parts = (msg.content?.parts || []);
        const text = parts.filter(p => typeof p === 'string').join('\n').trim();
        if (text) userMessages.push(text);
      }
    }

    return { title, createTime, userMessages };
  }).filter(c => c.userMessages.length > 0);
}

function chunkText(text, chunkSize, overlap) {
  chunkSize = chunkSize || 25000;
  overlap = overlap || 1000;
  if (text.length <= chunkSize) return [text];
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.substring(offset, offset + chunkSize));
    offset += chunkSize - overlap;
  }
  return chunks;
}

function repairTruncatedJSON(raw) {
  // Try to recover a truncated {"entities": [...]} response
  // by finding the last complete object in the array
  const idx = raw.lastIndexOf('},');
  if (idx === -1) {
    // Try last complete object at end of array (no trailing comma)
    const idx2 = raw.lastIndexOf('}]');
    if (idx2 !== -1) return JSON.parse(raw.substring(0, idx2 + 2) + '}');
    return null;
  }
  const repaired = raw.substring(0, idx + 1) + ']}';
  return JSON.parse(repaired);
}

function safeParseExtraction(raw, label) {
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn(`[${label}] JSON parse failed: ${e.message} — attempting repair`);
    try {
      const repaired = repairTruncatedJSON(cleaned);
      if (repaired && repaired.entities) {
        console.warn(`[${label}] Response truncated — recovered ${repaired.entities.length} entities from this chunk`);
        return repaired;
      }
    } catch (e2) {
      console.warn(`[${label}] JSON repair also failed: ${e2.message}`);
    }
    console.warn(`[${label}] Skipping chunk — no entities recovered`);
    return { entities: [] };
  }
}

// Resolve the primary user's full name from the graph directory
function getPrimaryUserName(graphDir) {
  try {
    const ents = listEntities(graphDir);
    let best = null;
    let maxConn = 0;
    for (const { data } of ents) {
      if ((data.entity || {}).entity_type === 'person') {
        const count = (data.connected_objects || []).length;
        if (count > maxConn) { maxConn = count; best = data; }
      }
    }
    if (best && best.entity && best.entity.name) {
      const n = best.entity.name;
      return n.full || n.preferred || '';
    }
  } catch (e) { /* ignore */ }
  return '';
}

function buildGenericTextPrompt(text, filename, chunkNum, totalChunks, primaryUserName) {
  const chunkLabel = totalChunks > 1 ? ` (chunk ${chunkNum} of ${totalChunks})` : '';
  const primaryBlock = primaryUserName ? `
PRIMARY USER CONTEXT:
The primary user of this system is ${primaryUserName}. Every person and organization you extract must be scored in relationship TO ${primaryUserName}.

RELATIONSHIP SCORING — PERSON ENTITIES:

For each PERSON entity, include a "relationship_dimensions" object AND a top-level "descriptor" field.

1. connection_type (required, enum)
   How is this person connected to ${primaryUserName}?
   "blood" — biological or legally adopted family
   "marriage" — connected through a marriage (current or former). Includes spouse, ex-spouse, in-law, step-relative.
   "chosen" — voluntary personal relationship (friend, mentor, mentee, confidant, surrogate family)
   "professional" — work or business relationship (colleague, manager, client, partner)
   "community" — shared context or proximity (classmate, neighbor, fellow member)

   TIEBREAKER RULE: When a relationship spans BOTH chosen AND professional (e.g., MBA classmate who became a business partner), pick whichever connection came FIRST chronologically. If they were friends before doing business together, connection_type = "chosen" and mention the business in the descriptor. DEFAULT TO "chosen" when ambiguous.

   SPOUSE RULE: If someone is identified as another person's wife/husband/spouse/partner, and that other person is NOT ${primaryUserName}, connection_type MUST be "marriage" with connected_through = the spouse. Marriage connection ALWAYS takes priority over any professional services they may also provide. Example: "Marcus's wife Keisha does hair" → connection_type = "marriage", connected_through = "Marcus", NOT connection_type = "professional".

   CRITICAL: "like a brother", "surrogate sister", "father figure" = "chosen", NOT "blood". Only actual blood/marriage/legal family = "blood" or "marriage".

2. access (required, float 0.00-1.00)
   How much vulnerability would ${primaryUserName} extend to this person?
   0.90-1.00: Unrestricted trust. Kids, home, finances, unlocked phone — all offered without anxiety.
   0.70-0.89: High trust. 3am emergency call. Vulnerable conversations. Significant favors expected to land.
   0.50-0.69: Mutual trust. Direct contact exists. Reaching out is normal. Would help if asked.
   0.30-0.49: Contextual trust. Warm in shared settings. Wouldn't reach out independently.
   0.10-0.29: Recognition. Know who they are. No real trust, just awareness.
   0.01-0.09: One-directional. Parasocial or purely observational.
   Score based on EVIDENCE in the text. Look for trust indicators, emotional language, frequency of contact, shared vulnerability, practical reliance.

3. connected_through (required, string or null)
   Is this a direct relationship with ${primaryUserName} or through someone else?
   null — direct relationship. ${primaryUserName} and this person have an independent connection.
   "Person Name" — connected through this person.

   CRITICAL RULES:
   a) If the text says "[Person] is [Someone Else]'s [wife/husband/spouse/partner]" and [Someone Else] is NOT ${primaryUserName}, then connected_through = "[Someone Else]". This person is NOT ${primaryUserName}'s family.
   b) If the text says "[Person] is [Someone]'s [sister/brother/child/parent]" and [Someone] is NOT ${primaryUserName}, then connected_through = "[Someone]".
   c) EXCEPTION — Spouse's family: If connected_through is ${primaryUserName}'s CURRENT SPOUSE, and the person is the spouse's blood relative, they are an in-law. Set sub_role = "in_law".
   d) EXCEPTION — Sibling's spouse: If the person is married to ${primaryUserName}'s sibling, they are an in-law. Set sub_role = "in_law" and connected_through = the sibling's name.
   e) If someone originally met ${primaryUserName} through a bridge person but NOW has an independent relationship, set connected_through = null and put the origin story in the descriptor.

4. status (required, enum)
   "active" — regular engagement, generating contact
   "stable" — solid, doesn't need regular contact. Would re-engage instantly.
   "passive" — no regular contact, zero animosity. Dormant, not dead.
   "diminishing" — actively fading. Less contact over time.
   "inactive" — effectively ended. Not hostile, just done.
   "estranged" — active conflict, avoidance, or tension.
   "deceased" — person has passed away.
   "complicated" — multiple simultaneous states. MUST explain in descriptor.

5. strength (required, float 0.00-1.00)
   How much would ${primaryUserName}'s life change without this person?
   0.90-1.00: Life-altering. Daily existence changes. The 5-7 anchors.
   0.75-0.89: Significant. Felt at milestones, holidays, hard decisions.
   0.50-0.74: Meaningful. Would miss them. Daily life continues unchanged.
   0.30-0.49: Mild. Latent goodwill. Would notice eventually if prompted.
   0.10-0.29: Negligible. Memory, not active life.
   0.01-0.09: None. Cultural awareness only.

   INDEPENDENCE RULE: Strength is independent of access. A deceased best friend has access 0.00 but strength can be 0.90. A friendly acquaintance might have access 0.55 but strength 0.30. Do not conflate reachability with emotional impact.
   EVIDENCE RULE: Do not inflate strength based on connection_type alone. Not all siblings are close. Not all colleagues are distant. Score what the text SHOWS, not what the relationship type implies.

6. sub_role (required, string)
   Most specific role this person plays:
   Family: spouse | child | parent | grandparent | sibling | uncle | aunt | cousin | in_law | extended
   Friends: friend | mentor | mentee | confidant | surrogate_sibling | surrogate_parent
   Professional: colleague | manager | report | partner | client | vendor
   Community: classmate | neighbor | member | acquaintance
   Other: influence

7. descriptor (required, string, 4-8 words)
   Completes "That's my ___" in ${primaryUserName}'s voice.
   Rules:
   - Use NICKNAMES when present in the data
   - High access (0.70+): qualifier + relationship + origin ("best friend from the block", "day-one from Howard, like a brother")
   - Moderate access (0.40-0.69): context + relationship ("CAU MBA classmate, trivia crew")
   - Low access (<0.40): connection path only ("old acquaintance from Markham")
   - Deceased: use "late" naturally ("late best friend from the block")
   - Former: include transition + ongoing connection ("ex-wife, London's mother")
   - Complicated: name the layers ("ex-wife, co-parent, complicated history")
   - Distance 2+ people: use bridge person's NICKNAME ("Ro's wife" not "Rodrique Fru's wife", "Jeff's wife" not "Jeffrey Richard Mitchell's wife")

8. descriptor_origin (required, string)
   Origin context for the relationship (e.g., "childhood", "Howard University", "work", "Lola's family", "the block")

RELATIONSHIP SCORING — ORGANIZATION ENTITIES:

ONLY extract organizations where ${primaryUserName} has a DIRECT relationship. If the org is mentioned in someone else's bio or as a general reference, DO NOT EXTRACT IT.

Include an "org_dimensions" object AND a top-level "descriptor" field:
- relationship_to_primary: "employer" | "alma_mater" | "membership" | "service_provider"
- org_category: "career" | "education" | "affiliations" | "services"
- org_status: "current" | "former"
- primary_user_role: ${primaryUserName}'s role/title at this org
- org_dates: approximate date range or ""
- org_descriptor: 3-6 word natural description
` : '';

  return `You are a structured data extraction engine. Extract ALL named people and organizations from this document.

This is a raw text document${chunkLabel}. It may be personal notes, relationship descriptions, memories, meeting notes, journal entries, correspondence, profiles, or any other text. Your job is to find EVERY named person and EVERY named organization mentioned, no matter how briefly.

CRITICAL — ANTI-HALLUCINATION RULES:
- ONLY extract entities whose names EXPLICITLY appear in the source text below
- Do NOT infer, generate, or fabricate any names that are not written in the text
- Every entity MUST include at least one observation with a DIRECT QUOTE from the source text as evidence
- If you are unsure whether a name appears in the text, do NOT include it
- Do NOT combine or merge separate people into one entity
- If the text says "his daughter" but does not name her, do NOT invent a name for her

CELEBRITY / PUBLIC FIGURE FILTER:
- Do NOT create entities for celebrities, public figures, or famous people unless they have a direct personal relationship with the author (e.g., they are a friend, colleague, family member, or direct acquaintance)
- If someone is mentioned as a comparison, reference, or example (e.g., "he's like the LeBron of his field"), do NOT create an entity for them
- If a famous person is mentioned only in passing or as a cultural reference, skip them
${primaryBlock}
EXTRACTION RULES:
- Return a MAXIMUM of 10 entities per chunk. Focus on the most significant named people and organizations. Skip minor mentions.
- entity_type MUST be "person", "business", or "institution"
- Use "business" for companies, for-profit organizations, and commercial entities
- Use "institution" for schools, universities, governments, hospitals, public services, churches, non-profits, and civic organizations
- For persons: include name, role, relationship to the author, location, personality traits, key facts — whatever the text says
- For organizations: include name, industry, location, what the author says about them
- Each observation MUST contain a direct quote or close paraphrase from the source text
- If someone is mentioned by first name only (e.g. "Marcus"), still extract them — but use exactly the name from the text
- If an organization is mentioned even once (e.g. "he works at Google"), extract it

OUTPUT FORMAT — valid JSON only, no markdown fences, no commentary:
{
  "entities": [
    {
      "entity_type": "person",
      "name": { "full": "Jane Smith" },
      "summary": "2-3 sentence summary of what the document says about this person",
      "attributes": { "role": "Product Manager", "location": "Atlanta", "personality": "outgoing and reliable" },
      "relationships": [{ "name": "Other Entity", "relationship": "colleague", "context": "worked together at Acme Corp" }],
      "observations": [{ "text": "Exact quote or paraphrase from the document about this entity" }],
      "relationship_dimensions": { "connection_type": "professional", "access": 0.55, "connected_through": null, "status": "active", "strength": 0.50, "sub_role": "colleague", "descriptor": "colleague at Acme Corp", "descriptor_origin": "work" },
      "descriptor": "colleague at Acme Corp"
    },
    {
      "entity_type": "business",
      "name": { "common": "Google" },
      "summary": "...",
      "attributes": { "industry": "Technology" },
      "relationships": [],
      "observations": [{ "text": "..." }],
      "org_dimensions": { "relationship_to_primary": "employer", "org_category": "career", "org_status": "current", "primary_user_role": "Engineer", "org_dates": "2020-present", "org_descriptor": "current employer, tech" },
      "descriptor": "current employer, tech"
    },
    {
      "entity_type": "institution",
      "name": { "common": "Howard University" },
      "summary": "...",
      "attributes": { "institution_type": "university" },
      "relationships": [],
      "observations": [{ "text": "..." }],
      "org_dimensions": { "relationship_to_primary": "alma_mater", "org_category": "education", "org_status": "former", "primary_user_role": "Student", "org_dates": "", "org_descriptor": "alma mater" },
      "descriptor": "alma mater"
    }
  ]
}

Source file: ${filename}${chunkLabel}

--- DOCUMENT TEXT ---
${text}
--- END ---`;
}

function buildIngestPrompt(batch, primaryUserName) {
  let text = '';
  batch.forEach((conv, i) => {
    text += '\nCONVERSATION ' + i + ' (title: "' + conv.title.replace(/"/g, '\\"') + '"):\n';
    let convText = conv.userMessages.join('\n');
    if (convText.length > 5000) convText = convText.substring(0, 5000) + '\n[...truncated]';
    text += convText + '\n';
  });

  let primaryBlock = '';
  if (primaryUserName) {
    primaryBlock = '\nPRIMARY USER CONTEXT:\n'
      + 'The primary user of this system is ' + primaryUserName + '. Every person and organization you extract must be scored in relationship TO ' + primaryUserName + '.\n'
      + '\nRELATIONSHIP SCORING — PERSON ENTITIES:\n'
      + 'For each PERSON entity, include a "relationship_dimensions" object AND a top-level "descriptor" field.\n'
      + '\n1. connection_type (required, enum): "blood" | "marriage" | "chosen" | "professional" | "community"\n'
      + '   "blood" = biological or legally adopted family. "marriage" = connected through marriage (spouse, ex-spouse, in-law, step-relative). "chosen" = voluntary personal relationship (friend, mentor, confidant, surrogate family). "professional" = work/business. "community" = shared context (classmate, neighbor).\n'
      + '   TIEBREAKER: When relationship spans BOTH chosen AND professional, pick whichever came FIRST chronologically. Default to "chosen" when ambiguous.\n'
      + '   SPOUSE RULE: If someone is identified as another person\'s wife/husband/spouse/partner, and that person is NOT ' + primaryUserName + ', connection_type MUST be "marriage" with connected_through = the spouse. Marriage ALWAYS takes priority over professional services.\n'
      + '   CRITICAL: "like a brother", "surrogate sister", "father figure" = "chosen", NOT "blood".\n'
      + '\n2. access (required, float 0.00-1.00): How much vulnerability would ' + primaryUserName + ' extend?\n'
      + '   0.90-1.00: Unrestricted trust (kids, home, finances). 0.70-0.89: High trust (3am call, vulnerable conversations). 0.50-0.69: Mutual trust (direct contact, would help). 0.30-0.49: Contextual (warm in shared settings). 0.10-0.29: Recognition only. 0.01-0.09: One-directional.\n'
      + '   Score based on EVIDENCE in the text.\n'
      + '\n3. connected_through (required, string or null): null = direct relationship. "Person Name" = connected through that person.\n'
      + '   CRITICAL: If "[Person] is [Someone]\'s [wife/husband/spouse]" and [Someone] is NOT ' + primaryUserName + ', then connected_through = "[Someone]". NOT ' + primaryUserName + '\'s family.\n'
      + '   EXCEPTION — Spouse\'s family: If connected_through is ' + primaryUserName + '\'s CURRENT SPOUSE and person is spouse\'s blood relative, set sub_role = "in_law".\n'
      + '   EXCEPTION — Sibling\'s spouse: If married to ' + primaryUserName + '\'s sibling, set sub_role = "in_law", connected_through = sibling\'s name.\n'
      + '   If someone originally met ' + primaryUserName + ' through a bridge person but NOW has an independent relationship, set connected_through = null.\n'
      + '\n4. status (required, enum): "active" | "stable" | "passive" | "diminishing" | "inactive" | "estranged" | "deceased" | "complicated"\n'
      + '\n5. strength (required, float 0.00-1.00): How much would ' + primaryUserName + '\'s life change without this person?\n'
      + '   0.90-1.00: Life-altering (5-7 anchors). 0.75-0.89: Significant (milestones, holidays). 0.50-0.74: Meaningful. 0.30-0.49: Mild. 0.10-0.29: Negligible. 0.01-0.09: None.\n'
      + '   INDEPENDENCE RULE: Strength is independent of access. Deceased best friend = access 0.00, strength 0.90. Do not inflate based on connection_type alone.\n'
      + '\n6. sub_role (required, string): Family: spouse|child|parent|grandparent|sibling|uncle|aunt|cousin|in_law|extended. Friends: friend|mentor|mentee|confidant|surrogate_sibling|surrogate_parent. Professional: colleague|manager|report|partner|client|vendor. Community: classmate|neighbor|member|acquaintance. Other: influence\n'
      + '\n7. descriptor (required, 4-8 words): Completes "That\'s my ___" in ' + primaryUserName + '\'s voice. Use NICKNAMES. Distance 2+ people use bridge person\'s nickname ("Ro\'s wife" not full name).\n'
      + '\n8. descriptor_origin (required, string): Origin context ("childhood", "Howard", "work", etc.)\n'
      + '\nRELATIONSHIP SCORING — ORGANIZATION ENTITIES:\n'
      + 'ONLY extract orgs where ' + primaryUserName + ' has a DIRECT relationship. If mentioned in someone else\'s bio, DO NOT EXTRACT.\n'
      + 'Include "org_dimensions" object: relationship_to_primary ("employer"|"alma_mater"|"membership"|"service_provider"), org_category ("career"|"education"|"affiliations"|"services"), org_status ("current"|"former"), primary_user_role, org_dates, org_descriptor (3-6 words).\n'
      + 'Also include top-level "descriptor" = org_dimensions.org_descriptor.\n\n';
  }

  return 'You are a structured data extraction engine. Analyze these user messages from ChatGPT conversations and extract every person, business, and institution the user mentions by name.\n\nRULES:\n- Only extract named entities (skip "my boss", "the company" without a specific name)\n- entity_type: "person", "business", or "institution"\n- Use "business" for companies and commercial entities; use "institution" for schools, universities, governments, hospitals, public services, churches, non-profits\n- name: { "full": "..." } for persons, { "common": "..." } for businesses and institutions\n- summary: 2-3 sentences synthesizing what the user said about this entity\n- attributes: only include clearly stated facts (role, location, expertise, industry)\n- relationships: connections between extracted entities\n- observations: each specific mention tagged with conversation_index (0-based integer matching conversation numbers below)\n- For persons: include relationship_dimensions and descriptor as top-level fields (see PRIMARY USER CONTEXT)\n- For orgs: include org_dimensions and descriptor as top-level fields\n- Do NOT invent information beyond what the user explicitly stated\n- Do NOT create entities for celebrities or public figures unless they have a direct personal relationship with the user\n- If no named entities found, return {"entities": []}\n'
    + primaryBlock
    + 'Output ONLY valid JSON, no markdown fences, no commentary:\n{\n  "entities": [\n    {\n      "entity_type": "person",\n      "name": { "full": "Jane Smith" },\n      "summary": "...",\n      "attributes": { "role": "...", "location": "..." },\n      "relationships": [{ "name": "Other Entity", "relationship": "colleague", "context": "..." }],\n      "observations": [{ "text": "What the user said about this entity", "conversation_index": 0 }],\n      "relationship_dimensions": { "connection_type": "professional", "access": 0.55, "connected_through": null, "status": "active", "strength": 0.50, "sub_role": "colleague", "descriptor": "colleague at Acme Corp", "descriptor_origin": "work" },\n      "descriptor": "colleague at Acme Corp"\n    }\n  ]\n}\n\n--- USER MESSAGES FROM CONVERSATIONS ---' + text + '\n--- END ---';
}

function buildProfilePrompt(text, filename, primaryUserName) {
  const primaryBlock = primaryUserName ? 'PRIMARY USER CONTEXT:\n'
    + 'The primary user of this system is ' + primaryUserName + '. Score this entity in relationship TO ' + primaryUserName + '.\n\n'
    + 'RELATIONSHIP SCORING — PERSON ENTITIES:\n'
    + 'Include a "relationship_dimensions" object AND a top-level "descriptor" field.\n'
    + '1. connection_type (required): "blood" | "marriage" | "chosen" | "professional" | "community"\n'
    + '2. access (required, float 0.00-1.00): vulnerability/trust level\n'
    + '3. connected_through (required, string or null)\n'
    + '4. status (required): "active" | "stable" | "passive" | "diminishing" | "inactive" | "estranged" | "deceased" | "complicated"\n'
    + '5. strength (required, float 0.00-1.00): life-impact score\n'
    + '6. sub_role (required, string): most specific role\n'
    + '7. descriptor (required, 4-8 words): completes "That\'s my ___"\n'
    + '8. descriptor_origin (required, string): origin context\n\n' : '';

  return 'You are processing a DEEP STRUCTURED PROFILE. Your job is to PRESERVE the full depth and structure of this assessment.\n\n'
    + 'CRITICAL RULES:\n'
    + '1. PRESERVE ALL STRUCTURE — nested objects, arrays, scores, and hierarchies must survive extraction. Do NOT flatten.\n'
    + '2. PRESERVE EXACT NUMBERS — OCEAN scores, Enneagram numbers, percentages, dates. Never round or approximate.\n'
    + '3. PRESERVE LISTS — energized_by, drained_by, blind_spots are ARRAYS. Keep them as arrays.\n'
    + '4. PRESERVE DISPUTES — if a score is marked as disputed, contested, or has a _note, include both the score AND the dispute.\n'
    + '5. PRESERVE MANAGEMENT PROTOCOLS — what_works, what_doesnt_work, communication guidelines are HIGH-VALUE data.\n'
    + '6. PRESERVE MJ/AI ANALYSIS — any analysis attributed to an AI, MJ, or external assessor is an OBSERVATION with attribution.\n'
    + '7. ONE ENTITY PER PROFILE — this document describes ONE person. Extract exactly one primary entity.\n'
    + '8. RELATIONSHIP DEDUP — if the same person appears in multiple sections (e.g., spouse in family AND spouse_dynamic), create ONE relationship entry with the richest context.\n'
    + '9. NO SELF-REFERENCES — do NOT create a relationship from the subject to themselves.\n'
    + '10. DIMENSION SCORING — score the relationship_dimensions from ' + (primaryUserName || 'the primary user') + '\'s perspective.\n\n'
    + primaryBlock
    + 'STRUCTURED ATTRIBUTE CATEGORIES:\n'
    + 'Extract into "structured_attributes" with these category keys:\n\n'
    + '- identity: { preferred_name, full_name, age, date_of_birth, location, origin, nationality, languages }\n'
    + '- professional: { current_role, company, industry, career_history (array), skills (array), education (array) }\n'
    + '- personality_assessments: {\n'
    + '    mbti: { type, description, confidence },\n'
    + '    enneagram: { core_type, wing, tritype, instinctual_variant, description },\n'
    + '    ocean: { openness: { score, percentile, _note? }, conscientiousness: { score, percentile, _note? }, extraversion: { score, percentile, _note? }, agreeableness: { score, percentile, _note? }, neuroticism: { score, percentile, _note? } }\n'
    + '  }\n'
    + '- behavioral_patterns: { communication_style, decision_making, conflict_style, energized_by (array), drained_by (array), blind_spots (array) }\n'
    + '- enneagram_dynamics: { core_motivation, fear, desire, growth_direction, stress_direction, integration_path, disintegration_path }\n'
    + '- family: { spouse: { name, relationship_type }, children (array of { name, age?, notes? }), family_notes }\n'
    + '- spouse_dynamic: { core_dynamic, friction_points (array), strengths (array), confirmed (array), disputed (array), modified (array) }\n'
    + '- relationship_to_primary_user: { what_works (array), what_doesnt_work (array), management_protocol, mj_analysis, communication_guidelines }\n'
    + '- ai_interaction_guidelines: { expectations (array), cautions (array), preferred_approach }\n'
    + '- profile_metadata: { assessment_date, last_updated, created_date, confidence_level, data_sources (array), verification_status, schema_version, gaps (array) }\n\n'
    + 'OBSERVATIONS RULES:\n'
    + '- Observations must be INSIGHT-LEVEL: blind spots, relationship dynamics, external analyses, behavioral patterns\n'
    + '- Do NOT dump flat attribute data as observations\n'
    + '- Each observation should be something a human would find genuinely insightful\n'
    + '- Include MJ/AI analyses as observations with source attribution\n\n'
    + 'OUTPUT FORMAT — valid JSON only, no markdown fences, no commentary:\n'
    + '{\n'
    + '  "entities": [{\n'
    + '    "entity_type": "person",\n'
    + '    "name": { "full": "Full Name", "preferred": "Nickname" },\n'
    + '    "summary": "2-3 sentence summary of this person based on the profile",\n'
    + '    "attributes": { "key": "value pairs for flat searchable data" },\n'
    + '    "relationships": [{ "name": "Person Name", "relationship": "type", "context": "rich context" }],\n'
    + '    "observations": [{ "text": "Insight-level observation with evidence" }],\n'
    + '    "structured_attributes": { "identity": {}, "professional": {}, "personality_assessments": {}, "behavioral_patterns": {}, "enneagram_dynamics": {}, "family": {}, "spouse_dynamic": {}, "relationship_to_primary_user": {}, "ai_interaction_guidelines": {}, "profile_metadata": {} },\n'
    + '    "relationship_dimensions": { "connection_type": "...", "access": 0.0, "connected_through": null, "status": "...", "strength": 0.0, "sub_role": "...", "descriptor": "...", "descriptor_origin": "..." },\n'
    + '    "descriptor": "4-8 word descriptor"\n'
    + '  }]\n'
    + '}\n\n'
    + 'Source file: ' + filename + '\n\n'
    + '--- PROFILE TEXT ---\n'
    + text + '\n'
    + '--- END ---';
}

// --- Auth middleware (multi-tenant) ---

function apiAuth(req, res, next) {
  const config = loadConfig();

  // Source 1: X-Context-API-Key header (existing behavior for API consumers)
  const key = req.headers['x-context-api-key'];

  if (key) {
    // Admin key — root namespace
    if (key === config.api_key) {
      req.agentId = req.headers['x-agent-id'] || 'external';
      req.graphDir = GRAPH_DIR;
      req.isAdmin = true;
      req.tenantId = null;
      return next();
    }

    // Tenant key lookup
    const tenants = loadTenants();
    const tenant = Object.values(tenants).find(t => t.api_key === key);
    if (tenant) {
      const tenantDir = path.join(GRAPH_DIR, `tenant-${tenant.tenant_id}`);
      if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
      req.agentId = req.headers['x-agent-id'] || tenant.tenant_name;
      req.graphDir = tenantDir;
      req.isAdmin = false;
      req.tenantId = tenant.tenant_id;
      return next();
    }

    return res.status(401).json({ error: 'Invalid API key' });
  }

  // Source 2: Bearer token or ca_session cookie (browser sessions via Google OAuth)
  const session = auth.verifySession(req);
  if (session && session.api_key) {
    const tenants = loadTenants();
    const tenant = Object.values(tenants).find(t => t.api_key === session.api_key);
    if (tenant) {
      const tenantDir = path.join(GRAPH_DIR, `tenant-${tenant.tenant_id}`);
      if (!fs.existsSync(tenantDir)) fs.mkdirSync(tenantDir, { recursive: true });
      req.agentId = tenant.tenant_name;
      req.graphDir = tenantDir;
      req.isAdmin = false;
      req.tenantId = tenant.tenant_id;
      return next();
    }
  }

  return res.status(401).json({ error: 'Missing X-Context-API-Key header or valid session' });
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// POST /api/tenant — Create a new tenant (admin only)
app.post('/api/tenant', apiAuth, adminOnly, (req, res) => {
  const { tenant_name } = req.body;
  if (!tenant_name || typeof tenant_name !== 'string' || !tenant_name.trim()) {
    return res.status(400).json({ error: 'tenant_name is required' });
  }

  const tenants = loadTenants();

  // Check duplicate name
  if (Object.values(tenants).some(t => t.tenant_name.toLowerCase() === tenant_name.trim().toLowerCase())) {
    return res.status(409).json({ error: `Tenant "${tenant_name}" already exists` });
  }

  const tenantId = crypto.randomBytes(4).toString('hex');
  const apiKey = 'ctx-' + crypto.randomBytes(16).toString('hex');
  const tenantDir = path.join(GRAPH_DIR, `tenant-${tenantId}`);
  fs.mkdirSync(tenantDir, { recursive: true });

  tenants[tenantId] = {
    tenant_id: tenantId,
    tenant_name: tenant_name.trim(),
    api_key: apiKey,
    created_at: new Date().toISOString(),
    created_by: req.agentId,
  };
  saveTenants(tenants);

  res.status(201).json({
    status: 'created',
    tenant_id: tenantId,
    tenant_name: tenant_name.trim(),
    api_key: apiKey,
    graph_directory: `tenant-${tenantId}`,
    note: 'Save this API key — it will not be shown again.',
  });
});

// POST /api/ingest/chatgpt — Import ChatGPT conversation history
app.post('/api/ingest/chatgpt', apiAuth, async (req, res) => {
  const startTime = Date.now();

  // Parse input
  let conversations;
  try {
    const input = req.body.conversations || req.body.raw;
    if (!input) {
      return res.status(400).json({ error: 'Missing "conversations" array or "raw" JSON string' });
    }
    conversations = parseChatGPTExport(input);
  } catch (err) {
    return res.status(400).json({ error: 'Failed to parse input: ' + err.message });
  }

  if (conversations.length === 0) {
    return res.status(400).json({ error: 'No conversations with user messages found' });
  }

  // Stream NDJSON progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');

  const BATCH_SIZE = 10;
  const batches = [];
  for (let i = 0; i < conversations.length; i += BATCH_SIZE) {
    batches.push(conversations.slice(i, i + BATCH_SIZE));
  }

  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  let observationsAdded = 0;
  let conversationsProcessed = 0;

  sendEvent({
    type: 'started',
    total_conversations: conversations.length,
    total_batches: batches.length,
  });

  const client = new Anthropic();
  const primaryUserName = getPrimaryUserName(req.graphDir);

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];

    try {
      const prompt = buildIngestPrompt(batch, primaryUserName);
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      });
      const rawResponse = message.content[0].text;
      const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(cleaned);

      // Build v2 entities from Claude's extraction
      const v2Entities = [];
      for (const extracted of (parsed.entities || [])) {
        const entityType = extracted.entity_type;
        if (!entityType || !['person', 'business'].includes(entityType)) continue;

        const displayName = entityType === 'person'
          ? (extracted.name?.full || '')
          : (extracted.name?.common || extracted.name?.legal || '');
        if (!displayName) continue;

        const now = new Date().toISOString();

        // Build observations from extracted data
        const observations = (extracted.observations || []).map(obs => {
          const convIdx = typeof obs.conversation_index === 'number' ? obs.conversation_index : 0;
          const conv = batch[convIdx] || batch[0];
          return {
            observation: (obs.text || '').trim(),
            observed_at: conv.createTime,
            source: 'chatgpt_import',
            confidence: 0.6,
            confidence_label: 'MODERATE',
            facts_layer: 'L2_GROUP',
            layer_number: 2,
            observed_by: req.agentId,
          };
        }).filter(o => o.observation);

        // Build attributes
        const attributes = [];
        if (extracted.attributes && typeof extracted.attributes === 'object') {
          let attrSeq = 1;
          for (const [key, value] of Object.entries(extracted.attributes)) {
            const val = Array.isArray(value) ? value.join(', ') : String(value);
            if (!val) continue;
            attributes.push({
              attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
              key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
              time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
              source_attribution: { facts_layer: 2, layer_label: 'group' },
            });
          }
        }

        // Build relationships
        const relationships = [];
        if (Array.isArray(extracted.relationships)) {
          let relSeq = 1;
          for (const rel of extracted.relationships) {
            relationships.push({
              relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
              name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
              sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
            });
          }
        }

        const v2Entity = {
          schema_version: '2.0',
          schema_type: 'context_architecture_entity',
          extraction_metadata: {
            extracted_at: now,
            updated_at: now,
            source_description: 'chatgpt_import',
            extraction_model: 'claude-sonnet-4-5-20250929',
            extraction_confidence: 0.6,
            schema_version: '2.0',
          },
          entity: {
            entity_type: entityType,
            name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
            summary: extracted.summary
              ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
              : { value: '', confidence: 0, facts_layer: 2 },
          },
          attributes,
          relationships,
          values: [],
          key_facts: [],
          constraints: [],
          observations,
          provenance_chain: {
            created_at: now,
            created_by: req.agentId,
            source_documents: [{ source: 'chatgpt_import', ingested_at: now }],
            merge_history: [],
          },
        };
        if (extracted.relationship_dimensions) {
          // Compute visual_tier from strength
          if (typeof extracted.relationship_dimensions.strength === 'number') {
            extracted.relationship_dimensions.visual_tier = computeVisualTier(extracted.relationship_dimensions.strength);
          }
          v2Entity.relationship_dimensions = extracted.relationship_dimensions;
          // Compute wiki_page and wiki_section
          var wp = computeWikiPage(extracted.relationship_dimensions);
          v2Entity.wiki_page = wp;
          v2Entity.wiki_section = computeWikiSection(extracted.relationship_dimensions, wp);
        }
        if (extracted.descriptor) v2Entity.descriptor = extracted.descriptor;
        if (extracted.org_dimensions) {
          v2Entity.org_dimensions = extracted.org_dimensions;
          // Add org_category attribute for sidebar compatibility
          if (extracted.org_dimensions.org_category) {
            v2Entity.attributes = v2Entity.attributes || [];
            v2Entity.attributes.push({
              attribute_id: 'ATTR-ORG-CAT',
              key: 'org_category', value: extracted.org_dimensions.org_category,
              confidence: 0.8, confidence_label: 'HIGH',
              time_decay: { stability: 'stable', captured_date: new Date().toISOString().slice(0, 10) },
              source_attribution: { facts_layer: 2, layer_label: 'group' },
            });
          }
        }
        v2Entities.push(v2Entity);
      }

      // Ingest via unified pipeline
      const result = await ingestPipeline(v2Entities, req.graphDir, req.agentId, {
        source: 'chatgpt_import',
        truthLevel: 'INFERRED',
      });

      entitiesCreated += result.created;
      entitiesUpdated += result.updated;
      observationsAdded += result.observationsAdded;

      conversationsProcessed += batch.length;
      sendEvent({
        type: 'progress',
        batch: bi + 1,
        total_batches: batches.length,
        conversations_processed: conversationsProcessed,
        total_conversations: conversations.length,
        entities_created: entitiesCreated,
        entities_updated: entitiesUpdated,
        observations_added: observationsAdded,
      });

    } catch (err) {
      conversationsProcessed += batch.length;
      sendEvent({
        type: 'batch_error',
        batch: bi + 1,
        error: err.message,
        conversations_processed: conversationsProcessed,
      });
    }
  }

  // Final summary
  sendEvent({
    type: 'complete',
    summary: {
      entities_created: entitiesCreated,
      entities_updated: entitiesUpdated,
      observations_added: observationsAdded,
      conversations_processed: conversationsProcessed,
      processing_time_seconds: Math.round((Date.now() - startTime) / 10) / 100,
    },
  });
  res.end();
});

// POST /api/ingest/files — Upload files for entity extraction
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 20, fileSize: 50 * 1024 * 1024 } });
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json']);

app.post('/api/ingest/files', apiAuth, upload.array('files', 20), async (req, res) => {
  const previewMode = req.query.preview === 'true';
  const files = req.files;
  if (files) {
    for (const f of files) {
      console.log('INGEST_DEBUG: file received:', f.originalname, f.mimetype, f.size, previewMode ? '(PREVIEW)' : '');
    }
  }
  if (!files || files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded. Send files via multipart field "files".' });
  }

  // Resolve primary user name for extraction prompts
  const primaryUserName = getPrimaryUserName(req.graphDir);

  // Validate extensions
  for (const file of files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: `Unsupported file type: ${ext}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}` });
    }
  }

  // Stream NDJSON progress
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');

  sendEvent({ type: 'started', total_files: files.length });

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalObservations = 0;
  const allPreviewEntities = [];
  const client = new Anthropic();

  for (let fi = 0; fi < files.length; fi++) {
    const file = files[fi];
    const filename = file.originalname;

    try {
      // JSON files: detect ChatGPT conversations format, otherwise treat as raw text
      if (path.extname(filename).toLowerCase() === '.json') {
        const raw = file.buffer.toString('utf-8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = null; }

        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].mapping && parsed[0].title !== undefined) {
          // ChatGPT conversations.json format
          const conversations = parseChatGPTExport(parsed);
          if (conversations.length > 0) {
            const BATCH_SIZE = 5;
            let created = 0, updated = 0, obsAdded = 0;
            for (let b = 0; b < conversations.length; b += BATCH_SIZE) {
              const batch = conversations.slice(b, b + BATCH_SIZE);
              const prompt = buildIngestPrompt(batch, primaryUserName);
              const message = await client.messages.create({
                model: 'claude-sonnet-4-5-20250929',
                max_tokens: 16384,
                messages: [{ role: 'user', content: prompt }],
              });
              const rawResp = message.content[0].text;
              const cleaned = rawResp.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
              const batchParsed = JSON.parse(cleaned);
              const rawEntities = (batchParsed.entities || []).filter(e => e && ['person', 'business', 'institution'].includes(e.entity_type));
              // Convert raw LLM output to v2 entity format
              const now = new Date().toISOString();
              const v2Batch = rawEntities.map(ext => {
                const eType = ext.entity_type === 'organization' ? 'business' : ext.entity_type;
                const v2 = {
                  schema_version: '2.0', schema_type: 'context_architecture_entity',
                  extraction_metadata: { extracted_at: now, updated_at: now, source_description: filename, extraction_model: 'claude-sonnet-4-5-20250929', extraction_confidence: 0.6, schema_version: '2.0' },
                  entity: { entity_type: eType, name: { ...ext.name, confidence: 0.6, facts_layer: 2 }, summary: ext.summary ? { value: ext.summary, confidence: 0.6, facts_layer: 2 } : { value: '', confidence: 0, facts_layer: 2 } },
                  attributes: [], relationships: [], values: [], key_facts: [], constraints: [],
                  observations: (ext.observations || []).map(o => ({ observation: (o.text || '').trim(), observed_at: now, source: filename, confidence: 0.6, confidence_label: 'MODERATE', facts_layer: 'L2_GROUP', layer_number: 2, observed_by: req.agentId, truth_level: 'INFERRED' })).filter(o => o.observation),
                  provenance_chain: { created_at: now, created_by: req.agentId, source_documents: [{ source: filename, ingested_at: now }], merge_history: [] },
                };
                if (ext.attributes && typeof ext.attributes === 'object') {
                  let seq = 1;
                  for (const [k, val] of Object.entries(ext.attributes)) {
                    const sv = Array.isArray(val) ? val.join(', ') : String(val);
                    if (sv) v2.attributes.push({ attribute_id: 'ATTR-' + String(seq++).padStart(3, '0'), key: k, value: sv, confidence: 0.6, confidence_label: 'MODERATE', time_decay: { stability: 'stable', captured_date: now.slice(0, 10) }, source_attribution: { facts_layer: 2, layer_label: 'group' } });
                  }
                }
                if (Array.isArray(ext.relationships)) {
                  let seq = 1;
                  for (const r of ext.relationships) v2.relationships.push({ relationship_id: 'REL-' + String(seq++).padStart(3, '0'), name: r.name || '', relationship_type: r.relationship || '', context: r.context || '', sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE' });
                }
                if (ext.relationship_dimensions) {
                  if (!ext.relationship_dimensions.visual_tier && typeof ext.relationship_dimensions.strength === 'number') ext.relationship_dimensions.visual_tier = computeVisualTier(ext.relationship_dimensions.strength);
                  v2.relationship_dimensions = ext.relationship_dimensions;
                }
                if (ext.descriptor) v2.descriptor = ext.descriptor;
                if (ext.org_dimensions) v2.org_dimensions = ext.org_dimensions;
                return v2;
              });
              if (v2Batch.length > 0) {
                const r = await ingestPipeline(v2Batch, req.graphDir, req.agentId, { source: filename, truthLevel: 'INFERRED' });
                created += r.created; updated += r.updated; obsAdded += r.observationsAdded;
              }
            }
            sendEvent({ type: 'file_progress', file: filename, file_index: fi + 1, total_files: files.length, entities_created: created, entities_updated: updated, observations_added: obsAdded });
            totalCreated += created; totalUpdated += updated; totalObservations += obsAdded;
            continue;
          }
        }
        // Not ChatGPT format — fall through to generic text extraction
      }

      const { text, metadata } = await normalizeFileToText(file.buffer, filename);

      let result;
      let pendingEntities = [];
      let pendingSource = filename;
      let pendingTruth = 'INFERRED';

      if (metadata.isContactList && metadata.rows) {
        // Direct mapping — no LLM call
        pendingEntities = mapContactRows(metadata.rows, filename, req.agentId);
        pendingSource = filename;
        pendingTruth = 'STRONG';

      } else if (metadata.isLinkedIn) {
        // LinkedIn extraction via Claude
        const prompt = buildLinkedInPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        const personEntity = linkedInResponseToEntity(parsed, filename, req.agentId);
        const personName = parsed.name?.full || '';
        const orgEntities = linkedInExperienceToOrgs(parsed, personName, filename, req.agentId);
        pendingEntities = [personEntity, ...orgEntities];

      } else if (metadata.isProfile) {
        // Profile mode — deep structured extraction
        console.log('INGEST_DEBUG: profile mode for', filename, '— text length:', text.length);
        const prompt = buildProfilePrompt(text, filename, primaryUserName);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        console.log('INGEST_DEBUG: profile response length:', rawResponse.length);
        const parsed = safeParseExtraction(rawResponse, 'profile');
        const profileEntities = parsed.entities || [];
        console.log('INGEST_DEBUG: profile extracted', profileEntities.length, 'entities');

        const now = new Date().toISOString();
        pendingEntities = profileEntities.map(function(extracted) {
          let entityType = extracted.entity_type;
          if (entityType === 'organization') entityType = 'business';
          if (!entityType || !['person', 'business', 'institution'].includes(entityType)) return null;

          // Validate relationships: remove self-refs and dedup
          const entityFullName = extracted.name?.full || extracted.name?.common || '';
          const entityPreferred = extracted.name?.preferred || '';
          const entityAliases = extracted.name?.aliases || [];
          const validatedRels = validateRelationships(
            extracted.relationships || [], entityFullName, entityPreferred, entityAliases
          );

          const observations = (extracted.observations || []).map(function(obs) {
            return {
              observation: (obs.text || '').trim(),
              observed_at: now,
              source: 'file_import:' + filename,
              confidence: 0.8,
              confidence_label: 'HIGH',
              facts_layer: 'L2_GROUP',
              layer_number: 2,
              observed_by: req.agentId,
            };
          }).filter(function(o) { return o.observation; });

          var attributes = [];
          if (extracted.attributes && typeof extracted.attributes === 'object') {
            var attrSeq = 1;
            for (var _key in extracted.attributes) {
              if (!extracted.attributes.hasOwnProperty(_key)) continue;
              var val = extracted.attributes[_key];
              val = Array.isArray(val) ? val.join(', ') : String(val);
              if (!val) continue;
              attributes.push({
                attribute_id: 'ATTR-' + String(attrSeq++).padStart(3, '0'),
                key: _key, value: val, confidence: 0.8, confidence_label: 'HIGH',
                time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
                source_attribution: { facts_layer: 2, layer_label: 'group' },
              });
            }
          }

          var relationships = [];
          var relSeq = 1;
          for (var ri = 0; ri < validatedRels.length; ri++) {
            var rel = validatedRels[ri];
            relationships.push({
              relationship_id: 'REL-' + String(relSeq++).padStart(3, '0'),
              name: rel.name || '', relationship_type: rel.relationship_type || rel.relationship || '',
              context: rel.context || '',
              sentiment: 'neutral', confidence: 0.8, confidence_label: 'HIGH',
            });
          }

          // Build structured_attributes with interface marker
          var structuredAttrs = extracted.structured_attributes || {};
          structuredAttrs.interface = 'profile';

          // Extract source date from profile metadata
          var sourceDate = null;
          if (structuredAttrs.profile_metadata) {
            sourceDate = structuredAttrs.profile_metadata.last_updated
              || structuredAttrs.profile_metadata.created_date
              || null;
          }

          var v2Entity = {
            schema_version: '2.0',
            schema_type: 'context_architecture_entity',
            extraction_metadata: {
              extracted_at: now, updated_at: now,
              source_description: 'file_import:' + filename,
              extraction_model: 'claude-sonnet-4-5-20250929',
              extraction_confidence: 0.8, schema_version: '2.0',
              extraction_mode: 'profile',
            },
            entity: {
              entity_type: entityType,
              name: Object.assign({}, extracted.name, { confidence: 0.8, facts_layer: 2 }),
              summary: extracted.summary
                ? { value: extracted.summary, confidence: 0.8, facts_layer: 2 }
                : { value: '', confidence: 0, facts_layer: 2 },
            },
            attributes: attributes, relationships: relationships,
            values: [], key_facts: [], constraints: [],
            observations: observations,
            structured_attributes: structuredAttrs,
            provenance_chain: {
              created_at: now, created_by: req.agentId,
              source_documents: [{ source: 'file_import:' + filename, ingested_at: now }],
              merge_history: [],
            },
          };

          if (sourceDate) {
            v2Entity.extraction_metadata.source_date = sourceDate;
          }

          if (extracted.relationship_dimensions) {
            if (typeof extracted.relationship_dimensions.strength === 'number') {
              extracted.relationship_dimensions.visual_tier = computeVisualTier(extracted.relationship_dimensions.strength);
            }
            v2Entity.relationship_dimensions = extracted.relationship_dimensions;
            var wp = computeWikiPage(extracted.relationship_dimensions);
            v2Entity.wiki_page = wp;
            v2Entity.wiki_section = computeWikiSection(extracted.relationship_dimensions, wp);
          }
          if (extracted.descriptor) v2Entity.descriptor = extracted.descriptor;

          return v2Entity;
        }).filter(Boolean);

        pendingSource = filename;
        pendingTruth = 'STRONG';
        console.log('INGEST_DEBUG: profile v2Entities:', pendingEntities.length);

      } else {
        // Generic text extraction via Claude (with chunking for large files)
        const chunks = chunkText(text);
        console.log('INGEST_DEBUG: generic text path for', filename, '— text length:', text.length, '— chunks:', chunks.length);

        const allExtracted = [];
        for (let ci = 0; ci < chunks.length; ci++) {
          const prompt = buildGenericTextPrompt(chunks[ci], filename, ci + 1, chunks.length, primaryUserName);
          console.log('INGEST_DEBUG: sending chunk', ci + 1, 'of', chunks.length, '— chunk length:', chunks[ci].length);
          const message = await client.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 16384,
            messages: [{ role: 'user', content: prompt }],
          });
          const rawResponse = message.content[0].text;
          console.log('INGEST_DEBUG: chunk', ci + 1, 'response length:', rawResponse.length);
          const parsed = safeParseExtraction(rawResponse, 'chunk ' + (ci + 1));
          const chunkEntities = parsed.entities || [];
          console.log('INGEST_DEBUG: chunk', ci + 1, 'extracted', chunkEntities.length, 'entities');
          allExtracted.push(...chunkEntities);
        }
        console.log('INGEST_DEBUG: total extracted across all chunks:', allExtracted.length);

        const now = new Date().toISOString();
        const v2Entities = allExtracted.map(extracted => {
          let entityType = extracted.entity_type;
          if (entityType === 'organization') entityType = 'business';
          if (!entityType || !['person', 'business', 'institution'].includes(entityType)) {
            console.log('INGEST_DEBUG: skipping entity with unknown type:', entityType, extracted.name);
            return null;
          }

          const observations = (extracted.observations || []).map(obs => ({
            observation: (obs.text || '').trim(),
            observed_at: now,
            source: `file_import:${filename}`,
            confidence: 0.6,
            confidence_label: 'MODERATE',
            facts_layer: 'L2_GROUP',
            layer_number: 2,
            observed_by: req.agentId,
          })).filter(o => o.observation);

          const attributes = [];
          if (extracted.attributes && typeof extracted.attributes === 'object') {
            let attrSeq = 1;
            for (const [key, value] of Object.entries(extracted.attributes)) {
              const val = Array.isArray(value) ? value.join(', ') : String(value);
              if (!val) continue;
              attributes.push({
                attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
                key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
                time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
                source_attribution: { facts_layer: 2, layer_label: 'group' },
              });
            }
          }

          const relationships = [];
          if (Array.isArray(extracted.relationships)) {
            let relSeq = 1;
            for (const rel of extracted.relationships) {
              relationships.push({
                relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
                name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
                sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
              });
            }
          }

          const v2Entity = {
            schema_version: '2.0',
            schema_type: 'context_architecture_entity',
            extraction_metadata: {
              extracted_at: now, updated_at: now,
              source_description: `file_import:${filename}`,
              extraction_model: 'claude-sonnet-4-5-20250929',
              extraction_confidence: 0.6, schema_version: '2.0',
            },
            entity: {
              entity_type: entityType,
              name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
              summary: extracted.summary
                ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
                : { value: '', confidence: 0, facts_layer: 2 },
            },
            attributes, relationships,
            values: [], key_facts: [], constraints: [],
            observations,
            provenance_chain: {
              created_at: now, created_by: req.agentId,
              source_documents: [{ source: `file_import:${filename}`, ingested_at: now }],
              merge_history: [],
            },
          };
          if (extracted.relationship_dimensions) {
            if (typeof extracted.relationship_dimensions.strength === 'number') {
              extracted.relationship_dimensions.visual_tier = computeVisualTier(extracted.relationship_dimensions.strength);
            }
            v2Entity.relationship_dimensions = extracted.relationship_dimensions;
            // Compute wiki_page and wiki_section
            var wp = computeWikiPage(extracted.relationship_dimensions);
            v2Entity.wiki_page = wp;
            v2Entity.wiki_section = computeWikiSection(extracted.relationship_dimensions, wp);
          }
          if (extracted.descriptor) v2Entity.descriptor = extracted.descriptor;
          if (extracted.org_dimensions) {
            v2Entity.org_dimensions = extracted.org_dimensions;
            // Add org_category attribute for sidebar compatibility
            if (extracted.org_dimensions.org_category) {
              v2Entity.attributes = v2Entity.attributes || [];
              v2Entity.attributes.push({
                attribute_id: 'ATTR-ORG-CAT',
                key: 'org_category', value: extracted.org_dimensions.org_category,
                confidence: 0.8, confidence_label: 'HIGH',
                time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
                source_attribution: { facts_layer: 2, layer_label: 'group' },
              });
            }
          }
          return v2Entity;
        }).filter(Boolean);

        console.log('INGEST_DEBUG: v2Entities after type filter:', v2Entities.length);

        pendingEntities = v2Entities;
      }

      // Preview mode: return entities for user review instead of saving
      if (previewMode) {
        const previewList = pendingEntities.map(e => {
          const ent = e.entity || {};
          const type = ent.entity_type || '';
          return {
            entity_type: type,
            name: type === 'person' ? (ent.name?.full || '') : (ent.name?.common || ent.name?.legal || ''),
            summary: ent.summary?.value || '',
            attribute_count: (e.attributes || []).length,
            relationship_count: (e.relationships || []).length,
            observation_count: (e.observations || []).length,
          };
        });
        allPreviewEntities.push(...pendingEntities);
        sendEvent({
          type: 'file_preview',
          file: filename,
          file_index: fi + 1,
          total_files: files.length,
          entities: previewList,
          full_entities: pendingEntities,
        });
      } else {
        result = await ingestPipeline(pendingEntities, req.graphDir, req.agentId, {
          source: pendingSource,
          truthLevel: pendingTruth,
        });

        totalCreated += result.created;
        totalUpdated += result.updated;
        totalObservations += result.observationsAdded;

        const progressEvent = {
          type: 'file_progress',
          file: filename,
          file_index: fi + 1,
          total_files: files.length,
          entities_created: result.created,
          entities_updated: result.updated,
          observations_added: result.observationsAdded,
        };
        if (result.created === 0 && result.updated === 0) {
          progressEvent.warning = 'No named entities found in this file. The file may not contain recognizable person or business names.';
          console.log('INGEST_DEBUG: 0 entities extracted from', filename);
        }
        sendEvent(progressEvent);
      }

    } catch (err) {
      console.error('INGEST_DEBUG: extraction error for', filename, err.message);
      sendEvent({
        type: 'file_error',
        file: filename,
        file_index: fi + 1,
        error: err.message,
      });
    }
  }

  if (previewMode) {
    sendEvent({
      type: 'preview_complete',
      total_entities: allPreviewEntities.length,
    });
  } else {
    sendEvent({
      type: 'complete',
      summary: {
        files_processed: files.length,
        entities_created: totalCreated,
        entities_updated: totalUpdated,
        observations_added: totalObservations,
      },
    });
  }
  res.end();
});

// POST /api/ingest/confirm — Save user-approved entities from preview
app.post('/api/ingest/confirm', apiAuth, express.json({ limit: '10mb' }), async (req, res) => {
  const { entities, source } = req.body;
  if (!Array.isArray(entities) || entities.length === 0) {
    return res.status(400).json({ error: 'No entities provided' });
  }

  try {
    const result = await ingestPipeline(entities, req.graphDir, req.agentId, {
      source: source || 'confirmed_upload',
      truthLevel: 'INFERRED',
    });
    console.log(`[ingest] Confirmed ${entities.length} entities: ${result.created} created, ${result.updated} updated`);
    res.json(result);
  } catch (err) {
    console.error('[ingest] Confirm error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Google Drive integration ---

// Helper: get tenant's Drive tokens from tenants.json
function getDriveTokens(tenantId) {
  const tenants = loadTenants();
  const tenant = tenants[tenantId];
  if (!tenant) return null;
  return { accessToken: tenant.access_token, refreshToken: tenant.refresh_token, tenant, tenants };
}

function saveDriveToken(tenantId, newAccessToken) {
  const tenants = loadTenants();
  if (tenants[tenantId]) {
    tenants[tenantId].access_token = newAccessToken;
    saveTenants(tenants);
  }
}

// GET /api/drive/files?folderId=X&q=searchterm — List or search Drive files
app.get('/api/drive/files', apiAuth, async (req, res) => {
  const tokens = getDriveTokens(req.tenantId);
  if (!tokens || !tokens.accessToken) {
    return res.status(401).json({ error: 'No Google Drive access. Please sign in with Google.' });
  }

  const folderId = req.query.folderId || null;
  const searchQuery = req.query.q || null;

  try {
    let files;
    if (searchQuery) {
      const r = await drive.withTokenRefresh(
        (token) => drive.searchFiles(token, searchQuery),
        tokens.accessToken,
        tokens.refreshToken,
      );
      files = r.result;
      if (r.newAccessToken) saveDriveToken(req.tenantId, r.newAccessToken);
      res.json({ files, search: searchQuery });
    } else {
      const r = await drive.withTokenRefresh(
        (token) => drive.listFiles(token, folderId),
        tokens.accessToken,
        tokens.refreshToken,
      );
      files = r.result;
      if (r.newAccessToken) saveDriveToken(req.tenantId, r.newAccessToken);
      res.json({ files, folderId: folderId || 'root' });
    }
  } catch (err) {
    console.error('Drive list error:', err.message);
    res.status(500).json({ error: 'Failed to list Drive files: ' + err.message });
  }
});

// POST /api/drive/ingest — Download files from Drive and ingest
app.post('/api/drive/ingest', apiAuth, async (req, res) => {
  console.log('INGEST_DEBUG: drive ingest request, fileIds:', req.body?.fileIds);
  const { fileIds } = req.body;
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return res.status(400).json({ error: 'Missing fileIds array' });
  }

  const tokens = getDriveTokens(req.tenantId);
  if (!tokens || !tokens.accessToken) {
    return res.status(401).json({ error: 'No Google Drive access. Please sign in with Google.' });
  }

  let currentToken = tokens.accessToken;
  const primaryUserName = getPrimaryUserName(req.graphDir);

  // Stream NDJSON
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();

  const sendEvent = (event) => res.write(JSON.stringify(event) + '\n');
  sendEvent({ type: 'started', total_files: fileIds.length });

  let totalCreated = 0;
  let totalUpdated = 0;
  let totalObservations = 0;
  const client = new Anthropic();

  for (let fi = 0; fi < fileIds.length; fi++) {
    const fileId = fileIds[fi];
    let filename = fileId;

    try {
      // Download from Drive (with token refresh)
      sendEvent({ type: 'file_downloading', file_index: fi + 1, file_id: fileId });

      const { result: downloaded, newAccessToken } = await drive.withTokenRefresh(
        (token) => drive.downloadFile(token, fileId),
        currentToken,
        tokens.refreshToken,
      );
      if (newAccessToken) {
        currentToken = newAccessToken;
        saveDriveToken(req.tenantId, newAccessToken);
      }

      const { buffer, filename: dlFilename } = downloaded;
      filename = dlFilename;

      // Run through the same parser pipeline as file upload
      const { text, metadata } = await normalizeFileToText(buffer, filename);

      let result;

      if (metadata.isContactList && metadata.rows) {
        const entities = mapContactRows(metadata.rows, filename, req.agentId);
        result = await ingestPipeline(entities, req.graphDir, req.agentId, {
          source: `drive:${filename}`,
          truthLevel: 'STRONG',
        });
      } else if (metadata.isLinkedIn) {
        const prompt = buildLinkedInPrompt(text, filename);
        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        const rawResponse = message.content[0].text;
        const cleaned = rawResponse.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const parsed = JSON.parse(cleaned);
        const entity = linkedInResponseToEntity(parsed, filename, req.agentId);
        const personName = parsed.name?.full || '';
        const orgEntities = linkedInExperienceToOrgs(parsed, personName, filename, req.agentId);
        result = await ingestPipeline([entity, ...orgEntities], req.graphDir, req.agentId, {
          source: `drive:${filename}`,
          truthLevel: 'INFERRED',
        });
      } else {
        const chunks = chunkText(text);
        console.log('INGEST_DEBUG: drive generic text path for', filename, '— text length:', text.length, '— chunks:', chunks.length);

        const allExtracted = [];
        for (let ci = 0; ci < chunks.length; ci++) {
          const prompt = buildGenericTextPrompt(chunks[ci], filename, ci + 1, chunks.length, primaryUserName);
          console.log('INGEST_DEBUG: drive sending chunk', ci + 1, 'of', chunks.length);
          const message = await client.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 16384,
            messages: [{ role: 'user', content: prompt }],
          });
          const rawResponse = message.content[0].text;
          console.log('INGEST_DEBUG: drive chunk', ci + 1, 'response length:', rawResponse.length);
          const parsed = safeParseExtraction(rawResponse, 'drive chunk ' + (ci + 1));
          const chunkEntities = parsed.entities || [];
          console.log('INGEST_DEBUG: drive chunk', ci + 1, 'extracted', chunkEntities.length, 'entities');
          allExtracted.push(...chunkEntities);
        }
        console.log('INGEST_DEBUG: drive total extracted across all chunks:', allExtracted.length);

        const now = new Date().toISOString();
        const v2Entities = allExtracted.map(extracted => {
          let entityType = extracted.entity_type;
          if (entityType === 'organization') entityType = 'business';
          if (!entityType || !['person', 'business', 'institution'].includes(entityType)) {
            console.log('INGEST_DEBUG: drive skipping entity with unknown type:', entityType, extracted.name);
            return null;
          }

          const observations = (extracted.observations || []).map(obs => ({
            observation: (obs.text || '').trim(),
            observed_at: now,
            source: `drive_import:${filename}`,
            confidence: 0.6,
            confidence_label: 'MODERATE',
            facts_layer: 'L2_GROUP',
            layer_number: 2,
            observed_by: req.agentId,
          })).filter(o => o.observation);

          const attributes = [];
          if (extracted.attributes && typeof extracted.attributes === 'object') {
            let attrSeq = 1;
            for (const [key, value] of Object.entries(extracted.attributes)) {
              const val = Array.isArray(value) ? value.join(', ') : String(value);
              if (!val) continue;
              attributes.push({
                attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
                key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
                time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
                source_attribution: { facts_layer: 2, layer_label: 'group' },
              });
            }
          }

          const relationships = [];
          if (Array.isArray(extracted.relationships)) {
            let relSeq = 1;
            for (const rel of extracted.relationships) {
              relationships.push({
                relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
                name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
                sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
              });
            }
          }

          return {
            schema_version: '2.0',
            schema_type: 'context_architecture_entity',
            extraction_metadata: {
              extracted_at: now, updated_at: now,
              source_description: `drive_import:${filename}`,
              extraction_model: 'claude-sonnet-4-5-20250929',
              extraction_confidence: 0.6, schema_version: '2.0',
            },
            entity: {
              entity_type: entityType,
              name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
              summary: extracted.summary
                ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
                : { value: '', confidence: 0, facts_layer: 2 },
            },
            attributes, relationships,
            values: [], key_facts: [], constraints: [],
            observations,
            provenance_chain: {
              created_at: now, created_by: req.agentId,
              source_documents: [{ source: `drive_import:${filename}`, ingested_at: now }],
              merge_history: [],
            },
          };
        }).filter(Boolean);

        console.log('INGEST_DEBUG: drive v2Entities after type filter:', v2Entities.length);

        result = await ingestPipeline(v2Entities, req.graphDir, req.agentId, {
          source: `drive:${filename}`,
          truthLevel: 'INFERRED',
        });
      }

      totalCreated += result.created;
      totalUpdated += result.updated;
      totalObservations += result.observationsAdded;

      const progressEvent = {
        type: 'file_progress',
        file: filename,
        file_index: fi + 1,
        total_files: fileIds.length,
        entities_created: result.created,
        entities_updated: result.updated,
        observations_added: result.observationsAdded,
      };
      if (result.created === 0 && result.updated === 0) {
        progressEvent.warning = 'No named entities found in this file. The file may not contain recognizable person or business names.';
        console.log('INGEST_DEBUG: 0 entities extracted from', filename);
      }
      sendEvent(progressEvent);

    } catch (err) {
      console.error('INGEST_DEBUG: drive extraction error for', filename, err.message);
      sendEvent({
        type: 'file_error',
        file: filename,
        file_index: fi + 1,
        error: err.message,
      });
    }
  }

  sendEvent({
    type: 'complete',
    summary: {
      files_processed: fileIds.length,
      entities_created: totalCreated,
      entities_updated: totalUpdated,
      observations_added: totalObservations,
    },
  });
  res.end();
});

// GET /api/entity/:id — Full entity JSON
app.get('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });
  res.json(entity);
});

// GET /api/entity/:id/dossier — Org dossier with connected roles, credentials, skills
app.get('/api/entity/:id/dossier', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const e = entity.entity || {};
  const type = e.entity_type || '';
  if (type !== 'organization' && type !== 'business' && type !== 'institution') {
    return res.status(400).json({ error: 'Dossier only available for organization/business/institution entities' });
  }

  const orgName = (e.name?.common || e.name?.legal || '').toLowerCase();
  const targetId = req.params.id;

  // Find the primary person entity for this tenant (the one with most connected_objects)
  const allEntities = listEntities(req.graphDir);
  let personData = null;
  let maxConnected = 0;
  for (const { data } of allEntities) {
    if ((data.entity || {}).entity_type === 'person') {
      const count = (data.connected_objects || []).length;
      if (count > maxConnected) { maxConnected = count; personData = data; }
    }
  }
  const connectedObjects = personData ? (personData.connected_objects || []) : [];

  // Collect role, credential, and skill entity IDs from person's connected_objects
  const roleRefs = connectedObjects.filter(c => c.entity_type === 'role');
  const credRefs = connectedObjects.filter(c => c.entity_type === 'credential');
  const skillRefs = connectedObjects.filter(c => c.entity_type === 'skill');

  // Read and filter roles that belong to this org
  const roles = [];
  for (const ref of roleRefs) {
    const roleEntity = readEntity(ref.entity_id, req.graphDir);
    if (!roleEntity) continue;
    const rd = roleEntity.role_data || {};
    if (rd.organization_id === targetId) {
      roles.push(roleEntity);
    } else if (orgName && (ref.label || '').toLowerCase().includes(orgName)) {
      roles.push(roleEntity);
    } else if (orgName && (rd.company || '').toLowerCase().includes(orgName)) {
      roles.push(roleEntity);
    }
  }

  // Read and filter credentials that belong to this org
  const credentials = [];
  for (const ref of credRefs) {
    const credEntity = readEntity(ref.entity_id, req.graphDir);
    if (!credEntity) continue;
    const cd = credEntity.credential_data || {};
    if (cd.organization_id === targetId) {
      credentials.push(credEntity);
    } else if (orgName && (ref.label || '').toLowerCase().includes(orgName)) {
      credentials.push(credEntity);
    } else if (orgName && (cd.institution || '').toLowerCase().includes(orgName)) {
      credentials.push(credEntity);
    }
  }

  // Build text corpus from role descriptions + org summary for skill filtering
  const roleText = roles.map(r => (r.role_data?.description || '').toLowerCase()).join(' ');
  const orgText = (entity.entity?.summary?.value || '').toLowerCase();
  const corpus = roleText + ' ' + orgText;

  // Filter skills to those mentioned in role descriptions or org summary
  const skills = [];
  for (const ref of skillRefs) {
    const skillEntity = readEntity(ref.entity_id, req.graphDir);
    if (!skillEntity) continue;
    const sn = (skillEntity.skill_data?.name || '').toLowerCase();
    if (sn && corpus.includes(sn)) {
      skills.push(skillEntity);
    }
  }

  // Sort roles by start_date descending
  roles.sort((a, b) => {
    const aDate = (a.role_data || {}).start_date || '';
    const bDate = (b.role_data || {}).start_date || '';
    return bDate.localeCompare(aDate);
  });

  const industry = (entity.attributes || []).find(a => a.key === 'industry');

  res.json({
    entity: entity.entity || {},
    attributes: entity.attributes || [],
    observations: entity.observations || [],
    roles,
    credentials,
    skills,
    industry: industry ? industry.value : '',
    relationships: entity.relationships || [],
  });
});

// DELETE /api/entity/:id — Delete an entity and its connected objects
app.delete('/api/entity/:id', apiAuth, (req, res) => {
  const result = deleteEntity(req.params.id, req.graphDir);
  if (!result.deleted) return res.status(404).json({ error: 'Entity not found' });
  console.log(`[delete] Deleted ${req.params.id} + ${result.connected_deleted.length} connected objects`);
  res.json(result);
});

// POST /api/dedup-relationships — Retroactively deduplicate relationships across all entities
app.post('/api/dedup-relationships', apiAuth, (req, res) => {
  const { similarity } = require('./merge-engine');
  const allEntities = listEntities(req.graphDir);
  let totalDeduped = 0;
  const changes = [];

  for (const { filename, data } of allEntities) {
    const rels = data.relationships || [];
    if (rels.length < 2) continue;

    const deduped = [];
    for (const rel of rels) {
      const existing = deduped.find(r =>
        similarity(r.name || '', rel.name || '') > 0.85 &&
        normalizeRelationshipType(r.relationship_type) === normalizeRelationshipType(rel.relationship_type)
      );
      if (existing) {
        // Keep the version with more detail
        const existingDetail = (existing.context || '').length + (existing.relationship_type || '').length;
        const relDetail = (rel.context || '').length + (rel.relationship_type || '').length;
        if (relDetail > existingDetail || (rel.confidence || 0) > (existing.confidence || 0)) {
          const oldId = existing.relationship_id;
          Object.assign(existing, rel);
          existing.relationship_id = oldId;
        }
      } else {
        deduped.push({ ...rel });
      }
    }

    const removed = rels.length - deduped.length;
    if (removed > 0) {
      data.relationships = deduped;
      writeEntity(data.entity.entity_id, data, req.graphDir);
      totalDeduped += removed;
      const eName = data.entity.entity_type === 'person'
        ? (data.entity.name?.full || '')
        : (data.entity.name?.common || data.entity.name?.legal || '');
      changes.push({ entity_id: data.entity.entity_id, name: eName, removed });
    }
  }

  console.log(`[dedup] Removed ${totalDeduped} duplicate relationships across ${changes.length} entities`);
  res.json({ total_removed: totalDeduped, entities_affected: changes.length, changes });
});

// POST /api/entities/bulk-delete — Delete multiple entities at once
app.post('/api/entities/bulk-delete', apiAuth, (req, res) => {
  const ids = req.body.entity_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'entity_ids array is required' });
  }

  const results = [];
  let deleted = 0;
  let failed = 0;

  for (const id of ids) {
    const result = deleteEntity(id, req.graphDir);
    if (result.deleted) {
      deleted++;
      results.push({ entity_id: id, deleted: true, connected_deleted: result.connected_deleted.length });
    } else {
      failed++;
      results.push({ entity_id: id, deleted: false });
    }
  }

  console.log(`[bulk-delete] Deleted ${deleted}/${ids.length} entities (${failed} not found)`);
  res.json({ deleted, failed, total: ids.length, results });
});

// POST /api/recategorize — Re-process all person entities with relationship directionality
app.post('/api/recategorize', apiAuth, (req, res) => {
  const allEnts = listEntities(req.graphDir);

  // Find primary person entity (most connected objects)
  let primaryData = null;
  let maxConn = 0;
  for (const { data } of allEnts) {
    if ((data.entity || {}).entity_type === 'person') {
      const count = (data.connected_objects || []).length;
      if (count > maxConn) { maxConn = count; primaryData = data; }
    }
  }

  if (!primaryData) {
    return res.status(400).json({ error: 'No primary person entity found' });
  }

  const primaryId = primaryData.entity.entity_id;
  const primaryName = (primaryData.entity.name?.full || '').toLowerCase();

  // Build relationship map from primary entity's relationships
  const primaryRelMap = {};
  for (const rel of (primaryData.relationships || [])) {
    const rname = (rel.name || '').toLowerCase().trim();
    primaryRelMap[rname] = {
      type: (rel.relationship_type || '').toLowerCase(),
      context: (rel.context || '').toLowerCase(),
      strength: rel.strength || '',
      trust_level: rel.trust_level || '',
    };
    // Also strip parentheticals
    const stripped = rname.replace(/\s*\([^)]*\)/g, '').trim();
    if (stripped && stripped !== rname) primaryRelMap[stripped] = primaryRelMap[rname];
  }

  // Categorization function for a person entity
  // Build primary user's alias list for matching
  const primaryAliases = [primaryName];
  if (primaryData.entity.name?.preferred) primaryAliases.push(primaryData.entity.name.preferred.toLowerCase());
  for (const a of (primaryData.entity.name?.aliases || [])) { primaryAliases.push(a.toLowerCase()); }
  // Also add first name and first+last as aliases
  const pnParts = primaryName.split(/\s+/);
  if (pnParts.length >= 1) primaryAliases.push(pnParts[0]);
  if (pnParts.length >= 2) primaryAliases.push(pnParts[0] + ' ' + pnParts[pnParts.length - 1]);

  // Build spouse name list from primary entity's relationships (for in-law detection)
  const spouseNames = [];
  for (const rel of (primaryData.relationships || [])) {
    const rt = (rel.relationship_type || '').toLowerCase();
    if (rt === 'spouse' || rt === 'wife' || rt === 'husband' || rt === 'current spouse' || rt === 'ex-wife' || rt === 'ex-husband' || rt === 'co-parent') {
      const sn = (rel.name || '').toLowerCase().trim();
      if (sn) {
        spouseNames.push(sn);
        const snParts = sn.split(/\s+/);
        if (snParts.length >= 1) spouseNames.push(snParts[0]);
      }
    }
  }

  function categorizeEntity(data) {
    const e = data.entity || {};
    const eid = e.entity_id;
    if (eid === primaryId) return null; // skip primary

    const name = (e.name?.full || '').toLowerCase().trim();
    const summary = (e.summary?.value || '').toLowerCase();

    // --- Build TARGETED text layers (not a single noisy blob) ---

    // Layer 1: relEntry from CJ's own relationships (MOST reliable — describes CJ→person)
    let relEntry = primaryRelMap[name] || null;
    if (!relEntry) {
      const stripped = name.replace(/\s*\([^)]*\)/g, '').trim();
      if (stripped !== name) relEntry = primaryRelMap[stripped] || null;
    }
    if (!relEntry) {
      const np = name.split(/\s+/);
      if (np.length >= 2) {
        const nf = np[0], nl = np[np.length - 1];
        for (const rk of Object.keys(primaryRelMap)) {
          if (rk.indexOf(nf) !== -1 && rk.indexOf(nl) !== -1) { relEntry = primaryRelMap[rk]; break; }
        }
        if (!relEntry) {
          for (const rk of Object.keys(primaryRelMap)) {
            const rkp = rk.split(/\s+/);
            if (rkp.length >= 2 && name.indexOf(rkp[0]) !== -1 && name.indexOf(rkp[rkp.length - 1]) !== -1) {
              relEntry = primaryRelMap[rk]; break;
            }
          }
        }
      }
    }

    // Layer 2: Entity's own relationships that specifically mention the primary user
    let reverseRelText = '';
    for (const rel of (data.relationships || [])) {
      const rn = (rel.name || '').toLowerCase();
      let mentionsPrimary = false;
      for (const pa of primaryAliases) {
        if (pa && (rn.indexOf(pa) !== -1 || pa.indexOf(rn) !== -1)) { mentionsPrimary = true; break; }
      }
      if (!mentionsPrimary) {
        const rnp = rn.split(/\s+/);
        if (rnp.length >= 2 && primaryName.indexOf(rnp[0]) !== -1 && primaryName.indexOf(rnp[rnp.length - 1]) !== -1) {
          mentionsPrimary = true;
        }
      }
      if (mentionsPrimary) {
        reverseRelText += ' ' + (rel.relationship_type || '') + ' ' + (rel.context || '');
        if (!relEntry) {
          relEntry = { type: (rel.relationship_type || '').toLowerCase(), context: (rel.context || '').toLowerCase(), strength: '', trust_level: '' };
        }
      }
    }

    // Layer 3: Only attributes that explicitly describe relationship TO CJ
    // Exclude 'role' and 'relationship' — they often describe the person's role TO SOMEONE ELSE
    // (e.g., "spouse of Rodrique Fru", "mother of Diamond Loggins")
    let attrText = '';
    for (const attr of (data.attributes || [])) {
      const k = (attr.key || '').toLowerCase();
      if (k === 'relationship_to_cj') {
        attrText += ' ' + (attr.value || '');
      }
    }

    // --- TEXT TIERS ---
    // DIRECT: relEntry + reverse lookup + relationship attributes (HIGH confidence for family)
    const directText = [
      (relEntry ? (relEntry.type + ' ' + relEntry.context) : ''),
      reverseRelText,
      attrText,
    ].join(' ').toLowerCase();

    // PRIMARY: direct + summary (MEDIUM confidence — summary may describe OTHER people's families)
    const primaryText = (directText + ' ' + summary).toLowerCase();

    // BROAD: all attribute values + observations (LOW confidence — only for celebrity detection)
    const broadParts = [summary];
    for (const attr of (data.attributes || [])) {
      broadParts.push((attr.value || ''));
    }
    for (const obs of (data.observations || [])) {
      if (obs.observation) broadParts.push(obs.observation);
    }
    const broadText = broadParts.join(' ').toLowerCase();

    function hasAny(haystack, terms) {
      for (const t of terms) { if (haystack.indexOf(t) !== -1) return t; }
      return null;
    }
    function hasAnyWord(haystack, terms) {
      for (const t of terms) {
        const re = new RegExp('(?:^|\\b)' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\b|$)', 'i');
        if (re.test(haystack)) return t;
      }
      return null;
    }

    // Check for surrogate/figurative terms — these override family keywords
    const surrogateTerms = ['like a brother', 'like a sister', 'like family', 'surrogate',
      'father figure', 'mother figure', 'big brother figure', 'big sister figure',
      'brother figure', 'sister figure'];
    const isSurrogate = hasAny(directText, surrogateTerms) || hasAny(summary, surrogateTerms);

    // INNER CIRCLE — check FIRST (more specific multi-word terms beat substring false-positives)
    // e.g., "childhood friend" must match before "child" matches for family
    const innerTerms = ['best friend', 'close friend', 'closest friend', 'groomsman', 'bridesmaid',
      'loyalty anchor', 'accountability partner', 'ride or die', 'day one',
      'childhood friend', 'lifelong friend', 'like a brother', 'like a sister',
      'like family', 'brotherhood', 'super close', 'surrogate', 'father figure',
      'mother figure', 'big brother', 'big sister', 'ai assistant', 'collaborator',
      'co-founder', 's-tier', 'a-tier', 'mentee', 'mba homie', 'homie',
      'groomsman', 'trusted', 'accountability'];
    const it = hasAny(primaryText, innerTerms);
    if (it) return { hint: 'friends', rel: it, dist: relEntry ? '1' : '2' };
    if (relEntry) {
      if (relEntry.strength === 'close') return { hint: 'friends', rel: 'strength:close', dist: '1' };
      const tl = String(relEntry.trust_level || '');
      if (tl.indexOf('9') !== -1 || tl.indexOf('10') !== -1) return { hint: 'friends', rel: 'trust:' + tl, dist: '1' };
    }

    // FAMILY — skip if surrogate
    // CRITICAL: Must verify the family keyword is IN RELATION TO CJ, not someone else
    // Strategy: relEntry.type is CJ's DIRECT relationship label (trusted). Context text needs directionality check.
    if (!isSurrogate) {
      const familyTerms = ['spouse', 'wife', 'husband', 'ex-wife', 'ex-husband', 'ex-spouse', 'co-parent',
        'mother', 'father', 'parent', 'mom', 'dad', 'son', 'daughter', 'child',
        'brother', 'sister', 'sibling', 'half-brother', 'half-sister',
        'stepmother', 'stepfather', 'nephew', 'niece', 'uncle', 'aunt', 'cousin',
        'in-law', 'sister-in-law', 'brother-in-law', 'mother-in-law', 'father-in-law',
        'grandparent', 'grandmother', 'grandfather'];

      // Check relEntry.type first — this is CJ's direct relationship label, always trusted
      const relTypeText = relEntry ? (relEntry.type || '').toLowerCase() : '';
      const ftRelType = hasAnyWord(relTypeText, familyTerms);
      if (ftRelType) {
        return { hint: 'family', rel: ftRelType, dist: relEntry ? '1' : '2' };
      }

      // If relEntry.type exists and is NOT a family term, do NOT promote to family from context
      // e.g., "childhood neighbor" with context "same age as CJ's sister" — "sister" describes someone else
      if (!relEntry || !relTypeText) {
        // No relEntry — check directText with directionality guard
        const ft = hasAnyWord(directText, familyTerms);
        if (ft) {
          const ofPattern = new RegExp('(?:spouse|wife|husband|mother|father|sister|brother|daughter|son|parent|child|sibling|nephew|niece|uncle|aunt|cousin|grandmother|grandfather)\\s+of\\s+(\\w[\\w\\s]*)', 'gi');
          let isFamilyOfOther = false;
          let match;
          while ((match = ofPattern.exec(directText)) !== null) {
            const ofWhom = match[1].trim().toLowerCase();
            const isCJ = primaryAliases.some(a => a && ofWhom.indexOf(a) !== -1);
            const isSpouse = spouseNames.some(s => s && ofWhom.indexOf(s) !== -1);
            if (!isCJ && !isSpouse) { isFamilyOfOther = true; break; }
          }
          if (!isFamilyOfOther) {
            const possPattern = /(\w[\w\s]*?)(?:'s|'s)\s+(?:spouse|wife|husband|mother|father|sister|brother|daughter|son|parent|child|sibling|nephew|niece|uncle|aunt|cousin|grandmother|grandfather)/gi;
            while ((match = possPattern.exec(directText)) !== null) {
              const owner = match[1].trim().toLowerCase();
              const isCJ = primaryAliases.some(a => a && owner.indexOf(a) !== -1);
              const isSpouse = spouseNames.some(s => s && owner.indexOf(s) !== -1);
              if (!isCJ && !isSpouse && owner.length > 1) { isFamilyOfOther = true; break; }
            }
          }
          if (!isFamilyOfOther) {
            const friendFamilyPattern = /(?:spouse|wife|husband|mother|father|sister|brother|daughter|son)\s+of\s+(?:a\s+|deceased\s+)?(?:friend|colleague|coworker|associate|peer|buddy)/gi;
            if (friendFamilyPattern.test(directText)) isFamilyOfOther = true;
          }
          if (!isFamilyOfOther) {
            return { hint: 'family', rel: ft, dist: relEntry ? '1' : '2' };
          }
        }
      }
    }

    // PROFESSIONAL — search PRIMARY text (direct + summary)
    const proTerms = ['colleague', 'coworker', 'manager', 'direct report', 'supervisor',
      'mentor', 'business partner', 'professional', 'security architect',
      'from your school', 'employer', 'employee', 'amazon'];
    const pt = hasAny(primaryText, proTerms);
    if (pt) return { hint: 'professional', rel: pt, dist: relEntry ? '1' : '2' };

    // CELEBRITY — search BROAD text, only if no relationship to primary
    if (!relEntry) {
      const celTerms = ['rapper', 'musician', 'artist', 'athlete', 'actor', 'actress',
        'singer', 'public figure', 'celebrity', 'entertainer', 'comedian'];
      const ct = hasAny(broadText, celTerms);
      if (ct) return { hint: 'celebrity', rel: ct, dist: '3' };
    }

    // If we have a relEntry but didn't match any keywords, they're at least connected
    if (relEntry) {
      // Check if relEntry type itself gives a hint
      const relType = relEntry.type || '';
      if (relType && relType !== '3rd degree connection' && relType !== '2nd degree connection') {
        return { hint: 'other', rel: 'connected:' + relType, dist: '1' };
      }
    }

    return { hint: 'other', rel: 'default', dist: relEntry ? '1' : '3' };
  }

  // Process all person entities
  const counts = { family: 0, friends: 0, professional: 0, community: 0, celebrity: 0, other: 0, skipped: 0 };
  const details = [];
  const now = new Date().toISOString();

  for (const { data, file } of allEnts) {
    const e = data.entity || {};
    if (e.entity_type !== 'person') continue;
    if (e.entity_id === primaryId) { counts.skipped++; continue; }

    // Strip old categorization attributes BEFORE categorizing (prevents circular contamination)
    data.attributes = (data.attributes || []).filter(a =>
      a.key !== 'categorization_hint' && a.key !== 'relationship_to_primary' && a.key !== 'relationship_distance'
    );

    const result = categorizeEntity(data);
    if (!result) { counts.skipped++; continue; }

    const eName = e.name?.full || e.entity_id;

    // Build final attributes
    const filtered = data.attributes;

    // Add new ones
    let nextSeq = filtered.length + 1;
    filtered.push({
      attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
      key: 'categorization_hint', value: result.hint,
      confidence: 0.8, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 1, layer_label: 'recategorize' },
    });
    filtered.push({
      attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
      key: 'relationship_to_primary', value: result.rel,
      confidence: 0.8, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 1, layer_label: 'recategorize' },
    });
    filtered.push({
      attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
      key: 'relationship_distance', value: result.dist,
      confidence: 0.8, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 1, layer_label: 'recategorize' },
    });

    data.attributes = filtered;

    // Write back
    writeEntity(e.entity_id, data, req.graphDir);

    counts[result.hint] = (counts[result.hint] || 0) + 1;
    details.push({ entity_id: e.entity_id, name: eName, hint: result.hint, trigger: result.rel, distance: result.dist });
  }

  const total = details.length;
  const summary = `Recategorized ${total} people: Family (${counts.family}), Friends (${counts.friends}), Professional (${counts.professional}), Community (${counts.community}), Celebrity (${counts.celebrity}), Other (${counts.other})`;
  console.log('[recategorize]', summary);

  res.json({ summary, counts, total, details });
});

// POST /api/cleanup-orgs — Delete unaffiliated orgs, merge duplicates, categorize remaining
app.post('/api/cleanup-orgs', apiAuth, (req, res) => {
  const allEnts = listEntities(req.graphDir);

  // --- STEP 1: Delete unaffiliated orgs ---
  const deleteNames = [
    'atlanta community foundation', 'aspen institute', 'brightpath advisory', 'careerbuilder',
    'carnegie mellon university', 'duke university', 'fintech innovations inc',
    'four seasons resort o\'ahu at ko olina', 'four seasons resort oahu at ko olina',
    'google', 'goldman sachs', 'georgia tech', 'georgia tech alumni association',
    'hyatt regency', 'kualoa ranch', 'lyft', 'mckinsey', 'mit', 'meta',
    'newell brands', 'national society of black engineers', 'openai', 'payverse',
    'stripe', 'swiftgo africa', 'spiritual aurora', 'savannah high school',
    'solace therapeutics', 'stanford university', 'studio verde',
    'techbridge atlanta', 'urbannest properties', 'wharton',
    'waikoloa beach marriott resort & spa', 'waikoloa beach marriott resort and spa',
    'testcorp', 'bigtech inc', 'bigtech', 'new hope baptist church',
  ];
  // Also delete known test entities
  const deleteSet = new Set(deleteNames);

  let deleted = 0;
  const deletedList = [];
  for (const { data } of allEnts) {
    const e = data.entity || {};
    const t = e.entity_type || '';
    if (t !== 'organization' && t !== 'business' && t !== 'institution') continue;
    const name = (e.name?.common || e.name?.full || e.name?.legal || '').toLowerCase().trim();
    if (deleteSet.has(name)) {
      const result = deleteEntity(e.entity_id, req.graphDir);
      if (result.deleted) {
        deleted++;
        deletedList.push({ entity_id: e.entity_id, name: e.name?.common || e.name?.full || '' });
      }
    }
  }

  // --- STEP 2: Merge duplicates ---
  const refreshed = listEntities(req.graphDir);
  const mergePairs = [
    { keep: 'amazon', absorb: 'amazon web services' },
    { keep: 'dell emc', absorb: 'emc corporation' },
    { keep: 'clark atlanta university', absorb: 'clark atlanta' },
  ];
  let merged = 0;
  const mergedList = [];
  for (const pair of mergePairs) {
    let keepEnt = null, absorbEnt = null;
    for (const { data } of refreshed) {
      const e = data.entity || {};
      const t = e.entity_type || '';
      if (t !== 'organization' && t !== 'business' && t !== 'institution') continue;
      const name = (e.name?.common || e.name?.full || e.name?.legal || '').toLowerCase().trim();
      if (name === pair.keep && !keepEnt) keepEnt = data;
      if (name === pair.absorb && !absorbEnt) absorbEnt = data;
    }
    if (keepEnt && absorbEnt) {
      // Merge relationships from absorb into keep
      const keepRels = keepEnt.relationships || [];
      const absorbRels = absorbEnt.relationships || [];
      const keepRelNames = new Set(keepRels.map(r => (r.name || '').toLowerCase()));
      for (const rel of absorbRels) {
        if (!keepRelNames.has((rel.name || '').toLowerCase())) {
          keepRels.push(rel);
        }
      }
      keepEnt.relationships = keepRels;
      // Merge observations
      const keepObs = keepEnt.observations || [];
      const absorbObs = absorbEnt.observations || [];
      for (const obs of absorbObs) keepObs.push(obs);
      keepEnt.observations = keepObs;
      // Write updated keep entity
      writeEntity(keepEnt.entity.entity_id, keepEnt, req.graphDir);
      // Delete absorbed entity
      deleteEntity(absorbEnt.entity.entity_id, req.graphDir);
      merged++;
      mergedList.push({ kept: keepEnt.entity.entity_id, absorbed: absorbEnt.entity.entity_id, name: pair.keep });
    }
  }

  // --- STEP 3: Also deduplicate ORG- entities vs BIZ- entities (same org, different IDs) ---
  // e.g., ENT-ORG-001 "Amazon (Relay)" and ENT-BIZ-A-030 "Amazon" — keep both but don't double-count
  // ENT-ORG-005 "Dell EMC" and ENT-BIZ-DE-044 "Dell EMC" — merge
  const refreshed2 = listEntities(req.graphDir);
  const orgsByName = {};
  for (const { data } of refreshed2) {
    const e = data.entity || {};
    const t = e.entity_type || '';
    if (t !== 'organization' && t !== 'business' && t !== 'institution') continue;
    const name = (e.name?.common || e.name?.full || e.name?.legal || '').toLowerCase().trim().replace(/\s*\([^)]*\)/g, '');
    if (!orgsByName[name]) orgsByName[name] = [];
    orgsByName[name].push(data);
  }
  for (const [name, dupes] of Object.entries(orgsByName)) {
    if (dupes.length <= 1) continue;
    // Keep the one with more content (more attributes + observations)
    dupes.sort((a, b) => {
      const sa = (a.attributes || []).length + (a.observations || []).length + (a.relationships || []).length;
      const sb = (b.attributes || []).length + (b.observations || []).length + (b.relationships || []).length;
      return sb - sa;
    });
    const keep = dupes[0];
    for (let i = 1; i < dupes.length; i++) {
      const abs = dupes[i];
      // Merge rels/obs into keep
      const kRels = keep.relationships || [];
      const kRelNames = new Set(kRels.map(r => (r.name || '').toLowerCase()));
      for (const rel of (abs.relationships || [])) {
        if (!kRelNames.has((rel.name || '').toLowerCase())) kRels.push(rel);
      }
      keep.relationships = kRels;
      for (const obs of (abs.observations || [])) (keep.observations || []).push(obs);
      writeEntity(keep.entity.entity_id, keep, req.graphDir);
      deleteEntity(abs.entity.entity_id, req.graphDir);
      merged++;
      mergedList.push({ kept: keep.entity.entity_id, absorbed: abs.entity.entity_id, name });
    }
  }

  // --- STEP 4: Categorize remaining orgs ---
  const refreshed3 = listEntities(req.graphDir);
  // Find primary entity for connected object lookups
  let primaryData = null;
  let maxConn = 0;
  for (const { data } of refreshed3) {
    if ((data.entity || {}).entity_type === 'person') {
      const count = (data.connected_objects || []).length;
      if (count > maxConn) { maxConn = count; primaryData = data; }
    }
  }
  const connected = (primaryData && primaryData.connected_objects) || [];
  // Build role and credential maps by org name
  const roleByName = {};
  const credByName = {};
  for (const c of connected) {
    if (c.entity_type === 'role' && c.label) {
      const atIdx = c.label.indexOf(' at ');
      if (atIdx !== -1) {
        const orgName = c.label.substring(atIdx + 4).trim().toLowerCase();
        const roleTitle = c.label.substring(0, atIdx).trim();
        roleByName[orgName] = roleTitle;
      }
    }
    if (c.entity_type === 'credential' && c.label) {
      const commaIdx = c.label.indexOf(', ');
      if (commaIdx !== -1) {
        const instName = c.label.substring(commaIdx + 2).trim().toLowerCase();
        credByName[instName] = c.label.substring(0, commaIdx).trim();
      }
    }
  }

  // Career hints from known data
  const careerHints = {
    'amazon': { role: 'Principal Product Manager', dates: '2020-present' },
    'amazon (relay)': { role: 'Principal Product Manager', dates: '2020-present' },
    'fandom': { role: 'Senior Product Manager, AI/ML', dates: '2019-2021' },
    'wayfair': { role: 'Associate Director of Product Management', dates: '2017-2019' },
    'dell emc': { role: 'Consultant', dates: '2013-2015' },
    'deloitte': { role: 'Business Technology Analyst', dates: '2011-2013' },
    'deloitte consulting llp': { role: 'Senior Consultant - Data Science & AI', dates: '2011-2013' },
    'instrumental.ly': { role: 'Co-Founder', dates: '2013-2016' },
    'walmart': { role: 'AI/DS Lead', dates: '' },
    'walmart technology': { role: 'AI/DS Lead', dates: '' },
    'flawless tracks': { role: 'Founder', dates: '' },
    'putchuon channel': { role: 'YouTube Creator', dates: '' },
    'self-employed': { role: 'Context Architecture Consultant', dates: '' },
  };
  const educationHints = {
    'howard university': { credential: 'BBA', year: '2005' },
    'clark atlanta university': { credential: 'MBA', year: '2012' },
    'harvard university': { credential: 'MBA', year: '' },
    'harvard business school': { credential: 'MBA', year: '' },
    'thornwood high school': { credential: 'Diploma', year: '' },
  };
  const serviceHints = new Set([
    'carl e. sanders ymca', 'carl e. sanders ymca, buckhead',
    'kaiser permanente', 'jpmorgan chase', 'fulton county court',
  ]);

  const categorized = { career: 0, education: 0, affiliations: 0, services: 0 };
  const catDetails = [];
  const now = new Date().toISOString();

  for (const { data } of refreshed3) {
    const e = data.entity || {};
    const t = e.entity_type || '';
    if (t !== 'organization' && t !== 'business' && t !== 'institution') continue;
    const name = (e.name?.common || e.name?.full || e.name?.legal || '').toLowerCase().trim();
    const nameClean = name.replace(/\s*\([^)]*\)/g, '').trim();

    // Determine category
    let orgCat = 'affiliations'; // default
    let catMeta = {};

    if (careerHints[name] || careerHints[nameClean]) {
      orgCat = 'career';
      catMeta = careerHints[name] || careerHints[nameClean];
    } else if (roleByName[name] || roleByName[nameClean]) {
      orgCat = 'career';
      catMeta = { role: roleByName[name] || roleByName[nameClean] };
    } else if (educationHints[name] || educationHints[nameClean]) {
      orgCat = 'education';
      catMeta = educationHints[name] || educationHints[nameClean];
    } else if (credByName[name] || credByName[nameClean]) {
      orgCat = 'education';
      catMeta = { credential: credByName[name] || credByName[nameClean] };
    } else if (serviceHints.has(name) || serviceHints.has(nameClean)) {
      orgCat = 'services';
    }

    // Strip old org_category attributes and write new one
    data.attributes = (data.attributes || []).filter(a =>
      a.key !== 'org_category' && a.key !== 'cj_role' && a.key !== 'cj_dates' && a.key !== 'cj_credential' && a.key !== 'cj_grad_year'
    );
    let nextSeq = data.attributes.length + 1;
    data.attributes.push({
      attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
      key: 'org_category', value: orgCat,
      confidence: 0.9, confidence_label: 'HIGH',
      time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
      source_attribution: { facts_layer: 1, layer_label: 'cleanup-orgs' },
    });
    if (catMeta.role) {
      data.attributes.push({
        attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
        key: 'cj_role', value: catMeta.role,
        confidence: 0.9, confidence_label: 'HIGH',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'cleanup-orgs' },
      });
    }
    if (catMeta.dates) {
      data.attributes.push({
        attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
        key: 'cj_dates', value: catMeta.dates,
        confidence: 0.9, confidence_label: 'HIGH',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'cleanup-orgs' },
      });
    }
    if (catMeta.credential) {
      data.attributes.push({
        attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
        key: 'cj_credential', value: catMeta.credential,
        confidence: 0.9, confidence_label: 'HIGH',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'cleanup-orgs' },
      });
    }
    if (catMeta.year) {
      data.attributes.push({
        attribute_id: `ATTR-${String(nextSeq++).padStart(3, '0')}`,
        key: 'cj_grad_year', value: catMeta.year,
        confidence: 0.9, confidence_label: 'HIGH',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'cleanup-orgs' },
      });
    }
    writeEntity(e.entity_id, data, req.graphDir);
    categorized[orgCat]++;
    catDetails.push({ entity_id: e.entity_id, name: e.name?.common || e.name?.full || '', category: orgCat, role: catMeta.role || '', credential: catMeta.credential || '' });
  }

  const total = catDetails.length;
  const summary = `Deleted ${deleted} orgs, merged ${merged} pairs, categorized ${total} remaining: Career (${categorized.career}), Education (${categorized.education}), Affiliations (${categorized.affiliations}), Services (${categorized.services})`;
  console.log('[cleanup-orgs]', summary);
  console.log('[cleanup-orgs] Remaining orgs:');
  for (const d of catDetails) console.log(`  [${d.category}] ${d.name} (${d.entity_id})${d.role ? ' — ' + d.role : ''}${d.credential ? ' — ' + d.credential : ''}`);

  res.json({ summary, deleted: deletedList, merged: mergedList, categorized: catDetails, counts: categorized });
});

// Progress tracking for generate-dimensions
let dimProgress = null;

function computeVisualTier(strength) {
  if (strength >= 0.85) return 'gold';
  if (strength >= 0.65) return 'green';
  if (strength >= 0.30) return 'neutral';
  return 'muted';
}

/**
 * Post-extraction validation for relationships.
 * Removes self-references and deduplicates by target name.
 */
function validateRelationships(relationships, entityName, preferredName, aliases) {
  if (!Array.isArray(relationships) || relationships.length === 0) return relationships;

  // Build set of self-names to filter
  const selfNames = new Set();
  if (entityName) selfNames.add(entityName.toLowerCase().trim());
  if (preferredName) selfNames.add(preferredName.toLowerCase().trim());
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      if (a) selfNames.add(a.toLowerCase().trim());
    }
  }

  // Remove self-references
  let filtered = relationships.filter(r => {
    const name = (r.name || '').toLowerCase().trim();
    return name && !selfNames.has(name);
  });

  // Deduplicate by target name — merge descriptions, keep more specific type
  const seen = new Map();
  const deduped = [];
  for (const rel of filtered) {
    const key = (rel.name || '').toLowerCase().trim();
    if (seen.has(key)) {
      const existing = seen.get(key);
      // Merge context
      if (rel.context && (!existing.context || rel.context.length > existing.context.length)) {
        existing.context = rel.context;
      }
      // Keep more specific relationship type
      if (rel.relationship && (!existing.relationship_type || rel.relationship.length > (existing.relationship_type || '').length)) {
        existing.relationship_type = rel.relationship || rel.relationship_type;
      }
    } else {
      if (rel.relationship && !rel.relationship_type) {
        rel.relationship_type = rel.relationship;
      }
      seen.set(key, rel);
      deduped.push(rel);
    }
  }

  return deduped;
}

// Server-side page/section assignment — mirrors frontend getPage/getFamilySection/getFriendsSection/getProfessionalSection
function computeWikiPage(dims) {
  if (!dims || !dims.connection_type) return 'other';
  if (dims.connection_type === 'blood' || dims.connection_type === 'marriage') {
    if (!dims.connected_through) return 'family';
    if (dims.connection_type === 'blood') return 'family';
    if (dims.connection_type === 'marriage' && dims.sub_role === 'in_law') return 'family';
    if (dims.connection_type === 'marriage' && dims.connected_through) return 'other';
    return 'family';
  }
  if (dims.connected_through && (dims.strength || 0) < 0.30) return 'other';
  if (dims.connection_type === 'chosen') return 'friends';
  if (dims.connection_type === 'professional') return 'professional';
  if (dims.connection_type === 'community') return 'other';
  return 'other';
}

function computeWikiSection(dims, page) {
  if (!dims) return '';
  if (page === 'family') {
    if (dims.sub_role === 'spouse') return 'Spouse';
    if (dims.sub_role === 'child') return 'Children';
    if (dims.sub_role === 'parent' || dims.sub_role === 'sibling' || dims.sub_role === 'grandparent') return 'Parents & Siblings';
    return 'Extended Family';
  }
  if (page === 'friends') {
    var str = dims.strength || 0;
    if (str >= 0.85) return 'Inner Circle';
    if (str >= 0.65) return 'Close Friends';
    if (str >= 0.40) return 'Friends';
    return 'Acquaintances';
  }
  if (page === 'professional') {
    if (dims.sub_role === 'partner') return 'Partners';
    if (dims.status === 'active' || dims.status === 'stable') return 'Current';
    return 'Former';
  }
  return '';
}

// GET /api/generate-dimensions/status — Progress tracking
app.get('/api/generate-dimensions/status', apiAuth, (req, res) => {
  if (!dimProgress) return res.json({ running: false });
  res.json(dimProgress);
});

// POST /api/generate-dimensions — Bulk-generate relationship_dimensions and org_dimensions via LLM
app.post('/api/generate-dimensions', apiAuth, async (req, res) => {
  if (dimProgress && dimProgress.running) {
    return res.status(409).json({ error: 'Migration already in progress', progress: dimProgress });
  }

  try {
    const entities = listEntities(req.graphDir);

    // 1. Find primary person entity (most connected objects)
    let primaryEntity = null;
    let maxConn = 0;
    for (const { data } of entities) {
      if ((data.entity || {}).entity_type === 'person') {
        const count = (data.connected_objects || []).length;
        if (count > maxConn) { maxConn = count; primaryEntity = data; }
      }
    }
    if (!primaryEntity) return res.status(400).json({ error: 'No primary person entity found' });

    const primaryName = primaryEntity.entity.name?.full || primaryEntity.entity.name?.preferred || '';
    const primaryId = primaryEntity.entity.entity_id;
    const primarySummary = primaryEntity.entity.summary?.value || '';

    // Build primary context: relationship map + nicknames
    const primaryRelMap = {};
    for (const rel of (primaryEntity.relationships || [])) {
      primaryRelMap[rel.name || ''] = { type: rel.relationship_type || '', context: rel.context || '' };
    }

    // 2. Separate persons vs orgs (exclude primary)
    const persons = [];
    const orgs = [];
    for (const { data } of entities) {
      const e = data.entity || {};
      const eid = e.entity_id;
      if (eid === primaryId) continue;
      if (e.entity_type === 'person') {
        persons.push(data);
      } else if (e.entity_type === 'organization' || e.entity_type === 'business' || e.entity_type === 'institution') {
        orgs.push(data);
      }
    }

    const client = new Anthropic();
    const errors = [];
    const peopleSummary = { family: [], friends: [], professional: [], other: [] };
    const orgsSummary = { career: [], education: [], affiliations: [], services: [], deleted: [] };
    const tierCounts = { gold: 0, green: 0, neutral: 0, muted: 0 };
    const startTime = Date.now();

    dimProgress = {
      running: true,
      phase: 'people',
      current: 0,
      total: persons.length + orgs.length,
      people_total: persons.length,
      orgs_total: orgs.length,
      people_processed: 0,
      orgs_processed: 0,
      orgs_deleted: 0,
      started_at: new Date().toISOString(),
      errors: [],
    };

    // === PERSON SYSTEM PROMPT ===
    const personSystemPrompt = `You are analyzing a person entity from a knowledge graph. The PRIMARY USER of this graph is ${primaryName}. Every person must be scored in relationship TO ${primaryName}.
${primarySummary ? `\nAbout ${primaryName}: ${primarySummary}\n` : ''}
Given each person's entity data below, answer these questions and return a JSON array with one object per person.

QUESTIONS:

1. connection_type — How is this person connected to ${primaryName}?
   Pick ONE:
   - "blood": biological or legally adopted family (parent, child, sibling, cousin, grandparent, aunt, uncle, nephew, niece, half-sibling)
   - "marriage": connected through a marriage, current or former (spouse, ex-spouse, in-law, step-relative)
   - "chosen": voluntary personal relationship (friend, best friend, mentor, mentee, confidant, surrogate sibling)
   - "professional": work or business relationship (colleague, manager, report, client, business partner)
   - "community": shared context or proximity, not individual bond (classmate, neighbor, fellow member)

2. access — How much vulnerability would ${primaryName} extend to this person? Score 0.00 to 1.00.
   Calibration probes (scoring aids, not definitions):
   0.90-1.00: Unrestricted trust. Would trust them alone with his child for a week? Give them home and car keys as first option? Hand them his unlocked phone without a second thought?
   0.70-0.89: High trust. Would call them at 3am in an emergency? Share something vulnerable? Ask for a significant favor and expect them to show up?
   0.50-0.69: Mutual trust. Has their direct contact? Reaching out would be normal and welcomed? Would help each other without hesitation if asked?
   0.30-0.49: Contextual trust. Would engage warmly in a shared setting but not reach out independently? Relationship exists within a container (group, event, mutual friend)?
   0.10-0.29: Recognition. Knows who they are. Maybe met once or twice. No real trust, just awareness.
   0.01-0.09: One-directional. Knows OF them but no mutual awareness. Parasocial or purely observational.
   Use the EVIDENCE in the entity data to score.

3. connected_through — Is this a direct relationship with ${primaryName}, or through someone else?
   Return null if direct (${primaryName} has an independent relationship with this person).
   Return the bridge person/group/org name if indirect.
   CRITICAL RULES:
   - If described as "spouse of [someone who is NOT ${primaryName}]", connected through that person. NOT ${primaryName}'s family.
   - If described as "[someone]'s [relative]" where [someone] is not ${primaryName}, connected through that person.
   - EXCEPTION: If connected_through is ${primaryName}'s CURRENT SPOUSE and connection_type is blood, this person is an in-law. Still return the spouse name as connected_through.
   - If they originally met ${primaryName} through someone but NOW have a fully independent relationship, return null. Origin story goes in descriptor, not connected_through.

4. status — What is the current energy of this relationship?
   Pick ONE:
   - "active": regular engagement, relationship generating contact
   - "stable": solid but doesn't need regular contact. It just IS. Would re-engage instantly.
   - "passive": no regular contact, zero animosity. Dormant, not dead.
   - "diminishing": actively fading. Less contact over time. Trending toward inactive.
   - "inactive": effectively ended. No contact, no expectation of contact. Not hostile, just done.
   - "estranged": active negative state. Conflict, avoidance, or unresolved tension.
   - "deceased": person has passed away.
   - "complicated": multiple simultaneous states. ALWAYS explain in descriptor when using this.

5. strength — How much would ${primaryName}'s life change without this person? Score 0.00 to 1.00.
   Calibration probes:
   0.90-1.00: Life-altering. Daily existence changes fundamentally. The 5-7 people who anchor life.
   0.75-0.89: Significant. Felt deeply at key moments — holidays, milestones, hard decisions.
   0.50-0.74: Meaningful. Would miss them, think of them. Daily life continues unchanged.
   0.30-0.49: Mild. Would notice eventually if prompted. Latent goodwill.
   0.10-0.29: Negligible. Memory, not active life.
   0.01-0.09: None. Cultural awareness only.
   IMPORTANT: Strength is independent of access. A deceased person can have access 0.00 but strength 0.90 (deeply missed). Don't conflate reachability with impact. Don't inflate based on connection_type alone. Not all siblings are close. Not all colleagues are distant. Use the EVIDENCE.

6. sub_role — What specific role does this person play? Pick the MOST SPECIFIC:
   Family: spouse | child | parent | grandparent | sibling | uncle | aunt | cousin | in_law | extended
   Friends: friend | mentor | mentee | confidant | surrogate_sibling | surrogate_parent
   Professional: colleague | manager | report | partner | client | vendor
   Community: classmate | neighbor | member | acquaintance
   Other: influence (parasocial/cultural)

7. descriptor — Write a 4-8 word phrase that completes "That's my ___" in how ${primaryName} would naturally introduce this person.
   Rules:
   - Use the person's NICKNAME if one exists in the data (Honeyman not Zebedee, Chiefe not Ryan, Big Al not Allen, Ro not Rodrique)
   - High access (0.70+): [qualifier] + [relationship] + [origin]. "best friend from the block"
   - Moderate access (0.40-0.69): [context-first]. "Justin's wife, always cordial"
   - Low access (<0.40): [connection path only]. "old acquaintance from Markham"
   - Deceased: use "late" naturally. "late best friend from the block"
   - Former: include transition + ongoing connection. "ex-wife, London's mother"
   - Complicated: name the layers. "ex-wife, London's mother, complicated history"
   - For indirect relationships: use bridge person's NICKNAME. "Ro's wife" not "Rodrique Fru's wife"

Return ONLY a valid JSON array, no markdown fences, no commentary:
[{"entity_id":"...","connection_type":"...","access":0.82,"connected_through":null,"status":"active","strength":0.85,"sub_role":"friend","descriptor":"close friend, came through Tone originally"}]`;

    // === ORG SYSTEM PROMPT ===
    const orgSystemPrompt = `You are analyzing organization entities from a knowledge graph. The PRIMARY USER is ${primaryName}.
${primarySummary ? `\nAbout ${primaryName}: ${primarySummary}\n` : ''}
Determine ${primaryName}'s relationship to each organization below.

If ${primaryName} has NO direct relationship to this org (it was mentioned in someone else's bio, or is a general reference), return: {"entity_id":"...","relationship_to_primary":"none"}

Otherwise return:
{
  "entity_id": "...",
  "relationship_to_primary": "employer|alma_mater|membership|service_provider",
  "org_category": "career|education|affiliations|services",
  "org_status": "current|former",
  "primary_user_role": "Principal Product Manager",
  "org_dates": "2020-present",
  "org_descriptor": "current employer, AI forecasting"
}

Rules:
- "employer" → org_category "career"
- "alma_mater" → org_category "education"
- "membership" (fraternity, church, community org, professional assoc) → org_category "affiliations"
- "service_provider" (healthcare, banking, insurance, legal) → org_category "services"
- "none" → this org should be flagged for deletion (not relevant to ${primaryName})

Return ONLY a valid JSON array, no markdown fences, no commentary.`;

    // 3. Process persons in batches of 5
    const personBatches = [];
    for (let i = 0; i < persons.length; i += 5) {
      personBatches.push(persons.slice(i, i + 5));
    }

    for (let bi = 0; bi < personBatches.length; bi++) {
      const batch = personBatches[bi];
      try {
        const personDescriptions = batch.map(data => {
          const e = data.entity || {};
          const name = e.name?.full || '';
          const nickname = e.name?.preferred || e.name?.nickname || '';
          const summary = e.summary?.value || '';
          const attrs = (data.attributes || []).map(a => `${a.key}: ${a.value}`).join('; ');
          const rels = (data.relationships || []).map(r => `${r.name} (${r.relationship_type}): ${r.context || ''}`).join('; ');
          const obs = (data.observations || []).slice(0, 5).map(o => o.content || o.text || '').join('; ');
          const relMapEntry = primaryRelMap[name] || null;
          const relMapText = relMapEntry ? `Primary user's relationship entry: type="${relMapEntry.type}", context="${relMapEntry.context}"` : 'No direct relationship entry from primary user';
          return `PERSON: entity_id="${e.entity_id}", name="${name}"${nickname ? `, nickname="${nickname}"` : ''}
Summary: ${summary}
Attributes: ${attrs}
Relationships: ${rels}
Observations (first 5): ${obs}
${relMapText}`;
        }).join('\n\n---\n\n');

        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [
            { role: 'user', content: `Analyze these persons:\n\n${personDescriptions}` },
          ],
          system: personSystemPrompt,
        });

        const responseText = message.content[0].text.trim();
        let dimensions;
        try {
          dimensions = JSON.parse(responseText);
        } catch {
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          dimensions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        }

        // Write results to entity files
        for (const dim of dimensions) {
          const entityData = batch.find(d => (d.entity || {}).entity_id === dim.entity_id);
          if (!entityData) continue;

          // Compute visual_tier from strength
          const strength = typeof dim.strength === 'number' ? dim.strength : 0.5;
          const access = typeof dim.access === 'number' ? dim.access : 0.5;
          const visualTier = computeVisualTier(strength);

          const relDims = {
            connection_type: dim.connection_type,
            access: Math.round(access * 100) / 100,
            connected_through: dim.connected_through || null,
            status: dim.status,
            strength: Math.round(strength * 100) / 100,
            sub_role: dim.sub_role,
            descriptor: dim.descriptor || '',
            descriptor_origin: dim.descriptor_origin || '',
            visual_tier: visualTier,
          };

          entityData.relationship_dimensions = relDims;
          entityData.descriptor = dim.descriptor || '';

          // Strip old categorization attributes
          if (entityData.attributes) {
            entityData.attributes = entityData.attributes.filter(a =>
              a.key !== 'categorization_hint' && a.key !== 'relationship_to_primary' && a.key !== 'relationship_distance'
            );
          }

          writeEntity(dim.entity_id, entityData, req.graphDir);
          tierCounts[visualTier] = (tierCounts[visualTier] || 0) + 1;

          // Categorize for summary using new getPage logic
          const name = (entityData.entity || {}).name?.full || '';
          const ct = relDims.connection_type;
          const connThrough = relDims.connected_through;
          if (ct === 'blood' || ct === 'marriage') {
            if (!connThrough || ct === 'blood') {
              peopleSummary.family.push(name);
            } else {
              peopleSummary.other.push(name);
            }
          } else if (ct === 'chosen' && access >= 0.30) {
            peopleSummary.friends.push(name);
          } else if (ct === 'professional' && access >= 0.30) {
            peopleSummary.professional.push(name);
          } else {
            peopleSummary.other.push(name);
          }
        }

        dimProgress.people_processed += dimensions.length;
        dimProgress.current = dimProgress.people_processed;
        console.log(`[generate-dimensions] Person batch ${bi + 1}/${personBatches.length}: processed ${dimensions.length} persons`);
      } catch (err) {
        console.error(`[generate-dimensions] Person batch ${bi + 1} error:`, err.message);
        errors.push(`Person batch ${bi + 1}: ${err.message}`);
        dimProgress.errors.push(`Person batch ${bi + 1}: ${err.message}`);
      }
    }

    // 4. Process orgs in batches of 5
    dimProgress.phase = 'orgs';
    const orgBatches = [];
    for (let i = 0; i < orgs.length; i += 5) {
      orgBatches.push(orgs.slice(i, i + 5));
    }

    for (let bi = 0; bi < orgBatches.length; bi++) {
      const batch = orgBatches[bi];
      try {
        const orgDescriptions = batch.map(data => {
          const e = data.entity || {};
          const name = e.name?.common || e.name?.full || e.name?.legal || '';
          const summary = e.summary?.value || '';
          const attrs = (data.attributes || []).map(a => `${a.key}: ${a.value}`).join('; ');
          const rels = (data.relationships || []).map(r => `${r.name} (${r.relationship_type}): ${r.context || ''}`).join('; ');
          return `ORG: entity_id="${e.entity_id}", name="${name}", type="${e.entity_type}"
Summary: ${summary}
Attributes: ${attrs}
Relationships: ${rels}`;
        }).join('\n\n---\n\n');

        const message = await client.messages.create({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 16384,
          messages: [
            { role: 'user', content: `Analyze these organizations:\n\n${orgDescriptions}` },
          ],
          system: orgSystemPrompt,
        });

        const responseText = message.content[0].text.trim();
        let dimensions;
        try {
          dimensions = JSON.parse(responseText);
        } catch {
          const jsonMatch = responseText.match(/\[[\s\S]*\]/);
          dimensions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        }

        for (const dim of dimensions) {
          const entityData = batch.find(d => (d.entity || {}).entity_id === dim.entity_id);
          if (!entityData) continue;

          const name = (entityData.entity || {}).name?.common || (entityData.entity || {}).name?.full || '';

          // Flag for deletion if "none"
          if (dim.relationship_to_primary === 'none') {
            orgsSummary.deleted.push(name);
            dimProgress.orgs_deleted++;
            // Mark entity for deletion (add attribute, don't delete yet)
            if (!entityData.attributes) entityData.attributes = [];
            entityData.attributes.push({ key: 'flagged_for_deletion', value: 'true', source: 'generate-dimensions' });
            writeEntity(dim.entity_id, entityData, req.graphDir);
            continue;
          }

          const orgDims = {
            relationship_to_primary: dim.relationship_to_primary,
            org_category: dim.org_category,
            org_status: dim.org_status,
            primary_user_role: dim.primary_user_role || '',
            org_dates: dim.org_dates || '',
            org_descriptor: dim.org_descriptor || '',
          };

          entityData.org_dimensions = orgDims;
          entityData.descriptor = dim.org_descriptor || '';

          // Also set org_category attribute for sidebar compatibility
          if (entityData.attributes) {
            const catAttr = entityData.attributes.find(a => a.key === 'org_category');
            if (catAttr) {
              catAttr.value = dim.org_category;
            } else {
              entityData.attributes.push({ key: 'org_category', value: dim.org_category, source: 'generate-dimensions' });
            }
          }

          writeEntity(dim.entity_id, entityData, req.graphDir);

          const cat = dim.org_category || 'services';
          if (orgsSummary[cat]) {
            orgsSummary[cat].push(name);
          } else {
            orgsSummary.services.push(name);
          }
        }

        dimProgress.orgs_processed += dimensions.length;
        dimProgress.current = dimProgress.people_processed + dimProgress.orgs_processed;
        console.log(`[generate-dimensions] Org batch ${bi + 1}/${orgBatches.length}: processed ${dimensions.length} orgs`);
      } catch (err) {
        console.error(`[generate-dimensions] Org batch ${bi + 1} error:`, err.message);
        errors.push(`Org batch ${bi + 1}: ${err.message}`);
        dimProgress.errors.push(`Org batch ${bi + 1}: ${err.message}`);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const summaryText = `Generated dimensions for ${persons.length} people, ${orgs.length} orgs in ${elapsed}s`;
    console.log('[generate-dimensions]', summaryText);

    dimProgress.running = false;
    dimProgress.completed_at = new Date().toISOString();
    dimProgress.phase = 'done';

    res.json({
      summary: summaryText,
      people: peopleSummary,
      orgs: orgsSummary,
      tiers: tierCounts,
      errors,
    });
  } catch (err) {
    console.error('[generate-dimensions] Fatal error:', err);
    dimProgress = { running: false, error: err.message };
    res.status(500).json({ error: err.message });
  }
});

// POST /api/merge-entities — Merge two entities into one
app.post('/api/merge-entities', apiAuth, (req, res) => {
  const { primary_id, secondary_id, name_override, nickname_additions, descriptor_override } = req.body;
  if (!primary_id || !secondary_id) return res.status(400).json({ error: 'primary_id and secondary_id required' });
  if (primary_id === secondary_id) return res.status(400).json({ error: 'Cannot merge entity with itself' });

  const primary = readEntity(primary_id, req.graphDir);
  const secondary = readEntity(secondary_id, req.graphDir);
  if (!primary) return res.status(404).json({ error: 'Primary entity not found: ' + primary_id });
  if (!secondary) return res.status(404).json({ error: 'Secondary entity not found: ' + secondary_id });

  const now = new Date().toISOString();
  const changes = [];

  // Merge name: optionally override, add nicknames
  if (name_override && primary.entity) {
    if (primary.entity.entity_type === 'person') {
      primary.entity.name.full = name_override;
    } else {
      primary.entity.name.common = name_override;
    }
    changes.push('name overridden to: ' + name_override);
  }
  if (nickname_additions && primary.entity && primary.entity.name) {
    if (!primary.entity.name.aliases) primary.entity.name.aliases = [];
    for (const nick of nickname_additions) {
      if (!primary.entity.name.aliases.includes(nick)) {
        primary.entity.name.aliases.push(nick);
      }
    }
    changes.push('added aliases: ' + nickname_additions.join(', '));
  }

  // Merge summary: keep primary unless secondary is longer
  if (secondary.entity && secondary.entity.summary && primary.entity) {
    const pLen = (primary.entity.summary?.value || '').length;
    const sLen = (secondary.entity.summary?.value || '').length;
    if (sLen > pLen) {
      primary.entity.summary = secondary.entity.summary;
      changes.push('kept longer summary from secondary');
    }
  }

  // Override descriptor if provided
  if (descriptor_override) {
    primary.descriptor = descriptor_override;
    changes.push('descriptor overridden');
  }

  // Merge attributes (skip duplicates by key)
  const existingKeys = new Set((primary.attributes || []).map(a => a.key));
  for (const attr of (secondary.attributes || [])) {
    if (!existingKeys.has(attr.key)) {
      (primary.attributes = primary.attributes || []).push(attr);
      existingKeys.add(attr.key);
      changes.push('added attribute: ' + attr.key);
    }
  }

  // Merge relationships (skip duplicates by name)
  const existingRelNames = new Set((primary.relationships || []).map(r => (r.name || '').toLowerCase()));
  for (const rel of (secondary.relationships || [])) {
    if (!existingRelNames.has((rel.name || '').toLowerCase())) {
      (primary.relationships = primary.relationships || []).push(rel);
      existingRelNames.add((rel.name || '').toLowerCase());
      changes.push('added relationship: ' + rel.name);
    }
  }

  // Merge observations
  const obsCount = (secondary.observations || []).length;
  if (obsCount > 0) {
    primary.observations = (primary.observations || []).concat(secondary.observations || []);
    changes.push('merged ' + obsCount + ' observations');
  }

  // Merge connected_objects
  const existingConnIds = new Set((primary.connected_objects || []).map(c => c.entity_id));
  for (const conn of (secondary.connected_objects || [])) {
    if (!existingConnIds.has(conn.entity_id) && conn.entity_id !== primary_id) {
      (primary.connected_objects = primary.connected_objects || []).push(conn);
      existingConnIds.add(conn.entity_id);
    }
  }

  // Keep relationship_dimensions and org_dimensions from primary (or secondary if primary lacks them)
  if (!primary.relationship_dimensions && secondary.relationship_dimensions) {
    primary.relationship_dimensions = secondary.relationship_dimensions;
    changes.push('inherited relationship_dimensions from secondary');
  }
  if (!primary.descriptor && secondary.descriptor) {
    primary.descriptor = secondary.descriptor;
  }
  if (!primary.org_dimensions && secondary.org_dimensions) {
    primary.org_dimensions = secondary.org_dimensions;
  }

  // Update provenance
  if (!primary.provenance_chain) primary.provenance_chain = {};
  if (!primary.provenance_chain.merge_history) primary.provenance_chain.merge_history = [];
  primary.provenance_chain.merge_history.push({
    merged_from: secondary_id,
    merged_at: now,
    merged_by: req.agentId,
  });
  if (primary.extraction_metadata) primary.extraction_metadata.updated_at = now;

  // Write updated primary
  writeEntity(primary_id, primary, req.graphDir);

  // Update all references to secondary across the graph
  const allEntities = listEntities(req.graphDir);
  let refsUpdated = 0;
  const secondaryName = secondary.entity?.name?.full || secondary.entity?.name?.common || '';
  const primaryName = primary.entity?.name?.full || primary.entity?.name?.common || '';
  for (const { data } of allEntities) {
    const eid = (data.entity || {}).entity_id;
    if (eid === primary_id || eid === secondary_id) continue;
    let changed = false;

    // Update connected_objects references
    if (data.connected_objects) {
      for (let i = 0; i < data.connected_objects.length; i++) {
        if (data.connected_objects[i].entity_id === secondary_id) {
          data.connected_objects[i].entity_id = primary_id;
          changed = true;
        }
      }
    }

    // Update relationship references
    if (data.relationships) {
      for (let i = 0; i < data.relationships.length; i++) {
        if (data.relationships[i].name === secondaryName) {
          data.relationships[i].name = primaryName;
          changed = true;
        }
      }
    }

    if (changed) {
      writeEntity(eid, data, req.graphDir);
      refsUpdated++;
    }
  }

  // Delete secondary entity
  deleteEntity(secondary_id, req.graphDir);
  changes.push('deleted secondary entity: ' + secondary_id);
  changes.push('updated ' + refsUpdated + ' entity references');

  console.log('[merge-entities] Merged', secondary_id, 'into', primary_id, ':', changes.length, 'changes');

  res.json({
    merged_into: primary_id,
    deleted: secondary_id,
    changes,
    refs_updated: refsUpdated,
    entity: {
      entity_id: primary_id,
      name: primary.entity?.name?.full || primary.entity?.name?.common || '',
      descriptor: primary.descriptor || '',
    },
  });
});

// GET /api/entity/:id/connected — Entity + all connected objects
app.get('/api/entity/:id/connected', apiAuth, (req, res) => {
  const result = loadConnectedObjects(req.params.id, req.graphDir);
  if (!result) return res.status(404).json({ error: 'Entity not found' });
  res.json(result);
});

// GET /api/entity/:id/summary — Lightweight summary
app.get('/api/entity/:id/summary', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const e = entity.entity || {};
  const type = e.entity_type;
  let name = '';
  if (type === 'person') {
    name = e.name?.full || '';
  } else {
    name = e.name?.common || e.name?.legal || '';
  }

  res.json({
    entity_id: e.entity_id,
    entity_type: type,
    name,
    summary: e.summary?.value || '',
    confidence: entity.extraction_metadata?.extraction_confidence || null,
    last_updated: entity.extraction_metadata?.extracted_at || null,
    attributes_count: entity.attributes?.length || 0,
    relationships_count: entity.relationships?.length || 0,
    key_facts_count: entity.key_facts?.length || 0,
  });
});

// GET /api/entity/:id/context — Entity profile + top 20 weighted observations
app.get('/api/entity/:id/context', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const e = entity.entity || {};
  const type = e.entity_type;
  const name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  const now = Date.now();

  // Score and sort observations
  const observations = (entity.observations || []).map(obs => {
    const obsTime = new Date(obs.observed_at).getTime();
    const daysSince = Math.max(0, (now - obsTime) / (1000 * 60 * 60 * 24));
    const timeDecayFactor = Math.exp(-0.03 * daysSince);
    const relevanceWeight = (obs.confidence || 0) * timeDecayFactor;
    return { ...obs, days_since: Math.round(daysSince * 100) / 100, time_decay_factor: Math.round(timeDecayFactor * 1000) / 1000, relevance_weight: Math.round(relevanceWeight * 1000) / 1000 };
  });

  observations.sort((a, b) => b.relevance_weight - a.relevance_weight);
  const top20 = observations.slice(0, 20);
  const top5 = observations.slice(0, 5);

  // Build context summary
  const entitySummary = e.summary?.value || '';
  let contextSummary = entitySummary;
  if (top5.length > 0) {
    const obsText = top5.map((o, i) => `(${i + 1}) ${o.observation}`).join(' ');
    contextSummary += ' Recent observations: ' + obsText;
  }

  res.json({
    entity_id: e.entity_id,
    entity_type: type,
    name,
    entity_summary: entitySummary,
    context_summary: contextSummary,
    observation_count: (entity.observations || []).length,
    observations: top20,
    profile: {
      attributes_count: (entity.attributes || []).length,
      relationships_count: (entity.relationships || []).length,
      values_count: (entity.values || []).length,
      key_facts_count: (entity.key_facts || []).length,
      constraints_count: (entity.constraints || []).length,
      confidence: entity.extraction_metadata?.extraction_confidence || null,
    },
  });
});

// GET /api/search?q=&type= — Fuzzy search entities with optional type filter
app.get('/api/search', apiAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });

  const typeFilter = req.query.type
    ? req.query.type.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
    : null;

  const { similarity } = require('./merge-engine');
  let entities = listEntities(req.graphDir);

  // Apply type filter if specified
  if (typeFilter) {
    entities = entities.filter(({ data }) => {
      const type = (data.entity || {}).entity_type;
      return typeFilter.includes(type);
    });
  }

  // Resolve entity name across all types
  function getEntityName(e) {
    var type = e.entity_type;
    if (type === 'person') return e.name?.full || '';
    if (type === 'business') return e.name?.common || e.name?.legal || '';
    return e.name?.full || e.name?.common || '';
  }

  // Enrich person results with categorization text and trimmed attributes/relationships
  function enrichPersonResult(result, e, data) {
    if (e.entity_type !== 'person') return result;
    result.attributes = (data.attributes || []).map(a => ({ key: a.key, value: a.value }));
    result.relationships = (data.relationships || []).map(r => ({ name: r.name, relationship_type: r.relationship_type, context: r.context }));
    if (data.relationship_dimensions) result.relationship_dimensions = data.relationship_dimensions;
    if (data.descriptor) result.descriptor = data.descriptor;
    if (data.structured_attributes) result.structured_attributes = data.structured_attributes;
    return result;
  }

  // Wildcard: return all entities
  if (q === '*') {
    const all = entities.map(({ data }) => {
      const e = data.entity || {};
      const name = getEntityName(e);
      const r = { entity_id: e.entity_id, entity_type: e.entity_type, name, summary: e.summary?.value || '', match_score: 1.0, observation_count: (data.observations || []).length, relationship_count: (data.relationships || []).length };
      enrichPersonResult(r, e, data);
      if (data.relationship_dimensions) r.relationship_dimensions = data.relationship_dimensions;
      if (data.descriptor) r.descriptor = data.descriptor;
      if (data.org_dimensions) r.org_dimensions = data.org_dimensions;
      // Include attributes for org-type entities (needed for org_category in sidebar)
      if (e.entity_type === 'organization' || e.entity_type === 'business' || e.entity_type === 'institution') {
        r.attributes = (data.attributes || []).map(a => ({ key: a.key, value: a.value }));
      }
      return r;
    });
    return res.json({ query: q, count: all.length, results: all });
  }

  const results = [];

  for (const { data } of entities) {
    const e = data.entity || {};
    const type = e.entity_type;
    let name = getEntityName(e);
    let score = 0;

    // Check name similarity
    score = Math.max(score, similarity(q, name));

    // Check aliases
    const aliases = e.name?.aliases || [];
    for (const alias of aliases) {
      score = Math.max(score, similarity(q, alias));
    }

    // Check attributes for keyword match
    for (const attr of (data.attributes || [])) {
      if ((attr.value || '').toLowerCase().includes(q)) {
        score = Math.max(score, 0.6);
      }
    }

    // Check summary
    if ((e.summary?.value || '').toLowerCase().includes(q)) {
      score = Math.max(score, 0.5);
    }

    if (score > 0.3) {
      const r = {
        entity_id: e.entity_id,
        entity_type: type,
        name,
        summary: e.summary?.value || '',
        match_score: Math.round(score * 100) / 100,
        observation_count: (data.observations || []).length,
        relationship_count: (data.relationships || []).length,
      };
      enrichPersonResult(r, e, data);
      if (data.relationship_dimensions) r.relationship_dimensions = data.relationship_dimensions;
      if (data.descriptor) r.descriptor = data.descriptor;
      if (data.org_dimensions) r.org_dimensions = data.org_dimensions;
      // Include attributes for org-type entities (needed for org_category in sidebar)
      if (type === 'organization' || type === 'business' || type === 'institution') {
        r.attributes = (data.attributes || []).map(a => ({ key: a.key, value: a.value }));
      }
      results.push(r);
    }
  }

  results.sort((a, b) => b.match_score - a.match_score);
  res.json({ query: q, count: results.length, results });
});

// PATCH /api/entity/:id — Merge-update entity fields
app.patch('/api/entity/:id', apiAuth, (req, res) => {
  const entity = readEntity(req.params.id, req.graphDir);
  if (!entity) return res.status(404).json({ error: 'Entity not found' });

  const now = new Date().toISOString();
  const updates = req.body;
  const changes = [];

  // Merge into entity.entity (name, summary, entity_type)
  if (updates.name && entity.entity) {
    Object.assign(entity.entity.name || {}, updates.name);
    changes.push('updated name');
  }
  if (updates.summary != null && entity.entity) {
    if (typeof entity.entity.summary === 'object') {
      entity.entity.summary.value = updates.summary;
    } else {
      entity.entity.summary = { value: updates.summary, confidence: 0.8 };
    }
    changes.push('updated summary');
  }

  // Merge attributes (append new ones, update existing by key)
  if (updates.attributes && entity.attributes) {
    if (typeof updates.attributes === 'object' && !Array.isArray(updates.attributes)) {
      // Object form: { role: "new value", location: "new value" }
      for (const [key, value] of Object.entries(updates.attributes)) {
        const existing = entity.attributes.find(a => a.key === key);
        if (existing) {
          existing.value = value;
          existing.confidence = 0.8;
          existing.confidence_label = 'STRONG';
          changes.push(`updated attribute ${key}`);
        } else {
          entity.attributes.push({
            attribute_id: `ATTR-${String(entity.attributes.length + 1).padStart(3, '0')}`,
            key, value, confidence: 0.8, confidence_label: 'STRONG',
            time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
            source_attribution: { facts_layer: 2, layer_label: 'group' },
          });
          changes.push(`added attribute ${key}`);
        }
      }
    }
  }

  // Merge relationships (append new, dedup by name)
  if (Array.isArray(updates.relationships)) {
    if (!entity.relationships) entity.relationships = [];
    for (const rel of updates.relationships) {
      const existing = entity.relationships.find(r =>
        (r.name || '').toLowerCase() === (rel.name || '').toLowerCase()
      );
      if (existing) {
        if (rel.relationship) existing.relationship_type = rel.relationship;
        if (rel.context) existing.context = rel.context;
        changes.push(`updated relationship ${rel.name}`);
      } else {
        entity.relationships.push({
          relationship_id: `REL-${String(entity.relationships.length + 1).padStart(3, '0')}`,
          name: rel.name, relationship_type: rel.relationship || '', context: rel.context || '',
          sentiment: 'neutral', confidence: 0.8, confidence_label: 'STRONG',
        });
        changes.push(`added relationship ${rel.name}`);
      }
    }
  }

  // Merge values (append new, dedup by value text)
  if (Array.isArray(updates.values)) {
    if (!entity.values) entity.values = [];
    for (const val of updates.values) {
      const valText = typeof val === 'string' ? val : val.value;
      const existing = entity.values.find(v => (v.value || '').toLowerCase() === valText.toLowerCase());
      if (!existing) {
        entity.values.push({
          value_id: `VAL-${String(entity.values.length + 1).padStart(3, '0')}`,
          value: valText, confidence: 0.8, confidence_label: 'STRONG',
        });
        changes.push(`added value ${valText}`);
      }
    }
  }

  // Update timestamps
  if (!entity.extraction_metadata) entity.extraction_metadata = {};
  entity.extraction_metadata.updated_at = now;

  // Provenance
  if (!entity.provenance_chain) {
    entity.provenance_chain = { created_at: now, created_by: 'api', source_documents: [], merge_history: [] };
  }
  entity.provenance_chain.merge_history = entity.provenance_chain.merge_history || [];
  entity.provenance_chain.merge_history.push({
    merged_at: now, merged_by: req.agentId, changes,
  });

  writeEntity(req.params.id, entity, req.graphDir);

  res.json({
    status: 'updated',
    entity_id: req.params.id,
    changes,
    updated_at: now,
  });
});

// POST /api/observe — Append an observation to an existing entity
const CONFIDENCE_MAP = {
  VERIFIED: 1.0, STRONG: 0.8, MODERATE: 0.6, SPECULATIVE: 0.4, UNCERTAIN: 0.2,
};
const VALID_LAYERS = ['L1_OBJECTIVE', 'L2_GROUP', 'L3_PERSONAL'];

app.post('/api/observe', apiAuth, (req, res) => {
  const { entity_id, observation, confidence_label, facts_layer, source } = req.body;

  // Validate required fields
  if (!entity_id) return res.status(400).json({ error: 'Missing entity_id' });
  if (!observation || typeof observation !== 'string' || !observation.trim()) {
    return res.status(400).json({ error: 'Missing or empty observation string' });
  }
  if (!confidence_label || !CONFIDENCE_MAP.hasOwnProperty(confidence_label)) {
    return res.status(400).json({
      error: 'Invalid confidence_label. Must be one of: ' + Object.keys(CONFIDENCE_MAP).join(', '),
    });
  }
  if (!facts_layer || !VALID_LAYERS.includes(facts_layer)) {
    return res.status(400).json({
      error: 'Invalid facts_layer. Must be one of: ' + VALID_LAYERS.join(', '),
    });
  }

  // Validate entity exists
  const entity = readEntity(entity_id, req.graphDir);
  if (!entity) return res.status(404).json({ error: `Entity ${entity_id} not found` });

  // Build observation
  const now = new Date().toISOString();
  if (!entity.observations) entity.observations = [];
  const seq = String(entity.observations.length + 1).padStart(3, '0');
  const tsCompact = now.replace(/[-:T]/g, '').slice(0, 14);
  const obsId = `OBS-${entity_id}-${tsCompact}-${seq}`;

  const obs = {
    observation_id: obsId,
    observation: observation.trim(),
    confidence: CONFIDENCE_MAP[confidence_label],
    confidence_label,
    facts_layer,
    layer_number: parseInt(facts_layer.charAt(1)),
    observed_at: now,
    observed_by: req.agentId,
    source: source || null,
  };

  entity.observations.push(obs);

  // Log to provenance chain
  if (!entity.provenance_chain) {
    entity.provenance_chain = { created_at: now, created_by: 'api', source_documents: [], merge_history: [] };
  }
  entity.provenance_chain.merge_history = entity.provenance_chain.merge_history || [];
  entity.provenance_chain.merge_history.push({
    merged_at: now,
    merged_by: req.agentId,
    changes: [`added observation ${obsId}`],
  });

  writeEntity(entity_id, entity, req.graphDir);

  res.status(201).json({
    status: 'created',
    entity_id,
    observation: obs,
  });
});

// POST /api/entity — Create a new entity with auto-generated ID
app.post('/api/entity', apiAuth, (req, res) => {
  const { entity_type, name, summary, attributes, relationships, values, source } = req.body;

  // Validate required fields
  if (!entity_type || !['person', 'business', 'institution'].includes(entity_type)) {
    return res.status(400).json({ error: 'entity_type is required and must be "person", "business", or "institution"' });
  }
  if (!name || typeof name !== 'object') {
    return res.status(400).json({ error: 'name is required and must be an object (e.g. { "full": "John Smith" })' });
  }
  const displayName = entity_type === 'person'
    ? (name.full || name.preferred || '')
    : (name.common || name.legal || '');
  if (!displayName) {
    return res.status(400).json({ error: entity_type === 'person' ? 'name.full is required' : 'name.common or name.legal is required' });
  }

  // Check for duplicate names
  const { similarity } = require('./merge-engine');
  const entities = listEntities(req.graphDir);
  for (const { data } of entities) {
    const e = data.entity || {};
    if (e.entity_type !== entity_type) continue;
    const existingName = entity_type === 'person'
      ? (e.name?.full || '')
      : (e.name?.common || e.name?.legal || '');
    if (existingName && similarity(displayName, existingName) > 0.85) {
      return res.status(409).json({
        error: `Entity "${existingName}" (${e.entity_id}) already exists with similar name. Use PATCH to update.`,
        existing_entity_id: e.entity_id,
      });
    }
  }

  // Generate entity_id
  let initials;
  if (entity_type === 'person') {
    initials = displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  } else if (entity_type === 'institution') {
    initials = 'INST-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  } else {
    initials = 'BIZ-' + displayName.split(/\s+/).map(w => w[0]).join('').toUpperCase();
  }
  const seq = getNextCounter(req.graphDir, entity_type);
  const entityId = `ENT-${initials}-${String(seq).padStart(3, '0')}`;

  // Build v2-compatible entity
  const now = new Date().toISOString();
  const entityData = {
    schema_version: '2.0',
    schema_type: 'context_architecture_entity',
    extraction_metadata: {
      extracted_at: now,
      updated_at: now,
      source_description: source || 'API create',
      extraction_model: 'manual',
      extraction_confidence: 0.8,
      schema_version: '2.0',
    },
    entity: {
      entity_type,
      entity_id: entityId,
      name: { ...name, confidence: 0.9, facts_layer: 1 },
      summary: summary
        ? { value: summary, confidence: 0.8, facts_layer: 2 }
        : { value: '', confidence: 0, facts_layer: 2 },
    },
    attributes: [],
    relationships: [],
    values: [],
    key_facts: [],
    constraints: [],
    observations: [],
    provenance_chain: {
      created_at: now,
      created_by: req.agentId,
      source_documents: source ? [{ source: source, ingested_at: now }] : [],
      merge_history: [],
    },
  };

  // Populate attributes from object
  if (attributes && typeof attributes === 'object') {
    let attrSeq = 1;
    for (const [key, value] of Object.entries(attributes)) {
      const val = Array.isArray(value) ? value.join(', ') : String(value);
      entityData.attributes.push({
        attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
        key, value: val, confidence: 0.8, confidence_label: 'STRONG',
        time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
        source_attribution: { facts_layer: 1, layer_label: 'objective' },
      });
    }
  }

  // Populate relationships
  if (Array.isArray(relationships)) {
    let relSeq = 1;
    for (const rel of relationships) {
      entityData.relationships.push({
        relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
        name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
        sentiment: 'neutral', confidence: 0.8, confidence_label: 'STRONG',
      });
    }
  }

  // Populate values
  if (Array.isArray(values)) {
    let valSeq = 1;
    for (const v of values) {
      const valText = typeof v === 'string' ? v : v.value || '';
      entityData.values.push({
        value_id: `VAL-${String(valSeq++).padStart(3, '0')}`,
        value: valText, confidence: 0.8, confidence_label: 'STRONG',
      });
    }
  }

  writeEntity(entityId, entityData, req.graphDir);

  res.status(201).json({
    status: 'created',
    entity_id: entityId,
    entity_type,
    name: displayName,
    entity: entityData,
  });
});

// DELETE /api/observe/:id — Delete a specific observation
app.delete('/api/observe/:id', apiAuth, (req, res) => {
  const obsId = req.params.id;
  const entities = listEntities(req.graphDir);

  for (const { file, data } of entities) {
    const observations = data.observations || [];
    const idx = observations.findIndex(o => o.observation_id === obsId);
    if (idx !== -1) {
      const removed = observations.splice(idx, 1)[0];
      const entityId = data.entity?.entity_id || file.replace('.json', '');

      // Log to provenance
      if (!data.provenance_chain) {
        data.provenance_chain = { created_at: new Date().toISOString(), created_by: 'api', source_documents: [], merge_history: [] };
      }
      data.provenance_chain.merge_history = data.provenance_chain.merge_history || [];
      data.provenance_chain.merge_history.push({
        merged_at: new Date().toISOString(),
        merged_by: req.agentId,
        changes: [`deleted observation ${obsId}`],
      });

      writeEntity(entityId, data, req.graphDir);

      return res.json({
        status: 'deleted',
        observation_id: obsId,
        entity_id: entityId,
        deleted_observation: removed,
      });
    }
  }

  res.status(404).json({ error: `Observation ${obsId} not found` });
});

// POST /api/extract — Extract from raw text (v2 schema)
app.post('/api/extract', apiAuth, async (req, res) => {
  const { text, type } = req.body;
  if (!text || !type) return res.status(400).json({ error: 'Missing text or type' });
  if (!['person', 'business'].includes(type)) return res.status(400).json({ error: 'Type must be person or business' });

  try {
    // Use v2 extraction via context-engine
    const { execFile } = require('child_process');
    const tmpIn = path.join(__dirname, 'watch-folder', 'output', `_api_input_${Date.now()}.txt`);
    const tmpOut = path.join(__dirname, 'watch-folder', 'output', `_api_output_${Date.now()}.json`);

    fs.writeFileSync(tmpIn, text);

    await new Promise((resolve, reject) => {
      execFile('node', [
        path.join(__dirname, 'context-engine.js'),
        '--input', tmpIn, '--output', tmpOut, '--type', type, '--schema-version', '2.0',
      ], {
        env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
        timeout: 180000,
      }, (err) => err ? reject(err) : resolve());
    });

    const result = JSON.parse(fs.readFileSync(tmpOut, 'utf-8'));

    // Clean up temp input
    fs.unlinkSync(tmpIn);

    // Auto-add to graph if entity_id present
    const entityId = result.entity?.entity_id;
    if (entityId) {
      const existing = readEntity(entityId, req.graphDir);
      if (existing) {
        const { merged } = merge(existing, result);
        if (merged) writeEntity(entityId, merged, req.graphDir);
      } else {
        writeEntity(entityId, result, req.graphDir);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/extract-url — Extract entities from any public URL
app.post('/api/extract-url', apiAuth, async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing "url" field' });
  }
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }

  try {
    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Failed to fetch URL: HTTP ${response.status}` });
    }

    const html = await response.text();

    // Strip HTML to clean text
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (!text || text.length < 50) {
      return res.status(422).json({ error: 'Could not extract meaningful text from this URL. The page may require JavaScript or be empty.' });
    }

    // Truncate if extremely large (keep first 30KB for extraction)
    if (text.length > 30000) {
      text = text.substring(0, 30000);
    }

    const primaryUserName = getPrimaryUserName(req.graphDir);
    const now = new Date().toISOString();
    const sourceAttribution = { type: 'web', url: url, extracted_at: now };

    // Use existing chunking + extraction pipeline
    const chunks = chunkText(text);
    const client = new Anthropic();
    const allExtracted = [];

    for (let ci = 0; ci < chunks.length; ci++) {
      const prompt = buildGenericTextPrompt(chunks[ci], url, ci + 1, chunks.length, primaryUserName);
      const message = await client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 16384,
        messages: [{ role: 'user', content: prompt }],
      });
      const rawResponse = message.content[0].text;
      const parsed = safeParseExtraction(rawResponse, 'url-extract chunk ' + (ci + 1));
      allExtracted.push(...(parsed.entities || []));
    }

    // Convert to v2 entities with source attribution
    const v2Entities = allExtracted.map(extracted => {
      let entityType = extracted.entity_type;
      if (entityType === 'organization') entityType = 'business';
      if (!entityType || !['person', 'business', 'institution'].includes(entityType)) return null;

      const observations = (extracted.observations || []).map(obs => ({
        observation: (obs.text || '').trim(),
        observed_at: now,
        source: 'url_extract',
        source_url: url,
        confidence: 0.6,
        confidence_label: 'MODERATE',
        facts_layer: 'L2_GROUP',
        layer_number: 2,
        observed_by: req.agentId,
        truth_level: 'INFERRED',
      })).filter(o => o.observation);

      const attributes = [];
      if (extracted.attributes && typeof extracted.attributes === 'object') {
        let attrSeq = 1;
        for (const [key, value] of Object.entries(extracted.attributes)) {
          const val = Array.isArray(value) ? value.join(', ') : String(value);
          if (!val) continue;
          attributes.push({
            attribute_id: `ATTR-${String(attrSeq++).padStart(3, '0')}`,
            key, value: val, confidence: 0.6, confidence_label: 'MODERATE',
            time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
            source_attribution: { ...sourceAttribution, facts_layer: 2, layer_label: 'group' },
          });
        }
      }

      const relationships = [];
      if (Array.isArray(extracted.relationships)) {
        let relSeq = 1;
        for (const rel of extracted.relationships) {
          relationships.push({
            relationship_id: `REL-${String(relSeq++).padStart(3, '0')}`,
            name: rel.name || '', relationship_type: rel.relationship || '', context: rel.context || '',
            sentiment: 'neutral', confidence: 0.6, confidence_label: 'MODERATE',
          });
        }
      }

      const v2Entity = {
        schema_version: '2.0',
        schema_type: 'context_architecture_entity',
        extraction_metadata: {
          extracted_at: now, updated_at: now,
          source_description: `url_extract:${url}`,
          extraction_model: 'claude-sonnet-4-5-20250929',
          extraction_confidence: 0.6, schema_version: '2.0',
        },
        entity: {
          entity_type: entityType,
          name: { ...extracted.name, confidence: 0.6, facts_layer: 2 },
          summary: extracted.summary
            ? { value: extracted.summary, confidence: 0.6, facts_layer: 2 }
            : { value: '', confidence: 0, facts_layer: 2 },
        },
        attributes, relationships,
        values: [], key_facts: [], constraints: [],
        observations,
        provenance_chain: {
          created_at: now, created_by: req.agentId,
          source_documents: [{ source: `url_extract:${url}`, url, ingested_at: now }],
          merge_history: [],
        },
      };
      if (extracted.relationship_dimensions) {
        if (typeof extracted.relationship_dimensions.strength === 'number') {
          extracted.relationship_dimensions.visual_tier = computeVisualTier(extracted.relationship_dimensions.strength);
        }
        v2Entity.relationship_dimensions = extracted.relationship_dimensions;
        var wp = computeWikiPage(extracted.relationship_dimensions);
        v2Entity.wiki_page = wp;
        v2Entity.wiki_section = computeWikiSection(extracted.relationship_dimensions, wp);
      }
      if (extracted.descriptor) v2Entity.descriptor = extracted.descriptor;
      if (extracted.org_dimensions) {
        v2Entity.org_dimensions = extracted.org_dimensions;
        if (extracted.org_dimensions.org_category) {
          v2Entity.attributes.push({
            attribute_id: 'ATTR-ORG-CAT',
            key: 'org_category', value: extracted.org_dimensions.org_category,
            confidence: 0.8, confidence_label: 'HIGH',
            time_decay: { stability: 'stable', captured_date: now.slice(0, 10) },
            source_attribution: { ...sourceAttribution, facts_layer: 2, layer_label: 'group' },
          });
        }
      }
      return v2Entity;
    }).filter(Boolean);

    // Return entities for preview/approval (same pattern as file upload preview)
    const previewList = v2Entities.map(e => {
      const ent = e.entity || {};
      const type = ent.entity_type || '';
      return {
        entity_type: type,
        name: type === 'person' ? (ent.name?.full || '') : (ent.name?.common || ent.name?.legal || ''),
        summary: ent.summary?.value || '',
        attribute_count: (e.attributes || []).length,
        relationship_count: (e.relationships || []).length,
        observation_count: (e.observations || []).length,
      };
    });

    res.json({
      entities: v2Entities,
      preview: previewList,
      source_url: url,
      source_type: 'web',
      entity_count: v2Entities.length,
    });

  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      return res.status(504).json({ error: 'URL fetch timed out after 15 seconds' });
    }
    console.error('[extract-url] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/entities/category/:category — List entities by wiki category
app.get('/api/entities/category/:category', apiAuth, (req, res) => {
  const category = req.params.category.toLowerCase();
  const validCategories = ['family', 'friends', 'professional', 'other', 'career', 'education', 'affiliations', 'services'];
  if (!validCategories.includes(category)) {
    return res.status(400).json({ error: `Invalid category. Valid: ${validCategories.join(', ')}` });
  }

  const entities = listEntities(req.graphDir);
  const results = [];

  for (const { data } of entities) {
    const e = data.entity || {};
    const type = e.entity_type;
    const name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || e.name?.full || '');

    // Person categories: family, friends, professional, other
    if (type === 'person') {
      const page = computeWikiPage(data.relationship_dimensions);
      if (page === category) {
        const r = { entity_id: e.entity_id, entity_type: type, name, summary: e.summary?.value || '', observation_count: (data.observations || []).length, relationship_count: (data.relationships || []).length };
        if (data.relationship_dimensions) r.relationship_dimensions = data.relationship_dimensions;
        if (data.descriptor) r.descriptor = data.descriptor;
        r.attributes = (data.attributes || []).map(a => ({ key: a.key, value: a.value }));
        r.relationships = (data.relationships || []).map(rel => ({ name: rel.name, relationship_type: rel.relationship_type, context: rel.context }));
        results.push(r);
      }
    }

    // Org categories: career, education, affiliations, services
    if (type === 'organization' || type === 'business' || type === 'institution') {
      const orgCat = (data.org_dimensions?.org_category || '').toLowerCase();
      const attrs = data.attributes || [];
      const attrCat = (attrs.find(a => a.key === 'org_category') || {}).value || '';
      if (orgCat === category || attrCat.toLowerCase() === category) {
        results.push({ entity_id: e.entity_id, entity_type: type, name, summary: e.summary?.value || '', attributes: attrs.map(a => ({ key: a.key, value: a.value })), org_dimensions: data.org_dimensions || null });
      }
    }
  }

  res.json({ category, count: results.length, results });
});

// GET /api/graph/stats — Knowledge graph health check
app.get('/api/graph/stats', apiAuth, (req, res) => {
  const entities = listEntities(req.graphDir);
  let lastUpdated = null;
  let totalMerges = 0;
  const typeCounts = { person: 0, business: 0, institution: 0 };

  for (const { data } of entities) {
    const type = data.entity?.entity_type;
    if (type && typeCounts[type] !== undefined) typeCounts[type]++;

    const extractedAt = data.extraction_metadata?.extracted_at;
    if (extractedAt && (!lastUpdated || extractedAt > lastUpdated)) {
      lastUpdated = extractedAt;
    }

    totalMerges += (data.provenance_chain?.merge_history || []).length;
  }

  res.json({
    status: 'healthy',
    entity_count: entities.length,
    type_counts: typeCounts,
    total_merges: totalMerges,
    last_updated: lastUpdated,
    graph_directory: GRAPH_DIR,
  });
});

// --- Share API routes ---

// POST /api/share — Create a new share link for a Career Lite entity
app.post('/api/share', apiAuth, shareLimiter, (req, res) => {
  const { entityId, sections, expiresInDays } = req.body;

  // Validate entityId
  if (!entityId || typeof entityId !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid entityId' });
  }
  if (!/^[\w-]+$/.test(entityId)) {
    return res.status(400).json({ error: 'Invalid entityId format' });
  }

  // Validate sections
  const allowedSections = ['summary', 'experience', 'education', 'skills', 'connections'];
  if (sections !== undefined && !Array.isArray(sections)) {
    return res.status(400).json({ error: 'sections must be an array of strings' });
  }
  if (sections && !sections.every(s => typeof s === 'string' && allowedSections.includes(s))) {
    return res.status(400).json({ error: 'Invalid section. Allowed: ' + allowedSections.join(', ') });
  }

  // Validate expiresInDays
  const validExpiries = [7, 30, 90, 365];
  if (expiresInDays !== undefined && !validExpiries.includes(expiresInDays)) {
    return res.status(400).json({ error: 'expiresInDays must be one of: ' + validExpiries.join(', ') });
  }

  const entityPath = path.join(req.graphDir, entityId + '.json');
  if (!fs.existsSync(entityPath)) return res.status(404).json({ error: 'Entity not found' });

  const entityData = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
  if (!entityData.career_lite || entityData.career_lite.interface !== 'career-lite') {
    return res.status(400).json({ error: 'Entity is not a Career Lite profile' });
  }

  const shareId = crypto.randomBytes(9).toString('base64url');
  const now = new Date();
  const days = expiresInDays || 30;
  const expiresAt = new Date(now.getTime() + days * 86400000).toISOString();

  const selectedSections = (sections || ['summary', 'experience', 'education', 'skills'])
    .filter(s => allowedSections.includes(s));

  const share = {
    shareId,
    tenantId: req.tenantId,
    entityId,
    sections: selectedSections,
    createdAt: now.toISOString(),
    expiresAt,
  };

  const shares = loadShares(req.graphDir);
  shares.push(share);
  saveShares(req.graphDir, shares);

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const shareUrl = `${protocol}://${host}/shared/${shareId}`;

  res.json({ shareId, shareUrl, sections: selectedSections, expiresAt });
});

// GET /api/shares/:entityId — List non-expired shares for an entity
app.get('/api/shares/:entityId', apiAuth, (req, res) => {
  const shares = loadShares(req.graphDir);
  const now = new Date().toISOString();
  const active = shares.filter(s => s.entityId === req.params.entityId && s.expiresAt > now);
  res.json(active);
});

// DELETE /api/share/:shareId — Revoke a share
app.delete('/api/share/:shareId', apiAuth, (req, res) => {
  const shares = loadShares(req.graphDir);
  const idx = shares.findIndex(s => s.shareId === req.params.shareId);
  if (idx === -1) return res.status(404).json({ error: 'Share not found' });
  shares.splice(idx, 1);
  saveShares(req.graphDir, shares);
  res.json({ ok: true });
});

// --- Serve the UI ---

// Admin migration page
app.get('/admin/migrate', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dimension Migration</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; color: #333; padding: 40px; }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 24px; }
  .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .card h2 { font-size: 1.1rem; margin-bottom: 12px; }
  .stat { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; }
  .stat:last-child { border-bottom: none; }
  .stat-label { color: #666; }
  .stat-value { font-weight: 600; }
  .btn { display: inline-block; padding: 10px 24px; border-radius: 6px; border: none; font-size: 0.95rem; font-weight: 600; cursor: pointer; }
  .btn-primary { background: #6366f1; color: white; }
  .btn-primary:hover { background: #5558e6; }
  .btn-primary:disabled { background: #ccc; cursor: not-allowed; }
  .progress { margin-top: 16px; display: none; }
  .progress-bar { height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; }
  .progress-fill { height: 100%; background: #6366f1; transition: width 0.3s; width: 0%; }
  .progress-text { font-size: 0.85rem; color: #666; margin-top: 8px; }
  .results { margin-top: 16px; display: none; }
  .results pre { background: #f8f8f8; padding: 12px; border-radius: 6px; font-size: 0.82rem; overflow-x: auto; white-space: pre-wrap; }
  .tier-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75rem; font-weight: 600; margin-right: 4px; }
  .tier-gold { background: #FFFDF5; border: 1px solid #D4A017; color: #8B6914; }
  .tier-green { background: #E8F5E9; border: 1px solid #4CAF50; color: #2E7D32; }
  .tier-neutral { background: #F5F5F5; border: 1px solid #999; color: #666; }
  .tier-muted { background: #FAFAFA; border: 1px solid #ddd; color: #999; }
  .error { color: #d32f2f; font-size: 0.85rem; margin-top: 8px; }
</style>
</head>
<body>
<div class="container">
  <h1>Dimension Migration</h1>

  <div class="card" id="countsCard">
    <h2>Entity Counts</h2>
    <div id="counts"><div style="color:#999">Loading...</div></div>
  </div>

  <div class="card">
    <h2>Run Migration</h2>
    <p style="color:#666;font-size:0.9rem;margin-bottom:12px;">Sends each entity to the LLM for dimension analysis. This will overwrite existing dimensions.</p>
    <button class="btn btn-primary" id="runBtn" onclick="runMigration()">Run Migration</button>
    <div class="progress" id="progress">
      <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
      <div class="progress-text" id="progressText">Starting...</div>
    </div>
    <div class="error" id="errorText"></div>
  </div>

  <div class="card results" id="resultsCard">
    <h2>Results</h2>
    <div id="resultsContent"></div>
  </div>
</div>

<script>
var API_KEY = '';

function getApiKey() {
  if (API_KEY) return API_KEY;
  API_KEY = prompt('Enter API key (x-context-api-key):');
  return API_KEY;
}

function fetchCounts() {
  var key = getApiKey();
  if (!key) return;
  fetch('/api/search?q=*', { headers: { 'x-context-api-key': key } })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var people = 0, orgs = 0, withDims = 0;
      var results = data.results || [];
      for (var i = 0; i < results.length; i++) {
        if (results[i].entity_type === 'person') {
          people++;
          if (results[i].relationship_dimensions) withDims++;
        }
        if (results[i].entity_type === 'organization' || results[i].entity_type === 'business' || results[i].entity_type === 'institution') orgs++;
      }
      var html = '';
      html += '<div class="stat"><span class="stat-label">People</span><span class="stat-value">' + people + '</span></div>';
      html += '<div class="stat"><span class="stat-label">Organizations</span><span class="stat-value">' + orgs + '</span></div>';
      html += '<div class="stat"><span class="stat-label">With dimensions</span><span class="stat-value">' + withDims + ' / ' + people + '</span></div>';
      document.getElementById('counts').innerHTML = html;
    });
}

function runMigration() {
  var key = getApiKey();
  if (!key) return;
  var btn = document.getElementById('runBtn');
  btn.disabled = true;
  btn.textContent = 'Running...';
  document.getElementById('progress').style.display = 'block';
  document.getElementById('resultsCard').style.display = 'none';
  document.getElementById('errorText').textContent = '';

  // Poll progress
  var pollId = setInterval(function() {
    fetch('/api/generate-dimensions/status', { headers: { 'x-context-api-key': key } })
      .then(function(r) { return r.json(); })
      .then(function(status) {
        if (status.running) {
          var pct = status.total > 0 ? Math.round((status.current / status.total) * 100) : 0;
          document.getElementById('progressFill').style.width = pct + '%';
          document.getElementById('progressText').textContent = status.phase + ': ' + status.current + ' / ' + status.total + ' (' + pct + '%)';
        }
      });
  }, 2000);

  fetch('/api/generate-dimensions', {
    method: 'POST',
    headers: { 'x-context-api-key': key, 'Content-Type': 'application/json' },
    body: '{}'
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      clearInterval(pollId);
      document.getElementById('progressFill').style.width = '100%';
      document.getElementById('progressText').textContent = 'Complete!';
      btn.disabled = false;
      btn.textContent = 'Run Migration';
      showResults(data);
      fetchCounts();
    })
    .catch(function(err) {
      clearInterval(pollId);
      document.getElementById('errorText').textContent = 'Error: ' + err.message;
      btn.disabled = false;
      btn.textContent = 'Run Migration';
    });
}

function showResults(data) {
  var card = document.getElementById('resultsCard');
  card.style.display = 'block';
  var html = '<p style="font-weight:600;margin-bottom:12px;">' + (data.summary || '') + '</p>';

  // People breakdown
  if (data.people) {
    html += '<h3 style="font-size:0.95rem;margin:12px 0 6px;">People</h3>';
    var cats = ['family', 'friends', 'professional', 'other'];
    for (var i = 0; i < cats.length; i++) {
      var arr = data.people[cats[i]] || [];
      if (arr.length > 0) html += '<div class="stat"><span class="stat-label">' + cats[i].charAt(0).toUpperCase() + cats[i].slice(1) + '</span><span class="stat-value">' + arr.length + '</span></div>';
    }
  }

  // Orgs breakdown
  if (data.orgs) {
    html += '<h3 style="font-size:0.95rem;margin:12px 0 6px;">Organizations</h3>';
    var orgCats = ['career', 'education', 'affiliations', 'services', 'deleted'];
    for (var i = 0; i < orgCats.length; i++) {
      var arr = data.orgs[orgCats[i]] || [];
      if (arr.length > 0) html += '<div class="stat"><span class="stat-label">' + orgCats[i].charAt(0).toUpperCase() + orgCats[i].slice(1) + (orgCats[i] === 'deleted' ? ' (flagged)' : '') + '</span><span class="stat-value">' + arr.length + '</span></div>';
    }
  }

  // Tiers
  if (data.tiers) {
    html += '<h3 style="font-size:0.95rem;margin:12px 0 6px;">Visual Tiers</h3>';
    html += '<div style="margin:4px 0;">';
    html += '<span class="tier-badge tier-gold">Gold: ' + (data.tiers.gold || 0) + '</span>';
    html += '<span class="tier-badge tier-green">Green: ' + (data.tiers.green || 0) + '</span>';
    html += '<span class="tier-badge tier-neutral">Neutral: ' + (data.tiers.neutral || 0) + '</span>';
    html += '<span class="tier-badge tier-muted">Muted: ' + (data.tiers.muted || 0) + '</span>';
    html += '</div>';
  }

  // Errors
  if (data.errors && data.errors.length > 0) {
    html += '<h3 style="font-size:0.95rem;margin:12px 0 6px;color:#d32f2f;">Errors (' + data.errors.length + ')</h3>';
    html += '<pre>' + data.errors.join('\\n') + '</pre>';
  }

  document.getElementById('resultsContent').innerHTML = html;
}

fetchCounts();
</script>
</body>
</html>`);
});

app.get('/openai-actions-spec.yaml', (req, res) => {
  res.setHeader('Content-Type', 'text/yaml');
  res.sendFile(path.join(__dirname, 'openai-actions-spec.yaml'));
});

app.get('/', (req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Engine v2</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 40px 24px;
  }

  header {
    text-align: center;
    margin-bottom: 48px;
  }

  h1 {
    font-size: 2.4rem;
    font-weight: 700;
    color: #ffffff;
    letter-spacing: -0.02em;
  }

  h1 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .subtitle {
    font-size: 1.1rem;
    color: #6b7280;
    margin-top: 8px;
  }

  .workspace {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 24px;
    min-height: 500px;
  }

  .panel {
    background: #12121a;
    border: 1px solid #1e1e2e;
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-header {
    padding: 16px 20px;
    border-bottom: 1px solid #1e1e2e;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .panel-label {
    font-size: 0.85rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
  }

  textarea {
    flex: 1;
    background: transparent;
    border: none;
    color: #e0e0e0;
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.9rem;
    line-height: 1.6;
    padding: 20px;
    resize: none;
    outline: none;
  }

  textarea::placeholder { color: #3a3a4a; }

  .buttons {
    display: flex;
    gap: 12px;
    justify-content: center;
    margin: 24px 0;
  }

  button {
    padding: 12px 28px;
    border: none;
    border-radius: 8px;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-person {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: white;
  }

  .btn-person:hover:not(:disabled) {
    background: linear-gradient(135deg, #4f46e5, #7c3aed);
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }

  .btn-business {
    background: linear-gradient(135deg, #0ea5e9, #06b6d4);
    color: white;
  }

  .btn-business:hover:not(:disabled) {
    background: linear-gradient(135deg, #0284c7, #0891b2);
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(14, 165, 233, 0.3);
  }

  .result-area {
    flex: 1;
    padding: 20px;
    overflow: auto;
  }

  pre {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    font-size: 0.85rem;
    line-height: 1.7;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #3a3a4a;
    font-size: 0.95rem;
    text-align: center;
    padding: 40px;
    line-height: 1.6;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    flex-direction: column;
    gap: 16px;
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid #1e1e2e;
    border-top-color: #8b5cf6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-text { color: #6b7280; font-size: 0.9rem; }

  .stats {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  .stat {
    background: #1a1a2e;
    border: 1px solid #2a2a3e;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 0.8rem;
  }

  .stat-value {
    color: #a78bfa;
    font-weight: 700;
    margin-right: 4px;
  }

  .stat-label { color: #6b7280; }

  /* JSON syntax highlighting */
  .json-key { color: #8b5cf6; }
  .json-string { color: #34d399; }
  .json-number { color: #f59e0b; }
  .json-bool { color: #f472b6; }
  .json-null { color: #6b7280; }
  .json-bracket { color: #6b7280; }

  .timer {
    font-size: 0.8rem;
    color: #4b5563;
  }

  /* v2 structured view */
  .entity-card {
    background: #1a1a2e;
    border: 1px solid #2a2a3e;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }

  .entity-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
    flex-wrap: wrap;
  }

  .entity-name {
    font-size: 1.1rem;
    font-weight: 700;
    color: #fff;
  }

  .entity-id {
    font-size: 0.7rem;
    color: #6366f1;
    font-family: monospace;
    background: rgba(99,102,241,0.1);
    padding: 2px 8px;
    border-radius: 4px;
  }

  .entity-summary {
    font-size: 0.85rem;
    color: #9ca3af;
    line-height: 1.5;
    margin-top: 6px;
  }

  .section {
    margin-bottom: 12px;
  }

  .section-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b7280;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid #1e1e2e;
  }

  .item-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 5px 0;
    font-size: 0.82rem;
    flex-wrap: wrap;
  }

  .item-key {
    color: #8b5cf6;
    font-weight: 600;
    min-width: 70px;
  }

  .item-value {
    color: #e0e0e0;
    flex: 1;
  }

  .badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .badge-verified { background: rgba(52,211,153,0.15); color: #34d399; }
  .badge-strong { background: rgba(96,165,250,0.15); color: #60a5fa; }
  .badge-moderate { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .badge-speculative { background: rgba(251,146,60,0.15); color: #fb923c; }
  .badge-uncertain { background: rgba(239,68,68,0.15); color: #ef4444; }

  .badge-time {
    background: rgba(139,92,246,0.1);
    color: #a78bfa;
    font-size: 0.6rem;
  }

  .badge-layer {
    font-size: 0.6rem;
  }

  .badge-layer-1 { background: rgba(52,211,153,0.1); color: #6ee7b7; }
  .badge-layer-2 { background: rgba(96,165,250,0.1); color: #93c5fd; }
  .badge-layer-3 { background: rgba(244,114,182,0.1); color: #f9a8d4; }

  .rel-sentiment {
    font-size: 0.65rem;
    padding: 1px 6px;
    border-radius: 4px;
  }

  .sentiment-positive { background: rgba(52,211,153,0.12); color: #34d399; }
  .sentiment-neutral { background: rgba(156,163,175,0.12); color: #9ca3af; }
  .sentiment-strained { background: rgba(239,68,68,0.12); color: #ef4444; }
  .sentiment-complex { background: rgba(251,191,36,0.12); color: #fbbf24; }
  .sentiment-unknown { background: rgba(107,114,128,0.12); color: #6b7280; }

  .constraint-card {
    background: rgba(239,68,68,0.05);
    border: 1px solid rgba(239,68,68,0.15);
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 6px;
    font-size: 0.8rem;
  }

  .constraint-name { color: #fca5a5; font-weight: 600; }
  .constraint-desc { color: #9ca3af; margin-top: 3px; }

  .view-toggle {
    display: flex;
    gap: 4px;
  }

  .view-btn {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 3px 10px;
    font-size: 0.7rem;
    border-radius: 4px;
    cursor: pointer;
  }

  .view-btn.active {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .json-view { display: none; }
  .json-view.active { display: block; }
  .structured-view { display: none; }
  .structured-view.active { display: block; }

  .provenance {
    font-size: 0.75rem;
    color: #4b5563;
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #1e1e2e;
  }

  .provenance code {
    color: #6366f1;
    font-size: 0.7rem;
  }

  .btn-sample {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 6px 14px;
    font-size: 0.8rem;
  }

  .btn-sample:hover:not(:disabled) {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .output-actions {
    display: flex;
    gap: 8px;
  }

  .btn-action {
    background: transparent;
    border: 1px solid #2a2a3e;
    color: #6b7280;
    padding: 6px 14px;
    font-size: 0.75rem;
    display: none;
  }

  .btn-action:hover:not(:disabled) {
    border-color: #8b5cf6;
    color: #a78bfa;
  }

  .btn-action.visible { display: inline-block; }

  .btn-action.copied {
    border-color: #34d399;
    color: #34d399;
  }

  footer {
    text-align: center;
    padding: 40px 24px 24px;
    color: #3a3a4a;
    font-size: 0.8rem;
  }

  footer a {
    color: #6b7280;
    text-decoration: none;
  }

  footer a:hover { color: #a78bfa; }

  @media (max-width: 768px) {
    .workspace { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>Context Engine</span></h1>
    <p class="subtitle">Turn messy text into structured intelligence</p>
  </header>

  <div class="workspace">
    <div class="panel">
      <div class="panel-header">
        <span class="panel-label">Input</span>
        <button class="btn-sample" onclick="loadSample()">Load Sample</button>
      </div>
      <textarea id="input" placeholder="Paste unstructured text about a person or business here..."></textarea>
    </div>

    <div class="panel">
      <div class="panel-header">
        <span class="panel-label">Structured Output</span>
        <div class="output-actions">
          <div class="view-toggle" id="view-toggle" style="display:none;">
            <button class="view-btn active" data-view="structured" onclick="toggleView('structured')">Structured</button>
            <button class="view-btn" data-view="json" onclick="toggleView('json')">JSON</button>
          </div>
          <button class="btn-action" id="btn-copy" onclick="copyJSON()">Copy JSON</button>
          <button class="btn-action" id="btn-download" onclick="downloadJSON()">Download JSON</button>
          <span class="timer" id="timer"></span>
        </div>
      </div>
      <div class="result-area" id="result">
        <div class="empty-state">
          Paste text on the left and click<br>Extract Person or Extract Business
        </div>
      </div>
    </div>
  </div>

  <div class="buttons">
    <button class="btn-person" id="btn-person" onclick="extract('person')">Extract Person</button>
    <button class="btn-business" id="btn-business" onclick="extract('business')">Extract Business</button>
  </div>
</div>

<footer>
  Built by CJ Mitchell | Context Architecture | <a href="https://github.com/flawlesstracks/context-engine" target="_blank">github.com/flawlesstracks/context-engine</a>
</footer>

<script>
var lastResult = null;
var currentView = 'structured';

var SAMPLE_TEXT = "Dr. Sarah Chen is a 38-year-old AI research lead at Meridian Labs in San Francisco. She previously spent six years at DeepMind working on reinforcement learning before joining Meridian in 2023 to build their applied AI division. Sarah holds a PhD from MIT in computational neuroscience and a BS from Stanford in computer science. She is known for her work on multi-agent systems and has published over 40 papers. Her close collaborators include Dr. James Park, CTO of Meridian Labs, and Professor Ana Ruiz at UC Berkeley who co-authored several papers with her. Sarah values rigorous experimentation and open science. She prefers written communication over meetings and is known for detailed technical memos. Outside of work she mentors undergrad researchers through a program called NextGen AI and is an avid rock climber.";

function loadSample() {
  document.getElementById('input').value = SAMPLE_TEXT;
}

function showActionButtons() {
  document.getElementById('btn-copy').classList.add('visible');
  document.getElementById('btn-download').classList.add('visible');
  document.getElementById('view-toggle').style.display = 'flex';
}

function hideActionButtons() {
  document.getElementById('btn-copy').classList.remove('visible');
  document.getElementById('btn-download').classList.remove('visible');
  document.getElementById('view-toggle').style.display = 'none';
}

async function copyJSON() {
  if (!lastResult) return;
  var btn = document.getElementById('btn-copy');
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  btn.textContent = 'Copied!';
  btn.classList.add('copied');
  setTimeout(function() {
    btn.textContent = 'Copy JSON';
    btn.classList.remove('copied');
  }, 2000);
}

function downloadJSON() {
  if (!lastResult) return;
  var e = lastResult.entity || {};
  var name = e.name?.full || e.name?.common || e.name?.legal || 'context';
  var filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-context.json';
  var blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toggleView(view) {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(function(b) {
    b.classList.toggle('active', b.dataset.view === view);
  });
  var sv = document.querySelector('.structured-view');
  var jv = document.querySelector('.json-view');
  if (sv) sv.classList.toggle('active', view === 'structured');
  if (jv) jv.classList.toggle('active', view === 'json');
}

function esc(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function confidenceBadge(conf, label) {
  if (conf == null) return '';
  var cls = 'badge-moderate';
  var lbl = label || '';
  if (conf >= 0.90) { cls = 'badge-verified'; lbl = lbl || 'VERIFIED'; }
  else if (conf >= 0.75) { cls = 'badge-strong'; lbl = lbl || 'STRONG'; }
  else if (conf >= 0.50) { cls = 'badge-moderate'; lbl = lbl || 'MODERATE'; }
  else if (conf >= 0.25) { cls = 'badge-speculative'; lbl = lbl || 'SPECULATIVE'; }
  else { cls = 'badge-uncertain'; lbl = lbl || 'UNCERTAIN'; }
  return '<span class="badge ' + cls + '">' + esc(lbl) + ' ' + conf.toFixed(2) + '</span>';
}

function timeBadge(decay) {
  if (!decay) return '';
  return '<span class="badge badge-time">' + esc(decay) + '</span>';
}

function layerBadge(layer) {
  if (!layer) return '';
  var labels = { 1: 'Objective', 2: 'Group', 3: 'Personal' };
  return '<span class="badge badge-layer badge-layer-' + layer + '">L' + layer + ' ' + esc(labels[layer] || '') + '</span>';
}

function sentimentBadge(sentiment) {
  if (!sentiment) return '';
  var cls = 'sentiment-' + sentiment.toLowerCase().replace(/[^a-z]/g, '');
  if (!['positive','neutral','strained','complex','unknown'].some(function(s) { return cls === 'sentiment-' + s; })) {
    cls = 'sentiment-neutral';
  }
  return '<span class="rel-sentiment ' + cls + '">' + esc(sentiment) + '</span>';
}

function syntaxHighlight(json) {
  var str = JSON.stringify(json, null, 2);
  return str.replace(
    /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
    function(match) {
      var cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'json-key';
        } else {
          cls = 'json-string';
        }
      } else if (/true|false/.test(match)) {
        cls = 'json-bool';
      } else if (/null/.test(match)) {
        cls = 'json-null';
      }
      return '<span class="' + cls + '">' + match + '</span>';
    }
  );
}

function buildStructuredView(data) {
  var html = '';
  var e = data.entity || {};
  var meta = data.extraction_metadata || {};
  var type = e.entity_type || 'person';

  // Entity card
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  html += '<div class="entity-card">';
  html += '<div class="entity-card-header">';
  html += '<span class="entity-name">' + esc(name) + '</span>';
  if (e.entity_id) html += '<span class="entity-id">' + esc(e.entity_id) + '</span>';
  html += confidenceBadge(meta.extraction_confidence);
  html += '</div>';
  if (e.summary?.value) {
    html += '<div class="entity-summary">' + esc(e.summary.value) + '</div>';
  }
  html += '</div>';

  // Stats bar
  var stats = [];
  stats.push({ v: (data.attributes || []).length, l: 'attributes' });
  stats.push({ v: (data.relationships || []).length, l: 'relationships' });
  stats.push({ v: (data.values || []).length, l: 'values' });
  stats.push({ v: (data.key_facts || []).length, l: 'key facts' });
  if ((data.constraints || []).length > 0) stats.push({ v: data.constraints.length, l: 'constraints' });
  if ((data.action_suggestions || []).length > 0) stats.push({ v: data.action_suggestions.length, l: 'actions' });
  html += '<div class="stats">' + stats.map(function(s) {
    return '<div class="stat"><span class="stat-value">' + s.v + '</span><span class="stat-label">' + s.l + '</span></div>';
  }).join('') + '</div>';

  // Attributes
  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    html += '<div class="section"><div class="section-title">Attributes</div>';
    attrs.forEach(function(a) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(a.key || '') + '</span>';
      html += '<span class="item-value">' + esc(String(a.value || '')) + '</span>';
      html += confidenceBadge(a.confidence, a.confidence_label);
      html += timeBadge(a.time_decay);
      html += layerBadge(a.facts_layer);
      html += '</div>';
    });
    html += '</div>';
  }

  // Relationships
  var rels = data.relationships || [];
  if (rels.length > 0) {
    html += '<div class="section"><div class="section-title">Relationships</div>';
    rels.forEach(function(r) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(r.name || '') + '</span>';
      html += '<span class="item-value">' + esc(r.relationship_type || '') + (r.context ? ' — ' + esc(r.context) : '') + '</span>';
      html += sentimentBadge(r.sentiment);
      html += confidenceBadge(r.confidence, r.confidence_label);
      html += '</div>';
    });
    html += '</div>';
  }

  // Values
  var vals = data.values || [];
  if (vals.length > 0) {
    html += '<div class="section"><div class="section-title">Values</div>';
    vals.forEach(function(v) {
      html += '<div class="item-row">';
      html += '<span class="item-key">' + esc(v.value || '') + '</span>';
      html += '<span class="item-value">' + esc(v.interpretation || '') + '</span>';
      html += confidenceBadge(v.confidence, v.confidence_label);
      html += timeBadge(v.time_decay);
      html += '</div>';
    });
    html += '</div>';
  }

  // Key Facts
  var facts = data.key_facts || [];
  if (facts.length > 0) {
    html += '<div class="section"><div class="section-title">Key Facts</div>';
    facts.forEach(function(f) {
      html += '<div class="item-row">';
      html += '<span class="item-value">' + esc(f.fact || '') + '</span>';
      html += confidenceBadge(f.confidence, f.confidence_label);
      html += timeBadge(f.time_decay);
      html += layerBadge(f.facts_layer);
      if (f.category) html += '<span class="badge badge-time">' + esc(f.category) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Constraints
  var constraints = data.constraints || [];
  if (constraints.length > 0) {
    html += '<div class="section"><div class="section-title">Constraints</div>';
    constraints.forEach(function(c) {
      html += '<div class="constraint-card">';
      html += '<div class="constraint-name">' + esc(c.type || c.constraint_id || '') + '</div>';
      html += '<div class="constraint-desc">' + esc(c.description || '') + '</div>';
      if (c.linked_entities && c.linked_entities.length > 0) {
        html += '<div class="constraint-desc" style="margin-top:4px;color:#6366f1;">Linked: ' + c.linked_entities.map(function(le) { return esc(le); }).join(', ') + '</div>';
      }
      html += '</div>';
    });
    html += '</div>';
  }

  // Action Suggestions
  var actions = data.action_suggestions || [];
  if (actions.length > 0) {
    html += '<div class="section"><div class="section-title">Action Suggestions</div>';
    actions.forEach(function(a) {
      html += '<div class="item-row">';
      html += '<span class="item-key" style="color:#34d399;">' + esc(a.priority || '') + '</span>';
      html += '<span class="item-value">' + esc(a.action || a.suggestion || '') + '</span>';
      if (a.rationale) html += '<span class="badge badge-time">' + esc(a.rationale) + '</span>';
      html += '</div>';
    });
    html += '</div>';
  }

  // Provenance
  var prov = data.provenance_chain || {};
  if (prov.created_at || prov.source_documents?.length > 0) {
    html += '<div class="provenance">';
    if (prov.created_at) html += 'Created: <code>' + esc(prov.created_at) + '</code>';
    if (prov.source_documents?.length > 0) {
      html += ' | Sources: <code>' + prov.source_documents.length + '</code>';
    }
    if (meta.schema_version) html += ' | Schema: <code>v' + esc(meta.schema_version) + '</code>';
    if (meta.source_hash) html += ' | Hash: <code>' + esc(meta.source_hash.slice(0, 12)) + '...</code>';
    html += '</div>';
  }

  return html;
}

async function extract(type) {
  var text = document.getElementById('input').value.trim();
  if (!text) return;

  var btnP = document.getElementById('btn-person');
  var btnB = document.getElementById('btn-business');
  var result = document.getElementById('result');
  var timer = document.getElementById('timer');

  btnP.disabled = true;
  btnB.disabled = true;
  lastResult = null;
  hideActionButtons();
  result.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Extracting ' + type + ' context (v2)...</div></div>';

  var start = Date.now();
  var interval = setInterval(function() {
    timer.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';
  }, 100);

  try {
    var res = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, type: type })
    });
    var data = await res.json();
    clearInterval(interval);
    timer.textContent = ((Date.now() - start) / 1000).toFixed(1) + 's';

    if (data.error) {
      result.innerHTML = '<div class="empty-state" style="color:#ef4444;">Error: ' + data.error + '</div>';
    } else {
      lastResult = data;
      showActionButtons();
      var structuredHtml = buildStructuredView(data);
      var jsonHtml = '<pre>' + syntaxHighlight(data) + '</pre>';
      result.innerHTML = '<div class="structured-view active">' + structuredHtml + '</div>' +
                         '<div class="json-view">' + jsonHtml + '</div>';
      currentView = 'structured';
      document.querySelectorAll('.view-btn').forEach(function(b) {
        b.classList.toggle('active', b.dataset.view === 'structured');
      });
    }
  } catch (err) {
    clearInterval(interval);
    result.innerHTML = '<div class="empty-state" style="color:#ef4444;">Request failed: ' + err.message + '</div>';
  }

  btnP.disabled = false;
  btnB.disabled = false;
}
</script>
</body>
</html>`;

// --- Ingest UI ---

app.get('/ingest', (req, res) => {
  res.send(INGEST_HTML);
});

const INGEST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ChatGPT Import — Context Engine</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
  }
  .container { max-width: 720px; margin: 0 auto; padding: 40px 24px; }
  header { text-align: center; margin-bottom: 48px; }
  h1 { font-size: 2.2rem; font-weight: 700; color: #fff; letter-spacing: -0.02em; }
  h1 span {
    background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle { font-size: 1rem; color: #6b7280; margin-top: 8px; }
  .steps {
    font-size: 0.8rem; color: #4b5563; margin-top: 16px; line-height: 1.7;
    text-align: left; max-width: 480px; margin-left: auto; margin-right: auto;
  }
  .steps strong { color: #6b7280; }

  .field { margin-bottom: 20px; }
  .field label {
    display: block; font-size: 0.8rem; font-weight: 600; color: #6b7280;
    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;
  }
  .field input {
    width: 100%; padding: 10px 14px; background: #12121a;
    border: 1px solid #1e1e2e; border-radius: 8px; color: #e0e0e0;
    font-size: 0.9rem; outline: none; font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .field input:focus { border-color: #6366f1; }

  .drop-zone {
    border: 2px dashed #2a2a3e; border-radius: 12px;
    padding: 48px 24px; text-align: center; cursor: pointer;
    transition: all 0.2s; background: #12121a; margin-bottom: 24px;
  }
  .drop-zone:hover, .drop-zone.dragover {
    border-color: #6366f1; background: rgba(99, 102, 241, 0.05);
  }
  .drop-zone.has-file {
    border-color: #34d399; background: rgba(52, 211, 153, 0.05);
  }
  .drop-icon { font-size: 1.6rem; margin-bottom: 10px; color: #3a3a4a; }
  .drop-text { color: #6b7280; font-size: 0.9rem; }
  .drop-text strong { color: #a78bfa; }
  .file-info {
    color: #34d399; font-size: 0.85rem; margin-top: 10px;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .btn {
    width: 100%; padding: 14px; border: none; border-radius: 8px;
    font-size: 1rem; font-weight: 600; cursor: pointer;
    background: linear-gradient(135deg, #6366f1, #8b5cf6); color: white;
    transition: all 0.2s;
  }
  .btn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 20px rgba(99, 102, 241, 0.3);
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .progress-section { display: none; margin: 24px 0; }
  .progress-section.active { display: block; }
  .progress-bar-bg {
    width: 100%; height: 8px; background: #1e1e2e;
    border-radius: 4px; overflow: hidden; margin-bottom: 12px;
  }
  .progress-bar {
    height: 100%; background: linear-gradient(90deg, #6366f1, #8b5cf6);
    border-radius: 4px; transition: width 0.3s; width: 0%;
  }
  .progress-text { font-size: 0.85rem; color: #9ca3af; }
  .progress-stats {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 0.8rem; color: #6b7280; margin-top: 8px;
  }

  .summary { display: none; margin: 24px 0; }
  .summary.active { display: block; }
  .summary-card {
    background: #12121a; border: 1px solid #1e1e2e;
    border-radius: 12px; padding: 24px;
  }
  .summary-title { font-size: 1.1rem; font-weight: 700; color: #34d399; margin-bottom: 16px; }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .summary-stat {
    background: #1a1a2e; border: 1px solid #2a2a3e;
    border-radius: 8px; padding: 14px; text-align: center;
  }
  .summary-stat-value { font-size: 1.5rem; font-weight: 700; color: #a78bfa; }
  .summary-stat-label {
    font-size: 0.7rem; color: #6b7280;
    text-transform: uppercase; letter-spacing: 0.05em; margin-top: 4px;
  }

  .error-msg { color: #ef4444; font-size: 0.85rem; margin-top: 12px; display: none; }
  .error-msg.active { display: block; }

  footer {
    text-align: center; padding: 40px 24px 24px;
    color: #3a3a4a; font-size: 0.8rem;
  }
  footer a { color: #6b7280; text-decoration: none; }
  footer a:hover { color: #a78bfa; }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1><span>ChatGPT Import</span></h1>
    <p class="subtitle">Import your ChatGPT conversation history into the knowledge graph</p>
    <div class="steps">
      <strong>How it works:</strong> Go to ChatGPT Settings &rarr; Data Controls &rarr; Export Data.
      You will receive a zip file containing <strong>conversations.json</strong>.
      Drop that file below. The engine extracts every person and business
      you mentioned, deduplicates across conversations, and builds your graph.
    </div>
  </header>

  <div class="field">
    <label>API Key</label>
    <input type="password" id="apiKey" placeholder="ctx-..." />
  </div>

  <div class="drop-zone" id="dropZone">
    <div class="drop-icon">&#8593;</div>
    <div class="drop-text">Drag &amp; drop <strong>conversations.json</strong> here, or click to browse</div>
    <div class="file-info" id="fileInfo"></div>
  </div>
  <input type="file" id="fileInput" accept=".json" style="display:none" />

  <button class="btn" id="btnImport" onclick="startImport()" disabled>Import Conversations</button>
  <div class="error-msg" id="errorMsg"></div>

  <div class="progress-section" id="progress">
    <div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
    <div class="progress-text" id="progressText">Starting import...</div>
    <div class="progress-stats" id="progressStats"></div>
  </div>

  <div class="summary" id="summary">
    <div class="summary-card">
      <div class="summary-title">Import Complete</div>
      <div class="summary-grid" id="summaryGrid"></div>
    </div>
  </div>
</div>

<footer>
  <a href="/">&larr; Back to Context Engine</a>
</footer>

<script>
var fileData = null;

var dropZone = document.getElementById('dropZone');
var fileInput = document.getElementById('fileInput');

dropZone.addEventListener('click', function() { fileInput.click(); });
dropZone.addEventListener('dragover', function(e) {
  e.preventDefault(); dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', function() {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', function(e) {
  e.preventDefault(); dropZone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', function() {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

function handleFile(file) {
  if (!file) return;
  showError('');
  var reader = new FileReader();
  reader.onload = function(e) {
    try {
      var data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Expected a JSON array of conversations');
      fileData = data;
      dropZone.classList.add('has-file');
      document.getElementById('fileInfo').textContent =
        file.name + ' \\u2014 ' + data.length + ' conversations (' + (file.size / 1048576).toFixed(1) + ' MB)';
      document.getElementById('btnImport').disabled = false;
    } catch (err) {
      showError('Invalid file: ' + err.message);
      fileData = null;
    }
  };
  reader.readAsText(file);
}

function showError(msg) {
  var el = document.getElementById('errorMsg');
  el.textContent = msg;
  if (msg) { el.classList.add('active'); } else { el.classList.remove('active'); }
}

async function startImport() {
  var apiKey = document.getElementById('apiKey').value.trim();
  if (!apiKey) return showError('API key is required');
  if (!fileData) return showError('No file selected');

  document.getElementById('btnImport').disabled = true;
  showError('');
  document.getElementById('progress').classList.add('active');
  document.getElementById('summary').classList.remove('active');
  document.getElementById('progressBar').style.width = '0%';
  document.getElementById('progressText').textContent = 'Starting import...';
  document.getElementById('progressStats').textContent = '';

  try {
    var response = await fetch('/api/ingest/chatgpt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Context-API-Key': apiKey },
      body: JSON.stringify({ conversations: fileData }),
    });

    if (!response.ok && !response.headers.get('content-type').includes('ndjson')) {
      var errBody = await response.json();
      throw new Error(errBody.error || 'Request failed with status ' + response.status);
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\\n');
      buffer = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try { handleEvent(JSON.parse(lines[i])); } catch (e) {}
      }
    }
    if (buffer.trim()) {
      try { handleEvent(JSON.parse(buffer)); } catch (e) {}
    }
  } catch (err) {
    showError(err.message);
  }

  document.getElementById('btnImport').disabled = false;
}

function handleEvent(event) {
  if (event.type === 'started') {
    document.getElementById('progressText').textContent =
      'Processing ' + event.total_conversations + ' conversations in ' + event.total_batches + ' batches...';
  } else if (event.type === 'progress') {
    var pct = Math.round((event.batch / event.total_batches) * 100);
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressText').textContent =
      'Batch ' + event.batch + ' / ' + event.total_batches +
      ' \\u2014 ' + event.conversations_processed + ' of ' + event.total_conversations + ' conversations';
    document.getElementById('progressStats').textContent =
      event.entities_created + ' created, ' +
      event.entities_updated + ' updated, ' +
      event.observations_added + ' observations';
  } else if (event.type === 'complete') {
    document.getElementById('progressBar').style.width = '100%';
    document.getElementById('progressText').textContent = 'Done!';
    showSummary(event.summary);
  } else if (event.type === 'batch_error') {
    var stats = document.getElementById('progressStats');
    stats.textContent += ' [batch ' + event.batch + ' error: ' + event.error + ']';
  }
}

function showSummary(s) {
  document.getElementById('summary').classList.add('active');
  var items = [
    { value: s.entities_created, label: 'Entities Created' },
    { value: s.entities_updated, label: 'Entities Updated' },
    { value: s.observations_added, label: 'Observations Added' },
    { value: s.conversations_processed, label: 'Conversations' },
    { value: s.processing_time_seconds + 's', label: 'Processing Time' },
  ];
  document.getElementById('summaryGrid').innerHTML = items.map(function(it) {
    return '<div class="summary-stat"><div class="summary-stat-value">' +
      it.value + '</div><div class="summary-stat-label">' + it.label + '</div></div>';
  }).join('');
}
</script>
</body>
</html>`;

// --- Wiki Dashboard ---

app.get('/wiki', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.removeHeader('ETag');
  res.send(WIKI_HTML);
});

// --- Public shared profile view (NO auth) ---

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderSharedErrorPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .error-card { background: #fff; border-radius: 12px; padding: 48px; max-width: 420px; text-align: center; box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .error-card h1 { font-size: 1.4rem; color: #1a1a2e; margin-bottom: 12px; }
  .error-card p { font-size: 0.95rem; color: #64748b; line-height: 1.6; }
  .footer { margin-top: 32px; font-size: 0.75rem; color: #94a3b8; }
</style></head><body>
<div class="error-card">
  <h1>${escHtml(title)}</h1>
  <p>${escHtml(message)}</p>
  <div class="footer">Shared via Context Architecture</div>
</div></body></html>`;
}

function renderSharedProfilePage(entity, share) {
  const e = entity.entity || {};
  const cl = entity.career_lite || {};
  const name = e.name?.full || 'Unknown';
  const initials = name.split(/\s+/).map(w => w[0] || '').join('').toUpperCase();
  const sections = share.sections || [];

  let body = '';

  // Summary
  if (sections.includes('summary') && e.summary?.value) {
    body += '<div class="sp-section"><h2>Summary</h2><p>' + escHtml(e.summary.value) + '</p></div>';
  }

  // Experience
  if (sections.includes('experience') && cl.experience?.length) {
    body += '<div class="sp-section"><h2>Experience</h2>';
    for (const x of cl.experience) {
      body += '<div class="sp-card">';
      if (x.company) body += '<div class="sp-card-title">' + escHtml(x.company) + '</div>';
      if (x.title) body += '<div class="sp-card-subtitle">' + escHtml(x.title) + '</div>';
      const dates = [x.start_date, x.end_date].filter(Boolean).join(' — ');
      if (dates) body += '<div class="sp-card-meta">' + escHtml(dates) + '</div>';
      if (x.description) body += '<div class="sp-card-desc">' + escHtml(x.description) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Education
  if (sections.includes('education') && cl.education?.length) {
    body += '<div class="sp-section"><h2>Education</h2>';
    for (const ed of cl.education) {
      body += '<div class="sp-card">';
      if (ed.institution) body += '<div class="sp-card-title">' + escHtml(ed.institution) + '</div>';
      const degree = [ed.degree, ed.field].filter(Boolean).join(', ');
      if (degree) body += '<div class="sp-card-subtitle">' + escHtml(degree) + '</div>';
      if (ed.years) body += '<div class="sp-card-meta">' + escHtml(ed.years) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Skills
  if (sections.includes('skills') && cl.skills?.length) {
    body += '<div class="sp-section"><h2>Skills</h2><div class="sp-skills">';
    for (const s of cl.skills) {
      body += '<span class="sp-skill-tag">' + escHtml(s) + '</span>';
    }
    body += '</div></div>';
  }

  // Connections
  if (sections.includes('connections') && e.relationships?.length) {
    body += '<div class="sp-section"><h2>Connections</h2>';
    for (const r of e.relationships) {
      body += '<div class="sp-card">';
      if (r.name) body += '<div class="sp-card-title">' + escHtml(r.name) + '</div>';
      const detail = [r.relationship, r.context].filter(Boolean).join(' — ');
      if (detail) body += '<div class="sp-card-subtitle">' + escHtml(detail) + '</div>';
      body += '</div>';
    }
    body += '</div>';
  }

  // Role / Location
  let subtitle = '';
  if (e.attributes?.role) subtitle += escHtml(e.attributes.role);
  if (e.attributes?.location) subtitle += (subtitle ? ' &middot; ' : '') + escHtml(e.attributes.location);

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escHtml(name)} — Shared Profile</title>
<meta property="og:title" content="${escHtml(name)} — Shared Profile">
<meta property="og:description" content="${escHtml(subtitle || 'Career profile shared via Context Architecture')}">
<meta property="og:type" content="profile">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; min-height: 100vh; }
  .sp-header { background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 48px 24px 36px; text-align: center; color: #fff; }
  .sp-avatar { width: 80px; height: 80px; border-radius: 50%; background: rgba(255,255,255,0.2); display: inline-flex; align-items: center; justify-content: center; font-size: 1.8rem; font-weight: 700; margin-bottom: 16px; border: 3px solid rgba(255,255,255,0.3); }
  .sp-name { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .sp-subtitle { font-size: 0.95rem; opacity: 0.85; }
  .sp-body { max-width: 640px; margin: -20px auto 40px; padding: 0 16px; }
  .sp-section { background: #fff; border-radius: 10px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
  .sp-section h2 { font-size: 1rem; font-weight: 600; color: #6366f1; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 0.8rem; }
  .sp-section > p { font-size: 0.92rem; line-height: 1.7; color: #475569; }
  .sp-card { padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
  .sp-card:last-child { border-bottom: none; padding-bottom: 0; }
  .sp-card:first-of-type { padding-top: 0; }
  .sp-card-title { font-size: 0.92rem; font-weight: 600; color: #1a1a2e; }
  .sp-card-subtitle { font-size: 0.85rem; color: #475569; margin-top: 2px; }
  .sp-card-meta { font-size: 0.78rem; color: #94a3b8; margin-top: 2px; }
  .sp-card-desc { font-size: 0.85rem; color: #64748b; margin-top: 6px; line-height: 1.5; }
  .sp-skills { display: flex; flex-wrap: wrap; gap: 8px; }
  .sp-skill-tag { display: inline-block; padding: 6px 14px; border-radius: 20px; font-size: 0.8rem; font-weight: 500; background: #ede9fe; color: #6366f1; }
  .sp-footer { text-align: center; padding: 24px; font-size: 0.75rem; color: #94a3b8; }
  @media (max-width: 600px) {
    .sp-header { padding: 32px 16px 28px; }
    .sp-name { font-size: 1.3rem; }
    .sp-body { margin-top: -12px; }
    .sp-section { padding: 18px; }
  }
</style></head><body>
<div class="sp-header">
  <div class="sp-avatar">${escHtml(initials)}</div>
  <div class="sp-name">${escHtml(name)}</div>
  ${subtitle ? '<div class="sp-subtitle">' + subtitle + '</div>' : ''}
</div>
<div class="sp-body">${body}</div>
<div class="sp-footer">Shared via Context Architecture</div>
</body></html>`;
}

app.get('/shared/:shareId', sharedViewLimiter, (req, res) => {
  const { shareId } = req.params;

  // Scan all tenant directories for this shareId
  let matchedShare = null;
  let tenantDir = null;

  try {
    const entries = fs.readdirSync(GRAPH_DIR).filter(f => f.startsWith('tenant-'));
    for (const dir of entries) {
      const fullDir = path.join(GRAPH_DIR, dir);
      const shares = loadShares(fullDir);
      const found = shares.find(s => s.shareId === shareId);
      if (found) {
        matchedShare = found;
        tenantDir = fullDir;
        break;
      }
    }
  } catch (err) {
    // GRAPH_DIR might not exist yet
  }

  if (!matchedShare) {
    return res.status(404).send(renderSharedErrorPage(
      'Profile Not Found',
      'This link is invalid or has been revoked. Please ask the profile owner for a new link.'
    ));
  }

  // Check expiry
  if (new Date(matchedShare.expiresAt) < new Date()) {
    return res.status(410).send(renderSharedErrorPage(
      'Link Expired',
      'This shared profile link has expired. Please ask the profile owner to generate a new link.'
    ));
  }

  // Load entity
  const entityPath = path.join(tenantDir, matchedShare.entityId + '.json');
  if (!fs.existsSync(entityPath)) {
    return res.status(404).send(renderSharedErrorPage(
      'Profile Not Found',
      'The profile could not be loaded. It may have been deleted.'
    ));
  }

  const entity = JSON.parse(fs.readFileSync(entityPath, 'utf-8'));
  res.send(renderSharedProfilePage(entity, matchedShare));
});

const WIKI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Architecture</title>
<style>
  :root {
    /* Backgrounds */
    --bg-primary: #f5f5f7;
    --bg-secondary: #ffffff;
    --bg-card: #ffffff;
    --bg-elevated: #ffffff;
    --bg-hover: rgba(99,102,241,0.05);
    --bg-active: rgba(99,102,241,0.08);
    --bg-input: #f5f5f7;
    --bg-tertiary: #eeeef0;

    /* Borders */
    --border-primary: #e5e5ea;
    --border-subtle: #f0f0f2;
    --border-focus: #6366f1;

    /* Text */
    --text-primary: #1a1a1a;
    --text-secondary: #4b5563;
    --text-tertiary: #6b7280;
    --text-muted: #9ca3af;
    --text-faint: #d1d5db;

    /* Accents */
    --accent-primary: #6366f1;
    --accent-secondary: #7c3aed;
    --accent-tertiary: #8b5cf6;
    --accent-light: #6366f1;
    --accent-gradient: linear-gradient(135deg, #6366f1, #8b5cf6);

    /* Status */
    --success: #059669;
    --success-bg: rgba(5,150,105,0.08);
    --warning: #d97706;
    --warning-bg: rgba(217,119,6,0.08);
    --error: #dc2626;
    --error-bg: rgba(220,38,38,0.06);
    --info: #2563eb;
    --info-bg: rgba(37,99,235,0.06);

    /* Layout */
    --sidebar-width: 300px;
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-xl: 16px;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow-md: 0 2px 8px rgba(0,0,0,0.06);
    --shadow-lg: 0 4px 16px rgba(0,0,0,0.08);

    /* Transitions */
    --transition-fast: 0.15s ease;
    --transition-normal: 0.2s ease;

    /* Typography */
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    --font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    background: var(--bg-primary);
    color: var(--text-primary);
    height: 100vh;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* --- Scrollbar --- */
  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d1d5db; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #9ca3af; }

  /* --- Login --- */
  #login-screen {
    display: flex; align-items: center; justify-content: center;
    height: 100vh; flex-direction: column; gap: 20px;
    background: var(--bg-primary);
  }
  .login-card {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-xl);
    padding: 48px 40px;
    width: 400px;
    text-align: center;
    box-shadow: var(--shadow-lg);
  }
  .login-brand {
    display: flex; align-items: center; justify-content: center;
    gap: 10px; margin-bottom: 8px;
  }
  .login-card h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 4px; }
  .login-card h1 span {
    background: var(--accent-gradient);
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .login-card .subtitle { color: var(--text-tertiary); font-size: 0.88rem; margin-bottom: 28px; }
  .login-card input {
    width: 100%; padding: 11px 14px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 0.88rem;
    outline: none; margin-bottom: 14px;
    transition: border-color var(--transition-fast);
  }
  .login-card input:focus { border-color: var(--border-focus); }
  .login-card input::placeholder { color: var(--text-muted); }
  .login-error { color: var(--error); font-size: 0.8rem; margin-bottom: 10px; display: none; }
  .login-error.active { display: block; }
  .btn {
    width: 100%; padding: 12px;
    border: none; border-radius: var(--radius-md);
    font-size: 0.92rem; font-weight: 600; cursor: pointer;
    background: var(--accent-gradient); color: white;
    transition: all var(--transition-normal);
    font-family: var(--font-sans);
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.3); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .google-btn {
    display: flex; align-items: center; justify-content: center;
    background: #fff; color: #333; text-decoration: none; margin-bottom: 16px;
    font-size: 0.88rem; font-weight: 600;
    border: 1px solid var(--border-primary);
  }
  .google-btn:hover { background: #f9f9fb; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .login-divider {
    display: flex; align-items: center; margin-bottom: 14px;
    color: var(--text-muted); font-size: 0.72rem;
  }
  .login-divider::before, .login-divider::after {
    content: ''; flex: 1; border-bottom: 1px solid var(--border-primary);
  }
  .login-divider span { padding: 0 12px; }

  /* --- App Layout --- */
  #app { display: none; height: 100vh; }
  #sidebar {
    width: var(--sidebar-width); min-width: var(--sidebar-width);
    border-right: 1px solid var(--border-primary);
    display: flex; flex-direction: column;
    background: var(--bg-secondary);
  }

  /* --- Sidebar Brand --- */
  .sidebar-brand {
    display: flex; align-items: center; gap: 10px;
    padding: 18px 20px 16px;
    border-bottom: 1px solid var(--border-primary);
  }
  .brand-icon {
    width: 32px; height: 32px; border-radius: var(--radius-md);
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.72rem; font-weight: 800; color: white;
    letter-spacing: -0.02em; flex-shrink: 0;
  }
  .brand-text {
    font-size: 0.88rem; font-weight: 700; color: var(--text-primary);
    letter-spacing: -0.01em;
  }

  /* --- Sidebar Nav --- */
  .sidebar-nav {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-primary);
    display: flex; flex-direction: column; gap: 2px;
  }
  .nav-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.82rem; font-weight: 500; cursor: pointer;
    transition: all var(--transition-fast);
    font-family: var(--font-sans);
    text-align: left; width: 100%;
  }
  .nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .nav-item svg { flex-shrink: 0; opacity: 0.6; }
  .nav-item:hover svg { opacity: 1; }

  /* --- Sidebar Search --- */
  .sidebar-search { padding: 12px 16px 8px; }
  .search-wrapper { position: relative; display: flex; align-items: center; }
  .search-icon {
    position: absolute; left: 10px;
    color: var(--text-muted); pointer-events: none;
  }
  #searchInput {
    width: 100%; padding: 8px 12px 8px 32px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.82rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  #searchInput:focus { border-color: var(--border-focus); }
  #searchInput::placeholder { color: var(--text-muted); }

  /* --- Sidebar Actions (legacy compat) --- */
  .sidebar-actions {
    padding: 8px 16px; border-bottom: 1px solid var(--border-primary);
  }
  .btn-upload {
    width: 100%; padding: 7px 0;
    border: 1px dashed var(--border-primary); border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.75rem; font-weight: 600;
    cursor: pointer; transition: all var(--transition-fast);
    letter-spacing: 0.03em; font-family: var(--font-sans);
  }
  .btn-upload:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); background: var(--bg-hover); }

  /* --- Sidebar Count --- */
  .sidebar-count {
    padding: 8px 20px; font-size: 0.68rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    border-bottom: 1px solid var(--border-primary);
  }

  /* --- Entity List --- */
  #entityList { flex: 1; overflow-y: auto; }
  .entity-item {
    padding: 12px 20px; cursor: pointer;
    border-bottom: 1px solid var(--border-subtle);
    transition: all var(--transition-fast);
  }
  .entity-item:hover { background: var(--bg-hover); }
  .entity-item.active {
    background: var(--bg-active);
    border-left: 3px solid var(--accent-primary);
    padding-left: 17px;
  }
  .entity-item-name {
    font-size: 0.85rem; font-weight: 600;
    color: var(--text-primary); margin-bottom: 2px;
  }
  .entity-item-summary {
    font-size: 0.72rem; color: var(--text-muted); line-height: 1.4;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    margin-top: 3px;
  }
  .type-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 2px 7px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.04em;
    vertical-align: middle; margin-left: 6px;
  }
  .type-badge.person { background: rgba(99,102,241,0.1); color: #6366f1; }
  .type-badge.business { background: rgba(14,165,233,0.1); color: #0284c7; }
  .type-badge.role { background: rgba(59,130,246,0.1); color: #2563eb; }
  .type-badge.organization { background: rgba(34,197,94,0.1); color: #16a34a; }
  .type-badge.credential { background: rgba(245,158,11,0.1); color: #d97706; }
  .type-badge.skill { background: rgba(20,184,166,0.1); color: #0d9488; }
  .type-badge.institution { background: rgba(168,85,247,0.1); color: #7c3aed; }

  /* --- Main Panel --- */
  #main {
    flex: 1; overflow-y: auto;
    padding: 32px 40px;
    background: var(--bg-primary);
  }
  .empty-state {
    display: flex; align-items: center; justify-content: center;
    height: 100%; color: var(--text-faint);
    font-size: 0.95rem; text-align: center;
    line-height: 1.8; flex-direction: column; gap: 12px;
  }

  /* --- Detail Header --- */
  .detail-header { margin-bottom: 28px; }
  .detail-header h2 {
    font-size: 1.6rem; font-weight: 700; color: var(--text-primary);
    display: inline; letter-spacing: -0.02em;
  }
  .entity-id-badge {
    font-size: 0.68rem; color: var(--accent-primary);
    font-family: var(--font-mono);
    background: rgba(99,102,241,0.08);
    padding: 3px 10px; border-radius: var(--radius-sm);
    margin-left: 10px; vertical-align: middle;
  }

  .btn-delete-entity {
    margin-left: 12px; vertical-align: middle;
    padding: 3px 12px; border-radius: var(--radius-sm);
    background: rgba(239,68,68,0.1); color: #ef4444;
    border: 1px solid rgba(239,68,68,0.3);
    font-size: 0.72rem; font-weight: 600; cursor: pointer;
    transition: all 0.15s;
  }
  .btn-delete-entity:hover { background: #ef4444; color: #fff; }

  /* --- Cleanup View --- */
  .cleanup-toolbar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 12px 16px; margin-bottom: 16px;
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  }
  .cleanup-toolbar select, .cleanup-toolbar input {
    padding: 6px 10px; border-radius: var(--radius-sm);
    border: 1px solid var(--border-primary); background: var(--bg-primary);
    color: var(--text-primary); font-size: 0.8rem; font-family: var(--font-sans);
  }
  .cleanup-toolbar label { font-size: 0.78rem; color: var(--text-secondary); font-weight: 500; }
  .cleanup-row {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid var(--border-subtle);
    transition: background var(--transition-fast);
  }
  .cleanup-row:hover { background: var(--bg-hover); }
  .cleanup-check { accent-color: var(--accent-primary); width: 16px; height: 16px; cursor: pointer; }
  .cleanup-name { flex: 1; font-size: 0.85rem; font-weight: 500; color: var(--text-primary); }
  .cleanup-type-badge {
    font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em;
    padding: 2px 8px; border-radius: 9999px; font-weight: 600;
    background: rgba(99,102,241,0.1); color: var(--accent-primary);
  }
  .cleanup-count { font-size: 0.72rem; color: var(--text-muted); min-width: 50px; text-align: right; }
  .cleanup-actions {
    position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; margin-top: 12px;
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg); box-shadow: var(--shadow-sm);
  }
  .cleanup-actions .btn-danger {
    padding: 8px 20px; border-radius: var(--radius-sm);
    background: #ef4444; color: #fff; border: none;
    font-size: 0.82rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s;
  }
  .cleanup-actions .btn-danger:hover { background: #dc2626; }
  .cleanup-actions .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
  .cleanup-actions .cleanup-selection-count { font-size: 0.78rem; color: var(--text-secondary); }
  .cleanup-entity-list {
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg); overflow: hidden;
  }

  /* --- Sections --- */
  .section {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    padding: 20px; margin-bottom: 16px;
    transition: border-color var(--transition-fast);
    box-shadow: var(--shadow-sm);
  }
  .section:hover { border-color: #d1d5db; }
  .section-header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px;
  }
  .section-title {
    font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.08em; color: var(--text-muted);
  }
  .section-title-only { margin-bottom: 12px; }
  .summary-text { font-size: 0.9rem; color: var(--text-secondary); line-height: 1.7; }
  .summary-edit {
    width: 100%; min-height: 70px; padding: 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.88rem; line-height: 1.6;
    resize: vertical; outline: none;
  }
  .summary-edit:focus { border-color: var(--border-focus); }
  .edit-actions { margin-top: 8px; display: flex; gap: 8px; }

  /* --- Attributes, Relationships, Values --- */
  .attr-row, .rel-row, .value-item {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 0; font-size: 0.84rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--border-subtle);
  }
  .attr-row:last-child, .rel-row:last-child, .value-item:last-child { border-bottom: none; }
  .attr-key {
    color: var(--accent-secondary); font-weight: 600;
    min-width: 90px; flex-shrink: 0; font-size: 0.82rem;
  }
  .attr-value { color: var(--text-primary); flex: 1; }
  .rel-name { color: var(--text-primary); font-weight: 600; min-width: 110px; }
  .rel-type {
    color: var(--info); font-size: 0.72rem;
    background: var(--info-bg);
    padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .rel-context { color: var(--text-tertiary); font-size: 0.78rem; flex: 1; }
  .rel-sentiment {
    font-size: 0.65rem; padding: 2px 8px; border-radius: var(--radius-sm);
  }
  .sentiment-positive { background: var(--success-bg); color: var(--success); }
  .sentiment-neutral { background: rgba(107,114,128,0.08); color: var(--text-secondary); }
  .sentiment-strained { background: var(--error-bg); color: var(--error); }
  .value-text { color: var(--text-primary); }

  /* --- Badges --- */
  .badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 2px 7px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.04em;
    white-space: nowrap; vertical-align: middle;
  }
  .badge-verified { background: rgba(5,150,105,0.1); color: #059669; }
  .badge-strong { background: rgba(37,99,235,0.1); color: #2563eb; }
  .badge-moderate { background: rgba(217,119,6,0.1); color: #d97706; }
  .badge-speculative { background: rgba(234,88,12,0.1); color: #ea580c; }
  .badge-uncertain { background: rgba(220,38,38,0.1); color: #dc2626; }
  .badge-layer {
    font-size: 0.58rem; padding: 2px 6px; border-radius: var(--radius-sm);
  }
  .badge-layer-1 { background: rgba(5,150,105,0.08); color: #059669; }
  .badge-layer-2 { background: rgba(37,99,235,0.08); color: #2563eb; }
  .badge-layer-3 { background: rgba(219,39,119,0.08); color: #db2777; }

  /* --- Observations --- */
  .obs-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 12px 14px; margin-bottom: 8px;
    transition: all var(--transition-fast);
  }
  .obs-card:hover { border-color: var(--border-primary); }
  .obs-text { font-size: 0.86rem; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px; }
  .obs-meta {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    font-size: 0.7rem;
  }
  .obs-source {
    color: var(--text-muted); font-family: var(--font-mono);
    font-size: 0.65rem;
  }
  .obs-date { color: var(--text-muted); font-size: 0.65rem; }
  .obs-decay {
    font-size: 0.6rem; color: var(--text-muted);
    font-family: var(--font-mono);
  }
  .btn-delete {
    background: none; border: 1px solid rgba(239,68,68,0.15);
    color: var(--error);
    font-size: 0.6rem; padding: 2px 8px; border-radius: var(--radius-sm);
    cursor: pointer; margin-left: auto; opacity: 0.4;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-delete:hover { opacity: 1; background: var(--error-bg); }

  /* --- Forms --- */
  .add-obs-form { margin-top: 12px; }
  .obs-textarea {
    width: 100%; min-height: 60px; padding: 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 0.86rem; line-height: 1.5;
    resize: vertical; outline: none; margin-bottom: 10px;
    transition: border-color var(--transition-fast);
  }
  .obs-textarea:focus { border-color: var(--border-focus); }
  .obs-textarea::placeholder { color: var(--text-muted); }
  .obs-form-row { display: flex; gap: 8px; align-items: center; }
  .obs-form-row select {
    padding: 7px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.78rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  .obs-form-row select:focus { border-color: var(--border-focus); }
  .btn-sm {
    padding: 5px 14px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.72rem; cursor: pointer;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-sm:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .btn-add {
    padding: 7px 18px; border: none; border-radius: var(--radius-sm);
    background: var(--accent-gradient); color: white;
    font-size: 0.78rem; font-weight: 600; cursor: pointer;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-add:hover { transform: translateY(-1px); box-shadow: 0 2px 12px rgba(99,102,241,0.3); }
  .btn-add:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-save {
    padding: 5px 16px; border: none; border-radius: var(--radius-sm);
    background: var(--success); color: #fff;
    font-size: 0.72rem; font-weight: 600; cursor: pointer;
    font-family: var(--font-sans);
  }
  .btn-cancel {
    padding: 5px 16px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    background: transparent; color: var(--text-tertiary);
    font-size: 0.72rem; cursor: pointer; font-family: var(--font-sans);
  }
  .toast {
    position: fixed; bottom: 24px; right: 24px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 12px 20px; font-size: 0.82rem;
    color: var(--success);
    display: none; z-index: 100;
    box-shadow: var(--shadow-lg);
    animation: slideUp 0.25s ease;
  }
  .toast.active { display: block; }
  @keyframes slideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  /* --- Upload Zone --- */
  .upload-view { display: none; }
  .upload-view.active { display: block; animation: fadeIn 0.2s ease; }
  .upload-dropzone {
    border: 2px dashed var(--border-primary);
    border-radius: var(--radius-xl);
    padding: 56px 24px;
    text-align: center; cursor: pointer;
    transition: all var(--transition-normal);
    background: var(--bg-secondary); margin-bottom: 20px;
  }
  .upload-dropzone:hover, .upload-dropzone.dragover {
    border-color: var(--accent-primary);
    background: var(--bg-hover);
  }
  .upload-dropzone-icon { font-size: 2.5rem; margin-bottom: 12px; opacity: 0.3; }
  .upload-dropzone-text { font-size: 0.92rem; color: var(--text-tertiary); margin-bottom: 6px; }
  .upload-dropzone-hint { font-size: 0.72rem; color: var(--text-muted); }
  .upload-file-list { margin-bottom: 16px; }
  .upload-file-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 14px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    margin-bottom: 6px; font-size: 0.82rem;
    transition: border-color var(--transition-fast);
  }
  .upload-file-item:hover { border-color: rgba(30,30,46,0.8); }
  .upload-file-name {
    color: var(--text-primary); flex: 1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .upload-file-size { color: var(--text-muted); font-size: 0.72rem; margin-left: 10px; flex-shrink: 0; }
  .upload-file-status { margin-left: 10px; font-size: 0.72rem; flex-shrink: 0; font-weight: 500; }
  .upload-file-status.pending { color: var(--text-muted); }
  .upload-file-status.processing { color: var(--warning); }
  .upload-file-status.done { color: var(--success); }
  .upload-file-status.error { color: var(--error); }
  .upload-file-remove {
    margin-left: 10px; background: none; border: none;
    color: var(--text-muted); cursor: pointer; font-size: 1rem;
    padding: 0 4px; transition: color var(--transition-fast);
  }
  .upload-file-remove:hover { color: var(--error); }
  .btn-start-upload {
    width: 100%; padding: 11px; border: none; border-radius: var(--radius-md);
    font-size: 0.88rem; font-weight: 600; cursor: pointer;
    background: var(--accent-gradient); color: white;
    transition: all var(--transition-normal); margin-bottom: 8px;
    font-family: var(--font-sans);
  }
  .btn-start-upload:hover { transform: translateY(-1px); box-shadow: 0 4px 20px rgba(99,102,241,0.3); }
  .btn-start-upload:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
  .btn-back-upload {
    width: 100%; padding: 9px;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    font-size: 0.82rem; font-weight: 500; cursor: pointer;
    background: transparent; color: var(--text-tertiary);
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .btn-back-upload:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .upload-progress-log {
    background: var(--bg-primary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    padding: 14px; margin-bottom: 16px;
    max-height: 220px; overflow-y: auto;
    font-family: var(--font-mono); font-size: 0.72rem;
    line-height: 1.8; color: var(--text-tertiary);
  }
  .upload-progress-log .log-success { color: var(--success); }
  .upload-progress-log .log-info { color: var(--info); }
  .upload-progress-log .log-error { color: var(--error); }
  .upload-summary {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg);
    padding: 20px; text-align: center; margin-bottom: 16px;
  }
  .upload-summary-stat {
    display: inline-block; margin: 0 20px; text-align: center;
  }
  .upload-summary-num {
    font-size: 1.8rem; font-weight: 700; color: var(--accent-tertiary);
    letter-spacing: -0.02em;
  }
  .upload-summary-label {
    font-size: 0.68rem; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px;
  }

  /* --- Drive Picker --- */
  .drive-breadcrumb {
    display: flex; align-items: center; flex-wrap: wrap; gap: 4px;
    margin-bottom: 12px; font-size: 0.78rem;
  }
  .drive-breadcrumb a {
    color: var(--info); text-decoration: none; cursor: pointer;
  }
  .drive-breadcrumb a:hover { text-decoration: underline; }
  .drive-breadcrumb .sep { color: var(--text-muted); }
  .drive-breadcrumb .current { color: var(--text-primary); font-weight: 600; }
  .drive-file-list {
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-md);
    overflow: hidden; margin-bottom: 16px;
  }
  .drive-file-row {
    display: flex; align-items: center; padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle); font-size: 0.82rem;
    transition: background var(--transition-fast); cursor: pointer;
  }
  .drive-file-row:last-child { border-bottom: none; }
  .drive-file-row:hover { background: var(--bg-hover); }
  .drive-file-row.selected { background: var(--bg-active); }
  .drive-file-check {
    width: 16px; height: 16px; margin-right: 10px;
    accent-color: var(--accent-primary); flex-shrink: 0;
  }
  .drive-file-icon {
    width: 20px; text-align: center; margin-right: 10px;
    flex-shrink: 0; font-size: 0.9rem;
  }
  .drive-file-name {
    flex: 1; color: var(--text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .drive-file-name.folder { color: var(--info); font-weight: 500; }
  .drive-file-meta {
    font-size: 0.68rem; color: var(--text-muted);
    margin-left: 12px; flex-shrink: 0; white-space: nowrap;
  }
  .drive-select-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 12px; font-size: 0.78rem; color: var(--text-tertiary);
  }
  .drive-loading {
    text-align: center; padding: 40px; color: var(--text-muted); font-size: 0.85rem;
  }
  .drive-empty {
    text-align: center; padding: 28px; color: var(--text-muted); font-size: 0.82rem;
  }
  .drive-search-bar {
    display: flex; align-items: center; gap: 6px; margin-bottom: 12px;
  }
  .drive-search-bar input {
    flex: 1; padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 0.82rem; outline: none;
    font-family: var(--font-sans);
    transition: border-color var(--transition-fast);
  }
  .drive-search-bar input:focus { border-color: var(--border-focus); }
  .drive-search-bar input::placeholder { color: var(--text-muted); }
  .drive-search-btn {
    padding: 8px 12px;
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary); cursor: pointer; font-size: 0.82rem;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .drive-search-btn:hover { border-color: var(--accent-primary); color: var(--accent-tertiary); }
  .drive-search-clear {
    padding: 8px 12px; background: transparent;
    border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm);
    color: var(--text-tertiary); cursor: pointer; font-size: 0.75rem;
    transition: all var(--transition-fast); font-family: var(--font-sans);
  }
  .drive-search-clear:hover { border-color: var(--error); color: var(--error); }
  .drive-search-tag {
    display: inline-block; font-size: 0.72rem; color: var(--info); margin-bottom: 8px;
  }

  /* --- Career Lite Profile --- */
  .cl-header {
    display: flex; gap: 20px; align-items: flex-start; margin-bottom: 6px;
  }
  .cl-avatar {
    width: 72px; height: 72px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 1.6rem; font-weight: 700; color: white; flex-shrink: 0;
    box-shadow: 0 4px 16px rgba(99,102,241,0.25);
  }
  .cl-header-info { flex: 1; min-width: 0; }
  .cl-name {
    font-size: 1.5rem; font-weight: 700; color: var(--text-primary);
    margin-bottom: 4px; letter-spacing: -0.02em;
  }
  .cl-headline { font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 4px; }
  .cl-current { font-size: 0.84rem; color: var(--accent-tertiary); margin-bottom: 4px; }
  .cl-location { font-size: 0.78rem; color: var(--text-tertiary); }
  .cl-contact-row {
    display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 0.78rem;
  }
  .cl-contact-row a { color: var(--info); text-decoration: none; }
  .cl-contact-row a:hover { text-decoration: underline; }
  .cl-contact-item { color: var(--text-secondary); }
  .cl-interface-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 3px 10px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.06em;
    background: rgba(139,92,246,0.12); color: var(--accent-tertiary);
    margin-top: 10px;
  }
  /* --- Profile Mode Styles --- */
  .profile-badge {
    display: inline-block; font-size: 0.6rem; font-weight: 600;
    padding: 3px 10px; border-radius: var(--radius-sm);
    text-transform: uppercase; letter-spacing: 0.06em;
    background: rgba(236,72,153,0.12); color: #ec4899;
    margin-left: 8px; vertical-align: middle;
  }
  .profile-section {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: 10px; overflow: hidden;
  }
  .profile-section-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; cursor: pointer; user-select: none;
    font-size: 0.85rem; font-weight: 600; color: var(--text-primary);
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
    transition: background var(--transition-fast);
  }
  .profile-section-header:hover { background: var(--bg-hover); }
  .profile-section-header .chevron { font-size: 0.7rem; color: var(--text-tertiary); transition: transform 0.2s; }
  .profile-section-header.collapsed .chevron { transform: rotate(-90deg); }
  .profile-section-body { padding: 12px 16px; }
  .profile-section-body.hidden { display: none; }
  .profile-bar-wrap { margin-bottom: 8px; }
  .profile-bar-label {
    display: inline-block; min-width: 120px; font-size: 0.78rem;
    font-weight: 500; color: var(--text-secondary);
  }
  .profile-bar-track {
    display: inline-block; width: calc(100% - 180px); height: 14px;
    background: var(--bg-tertiary); border-radius: 7px; vertical-align: middle;
    overflow: hidden; position: relative;
  }
  .profile-bar-fill {
    height: 100%; border-radius: 7px;
    background: linear-gradient(90deg, var(--accent-primary), var(--accent-tertiary));
    transition: width 0.4s ease;
  }
  .profile-bar-value {
    display: inline-block; min-width: 40px; font-size: 0.72rem;
    font-weight: 600; color: var(--text-primary); text-align: right;
    margin-left: 6px; vertical-align: middle;
  }
  .profile-dispute {
    display: inline-block; font-size: 0.65rem; font-weight: 600;
    padding: 1px 6px; border-radius: var(--radius-sm);
    background: rgba(245,158,11,0.15); color: #f59e0b;
    margin-left: 6px; vertical-align: middle;
  }
  .profile-tag {
    display: inline-block; padding: 4px 10px; border-radius: 16px;
    font-size: 0.72rem; font-weight: 500; margin: 2px 4px 2px 0;
    background: rgba(99,102,241,0.08); color: var(--accent-light);
    border: 1px solid rgba(99,102,241,0.15);
  }
  .profile-insight-card {
    background: var(--bg-secondary); border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md); padding: 10px 14px; margin-bottom: 8px;
    border-left: 3px solid var(--accent-tertiary);
  }
  .profile-insight-card .insight-text { font-size: 0.82rem; color: var(--text-primary); line-height: 1.5; }
  .profile-insight-card .insight-source { font-size: 0.7rem; color: var(--text-tertiary); margin-top: 4px; }
  .profile-green {
    border-left: 3px solid #10b981; background: rgba(16,185,129,0.04);
    border-radius: var(--radius-md); padding: 8px 12px; margin-bottom: 6px;
    font-size: 0.82rem; color: var(--text-primary);
  }
  .profile-red {
    border-left: 3px solid #ef4444; background: rgba(239,68,68,0.04);
    border-radius: var(--radius-md); padding: 8px 12px; margin-bottom: 6px;
    font-size: 0.82rem; color: var(--text-primary);
  }
  .profile-amber {
    border-left: 3px solid #f59e0b; background: rgba(245,158,11,0.04);
    border-radius: var(--radius-md); padding: 8px 12px; margin-bottom: 6px;
    font-size: 0.82rem; color: var(--text-primary);
  }
  .profile-kv-row { display: flex; padding: 3px 0; font-size: 0.82rem; }
  .profile-kv-key { min-width: 140px; color: var(--text-tertiary); font-weight: 500; }
  .profile-kv-val { color: var(--text-primary); flex: 1; }
  .profile-source-date { font-size: 0.7rem; color: var(--text-tertiary); }
  .profile-source-date.stale { color: #f59e0b; }

  .cl-exp-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 14px 16px; margin-bottom: 8px;
    transition: border-color var(--transition-fast);
  }
  .cl-exp-card:hover { border-color: var(--border-primary); }
  .cl-exp-company { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .cl-exp-title { font-size: 0.84rem; color: var(--accent-tertiary); }
  .cl-exp-dates { font-size: 0.72rem; color: var(--text-tertiary); margin-top: 2px; }
  .cl-exp-desc { font-size: 0.8rem; color: var(--text-secondary); margin-top: 8px; line-height: 1.6; }
  .cl-edu-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 12px 16px; margin-bottom: 8px;
    transition: border-color var(--transition-fast);
  }
  .cl-edu-card:hover { border-color: var(--border-primary); }
  .cl-edu-institution { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
  .cl-edu-degree { font-size: 0.8rem; color: var(--text-secondary); }
  .cl-edu-years { font-size: 0.72rem; color: var(--text-tertiary); }
  .cl-skills-wrap { display: flex; flex-wrap: wrap; gap: 6px; }
  .cl-skill-tag {
    display: inline-block; padding: 5px 12px; border-radius: 20px;
    font-size: 0.72rem; font-weight: 500;
    background: rgba(99,102,241,0.08); color: var(--accent-light);
    border: 1px solid rgba(99,102,241,0.15);
    transition: all var(--transition-fast);
  }
  .cl-skill-tag:hover { background: rgba(99,102,241,0.15); }

  /* --- Share Modal --- */
  .share-overlay {
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.3); z-index: 1000;
    display: flex; align-items: center; justify-content: center;
    backdrop-filter: blur(4px);
  }
  .share-modal {
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-lg); padding: 28px; width: 440px; max-width: 90vw;
    max-height: 85vh; overflow-y: auto; box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  }
  .share-modal h3 {
    font-size: 1.05rem; font-weight: 600; color: var(--text-primary);
    margin-bottom: 20px;
  }
  .share-section-toggles { margin-bottom: 20px; }
  .share-toggle-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 0; border-bottom: 1px solid var(--border-subtle);
  }
  .share-toggle-row:last-child { border-bottom: none; }
  .share-toggle-row label {
    font-size: 0.85rem; color: var(--text-secondary); cursor: pointer;
  }
  .share-toggle-row input[type="checkbox"] { accent-color: var(--accent-light); width: 16px; height: 16px; cursor: pointer; }
  .share-expiry-row {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px; padding: 10px 0;
  }
  .share-expiry-row label { font-size: 0.85rem; color: var(--text-secondary); }
  .share-expiry-row select {
    background: var(--bg-secondary); border: 1px solid var(--border-primary);
    color: var(--text-primary); border-radius: var(--radius-sm); padding: 6px 10px;
    font-size: 0.82rem;
  }
  .share-actions {
    display: flex; gap: 10px; margin-bottom: 16px;
  }
  .share-actions button {
    flex: 1; padding: 10px; border-radius: var(--radius-sm); font-size: 0.85rem;
    font-weight: 500; cursor: pointer; border: 1px solid var(--border-primary);
    transition: all var(--transition-fast);
  }
  .btn-generate {
    background: var(--accent-gradient); color: #fff; border: none !important;
  }
  .btn-generate:hover { opacity: 0.9; }
  .btn-cancel {
    background: var(--bg-secondary); color: var(--text-secondary);
  }
  .btn-cancel:hover { border-color: var(--text-muted); }
  .share-result {
    background: var(--bg-secondary); border: 1px solid var(--border-primary);
    border-radius: var(--radius-sm); padding: 12px; margin-bottom: 16px;
  }
  .share-result-url {
    font-size: 0.8rem; color: var(--accent-light); word-break: break-all;
    margin-bottom: 8px; font-family: monospace;
  }
  .btn-copy-link {
    background: var(--bg-tertiary); border: 1px solid var(--border-primary);
    color: var(--text-primary); padding: 6px 14px; border-radius: var(--radius-sm);
    font-size: 0.78rem; cursor: pointer; transition: all var(--transition-fast);
  }
  .btn-copy-link:hover { border-color: var(--accent-light); color: var(--accent-light); }
  .share-active-list { margin-top: 16px; }
  .share-active-list h4 {
    font-size: 0.82rem; font-weight: 600; color: var(--text-secondary);
    margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px;
  }
  .share-active-item {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 0; border-bottom: 1px solid var(--border-subtle);
    font-size: 0.8rem;
  }
  .share-active-item:last-child { border-bottom: none; }
  .share-active-info { color: var(--text-tertiary); }
  .share-active-sections { color: var(--text-muted); font-size: 0.72rem; }
  .btn-revoke {
    background: none; border: 1px solid rgba(239,68,68,0.3); color: #ef4444;
    padding: 4px 10px; border-radius: var(--radius-sm); font-size: 0.72rem;
    cursor: pointer; transition: all var(--transition-fast);
  }
  .btn-revoke:hover { background: rgba(239,68,68,0.1); border-color: #ef4444; }
  .btn-share {
    background: var(--accent-gradient); color: #fff; border: none;
    padding: 5px 14px; border-radius: var(--radius-sm); font-size: 0.75rem;
    font-weight: 500; cursor: pointer; transition: opacity var(--transition-fast);
  }
  .btn-share:hover { opacity: 0.85; }
  .cl-header-actions {
    display: flex; align-items: center; gap: 10px;
  }

  /* --- Sidebar Footer --- */
  .sidebar-footer {
    padding: 12px 20px;
    border-top: 1px solid var(--border-primary);
    font-size: 0.7rem; color: var(--text-faint); text-align: center;
    line-height: 1.6;
  }
  .sidebar-footer a {
    color: var(--text-muted); text-decoration: none;
    transition: color var(--transition-fast);
  }
  .sidebar-footer a:hover { color: var(--accent-tertiary); }

  /* --- Sidebar Hierarchical Nav --- */
  .sidebar-section { border-bottom: 1px solid var(--border-subtle); }
  .sidebar-section:last-child { border-bottom: none; }
  .sidebar-section-header {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 16px; cursor: pointer;
    font-size: 14px; font-weight: 700; color: var(--text-secondary);
    transition: background var(--transition-fast);
    user-select: none;
  }
  .sidebar-section-header:hover { background: var(--bg-hover); }
  .sidebar-section-chevron {
    display: inline-block; font-size: 0.6rem; transition: transform 0.2s ease;
    color: var(--text-muted); flex-shrink: 0;
  }
  .sidebar-section-chevron.collapsed { transform: rotate(-90deg); }
  .sidebar-section-title { flex: 1; }
  .sidebar-section-count {
    font-size: 0.65rem; font-weight: 500; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 7px; border-radius: 10px;
  }
  .sidebar-section-body { overflow: hidden; }
  .sidebar-section-body.collapsed { display: none; }
  .sidebar-profile-header {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 20px 4px;
  }
  .sidebar-profile-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem; font-weight: 700; color: white; flex-shrink: 0;
    overflow: hidden;
  }
  .sidebar-profile-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .sidebar-profile-name {
    font-size: 0.85rem; font-weight: 600; color: var(--text-primary);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-view-item {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 20px 7px 36px; cursor: pointer;
    font-size: 13px; color: var(--text-tertiary);
    transition: all var(--transition-fast);
  }
  .sidebar-view-item:hover { background: var(--bg-hover); color: var(--text-primary); }
  .sidebar-view-item.active {
    background: #f5f0ff; color: #6366f1;
    border-left: 3px solid #6366f1;
    padding-left: 33px;
  }
  .sidebar-view-item .view-icon { font-size: 0.85rem; flex-shrink: 0; width: 18px; text-align: center; }
  .sidebar-view-item.placeholder { color: var(--text-muted); cursor: default; }
  .sidebar-view-item.placeholder:hover { background: transparent; color: var(--text-muted); }
  .coming-soon-badge {
    font-size: 0.55rem; font-weight: 600; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 6px; border-radius: 8px;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .sidebar-group-label {
    font-size: 11px; font-weight: 600; color: var(--text-muted);
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 8px 20px 4px;
  }
  .sidebar-entity-row {
    display: block; padding: 6px 20px 6px 36px; cursor: pointer;
    font-size: 13px; color: var(--text-primary);
    transition: background var(--transition-fast);
  }
  .sidebar-entity-row:hover { background: #f0f0ff; }
  .sidebar-entity-row.active {
    background: #f5f0ff;
    border-left: 3px solid #6366f1;
    padding-left: 33px;
  }
  .sidebar-entity-row .entity-name {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 6px;
  }
  .sidebar-entity-row .entity-subtitle {
    font-size: 12px; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    padding-left: 0;
  }
  .sidebar-empty-hint {
    padding: 8px 20px 8px 36px; font-size: 12px; color: var(--text-muted);
    font-style: italic;
  }
  .sidebar-cat-row {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 20px 7px 36px; cursor: pointer;
    font-size: 13px; color: var(--text-tertiary);
    transition: all var(--transition-fast);
  }
  .sidebar-cat-row:hover { background: var(--bg-hover); color: var(--text-primary); }
  .sidebar-cat-row.active {
    background: #f5f0ff; color: #6366f1;
    border-left: 3px solid #6366f1; padding-left: 33px;
  }
  .sidebar-cat-row .cat-emoji { font-size: 0.85rem; flex-shrink: 0; width: 18px; text-align: center; }
  .sidebar-cat-row .cat-label { flex: 1; }
  .sidebar-cat-row .cat-count {
    font-size: 0.65rem; font-weight: 500; color: var(--text-muted);
    background: var(--bg-tertiary); padding: 1px 7px; border-radius: 10px;
  }
  #breadcrumbs {
    padding: 0;
  }
  #breadcrumbs:empty {
    display: none;
  }
  .breadcrumb-bar {
    display: flex; align-items: center; gap: 0;
    padding: 10px 28px 0; font-size: 0.78rem;
  }
  .breadcrumb-bar a {
    color: var(--text-muted); text-decoration: none; cursor: pointer;
    transition: color 0.15s;
  }
  .breadcrumb-bar a:hover { color: #6366f1; }
  .breadcrumb-sep {
    margin: 0 6px; color: var(--text-muted); font-size: 0.7rem;
  }
  .breadcrumb-current {
    color: var(--text-primary); font-weight: 500;
  }
  .cat-page-header {
    font-size: 1.3rem; font-weight: 700; color: var(--text-primary);
    padding: 20px 0 16px; border-bottom: 1px solid var(--border-subtle);
    margin-bottom: 16px;
  }
  .cat-page-count {
    font-size: 0.85rem; font-weight: 400; color: var(--text-muted); margin-left: 8px;
  }
  .cat-card-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .cat-card {
    background: var(--bg-card); border: 1px solid var(--border-primary);
    border-radius: var(--radius-md); padding: 14px 16px; cursor: pointer;
    transition: all var(--transition-fast); position: relative;
  }
  .cat-card:hover { border-color: #6366f1; box-shadow: 0 2px 8px rgba(99,102,241,0.1); }
  .cat-card-name { font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
  .cat-card-subtitle { font-size: 0.82rem; color: #555555; margin-bottom: 6px; }
  .cat-card-summary { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4; }
  /* Strength tiers */
  .cat-card.tier-gold { border-left: 3px solid #D4A017; background: #FFFDF5; }
  .cat-card.tier-green { border-left: 3px solid #4CAF50; }
  .cat-card.tier-muted { background: #F8F8F8; }
  .cat-card.tier-muted .cat-card-name { color: #777; }
  .cat-card.tier-muted .cat-card-subtitle { color: #999; }
  .cat-card.tier-muted .cat-card-summary { color: #999; }
  .cat-card-star { color: #D4A017; font-size: 0.75rem; margin-left: 4px; }
  /* Status overrides (layer on top of tiers) */
  .cat-card.status-deceased { border-left: 3px solid #9E9E9E; background: #FAFAFA; }
  .cat-card.status-deceased .cat-card-name { color: var(--text-primary); }
  .cat-card.status-former-spouse { border-left: 3px solid #FF9800; }
  .cat-card.status-current-spouse { border-left: 3px solid #4CAF50; }
  /* Status pills */
  .cat-status-pill {
    position: absolute; top: 10px; right: 10px;
    font-size: 0.65rem; font-weight: 600; padding: 2px 8px;
    border-radius: 10px; text-transform: uppercase; letter-spacing: 0.3px;
  }
  .cat-status-pill.pill-current { background: #E8F5E9; color: #2E7D32; }
  .cat-status-pill.pill-former { background: #FFF3E0; color: #E65100; }
  .cat-status-pill.pill-deceased { background: #F5F5F5; color: #616161; }
  .cat-status-pill.pill-complex { background: #FFF3E0; color: #E65100; }
  .cat-subsection { margin-bottom: 20px; }
  .cat-subsection-label {
    font-size: 0.9rem; font-weight: 600; color: var(--text-primary);
    margin-bottom: 10px; padding-left: 2px;
    border-bottom: 1px solid var(--border-subtle, var(--border-primary)); padding-bottom: 6px;
  }
  .cat-sub-divider {
    font-size: 0.82rem; font-weight: 500; color: #888;
    margin-top: 16px; margin-bottom: 8px; padding-left: 2px;
    border-top: 1px solid #E0E0E0; padding-top: 10px;
  }
  .cat-sub-divider:first-child { margin-top: 0; border-top: none; padding-top: 0; }
  .sidebar-footer-user {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px; justify-content: center;
  }
  .sidebar-user-avatar {
    width: 32px; height: 32px; border-radius: 50%;
    background: var(--accent-gradient);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.6rem; font-weight: 700; color: white; flex-shrink: 0;
    overflow: hidden;
  }
  .sidebar-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .sidebar-footer-user-name {
    font-size: 13px; font-weight: 600; color: var(--text-primary);
  }
  .sidebar-footer-actions {
    display: flex; gap: 6px; justify-content: center; flex-wrap: wrap;
  }
  .sidebar-footer-actions a, .sidebar-footer-actions span a {
    color: var(--text-muted); text-decoration: none; font-size: 12px;
    transition: color var(--transition-fast);
  }
  .sidebar-footer-actions a:hover { color: var(--accent-tertiary); }
  .sidebar-footer-separator { color: var(--text-faint); }

  /* --- Skeleton Loading --- */
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .skeleton {
    background: linear-gradient(90deg, var(--bg-card) 25%, var(--bg-elevated) 50%, var(--bg-card) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: var(--radius-sm);
  }
</style>
</head>
<body>

<!-- Login Screen -->
<div id="login-screen">
  <div class="login-card">
    <div class="login-brand">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="url(#loginGrad)"/>
        <text x="18" y="23" text-anchor="middle" fill="white" font-size="14" font-weight="700" font-family="system-ui">CA</text>
        <defs><linearGradient id="loginGrad" x1="0" y1="0" x2="36" y2="36"><stop stop-color="#6366f1"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs>
      </svg>
    </div>
    <h1><span>Context Architecture</span></h1>
    <p class="subtitle">Knowledge Graph Dashboard</p>
    <a href="/auth/google" class="btn google-btn" id="btnGoogle">
      <svg width="18" height="18" viewBox="0 0 48 48" style="vertical-align:middle;margin-right:8px;">
        <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 010-9.18l-7.98-6.19a24.1 24.1 0 000 21.56l7.98-6.19z"/>
        <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Sign in with Google
    </a>
    <div class="login-divider"><span>or use API key</span></div>
    <input type="password" id="apiKeyInput" placeholder="Enter API key (ctx-...)" />
    <div class="login-error" id="loginError"></div>
    <button class="btn" id="btnLogin" onclick="login()">Connect</button>
  </div>
</div>

<!-- App -->
<div id="app">
  <div id="sidebar">
    <div class="sidebar-brand">
      <div class="brand-icon">CA</div>
      <div class="brand-text">Context Architecture</div>
    </div>
    <div class="sidebar-search">
      <div class="search-wrapper">
        <svg class="search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
          <circle cx="6.5" cy="6.5" r="5"/>
          <path d="M14.5 14.5l-4-4"/>
        </svg>
        <input type="text" id="searchInput" placeholder="Search entities..." oninput="onSearch()" />
      </div>
    </div>
    <div class="sidebar-count" id="sidebarCount"></div>
    <div id="entityList"></div>
    <div class="sidebar-footer">
      <div class="sidebar-footer-user">
        <div class="sidebar-user-avatar" id="userAvatar"></div>
        <span id="userInfo"></span>
      </div>
      <div class="sidebar-footer-actions">
        <a href="#" onclick="showUploadView();return false;">Upload</a>
        <span class="sidebar-footer-separator">&middot;</span>
        <a href="#" onclick="showCleanupView();return false;">Cleanup</a>
        <span class="sidebar-footer-separator">&middot;</span>
        <a href="#" onclick="showDriveView();return false;" id="btnDrive" style="display:none;">Drive</a>
        <span class="sidebar-footer-separator" id="driveSep" style="display:none;">&middot;</span>
        <span id="logoutLink"></span>
      </div>
    </div>
  </div>
  <div id="breadcrumbs"></div>
  <div id="main">
    <div class="empty-state" id="emptyState">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2">
        <circle cx="24" cy="24" r="20"/>
        <circle cx="24" cy="20" r="7"/>
        <path d="M12 40c0-6.627 5.373-12 12-12s12 5.373 12 12"/>
      </svg>
      <div>Select an entity from the sidebar<br/>to view its knowledge graph profile</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>
<input type="file" id="uploadFileInput" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.csv,.txt,.md,.json" style="display:none" />

<script>
var apiKey = '';
var sessionUser = null;
var entities = [];
var selectedId = null;
var selectedData = null;
var searchTimeout = null;
var primaryEntityId = null;
var primaryEntityData = null;
var allEntities = [];
var selectedView = null;
var selectedCategory = null;
var breadcrumbs = [];
var collapsedSections = {};

function esc(s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }

function renderBreadcrumbs() {
  var el = document.getElementById('breadcrumbs');
  if (!el) return;
  if (!breadcrumbs || breadcrumbs.length === 0) { el.innerHTML = ''; return; }
  var html = '<div class="breadcrumb-bar">';
  for (var i = 0; i < breadcrumbs.length; i++) {
    var b = breadcrumbs[i];
    if (i > 0) html += '<span class="breadcrumb-sep">\u203A</span>';
    if (i < breadcrumbs.length - 1 && b.action) {
      html += '<a onclick="' + b.action + '">' + esc(b.label) + '</a>';
    } else {
      html += '<span class="breadcrumb-current">' + esc(b.label) + '</span>';
    }
  }
  html += '</div>';
  el.innerHTML = html;
}

function findPrimaryUser(ents, user) {
  if (!user || !user.name) return null;
  var persons = ents.filter(function(e) { return e.entity_type === 'person'; });
  if (persons.length === 0) return null;
  var uname = user.name.toLowerCase().trim();
  var uemail = (user.email || '').toLowerCase().trim();

  for (var i = 0; i < persons.length; i++) {
    console.log('SIDEBAR_DEBUG: comparing entity:', persons[i].name, 'to user:', user.name, uemail);
  }

  // 1. Exact email match
  if (uemail) {
    for (var i = 0; i < persons.length; i++) {
      var pemail = (persons[i].email || '').toLowerCase().trim();
      if (pemail && pemail === uemail) { console.log('SIDEBAR_DEBUG: matched by email'); return persons[i].entity_id; }
    }
  }

  // 2. Exact name match
  for (var i = 0; i < persons.length; i++) {
    if (persons[i].name && persons[i].name.toLowerCase().trim() === uname) { console.log('SIDEBAR_DEBUG: matched by exact name'); return persons[i].entity_id; }
  }

  // 3. Substring match (either direction)
  for (var i = 0; i < persons.length; i++) {
    var pname = (persons[i].name || '').toLowerCase().trim();
    if (pname.indexOf(uname) !== -1 || uname.indexOf(pname) !== -1) { console.log('SIDEBAR_DEBUG: matched by substring'); return persons[i].entity_id; }
  }

  // 4. First+last word match: check if first AND last word of one appear in the other
  var uwords = uname.split(/\\s+/);
  if (uwords.length >= 2) {
    var ufirst = uwords[0];
    var ulast = uwords[uwords.length - 1];
    for (var i = 0; i < persons.length; i++) {
      var pname = (persons[i].name || '').toLowerCase();
      if (pname.indexOf(ufirst) !== -1 && pname.indexOf(ulast) !== -1) { console.log('SIDEBAR_DEBUG: matched by first+last'); return persons[i].entity_id; }
    }
  }
  // Also check reverse: entity first+last in user name
  for (var i = 0; i < persons.length; i++) {
    var pwords = (persons[i].name || '').toLowerCase().split(/\\s+/);
    if (pwords.length >= 2) {
      var pfirst = pwords[0];
      var plast = pwords[pwords.length - 1];
      if (uname.indexOf(pfirst) !== -1 && uname.indexOf(plast) !== -1) { console.log('SIDEBAR_DEBUG: matched by entity first+last in user'); return persons[i].entity_id; }
    }
  }

  // Fallback: single person entity
  if (persons.length === 1) return persons[0].entity_id;
  console.log('SIDEBAR_DEBUG: NO MATCH FOUND');
  return null;
}

// === DIMENSION-READING FUNCTIONS ===
// All categorization is driven by relationship_dimensions. No keyword matching.

function getPage(entity) {
  var d = entity.relationship_dimensions;
  if (!d || !d.connection_type) return 'other';

  // Family: blood, or marriage direct, or any in-law (sub_role gates it)
  if (d.connection_type === 'blood' || d.connection_type === 'marriage') {
    if (!d.connected_through) return 'family';
    if (d.connection_type === 'blood') return 'family';
    if (d.connection_type === 'marriage' && d.sub_role === 'in_law') return 'family';
    // Marriage through someone else (friend's spouse) = Other
    if (d.connection_type === 'marriage' && d.connected_through) return 'other';
    return 'family';
  }

  // Indirect connections with low strength = Other (friend's partners, etc.)
  if (d.connected_through && (d.strength || 0) < 0.30) return 'other';

  // Page assignment uses connection_type only — never access score
  if (d.connection_type === 'chosen') return 'friends';
  if (d.connection_type === 'professional') return 'professional';
  if (d.connection_type === 'community') return 'other';

  return 'other';
}

function getFamilySection(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return 'Extended Family';
  if (d.sub_role === 'spouse') return 'Spouse';
  if (d.sub_role === 'child') return 'Children';
  if (d.sub_role === 'parent' || d.sub_role === 'sibling' || d.sub_role === 'grandparent') return 'Parents & Siblings';
  return 'Extended Family';
}

function getParentsSiblingsSubSection(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return 'Siblings';
  if (d.sub_role === 'parent' || d.sub_role === 'grandparent') return 'Parents';
  return 'Siblings';
}

function getFriendsSection(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return 'Friends';
  var str = d.strength || 0;
  if (str >= 0.85) return 'Inner Circle';
  if (str >= 0.65) return 'Close Friends';
  if (str >= 0.40) return 'Friends';
  return 'Acquaintances';
}

function getProfessionalSection(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return 'Current';
  if (d.sub_role === 'partner') return 'Partners';
  if (d.status === 'active' || d.status === 'stable') return 'Current';
  return 'Former';
}

function getCardClasses(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return 'cat-card';
  var classes = 'cat-card';
  // Status overrides come first
  if (d.status === 'deceased') {
    return 'cat-card status-deceased';
  }
  if (d.sub_role === 'spouse' && d.status !== 'active' && d.status !== 'stable') {
    return 'cat-card status-former-spouse';
  }
  // Strength tier
  var tier = d.visual_tier || 'neutral';
  if (tier === 'gold') return 'cat-card tier-gold';
  if (tier === 'green') return 'cat-card tier-green';
  if (tier === 'muted') return 'cat-card tier-muted';
  return 'cat-card';
}

function getStatusPill(entity) {
  var d = entity.relationship_dimensions;
  if (!d) return '';
  if (d.status === 'deceased') return '<span class="cat-status-pill pill-deceased">In Memory</span>';
  if (d.sub_role === 'spouse' && d.status !== 'active' && d.status !== 'stable')
    return '<span class="cat-status-pill pill-former">Former</span>';
  if (d.sub_role === 'spouse' && (d.status === 'active' || d.status === 'stable'))
    return '<span class="cat-status-pill pill-current">Current</span>';
  if (d.status === 'complicated') return '<span class="cat-status-pill pill-complex">Complex</span>';
  return '';
}

function showGoldStar(entity) {
  var d = entity.relationship_dimensions;
  return d && d.visual_tier === 'gold';
}

function getCardSubtitle(entity) {
  var d = entity.relationship_dimensions;
  return (d && d.descriptor) || entity.descriptor || entity._relType || entity.summary || '';
}

function sortPeopleGroup(group, category) {
  // All sections: living first by strength desc, then deceased by strength desc
  if (category === 'family') {
    var rolePriority = { 'spouse': 1, 'child': 2, 'parent': 3, 'grandparent': 3, 'sibling': 4 };
    group.sort(function(a, b) {
      var da = a.relationship_dimensions || {};
      var db = b.relationship_dimensions || {};
      // Deceased sort after living
      var aDead = da.status === 'deceased' ? 1 : 0;
      var bDead = db.status === 'deceased' ? 1 : 0;
      if (aDead !== bDead) return aDead - bDead;
      var pa = rolePriority[da.sub_role] || 99;
      var pb = rolePriority[db.sub_role] || 99;
      if (pa !== pb) return pa - pb;
      var sa = da.strength || 0;
      var sb = db.strength || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  } else {
    // Friends, Professional, Other: living first, then deceased, each by strength desc
    group.sort(function(a, b) {
      var da = a.relationship_dimensions || {};
      var db = b.relationship_dimensions || {};
      var aDead = da.status === 'deceased' ? 1 : 0;
      var bDead = db.status === 'deceased' ? 1 : 0;
      if (aDead !== bDead) return aDead - bDead;
      var sa = da.strength || 0;
      var sb = db.strength || 0;
      if (sa !== sb) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
  }
  return group;
}

function buildSidebarData() {
  var q = (document.getElementById('searchInput') || {}).value;
  q = (q || '').trim().toLowerCase();
  var isSearching = q.length > 0;

  // Build relationship map from primary entity (store raw data, not pre-categorized)
  var relMap = {};
  var primaryUserName = '';
  if (primaryEntityData && primaryEntityData.entity) {
    var pn = primaryEntityData.entity.name || {};
    primaryUserName = (pn.full || pn.preferred || '').toLowerCase().trim();
  }
  if (primaryEntityData && primaryEntityData.relationships) {
    var rels = primaryEntityData.relationships;
    for (var i = 0; i < rels.length; i++) {
      var rname = (rels[i].name || '').toLowerCase().trim();
      var entry = {
        type: rels[i].relationship_type || '',
        context: rels[i].context || '',
        strength: rels[i].strength || '',
        trust_level: rels[i].trust_level || ''
      };
      relMap[rname] = entry;
      // Also key by name without parentheticals: "Allen Jones (Big Al)" -> "allen jones"
      var stripped = rname.replace(/\\s*\\([^)]*\\)/g, '').trim();
      if (stripped && stripped !== rname) {
        relMap[stripped] = entry;
      }
    }
  }

  // Build role/credential maps from connected objects for org grouping
  var roleByOrg = {};   // orgName -> roleTitle (name-based)
  var credByOrg = {};   // orgName -> credLabel (name-based)
  var roleByOrgId = {}; // entity_id -> roleTitle (id-based, more reliable)
  var credByOrgId = {}; // entity_id -> credLabel (id-based, more reliable)
  var connectedIds = {}; // entity_id -> true (set of all connected object IDs)
  var connected = (primaryEntityData && primaryEntityData.connected_objects) || [];

  // First pass: index all connected objects by ID
  for (var i = 0; i < connected.length; i++) {
    connectedIds[connected[i].entity_id] = true;
  }

  // Second pass: build role and credential maps
  // For roles, find which org entity they reference by matching the org name
  for (var i = 0; i < connected.length; i++) {
    var c = connected[i];
    if (c.entity_type === 'role' && c.label) {
      var atIdx = c.label.indexOf(' at ');
      if (atIdx !== -1) {
        var orgName = c.label.substring(atIdx + 4).trim();
        var roleTitle = c.label.substring(0, atIdx).trim();
        roleByOrg[orgName.toLowerCase()] = roleTitle;
        // Find the connected org entity with this name and map by ID
        for (var j = 0; j < connected.length; j++) {
          var co = connected[j];
          if ((co.entity_type === 'organization' || co.entity_type === 'institution' || co.entity_type === 'business') && co.label) {
            if (co.label.toLowerCase().trim() === orgName.toLowerCase()) {
              roleByOrgId[co.entity_id] = roleTitle;
            }
          }
        }
      }
    }
    if (c.entity_type === 'credential' && c.label) {
      var commaIdx = c.label.indexOf(', ');
      if (commaIdx !== -1) {
        var instName = c.label.substring(commaIdx + 2).trim();
        credByOrg[instName.toLowerCase()] = c.label;
        // Find the connected org/institution entity with this name and map by ID
        for (var j = 0; j < connected.length; j++) {
          var co = connected[j];
          if ((co.entity_type === 'organization' || co.entity_type === 'institution' || co.entity_type === 'business') && co.label) {
            if (co.label.toLowerCase().trim() === instName.toLowerCase()) {
              credByOrgId[co.entity_id] = c.label;
            }
          }
        }
      }
    }
  }

  var you = null;
  var people = { family: [], friends: [], professional: [], community: [], other: [] };
  var organizations = { career: [], education: [], affiliations: [], services: [], other: [] };
  var projects = { active: [], rnd: [], archive: [] };
  var seenOrgNames = {}; // lowercase name -> entity_id (dedup: prefer connected objects)

  var src = isSearching ? entities : allEntities;
  for (var i = 0; i < src.length; i++) {
    var e = src[i];
    var t = e.entity_type;
    // Skip role/credential/skill from sidebar
    if (t === 'role' || t === 'credential' || t === 'skill') continue;

    // Filter out test entities
    var ename = (e.name || '');
    if (ename.match(/\\btest\\b/i) || ename.match(/\\bTestCorp\\b/i) || ename.match(/\\bBigTech\\b/i)) continue;

    if (e.entity_id === primaryEntityId) {
      you = e;
      continue;
    }
    if (t === 'person') {
      var elower = ename.toLowerCase().trim();

      // Step 1: Exact match in relMap
      var relEntry = relMap[elower] || null;

      // Step 2: Fuzzy match — strip parentheticals from entity name and try again
      if (!relEntry) {
        var eStripped = elower.replace(/\\s*\\([^)]*\\)/g, '').trim();
        if (eStripped !== elower) relEntry = relMap[eStripped] || null;
      }

      // Step 3: Fuzzy match — first+last name overlap
      if (!relEntry) {
        var eParts = elower.split(/\\s+/);
        if (eParts.length >= 2) {
          var eFirst = eParts[0];
          var eLast = eParts[eParts.length - 1];
          for (var rk in relMap) {
            if (rk.indexOf(eFirst) !== -1 && rk.indexOf(eLast) !== -1) {
              relEntry = relMap[rk];
              break;
            }
          }
          // Also try: relMap key first+last in entity name
          if (!relEntry) {
            for (var rk in relMap) {
              var rkParts = rk.split(/\\s+/);
              if (rkParts.length >= 2) {
                var rkFirst = rkParts[0];
                var rkLast = rkParts[rkParts.length - 1];
                if (elower.indexOf(rkFirst) !== -1 && elower.indexOf(rkLast) !== -1) {
                  relEntry = relMap[rk];
                  break;
                }
              }
            }
          }
        }
      }

      // Step 4: Reverse lookup — check if entity's own relationships mention the primary user
      if (!relEntry && e.relationships && primaryUserName) {
        var eRels = e.relationships;
        for (var ri = 0; ri < eRels.length; ri++) {
          var erName = (eRels[ri].name || '').toLowerCase();
          if (erName && primaryUserName.indexOf(erName) !== -1) {
            relEntry = { type: eRels[ri].relationship_type || '', context: eRels[ri].context || '', strength: '', trust_level: '' };
            break;
          }
          // Also fuzzy: first+last of rel name in primary user name
          var erParts = erName.split(/\\s+/);
          if (erParts.length >= 2) {
            if (primaryUserName.indexOf(erParts[0]) !== -1 && primaryUserName.indexOf(erParts[erParts.length - 1]) !== -1) {
              relEntry = { type: eRels[ri].relationship_type || '', context: eRels[ri].context || '', strength: '', trust_level: '' };
              break;
            }
          }
        }
      }

      // Categorize using dimension-reading functions
      var page = getPage(e);
      console.log('CAT_DEBUG:', ename, '->', page);

      // Set subtitle from descriptor
      e._relType = getCardSubtitle(e);

      if (people[page]) {
        people[page].push(e);
      } else {
        people.other.push(e);
      }
    } else if (t === 'organization' || t === 'business' || t === 'institution') {
      var oname = ename.toLowerCase().trim();

      // Dedup: skip if we already added an entity with this name
      // Prefer connected objects (which are processed first in allEntities)
      if (seenOrgNames[oname] && seenOrgNames[oname] !== e.entity_id) continue;
      seenOrgNames[oname] = e.entity_id;

      // Priority 1: Read org_category attribute (set by /api/cleanup-orgs)
      var orgCat = '';
      var orgRole = '';
      var orgDates = '';
      var orgCred = '';
      var orgGradYear = '';
      var eaList = e.attributes || [];
      for (var ai = 0; ai < eaList.length; ai++) {
        if (eaList[ai].key === 'org_category') orgCat = (eaList[ai].value || '').toLowerCase();
        if (eaList[ai].key === 'cj_role') orgRole = eaList[ai].value || '';
        if (eaList[ai].key === 'cj_dates') orgDates = eaList[ai].value || '';
        if (eaList[ai].key === 'cj_credential') orgCred = eaList[ai].value || '';
        if (eaList[ai].key === 'cj_grad_year') orgGradYear = eaList[ai].value || '';
      }

      // Build subtitle from attribute data
      var orgSubtitle = '';
      if (orgCat === 'career') {
        orgSubtitle = orgRole || roleByOrgId[e.entity_id] || roleByOrg[oname] || '';
        if (orgDates) orgSubtitle += (orgSubtitle ? ' (' + orgDates + ')' : orgDates);
      } else if (orgCat === 'education') {
        orgSubtitle = orgCred || credByOrgId[e.entity_id] || credByOrg[oname] || '';
        if (orgGradYear) orgSubtitle += (orgSubtitle ? ' (' + orgGradYear + ')' : orgGradYear);
      }

      if (orgCat === 'career' || orgCat === 'education' || orgCat === 'affiliations' || orgCat === 'services') {
        organizations[orgCat].push({ org: e, subtitle: orgSubtitle });
      } else {
        // Priority 2: Fallback to role/credential matching
        if (roleByOrgId[e.entity_id]) {
          organizations.career.push({ org: e, subtitle: roleByOrgId[e.entity_id] });
        } else if (credByOrgId[e.entity_id]) {
          organizations.education.push({ org: e, subtitle: credByOrgId[e.entity_id] });
        } else if (roleByOrg[oname]) {
          organizations.career.push({ org: e, subtitle: roleByOrg[oname] });
        } else if (credByOrg[oname]) {
          organizations.education.push({ org: e, subtitle: credByOrg[oname] });
        } else {
          // Fuzzy match
          var matched = false;
          for (var rk in roleByOrg) {
            if (oname.indexOf(rk) !== -1 || rk.indexOf(oname) !== -1) {
              organizations.career.push({ org: e, subtitle: roleByOrg[rk] });
              matched = true;
              break;
            }
          }
          if (!matched) {
            for (var ck in credByOrg) {
              if (oname.indexOf(ck) !== -1 || ck.indexOf(oname) !== -1) {
                organizations.education.push({ org: e, subtitle: credByOrg[ck] });
                matched = true;
                break;
              }
            }
          }
          if (!matched) {
            organizations.other.push({ org: e, subtitle: '' });
          }
        }
      }
    } else if (t === 'project') {
      projects.active.push(e);
    }
  }

  // Sort people groups
  sortPeopleGroup(people.family, 'family');
  sortPeopleGroup(people.friends, 'friends');
  sortPeopleGroup(people.professional, 'professional');
  sortPeopleGroup(people.community, 'community');
  sortPeopleGroup(people.other, 'other');

  // If not searching and primary not in allEntities, still show You if we have data
  if (!you && primaryEntityId && !isSearching) {
    for (var i = 0; i < allEntities.length; i++) {
      if (allEntities[i].entity_id === primaryEntityId) { you = allEntities[i]; break; }
    }
  }
  return { you: you, people: people, organizations: organizations, projects: projects };
}

function selectView(viewId) {
  if (!primaryEntityId) return;
  selectedId = primaryEntityId;
  selectedView = viewId;
  selectedCategory = null;
  var viewLabels = { 'overview': 'Overview', 'career-lite': 'Career Lite', 'executive-brief': 'Executive Brief', 'creator-profile': 'Creator Profile', 'values-identity': 'Values & Identity' };
  breadcrumbs = [
    { label: 'My Profiles', action: '' },
    { label: viewLabels[viewId] || viewId }
  ];
  renderBreadcrumbs();
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';

  if (viewId === 'career-lite') {
    if (primaryEntityData) {
      renderCareerLite(primaryEntityData);
    } else {
      api('GET', '/api/entity/' + primaryEntityId).then(function(data) {
        primaryEntityData = data;
        selectedData = data;
        renderCareerLite(data);
      });
    }
  } else if (viewId === 'overview') {
    if (primaryEntityData) {
      renderProfileOverview(primaryEntityData);
    } else {
      api('GET', '/api/entity/' + primaryEntityId).then(function(data) {
        primaryEntityData = data;
        selectedData = data;
        renderProfileOverview(data);
      });
    }
  } else if (viewId === 'executive-brief') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Executive Brief</div><div style="color:var(--text-muted);">Coming soon &mdash; Achievement-led professional profile</div></div>';
  } else if (viewId === 'creator-profile') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Creator Profile</div><div style="color:var(--text-muted);">Coming soon &mdash; Projects, content, and ventures</div></div>';
  } else if (viewId === 'values-identity') {
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Values &amp; Identity</div><div style="color:var(--text-muted);">Coming soon &mdash; Core values, interests, and personality</div></div>';
  } else {
    var label = viewId.replace(/-/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    document.getElementById('main').innerHTML = '<div class="empty-state"><div style="font-size:1.1rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">' + esc(label) + '</div><div style="color:var(--text-muted);">Coming soon</div></div>';
  }
  renderSidebar();
}

function selectCategoryPage(category) {
  selectedCategory = category;
  selectedId = null;
  selectedView = null;
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
  var catLabels = { family: 'Family', friends: 'Friends', professional: 'Professional', community: 'Communities', other: 'Other' };
  breadcrumbs = [
    { label: 'People', action: '' },
    { label: catLabels[category] || category }
  ];
  renderBreadcrumbs();
  var data = buildSidebarData();
  var people = data.people[category] || [];
  renderCategoryPage(category, people);
  renderSidebar();
}

function renderPeopleCards(people, category) {
  var html = '';
  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    var pName = p.name || '';
    var pSub = getCardSubtitle(p);
    var pSummary = (p.summary || '').substring(0, 120);
    if ((p.summary || '').length > 120) pSummary += '...';

    var cardClass = getCardClasses(p);
    var pillHtml = getStatusPill(p);
    var starHtml = showGoldStar(p) ? '<span class="cat-card-star">\u2605</span>' : '';

    // Keep star for deceased gold-tier entities
    var d = p.relationship_dimensions || {};
    if (d.status === 'deceased' && d.visual_tier === 'gold') {
      starHtml = '<span class="cat-card-star">\u2605</span>';
    }

    html += '<div class="' + cardClass + '" onclick="selectEntity(' + "'" + esc(p.entity_id) + "'" + ',' + "'" + category + "'" + ')">';
    if (pillHtml) html += pillHtml;
    html += '<div class="cat-card-name">' + esc(pName) + starHtml + '</div>';
    if (pSub) html += '<div class="cat-card-subtitle">' + esc(pSub) + '</div>';
    if (pSummary) html += '<div class="cat-card-summary">' + esc(pSummary) + '</div>';
    html += '</div>';
  }
  return html;
}

function renderSubSection(label, people, category) {
  if (people.length === 0) return '';
  var html = '<div class="cat-subsection">';
  html += '<div class="cat-subsection-label">' + esc(label) + ' (' + people.length + ')</div>';
  html += '<div class="cat-card-grid">';
  html += renderPeopleCards(people, category);
  html += '</div></div>';
  return html;
}

function renderParentsSiblingsSection(parentsSiblings, category) {
  if (parentsSiblings.length === 0) return '';
  // Split using sub_role from dimensions — no keyword matching
  var parents = [], siblings = [];
  for (var i = 0; i < parentsSiblings.length; i++) {
    var subSec = getParentsSiblingsSubSection(parentsSiblings[i]);
    if (subSec === 'Parents') parents.push(parentsSiblings[i]);
    else siblings.push(parentsSiblings[i]);
  }
  var html = '<div class="cat-subsection">';
  html += '<div class="cat-subsection-label">Parents & Siblings (' + parentsSiblings.length + ')</div>';
  if (parents.length > 0) {
    html += '<div class="cat-sub-divider">Parents (' + parents.length + ')</div>';
    html += '<div class="cat-card-grid">';
    html += renderPeopleCards(parents, category);
    html += '</div>';
  }
  if (siblings.length > 0) {
    html += '<div class="cat-sub-divider">Siblings (' + siblings.length + ')</div>';
    html += '<div class="cat-card-grid">';
    html += renderPeopleCards(siblings, category);
    html += '</div>';
  }
  html += '</div>';
  return html;
}

function renderCategoryPage(category, people) {
  var catMeta = {
    family: { emoji: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC66', label: 'Family' },
    friends: { emoji: '\uD83E\uDD1D', label: 'Friends' },
    professional: { emoji: '\uD83D\uDCBC', label: 'Professional' },
    community: { emoji: '\uD83C\uDFD8\uFE0F', label: 'Communities' },
    other: { emoji: '\uD83D\uDC65', label: 'Other' }
  };
  var meta = catMeta[category] || { emoji: '', label: category };
  var html = '<div style="padding: 24px 28px;">';
  html += '<div class="cat-page-header">' + meta.emoji + ' ' + esc(meta.label);
  html += '<span class="cat-page-count">&middot; ' + people.length + ' ' + (people.length === 1 ? 'person' : 'people') + '</span>';
  html += '</div>';

  if (category === 'family') {
    // Family sub-sections using getFamilySection() — pure dimension reads
    var spouse = [], children = [], parentsSiblings = [], extended = [];
    for (var i = 0; i < people.length; i++) {
      var section = getFamilySection(people[i]);
      if (section === 'Spouse') spouse.push(people[i]);
      else if (section === 'Children') children.push(people[i]);
      else if (section === 'Parents & Siblings') parentsSiblings.push(people[i]);
      else extended.push(people[i]);
    }
    // Sort: spouse active/stable first, then by strength
    spouse.sort(function(a, b) {
      var da = (a.relationship_dimensions || {});
      var db = (b.relationship_dimensions || {});
      var aActive = (da.status === 'active' || da.status === 'stable') ? 0 : 1;
      var bActive = (db.status === 'active' || db.status === 'stable') ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (db.strength || 0) - (da.strength || 0);
    });
    // Parents before grandparents, then by strength
    parentsSiblings.sort(function(a, b) {
      var da = (a.relationship_dimensions || {});
      var db = (b.relationship_dimensions || {});
      var rolePri = { 'parent': 1, 'grandparent': 2, 'sibling': 3 };
      var pa = rolePri[da.sub_role] || 99;
      var pb = rolePri[db.sub_role] || 99;
      if (pa !== pb) return pa - pb;
      return (db.strength || 0) - (da.strength || 0);
    });
    // Extended by strength descending
    extended.sort(function(a, b) {
      return ((b.relationship_dimensions || {}).strength || 0) - ((a.relationship_dimensions || {}).strength || 0);
    });
    html += renderSubSection('Spouse', spouse, category);
    html += renderSubSection('Children', children, category);
    html += renderParentsSiblingsSection(parentsSiblings, category);
    html += renderSubSection('Extended Family', extended, category);
  } else if (category === 'friends') {
    // Friends sub-sections using getFriendsSection()
    var innerCircle = [], closeFriends = [], friends = [], acquaintances = [];
    for (var i = 0; i < people.length; i++) {
      var section = getFriendsSection(people[i]);
      if (section === 'Inner Circle') innerCircle.push(people[i]);
      else if (section === 'Close Friends') closeFriends.push(people[i]);
      else if (section === 'Friends') friends.push(people[i]);
      else acquaintances.push(people[i]);
    }
    html += renderSubSection('Inner Circle', innerCircle, category);
    html += renderSubSection('Close Friends', closeFriends, category);
    html += renderSubSection('Friends', friends, category);
    html += renderSubSection('Acquaintances', acquaintances, category);
  } else if (category === 'professional') {
    // Professional sub-sections using getProfessionalSection()
    var partners = [], current = [], former = [];
    for (var i = 0; i < people.length; i++) {
      var section = getProfessionalSection(people[i]);
      if (section === 'Partners') partners.push(people[i]);
      else if (section === 'Current') current.push(people[i]);
      else former.push(people[i]);
    }
    html += renderSubSection('Partners', partners, category);
    html += renderSubSection('Current', current, category);
    html += renderSubSection('Former', former, category);
  } else {
    // Other / Community: flat grid sorted by strength
    html += '<div class="cat-card-grid">';
    html += renderPeopleCards(people, category);
    html += '</div>';
  }

  if (people.length === 0) {
    html += '<div style="padding:24px;color:var(--text-muted);text-align:center;">No people in this category</div>';
  }
  html += '</div>';
  document.getElementById('main').innerHTML = html;
}

function selectOrgCategoryPage(category) {
  selectedCategory = 'org_' + category;
  selectedId = null;
  selectedView = null;
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
  var catLabels = { career: 'Career', education: 'Education', affiliations: 'Affiliations', services: 'Services', other: 'Other' };
  breadcrumbs = [
    { label: 'Organizations', action: '' },
    { label: catLabels[category] || category }
  ];
  renderBreadcrumbs();
  var data = buildSidebarData();
  var orgs = data.organizations[category] || [];
  renderOrgCategoryPage(category, orgs);
  renderSidebar();
}

function renderOrgCategoryPage(category, orgs) {
  var catMeta = {
    career: { emoji: '\uD83D\uDCBC', label: 'Career' },
    education: { emoji: '\uD83C\uDF93', label: 'Education' },
    affiliations: { emoji: '\uD83E\uDD1D', label: 'Affiliations' },
    services: { emoji: '\uD83C\uDFE6', label: 'Services' },
    other: { emoji: '\uD83C\uDFE2', label: 'Other' }
  };
  var meta = catMeta[category] || { emoji: '', label: category };
  var html = '<div style="padding: 24px 28px;">';
  html += '<div class="cat-page-header">' + meta.emoji + ' ' + esc(meta.label);
  html += '<span class="cat-page-count">&middot; ' + orgs.length + ' ' + (orgs.length === 1 ? 'organization' : 'organizations') + '</span>';
  html += '</div>';
  html += '<div class="cat-card-grid">';
  for (var i = 0; i < orgs.length; i++) {
    var item = orgs[i];
    var o = item.org || item;
    var oName = o.name || '';
    var oSub = item.subtitle || '';
    var oSummary = (o.summary || '').substring(0, 140);
    if ((o.summary || '').length > 140) oSummary += '...';
    var oType = o.entity_type || '';
    var typeBadge = '';
    if (oType === 'institution') typeBadge = '<span style="font-size:0.7rem;background:#e0e7ff;color:#4338ca;padding:1px 6px;border-radius:8px;margin-left:6px;">Institution</span>';
    else if (oType === 'business') typeBadge = '<span style="font-size:0.7rem;background:#dcfce7;color:#166534;padding:1px 6px;border-radius:8px;margin-left:6px;">Business</span>';
    html += '<div class="cat-card" onclick="selectEntity(' + "'" + esc(o.entity_id) + "'" + ',' + "'" + 'org_' + category + "'" + ')">';
    html += '<div class="cat-card-name">' + esc(oName) + typeBadge + '</div>';
    if (oSub) html += '<div class="cat-card-subtitle">' + esc(oSub) + '</div>';
    if (oSummary) html += '<div class="cat-card-summary">' + esc(oSummary) + '</div>';
    html += '</div>';
  }
  html += '</div>';
  if (orgs.length === 0) {
    html += '<div style="padding:24px;color:var(--text-muted);text-align:center;">No organizations in this category</div>';
  }
  html += '</div>';
  document.getElementById('main').innerHTML = html;
}

function renderProfileOverview(data) {
  var e = data.entity || {};
  var name = (e.name && (e.name.full || e.name.preferred || e.name.common)) || '';
  var summary = (e.summary && e.summary.value) || '';
  var attrs = data.attributes || [];
  var connected = data.connected_objects || [];
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  var rels = data.relationships || [];

  // Extract key attributes
  var headline = '', location = '';
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].key === 'headline') headline = String(attrs[i].value || '');
    if (attrs[i].key === 'location') location = String(attrs[i].value || '');
  }

  // Count connected objects by type
  var connCounts = {};
  for (var i = 0; i < connected.length; i++) {
    var ct = connected[i].entity_type;
    connCounts[ct] = (connCounts[ct] || 0) + 1;
  }

  var h = '';

  // Profile header with large avatar
  h += '<div style="display:flex;align-items:center;gap:20px;padding:24px 0 16px;">';
  h += '<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:1.5rem;font-weight:700;color:white;flex-shrink:0;overflow:hidden;">';
  if (sessionUser && sessionUser.picture) {
    h += '<img src="' + esc(sessionUser.picture) + '" alt="" style="width:100%;height:100%;object-fit:cover;" />';
  } else {
    var initials = name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
    h += initials;
  }
  h += '</div>';
  h += '<div>';
  h += '<h2 style="font-size:1.4rem;font-weight:700;color:var(--text-primary);margin:0 0 4px;">' + esc(name) + '</h2>';
  if (headline) h += '<div style="font-size:0.9rem;color:var(--text-secondary);margin-bottom:4px;">' + esc(headline) + '</div>';
  if (location) h += '<div style="font-size:0.82rem;color:var(--text-muted);display:flex;align-items:center;gap:4px;">&#128205; ' + esc(location) + '</div>';
  h += '</div></div>';

  // Key stats card
  var roleCount = connCounts['role'] || 0;
  var skillCount = connCounts['skill'] || 0;
  var relCount = rels.length;
  h += '<div style="display:flex;gap:16px;margin-bottom:20px;">';
  var stats = [
    { n: roleCount, l: 'Roles' },
    { n: skillCount, l: 'Skills' },
    { n: relCount, l: 'Connections' }
  ];
  for (var i = 0; i < stats.length; i++) {
    h += '<div style="flex:1;background:var(--bg-card);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:12px 16px;text-align:center;">';
    h += '<div style="font-size:1.3rem;font-weight:700;color:#6366f1;">' + stats[i].n + '</div>';
    h += '<div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">' + stats[i].l + '</div>';
    h += '</div>';
  }
  h += '</div>';

  // Summary
  if (summary) {
    h += '<div class="section"><div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div></div>';
  }

  // Top 3 recent observations
  if (obs.length > 0) {
    var topObs = obs.slice(0, 3);
    h += '<div class="section"><div class="section-title section-title-only">Recent Observations</div>';
    for (var i = 0; i < topObs.length; i++) {
      var o = topObs[i];
      var decay = calcDecay(o.observed_at);
      h += '<div class="obs-card" style="opacity:' + Math.max(0.5, decay).toFixed(2) + '">';
      h += '<div class="obs-text">' + esc(o.observation) + '</div>';
      h += '<div class="obs-meta">';
      h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      h += confidenceBadge(o.confidence, o.confidence_label);
      h += '</div></div>';
    }
    h += '</div>';
  }

  // Connected objects summary
  var connKeys = Object.keys(connCounts);
  if (connKeys.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:10px;">';
    var connLabels = { role: 'Roles', organization: 'Organizations', institution: 'Institutions', credential: 'Credentials', skill: 'Skills' };
    for (var i = 0; i < connKeys.length; i++) {
      var ck = connKeys[i];
      var cl = connLabels[ck] || (ck.charAt(0).toUpperCase() + ck.slice(1) + 's');
      h += '<div style="background:var(--bg-card);border:1px solid var(--border-primary);border-radius:var(--radius-md);padding:8px 14px;font-size:0.82rem;">';
      h += '<span style="font-weight:600;color:#6366f1;">' + connCounts[ck] + '</span> ' + esc(cl);
      h += '</div>';
    }
    h += '</div></div>';
  }

  document.getElementById('main').innerHTML = h;
}

function renderOverview(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  if (['role', 'organization', 'credential', 'skill'].indexOf(type) !== -1) {
    return renderConnectedDetail(data);
  }
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  var summary = e.summary?.value || '';
  var meta = data.extraction_metadata || {};
  var h = '';

  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += confidenceBadge(meta.extraction_confidence);
  h += '</div>';

  h += '<div class="section">';
  h += '<div class="section-header"><span class="section-title">Summary</span>';
  h += '<button class="btn-sm" id="btnEditSummary" onclick="toggleSummaryEdit()">Edit</button></div>';
  h += '<div id="summaryDisplay" class="summary-text">' + esc(summary) + '</div>';
  h += '<div id="summaryEditSection" style="display:none">';
  h += '<textarea class="summary-edit" id="summaryEdit">' + esc(summary) + '</textarea>';
  h += '<div class="edit-actions"><button class="btn-save" onclick="saveSummary()">Save</button>';
  h += '<button class="btn-cancel" onclick="toggleSummaryEdit()">Cancel</button></div>';
  h += '</div></div>';

  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Attributes</div>';
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      h += '<div class="attr-row"><span class="attr-key">' + esc(a.key) + '</span>';
      h += '<span class="attr-value">' + esc(String(a.value || '')) + '</span>';
      h += confidenceBadge(a.confidence, a.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  var rels = data.relationships || [];
  if (rels.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Relationships</div>';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += sentimentBadge(r.sentiment);
      h += confidenceBadge(r.confidence, r.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  var vals = data.values || [];
  if (vals.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Values</div>';
    for (var i = 0; i < vals.length; i++) {
      h += '<div class="value-item"><span class="value-text">' + esc(vals[i].value || '') + '</span>';
      h += confidenceBadge(vals[i].confidence, vals[i].confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  h += '<div class="section"><div class="section-title section-title-only">Observations (' + obs.length + ')</div>';
  if (obs.length === 0) {
    h += '<div style="color:#3a3a4a;font-size:0.82rem;padding:8px 0;">No observations yet</div>';
  }
  for (var i = 0; i < obs.length; i++) {
    var o = obs[i];
    var decay = calcDecay(o.observed_at);
    var opacity = Math.max(0.35, decay);
    h += '<div class="obs-card" style="opacity:' + opacity.toFixed(2) + '">';
    h += '<div class="obs-text">' + esc(o.observation) + '</div>';
    h += '<div class="obs-meta">';
    h += confidenceBadge(o.confidence, o.confidence_label);
    h += layerBadge(o.layer_number);
    if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
    h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
    h += '<span class="obs-decay">' + (decay * 100).toFixed(0) + '% weight</span>';
    h += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
    h += '</div></div>';
  }
  h += '</div>';

  var connected = data.connected_objects || [];
  if (connected.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects (' + connected.length + ')</div>';
    var groups = { role: [], organization: [], institution: [], credential: [], skill: [] };
    for (var i = 0; i < connected.length; i++) {
      var c = connected[i];
      if (groups[c.entity_type]) groups[c.entity_type].push(c);
    }
    var groupLabels = { role: 'Roles', organization: 'Organizations', institution: 'Institutions', credential: 'Credentials', skill: 'Skills' };
    var groupKeys = ['role', 'organization', 'institution', 'credential', 'skill'];
    for (var g = 0; g < groupKeys.length; g++) {
      var gk = groupKeys[g];
      var items = groups[gk];
      if (items.length === 0) continue;
      h += '<div style="margin-bottom:12px;"><div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">' + groupLabels[gk] + '</div>';
      for (var j = 0; j < items.length; j++) {
        h += '<div class="entity-item" style="padding:6px 10px;cursor:pointer;" onclick="selectEntity(' + "'" + esc(items[j].entity_id) + "'" + ')">';
        h += '<span class="entity-item-name">' + esc(items[j].label) + '</span>';
        h += '<span class="type-badge ' + esc(items[j].entity_type) + '">' + esc(items[j].entity_type) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
  }

  h += '<div class="section"><div class="section-title section-title-only">Add Observation</div>';
  h += '<div class="add-obs-form">';
  h += '<textarea class="obs-textarea" id="obsText" placeholder="What did you learn about this entity?"></textarea>';
  h += '<div class="obs-form-row">';
  h += '<select id="obsConfidence"><option value="VERIFIED">Verified</option>';
  h += '<option value="STRONG" selected>Strong</option><option value="MODERATE">Moderate</option>';
  h += '<option value="SPECULATIVE">Speculative</option><option value="UNCERTAIN">Uncertain</option></select>';
  h += '<select id="obsLayer"><option value="L1_OBJECTIVE">L1 Objective</option>';
  h += '<option value="L2_GROUP" selected>L2 Group</option><option value="L3_PERSONAL">L3 Personal</option></select>';
  h += '<button class="btn-add" id="btnAddObs" onclick="addObs()">Add Observation</button>';
  h += '</div></div></div>';

  document.getElementById('main').innerHTML = h;
}

function toggleSection(sectionId) {
  collapsedSections[sectionId] = !collapsedSections[sectionId];
  try { sessionStorage.setItem('ca_collapsed', JSON.stringify(collapsedSections)); } catch(e) {}
  renderSidebar();
}

function toggleProfileSection(id) {
  var body = document.getElementById('profile-sec-' + id);
  if (!body) return;
  var header = body.previousElementSibling;
  if (body.classList.contains('hidden')) {
    body.classList.remove('hidden');
    if (header) header.classList.remove('collapsed');
  } else {
    body.classList.add('hidden');
    if (header) header.classList.add('collapsed');
  }
}

// Capture OAuth session token from URL and store in sessionStorage
(function() {
  var params = new URLSearchParams(window.location.search);
  var sessionToken = params.get('session');
  if (sessionToken) {
    sessionStorage.setItem('ca_token', sessionToken);
    history.replaceState(null, '', '/wiki');
  }
})();

function getAuthHeaders() {
  var headers = { 'X-Agent-Id': 'wiki-dashboard' };
  if (apiKey) {
    headers['X-Context-API-Key'] = apiKey;
  } else {
    var token = sessionStorage.getItem('ca_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
  }
  return headers;
}

function api(method, path, body) {
  var opts = {
    method: method,
    headers: getAuthHeaders(),
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(path, opts).then(function(r) {
    if (!r.ok) return r.json().then(function(e) { throw new Error(e.error || 'Request failed'); });
    return r.json();
  });
}

function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('active');
  setTimeout(function() { el.classList.remove('active'); }, 2000);
}

function enterApp(user) {
  sessionUser = user;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';

  // Restore collapsed sections from sessionStorage
  try {
    var saved = sessionStorage.getItem('ca_collapsed');
    if (saved) collapsedSections = JSON.parse(saved);
  } catch(e) {}

  // Set up footer user info
  if (user && user.name) {
    document.getElementById('userInfo').innerHTML = '<span class="sidebar-footer-user-name">' + esc(user.name) + '</span>';
    document.getElementById('logoutLink').innerHTML = '<a href="#" onclick="logout();return false;">Logout</a>';
    document.getElementById('btnDrive').style.display = 'inline';
    document.getElementById('driveSep').style.display = 'inline';
    // User avatar
    var avatarEl = document.getElementById('userAvatar');
    if (user.picture) {
      avatarEl.innerHTML = '<img src="' + esc(user.picture) + '" alt="" />';
    } else {
      var initials = user.name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
      avatarEl.textContent = initials;
    }
  }

  // Two-phase load: fetch all entities, then identify primary user
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    primaryEntityId = findPrimaryUser(allEntities, sessionUser);
    if (primaryEntityId) {
      return api('GET', '/api/entity/' + primaryEntityId).then(function(fullData) {
        primaryEntityData = fullData;
        renderSidebar();
        selectView('overview');
      });
    } else {
      renderSidebar();
    }
  });
}

function logout() {
  sessionStorage.removeItem('ca_token');
  fetch('/auth/logout', { method: 'POST' }).then(function() {
    window.location.reload();
  });
}

/* --- Login --- */
// Auto-login: check for existing session (Bearer token from sessionStorage)
(function() {
  var token = sessionStorage.getItem('ca_token');
  if (!token) return; // No token — show login screen
  fetch('/auth/me', { headers: { 'Authorization': 'Bearer ' + token } }).then(function(r) {
    if (r.ok) return r.json();
    throw new Error('auth failed: ' + r.status);
  }).then(function(user) {
    if (user && user.tenant_id) {
      enterApp(user);
    }
  }).catch(function(err) {
    sessionStorage.removeItem('ca_token');
  });
})();

// Manual API key login
function login() {
  apiKey = document.getElementById('apiKeyInput').value.trim();
  if (!apiKey) return;
  document.getElementById('btnLogin').disabled = true;
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    renderSidebar();
  }).catch(function(err) {
    var el = document.getElementById('loginError');
    el.textContent = err.message; el.classList.add('active');
    document.getElementById('btnLogin').disabled = false;
  });
}
document.getElementById('apiKeyInput').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') login();
});

/* --- Sidebar --- */
function onSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(function() {
    var q = document.getElementById('searchInput').value.trim();
    if (!q) {
      // Empty search — restore all entities and clear search state
      entities = allEntities.slice();
      renderSidebar();
      // Restore previous main panel state
      if (selectedCategory) {
        selectCategoryPage(selectedCategory);
      } else if (selectedId) {
        selectEntity(selectedId);
      } else {
        breadcrumbs = [];
        renderBreadcrumbs();
        var empty = document.getElementById('emptyState');
        if (empty) empty.style.display = '';
      }
      return;
    }
    var url = '/api/search?q=' + encodeURIComponent(q);
    api('GET', url).then(function(data) {
      var results = data.results || [];
      entities = results;
      selectedCategory = null;
      selectedId = null;
      selectedView = null;
      breadcrumbs = [{ label: 'Search: ' + q }];
      renderBreadcrumbs();
      renderSearchResults(results, q);
      renderSidebar();
    });
  }, 250);
}

function renderSearchResults(results, query) {
  var html = '<div style="padding: 24px 28px;">';
  html += '<div class="cat-page-header">';
  html += 'Search results for ' + "'" + esc(query) + "'";
  html += '<span class="cat-page-count">&middot; ' + results.length + ' ' + (results.length === 1 ? 'result' : 'results') + '</span>';
  html += '</div>';
  if (results.length === 0) {
    html += '<div style="padding:24px;color:var(--text-muted);text-align:center;">No results found</div>';
  } else {
    html += '<div class="cat-card-grid">';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var rName = r.name || r.entity_id || '';
      var rType = r.entity_type || '';
      var rSummary = (r.summary || '').substring(0, 120);
      if ((r.summary || '').length > 120) rSummary += '...';
      html += '<div class="cat-card" onclick="selectEntity(' + "'" + esc(r.entity_id) + "'" + ')">';
      html += '<div class="cat-card-name">' + esc(rName) + ' <span class="type-badge ' + rType + '">' + esc(rType) + '</span></div>';
      if (rSummary) html += '<div class="cat-card-summary">' + esc(rSummary) + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }
  html += '</div>';
  document.getElementById('main').innerHTML = html;
}

function renderSidebarSection(id, emoji, title, count, contentFn, defaultCollapsed) {
  var isCollapsed = collapsedSections[id] !== undefined ? collapsedSections[id] : !!defaultCollapsed;
  var html = '<div class="sidebar-section">';
  html += '<div class="sidebar-section-header" onclick="toggleSection(' + "'" + id + "'" + ')">';
  html += '<span class="sidebar-section-chevron' + (isCollapsed ? ' collapsed' : '') + '">&#9660;</span>';
  html += '<span class="sidebar-section-title">' + emoji + ' ' + esc(title) + '</span>';
  if (count != null) html += '<span class="sidebar-section-count">' + count + '</span>';
  html += '</div>';
  html += '<div class="sidebar-section-body' + (isCollapsed ? ' collapsed' : '') + '">';
  html += contentFn();
  html += '</div></div>';
  return html;
}

function renderSidebarEntityRow(e, subtitle) {
  var cls = (e.entity_id === selectedId && selectedView === null) ? 'sidebar-entity-row active' : 'sidebar-entity-row';
  var html = '<div class="' + cls + '" onclick="selectEntity(' + "'" + esc(e.entity_id) + "'" + ')">';
  html += '<div class="entity-name">' + esc(e.name) + ' <span class="type-badge ' + e.entity_type + '">' + e.entity_type + '</span></div>';
  if (subtitle) html += '<div class="entity-subtitle">' + esc(subtitle) + '</div>';
  html += '</div>';
  return html;
}

function renderSidebar() {
  var data = buildSidebarData();
  console.log('SIDEBAR_DEBUG: buildSidebarData called');
  console.log('SIDEBAR_DEBUG: you:', data.you ? data.you.name : 'NOT FOUND');
  console.log('SIDEBAR_DEBUG: allEntities:', allEntities.length, 'entities:', entities.length);
  console.log('SIDEBAR_DEBUG: primaryEntityId:', primaryEntityId);
  console.log('SIDEBAR_DEBUG: primaryEntityData:', primaryEntityData ? 'loaded' : 'null');
  console.log('SIDEBAR_DEBUG: people fam/friends/pro/community/other:', data.people.family.length, data.people.friends.length, data.people.professional.length, data.people.community.length, data.people.other.length);
  console.log('SIDEBAR_DEBUG: orgs career/edu/affil/svc/other:', data.organizations.career.length, data.organizations.education.length, data.organizations.affiliations.length, data.organizations.services.length, data.organizations.other.length);
  var html = '';
  var totalCount = 0;

  // Section 1: My Profiles
  if (data.you) {
    html += renderSidebarSection('you', '\uD83D\uDC64', 'My Profiles', null, function() {
      var h = '';
      // Profile card with avatar + name + headline
      var headline = '';
      var pAttrs = (primaryEntityData && primaryEntityData.attributes) || [];
      for (var a = 0; a < pAttrs.length; a++) {
        if (pAttrs[a].key === 'headline') { headline = String(pAttrs[a].value || ''); break; }
      }
      h += '<div class="sidebar-profile-header">';
      h += '<div class="sidebar-profile-avatar">';
      if (sessionUser && sessionUser.picture) {
        h += '<img src="' + esc(sessionUser.picture) + '" alt="" />';
      } else {
        var n = data.you.name || (sessionUser && sessionUser.name) || '';
        var init = n.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase().slice(0, 2);
        h += init;
      }
      h += '</div>';
      h += '<div style="overflow:hidden;">';
      h += '<div class="sidebar-profile-name">' + esc(data.you.name || '') + '</div>';
      if (headline) h += '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(headline) + '</div>';
      h += '</div>';
      h += '</div>';
      // Interface sub-items
      var views = [
        { id: 'overview', icon: '\uD83D\uDCCB', label: 'Overview' },
        { id: 'career-lite', icon: '\uD83D\uDCBC', label: 'Career Lite' },
        { id: 'executive-brief', icon: '\uD83D\uDCC4', label: 'Executive Brief', soon: true },
        { id: 'creator-profile', icon: '\uD83C\uDFA8', label: 'Creator Profile', soon: true },
        { id: 'values-identity', icon: '\uD83E\uDDED', label: 'Values & Identity', soon: true }
      ];
      for (var i = 0; i < views.length; i++) {
        var v = views[i];
        var active = (selectedId === primaryEntityId && selectedView === v.id);
        var cls = 'sidebar-view-item' + (active ? ' active' : '') + (v.soon ? ' placeholder' : '');
        if (v.soon) {
          h += '<div class="' + cls + '">';
        } else {
          h += '<div class="' + cls + '" onclick="selectView(' + "'" + v.id + "'" + ')">';
        }
        h += '<span class="view-icon">' + v.icon + '</span>';
        h += '<span>' + esc(v.label) + '</span>';
        if (v.soon) h += ' <span class="coming-soon-badge">Soon</span>';
        h += '</div>';
      }
      totalCount++;
      return h;
    }, false);
  }

  // Section 2: People
  var peopleCount = data.people.family.length + data.people.friends.length +
                    data.people.professional.length + data.people.community.length + data.people.other.length;
  if (peopleCount > 0 || !data.you) {
    html += renderSidebarSection('people', '\uD83D\uDC65', 'People', peopleCount, function() {
      var h = '';
      var cats = [
        { key: 'family', emoji: '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC66', label: 'Family' },
        { key: 'friends', emoji: '\uD83E\uDD1D', label: 'Friends' },
        { key: 'professional', emoji: '\uD83D\uDCBC', label: 'Professional' },
        { key: 'community', emoji: '\uD83C\uDFD8\uFE0F', label: 'Communities' },
        { key: 'other', emoji: '\uD83D\uDC65', label: 'Other' }
      ];
      for (var g = 0; g < cats.length; g++) {
        var items = data.people[cats[g].key] || [];
        if (items.length === 0) continue;
        var isActive = selectedCategory === cats[g].key;
        h += '<div class="sidebar-cat-row' + (isActive ? ' active' : '') + '" onclick="selectCategoryPage(' + "'" + cats[g].key + "'" + ')">';
        h += '<span class="cat-emoji">' + cats[g].emoji + '</span>';
        h += '<span class="cat-label">' + esc(cats[g].label) + '</span>';
        h += '<span class="cat-count">' + items.length + '</span>';
        h += '</div>';
      }
      if (peopleCount === 0) {
        h += '<div class="sidebar-empty-hint">No people found</div>';
      }
      return h;
    }, false);
    totalCount += peopleCount;
  }

  // Section 3: Organizations (category link rows)
  var orgCount = data.organizations.career.length + data.organizations.education.length + data.organizations.affiliations.length + data.organizations.services.length + data.organizations.other.length;
  if (orgCount > 0) {
    html += renderSidebarSection('orgs', '\uD83C\uDFE2', 'Organizations', orgCount, function() {
      var h = '';
      var orgCats = [
        { key: 'career', emoji: '\uD83D\uDCBC', label: 'Career' },
        { key: 'education', emoji: '\uD83C\uDF93', label: 'Education' },
        { key: 'affiliations', emoji: '\uD83E\uDD1D', label: 'Affiliations' },
        { key: 'services', emoji: '\uD83C\uDFE6', label: 'Services' },
        { key: 'other', emoji: '\uD83C\uDFE2', label: 'Other' }
      ];
      for (var g = 0; g < orgCats.length; g++) {
        var items = data.organizations[orgCats[g].key] || [];
        if (items.length === 0) continue;
        var isActive = selectedCategory === ('org_' + orgCats[g].key);
        h += '<div class="sidebar-cat-row' + (isActive ? ' active' : '') + '" onclick="selectOrgCategoryPage(' + "'" + orgCats[g].key + "'" + ')">';
        h += '<span class="cat-emoji">' + orgCats[g].emoji + '</span>';
        h += '<span class="cat-label">' + esc(orgCats[g].label) + '</span>';
        h += '<span class="cat-count">' + items.length + '</span>';
        h += '</div>';
      }
      if (orgCount === 0) {
        h += '<div class="sidebar-empty-hint">No organizations found</div>';
      }
      return h;
    }, false);
    totalCount += orgCount;
  }

  // Section 4: Projects
  var projCount = data.projects.active.length + data.projects.rnd.length + data.projects.archive.length;
  html += renderSidebarSection('projects', '\uD83D\uDD28', 'Projects', projCount, function() {
    var h = '';
    if (projCount === 0) {
      h += '<div class="sidebar-empty-hint">No projects yet &mdash; upload project docs to get started</div>';
      return h;
    }
    if (data.projects.active.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDFE2 Active</div>';
      for (var i = 0; i < data.projects.active.length; i++) {
        h += renderSidebarEntityRow(data.projects.active[i], '');
      }
    }
    if (data.projects.rnd.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDD2C R&amp;D</div>';
      for (var i = 0; i < data.projects.rnd.length; i++) {
        h += renderSidebarEntityRow(data.projects.rnd[i], '');
      }
    }
    if (data.projects.archive.length > 0) {
      h += '<div class="sidebar-group-label">\uD83D\uDCE6 Archive</div>';
      for (var i = 0; i < data.projects.archive.length; i++) {
        h += renderSidebarEntityRow(data.projects.archive[i], '');
      }
    }
    return h;
  }, true);

  // Section 5: Timeline placeholder
  html += renderSidebarSection('timeline', '\uD83D\uDCC5', 'Timeline', null, function() {
    return '<div class="sidebar-view-item placeholder"><span class="view-icon">\uD83D\uDCC5</span><span>Coming soon</span> <span class="coming-soon-badge">Soon</span></div>';
  }, true);

  document.getElementById('entityList').innerHTML = html || '<div style="padding:16px;color:#3a3a4a;font-size:0.82rem;">No entities found</div>';
  document.getElementById('sidebarCount').textContent = totalCount + ' entit' + (totalCount === 1 ? 'y' : 'ies');
}

// Backward-compat alias
function renderEntityList() { renderSidebar(); }

/* --- Entity Detail --- */
function confirmDeleteEntity(id, name) {
  if (!confirm('Delete "' + name + '" (' + id + ') and all connected objects? This cannot be undone.')) return;
  api('DELETE', '/api/entity/' + id).then(function(result) {
    toast('Deleted ' + id + (result.connected_deleted && result.connected_deleted.length > 0 ? ' + ' + result.connected_deleted.length + ' connected objects' : ''));
    selectedId = null;
    selectedData = null;
    breadcrumbs = [];
    renderBreadcrumbs();
    document.getElementById('main').innerHTML = '<div class="empty-state">Entity deleted. Select another entity.</div>';
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  }).catch(function(err) {
    toast('Delete failed: ' + err.message);
  });
}

function selectEntity(id, fromCategory) {
  var prevCategory = fromCategory || selectedCategory;
  selectedId = id;
  selectedView = null;
  selectedCategory = null;
  var empty = document.getElementById('emptyState');
  if (empty) empty.style.display = 'none';
  api('GET', '/api/entity/' + id).then(function(data) {
    selectedData = data;
    var type = (data.entity || {}).entity_type || '';
    var eName = type === 'person' ? ((data.entity.name || {}).full || '') : ((data.entity.name || {}).common || (data.entity.name || {}).legal || '');
    // Build breadcrumbs based on entity type and navigation context
    var catLabels = { family: 'Family', friends: 'Friends', professional: 'Professional', community: 'Communities', other: 'Other' };
    if (type === 'person' && prevCategory && catLabels[prevCategory]) {
      breadcrumbs = [
        { label: 'People', action: '' },
        { label: catLabels[prevCategory], action: 'selectCategoryPage(' + "'" + prevCategory + "'" + ')' },
        { label: eName || id }
      ];
    } else if (type === 'organization' || type === 'business' || type === 'institution') {
      var orgCatLabels = { org_career: 'Career', org_education: 'Education', org_affiliations: 'Affiliations', org_services: 'Services', org_other: 'Other' };
      if (prevCategory && orgCatLabels[prevCategory]) {
        var orgCatKey = prevCategory.replace('org_', '');
        breadcrumbs = [
          { label: 'Organizations', action: '' },
          { label: orgCatLabels[prevCategory], action: 'selectOrgCategoryPage(' + "'" + orgCatKey + "'" + ')' },
          { label: eName || id }
        ];
      } else {
        breadcrumbs = [
          { label: 'Organizations', action: '' },
          { label: eName || id }
        ];
      }
    } else if (type === 'person') {
      breadcrumbs = [
        { label: 'People', action: '' },
        { label: eName || id }
      ];
    } else {
      breadcrumbs = [
        { label: eName || id }
      ];
    }
    renderBreadcrumbs();
    if (type === 'organization' || type === 'business' || type === 'institution') {
      return api('GET', '/api/entity/' + id + '/dossier').then(function(dossier) {
        renderOrgDossier(dossier);
        renderSidebar();
      });
    }
    renderDetail(data);
    renderSidebar();
  }).catch(function(err) {
    document.getElementById('main').innerHTML = '<div class="empty-state">Error loading entity: ' + esc(err.message) + '</div>';
  });
}

function confidenceBadge(conf, label) {
  if (conf == null && !label) return '';
  var cls = 'badge-moderate'; var lbl = label || '';
  if (conf >= 0.90 || lbl === 'VERIFIED') { cls = 'badge-verified'; lbl = lbl || 'VERIFIED'; }
  else if (conf >= 0.75 || lbl === 'STRONG') { cls = 'badge-strong'; lbl = lbl || 'STRONG'; }
  else if (conf >= 0.50 || lbl === 'MODERATE') { cls = 'badge-moderate'; lbl = lbl || 'MODERATE'; }
  else if (conf >= 0.25 || lbl === 'SPECULATIVE') { cls = 'badge-speculative'; lbl = lbl || 'SPECULATIVE'; }
  else { cls = 'badge-uncertain'; lbl = lbl || 'UNCERTAIN'; }
  return ' <span class="badge ' + cls + '">' + lbl + (conf != null ? ' ' + conf.toFixed(2) : '') + '</span>';
}

function layerBadge(layer) {
  if (!layer) return '';
  var labels = { 1: 'Objective', 2: 'Group', 3: 'Personal' };
  return ' <span class="badge badge-layer badge-layer-' + layer + '">L' + layer + ' ' + (labels[layer] || '') + '</span>';
}

function sentimentBadge(s) {
  if (!s) return '';
  var cls = 'sentiment-neutral';
  if (s === 'positive') cls = 'sentiment-positive';
  else if (s === 'strained') cls = 'sentiment-strained';
  return ' <span class="rel-sentiment ' + cls + '">' + esc(s) + '</span>';
}

function calcDecay(observedAt) {
  if (!observedAt) return 1;
  var days = Math.max(0, (Date.now() - new Date(observedAt).getTime()) / 86400000);
  return Math.exp(-0.03 * days);
}

/* --- File Upload --- */
var uploadFiles = [];
var uploadInProgress = false;

function showUploadView() {
  selectedId = null;
  selectedView = null;
  uploadFiles = [];
  uploadInProgress = false;
  var h = '<div class="upload-view active">';
  h += '<h2 style="font-size:1.2rem;font-weight:700;color:var(--text-primary);margin-bottom:16px;">Upload Files</h2>';
  h += '<div class="upload-dropzone" id="uploadDropzone">';
  h += '<div class="upload-dropzone-icon">+</div>';
  h += '<div class="upload-dropzone-text">Drag & drop files here, or click to browse</div>';
  h += '<div class="upload-dropzone-hint">PDF, DOC, DOCX, XLSX, CSV, TXT, MD, JSON &mdash; up to 50 MB per file</div>';
  h += '</div>';
  h += '<div class="url-extract-section" style="margin:20px 0;padding:16px;background:var(--bg-secondary,#f5f5f7);border-radius:10px;">';
  h += '<div style="font-size:0.85rem;font-weight:600;color:var(--text-primary);margin-bottom:8px;">Or paste a URL</div>';
  h += '<div style="display:flex;gap:8px;">';
  h += '<input type="url" id="urlExtractInput" placeholder="https://example.com/about" style="flex:1;padding:8px 12px;border:1px solid var(--border,#e2e2e5);border-radius:6px;font-size:0.85rem;background:var(--bg-primary,#fff);color:var(--text-primary);" />';
  h += '<button onclick="extractFromURL()" id="btnExtractUrl" style="padding:8px 16px;border:none;border-radius:6px;background:#6366f1;color:#fff;font-size:0.82rem;font-weight:600;cursor:pointer;white-space:nowrap;">Extract</button>';
  h += '</div>';
  h += '<div id="urlExtractStatus" style="margin-top:8px;font-size:0.78rem;color:var(--text-muted);display:none;"></div>';
  h += '</div>';
  h += '<div class="upload-file-list" id="uploadFileList"></div>';
  h += '<div id="uploadProgressLog" class="upload-progress-log" style="display:none;"></div>';
  h += '<div id="uploadSummary" style="display:none;"></div>';
  h += '<button class="btn-start-upload" id="btnStartUpload" onclick="startUpload()" style="display:none;">Upload & Extract</button>';
  h += '<button class="btn-back-upload" onclick="hideUploadView()">Back to Entities</button>';
  h += '</div>';
  document.getElementById('main').innerHTML = h;

  // Wire up drop zone
  var dz = document.getElementById('uploadDropzone');
  dz.addEventListener('click', function() { document.getElementById('uploadFileInput').click(); });
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', function() { dz.classList.remove('dragover'); });
  dz.addEventListener('drop', function(e) {
    e.preventDefault(); dz.classList.remove('dragover');
    addUploadFiles(e.dataTransfer.files);
  });
  document.getElementById('uploadFileInput').onchange = function(e) {
    addUploadFiles(e.target.files);
    e.target.value = '';
  };

  // Deselect sidebar items
  var items = document.querySelectorAll('.entity-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
}

function hideUploadView() {
  if (uploadInProgress) return;
  document.getElementById('main').innerHTML = '<div class="empty-state" id="emptyState">Select an entity from the sidebar<br/>to view its knowledge graph profile</div>';
}

/* --- URL Extraction --- */
var urlExtractInProgress = false;
function extractFromURL() {
  var urlInput = document.getElementById('urlExtractInput');
  var statusEl = document.getElementById('urlExtractStatus');
  var btn = document.getElementById('btnExtractUrl');
  if (!urlInput || urlExtractInProgress) return;
  var url = urlInput.value.trim();
  if (!url) { toast('Please enter a URL'); return; }
  if (!/^https?:\/\//i.test(url)) { toast('URL must start with http:// or https://'); return; }

  urlExtractInProgress = true;
  btn.disabled = true;
  btn.textContent = 'Extracting...';
  statusEl.style.display = 'block';
  statusEl.textContent = 'Fetching and analyzing ' + url + '...';

  api('POST', '/api/extract-url', { url: url }).then(function(data) {
    urlExtractInProgress = false;
    btn.disabled = false;
    btn.textContent = 'Extract';

    if (!data.entities || data.entities.length === 0) {
      statusEl.textContent = 'No entities found at that URL.';
      statusEl.style.color = 'var(--warning, #d97706)';
      return;
    }

    statusEl.textContent = 'Found ' + data.entities.length + ' entities from ' + url;
    statusEl.style.color = 'var(--success, #22c55e)';

    // Feed into existing preview flow
    previewEntities = data.entities;
    previewSource = 'url_extract:' + url;

    // Show summary + preview checklist
    var sumEl = document.getElementById('uploadSummary');
    if (sumEl) {
      sumEl.style.display = 'block';
      sumEl.innerHTML = '';
    }
    var logEl = document.getElementById('uploadProgressLog');
    if (logEl) { logEl.style.display = 'block'; logEl.innerHTML = '<div style="padding:8px;color:var(--success);">Extracted ' + data.entity_count + ' entities from URL</div>'; }
    renderPreviewChecklist();
  }).catch(function(err) {
    urlExtractInProgress = false;
    btn.disabled = false;
    btn.textContent = 'Extract';
    statusEl.textContent = 'Error: ' + (err.message || 'Failed to extract from URL');
    statusEl.style.color = 'var(--error, #ef4444)';
  });
}

/* --- Cleanup View --- */
var cleanupEntities = [];
var cleanupSelected = {};
var cleanupTypeFilter = '';
var cleanupMaxObs = '';

function showCleanupView() {
  selectedId = null;
  selectedView = null;
  cleanupEntities = [];
  cleanupSelected = {};
  cleanupTypeFilter = '';
  cleanupMaxObs = '';
  document.getElementById('main').innerHTML = '<div style="padding:40px;color:var(--text-muted);text-align:center;">Loading entities...</div>';
  api('GET', '/api/search?q=*').then(function(data) {
    cleanupEntities = (data.results || []).sort(function(a, b) {
      return (a.name || '').localeCompare(b.name || '');
    });
    renderCleanupView();
  }).catch(function(err) {
    document.getElementById('main').innerHTML = '<div style="padding:40px;color:#ef4444;">Error loading entities: ' + esc(err.message) + '</div>';
  });
}

function getCleanupVisible() {
  return cleanupEntities.filter(function(e) {
    if (cleanupTypeFilter && e.entity_type !== cleanupTypeFilter) return false;
    if (cleanupMaxObs !== '' && !isNaN(parseInt(cleanupMaxObs))) {
      if ((e.observation_count || 0) >= parseInt(cleanupMaxObs)) return false;
    }
    return true;
  });
}

function renderCleanupView() {
  var visible = getCleanupVisible();
  var selCount = 0;
  for (var k in cleanupSelected) { if (cleanupSelected[k]) selCount++; }

  var h = '<div style="padding:24px;max-width:900px;margin:0 auto;">';
  h += '<h2 style="font-size:1.2rem;font-weight:700;color:var(--text-primary);margin-bottom:16px;">Cleanup Entities</h2>';

  // Toolbar
  h += '<div class="cleanup-toolbar">';
  h += '<label>Type: <select onchange="cleanupTypeFilter=this.value;renderCleanupView()">';
  h += '<option value="">All</option>';
  h += '<option value="person"' + (cleanupTypeFilter === 'person' ? ' selected' : '') + '>Person</option>';
  h += '<option value="business"' + (cleanupTypeFilter === 'business' ? ' selected' : '') + '>Business</option>';
  h += '<option value="institution"' + (cleanupTypeFilter === 'institution' ? ' selected' : '') + '>Institution</option>';
  h += '<option value="organization"' + (cleanupTypeFilter === 'organization' ? ' selected' : '') + '>Organization</option>';
  h += '</select></label>';
  h += '<label>Max obs: <input type="number" min="0" style="width:60px" value="' + esc(cleanupMaxObs) + '" onchange="cleanupMaxObs=this.value;renderCleanupView()" placeholder="e.g. 2"></label>';
  h += '<label><input type="checkbox" class="cleanup-check" onchange="toggleAllCleanup(this.checked)"> Select all visible (' + visible.length + ')</label>';
  h += '<button style="margin-left:auto;padding:6px 14px;border-radius:var(--radius-sm);border:1px solid var(--border-primary);background:var(--bg-primary);color:var(--text-secondary);font-size:0.78rem;cursor:pointer;" onclick="runDedupRelationships()">Dedup Relationships</button>';
  h += '</div>';

  // Entity list
  h += '<div class="cleanup-entity-list">';
  if (visible.length === 0) {
    h += '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.85rem;">No entities match filters</div>';
  }
  for (var i = 0; i < visible.length; i++) {
    var e = visible[i];
    var checked = cleanupSelected[e.entity_id] ? ' checked' : '';
    h += '<div class="cleanup-row">';
    h += '<input type="checkbox" class="cleanup-check"' + checked + ' onchange="toggleCleanupEntity(' + "'" + esc(e.entity_id) + "'" + ')">';
    h += '<span class="cleanup-name">' + esc(e.name || e.entity_id) + '</span>';
    h += '<span class="cleanup-type-badge">' + esc(e.entity_type || '') + '</span>';
    h += '<span class="cleanup-count" title="Observations">' + (e.observation_count || 0) + ' obs</span>';
    h += '<span class="cleanup-count" title="Relationships">' + (e.relationship_count || 0) + ' rels</span>';
    h += '</div>';
  }
  h += '</div>';

  // Action bar
  h += '<div class="cleanup-actions">';
  h += '<button class="btn-danger"' + (selCount === 0 ? ' disabled' : '') + ' onclick="bulkDeleteSelected()">Delete Selected</button>';
  h += '<span class="cleanup-selection-count">' + selCount + ' selected</span>';
  h += '<button style="margin-left:auto;padding:8px 16px;border-radius:var(--radius-sm);border:1px solid var(--border-primary);background:var(--bg-primary);color:var(--text-secondary);font-size:0.82rem;cursor:pointer;" onclick="hideUploadView()">Back</button>';
  h += '</div>';

  h += '</div>';
  document.getElementById('main').innerHTML = h;
}

function toggleCleanupEntity(id) {
  cleanupSelected[id] = !cleanupSelected[id];
  renderCleanupView();
}

function toggleAllCleanup(checked) {
  var visible = getCleanupVisible();
  for (var i = 0; i < visible.length; i++) {
    cleanupSelected[visible[i].entity_id] = checked;
  }
  renderCleanupView();
}

function bulkDeleteSelected() {
  var ids = [];
  for (var k in cleanupSelected) { if (cleanupSelected[k]) ids.push(k); }
  if (ids.length === 0) return;
  if (!confirm('Delete ' + ids.length + ' entities and all their connected objects? This cannot be undone.')) return;

  api('POST', '/api/entities/bulk-delete', { entity_ids: ids }).then(function(result) {
    toast('Deleted ' + result.deleted + ' entities' + (result.failed > 0 ? ' (' + result.failed + ' not found)' : ''));
    cleanupSelected = {};
    // Refresh sidebar + cleanup view
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
      cleanupEntities = allEntities.slice().sort(function(a, b) {
        return (a.name || '').localeCompare(b.name || '');
      });
      renderCleanupView();
    });
  }).catch(function(err) {
    toast('Bulk delete failed: ' + err.message);
  });
}

function runDedupRelationships() {
  if (!confirm('Scan all entities and remove duplicate relationships?')) return;
  api('POST', '/api/dedup-relationships').then(function(result) {
    var msg = 'Removed ' + result.total_removed + ' duplicate relationships across ' + result.entities_affected + ' entities';
    toast(msg);
  }).catch(function(err) {
    toast('Dedup failed: ' + err.message);
  });
}

var ALLOWED_UPLOAD_EXT = ['.pdf', '.docx', '.xlsx', '.xls', '.csv', '.txt', '.md', '.json'];

function addUploadFiles(fileList) {
  for (var i = 0; i < fileList.length; i++) {
    var f = fileList[i];
    var ext = '.' + f.name.split('.').pop().toLowerCase();
    if (ALLOWED_UPLOAD_EXT.indexOf(ext) === -1) {
      toast('Unsupported file type: ' + ext);
      continue;
    }
    // Avoid duplicates by name
    var dup = false;
    for (var j = 0; j < uploadFiles.length; j++) {
      if (uploadFiles[j].name === f.name) { dup = true; break; }
    }
    if (!dup) uploadFiles.push(f);
  }
  renderUploadFileList();
}

function removeUploadFile(idx) {
  uploadFiles.splice(idx, 1);
  renderUploadFileList();
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderUploadFileList() {
  var html = '';
  for (var i = 0; i < uploadFiles.length; i++) {
    var f = uploadFiles[i];
    html += '<div class="upload-file-item">';
    html += '<span class="upload-file-name">' + esc(f.name) + '</span>';
    html += '<span class="upload-file-size">' + formatFileSize(f.size) + '</span>';
    html += '<span class="upload-file-status pending" id="uploadStatus' + i + '">ready</span>';
    html += '<button class="upload-file-remove" onclick="removeUploadFile(' + i + ')">&times;</button>';
    html += '</div>';
  }
  document.getElementById('uploadFileList').innerHTML = html;
  var btn = document.getElementById('btnStartUpload');
  if (btn) btn.style.display = uploadFiles.length > 0 ? 'block' : 'none';
}

var previewEntities = [];
var previewSource = '';

function startUpload() {
  if (uploadFiles.length === 0 || uploadInProgress) return;
  uploadInProgress = true;
  previewEntities = [];
  document.getElementById('btnStartUpload').disabled = true;

  // Disable remove buttons
  var removeBtns = document.querySelectorAll('.upload-file-remove');
  for (var i = 0; i < removeBtns.length; i++) removeBtns[i].style.display = 'none';

  var log = document.getElementById('uploadProgressLog');
  log.style.display = 'block';
  log.innerHTML = '<div class="log-info">Extracting entities (preview mode)...</div>';

  var formData = new FormData();
  for (var i = 0; i < uploadFiles.length; i++) {
    formData.append('files', uploadFiles[i]);
  }
  previewSource = uploadFiles.length === 1 ? uploadFiles[0].name : uploadFiles.length + ' files';

  var headers = getAuthHeaders();
  headers['X-Agent-Id'] = 'wiki-upload';

  fetch('/api/ingest/files?preview=true', {
    method: 'POST',
    headers: headers,
    body: formData,
  }).then(function(response) {
    if (!response.ok) {
      return response.json().then(function(e) {
        throw new Error(e.error || 'Upload failed (' + response.status + ')');
      });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function read() {
      return reader.read().then(function(result) {
        if (result.done) {
          uploadComplete();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            var evt = JSON.parse(lines[i]);
            handleUploadEvent(evt);
          } catch (e) {}
        }
        return read();
      });
    }
    return read();
  }).catch(function(err) {
    log.innerHTML += '<div class="log-error">Error: ' + esc(err.message) + '</div>';
    log.scrollTop = log.scrollHeight;
    uploadInProgress = false;
    document.getElementById('btnStartUpload').disabled = false;
    document.getElementById('btnStartUpload').textContent = 'Retry';
  });
}

function handleUploadEvent(evt) {
  var log = document.getElementById('uploadProgressLog');
  if (evt.type === 'started') {
    log.innerHTML += '<div class="log-info">Extracting from ' + evt.total_files + ' file' + (evt.total_files > 1 ? 's' : '') + '...</div>';
  } else if (evt.type === 'file_preview') {
    var idx = evt.file_index - 1;
    var statusEl = document.getElementById('uploadStatus' + idx);
    if (statusEl) {
      statusEl.className = 'upload-file-status done';
      statusEl.textContent = evt.entities.length + ' found';
    }
    if (evt.full_entities) {
      for (var k = 0; k < evt.full_entities.length; k++) previewEntities.push(evt.full_entities[k]);
    }
    log.innerHTML += '<div class="log-info">' + esc(evt.file) + ' — found ' + evt.entities.length + ' entities (pending review)</div>';
  } else if (evt.type === 'preview_complete') {
    // Show preview UI
    log.innerHTML += '<div class="log-info" style="font-weight:600;margin-top:8px;">Review extracted entities below. Uncheck any you want to reject.</div>';
  } else if (evt.type === 'file_progress') {
    var idx = evt.file_index - 1;
    var statusEl = document.getElementById('uploadStatus' + idx);
    if (evt.warning) {
      if (statusEl) {
        statusEl.className = 'upload-file-status error';
        statusEl.textContent = 'no entities';
      }
      log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.warning) + '</div>';
    } else {
      if (statusEl) {
        statusEl.className = 'upload-file-status done';
        statusEl.textContent = evt.entities_created + ' created, ' + evt.entities_updated + ' merged';
      }
      log.innerHTML += '<div class="log-success">' + esc(evt.file) + ' — ' + evt.entities_created + ' created, ' + evt.entities_updated + ' updated</div>';
    }
  } else if (evt.type === 'file_error') {
    var idx = evt.file_index - 1;
    var statusEl = document.getElementById('uploadStatus' + idx);
    if (statusEl) {
      statusEl.className = 'upload-file-status error';
      statusEl.textContent = 'error';
    }
    log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.error) + '</div>';
  } else if (evt.type === 'complete') {
    var s = evt.summary || {};
    var sumEl = document.getElementById('uploadSummary');
    sumEl.style.display = 'block';
    sumEl.innerHTML = '<div class="upload-summary">' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.files_processed || 0) + '</div><div class="upload-summary-label">Files</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_created || 0) + '</div><div class="upload-summary-label">Created</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_updated || 0) + '</div><div class="upload-summary-label">Merged</div></div>' +
      '</div>';
  }
  log.scrollTop = log.scrollHeight;
}

function renderPreviewChecklist() {
  var html = '<div class="preview-checklist" style="margin-top:12px;">';
  html += '<div style="display:flex;gap:8px;margin-bottom:10px;">';
  html += '<button class="btn-sm" onclick="toggleAllPreview(true)">Select All</button>';
  html += '<button class="btn-sm" onclick="toggleAllPreview(false)">Deselect All</button>';
  html += '<span style="color:var(--text-secondary);font-size:0.8rem;line-height:28px;">' + previewEntities.length + ' entities found</span>';
  html += '</div>';
  for (var i = 0; i < previewEntities.length; i++) {
    var ent = previewEntities[i].entity || {};
    var type = ent.entity_type || '';
    var name = type === 'person' ? (ent.name && ent.name.full || '') : (ent.name && (ent.name.common || ent.name.legal) || '');
    var summary = ent.summary && ent.summary.value || '';
    if (summary.length > 100) summary = summary.substring(0, 100) + '...';
    html += '<label class="preview-entity-row" style="display:flex;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border-subtle);cursor:pointer;align-items:flex-start;">';
    html += '<input type="checkbox" checked data-preview-idx="' + i + '" onchange="updatePreviewCount()" style="margin-top:3px;">';
    html += '<div style="flex:1;min-width:0;">';
    html += '<span style="font-weight:600;color:var(--text-primary);">' + esc(name) + '</span>';
    html += ' <span class="type-badge ' + type + '" style="font-size:0.65rem;padding:1px 6px;">' + type + '</span>';
    if (summary) html += '<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(summary) + '</div>';
    html += '</div></label>';
  }
  html += '</div>';
  html += '<button class="btn-start-upload" onclick="confirmPreview()" style="margin-top:12px;background:#22c55e;">Save ' + previewEntities.length + ' Selected Entities</button>';
  var sumEl = document.getElementById('uploadSummary');
  sumEl.style.display = 'block';
  sumEl.innerHTML = html;
  updatePreviewCount();
}

function toggleAllPreview(checked) {
  var boxes = document.querySelectorAll('[data-preview-idx]');
  for (var i = 0; i < boxes.length; i++) boxes[i].checked = checked;
  updatePreviewCount();
}

function updatePreviewCount() {
  var boxes = document.querySelectorAll('[data-preview-idx]');
  var count = 0;
  for (var i = 0; i < boxes.length; i++) { if (boxes[i].checked) count++; }
  var btn = document.querySelector('.btn-start-upload');
  if (btn) btn.textContent = 'Save ' + count + ' Selected Entities';
}

function confirmPreview() {
  var boxes = document.querySelectorAll('[data-preview-idx]');
  var selected = [];
  for (var i = 0; i < boxes.length; i++) {
    if (boxes[i].checked) {
      var idx = parseInt(boxes[i].getAttribute('data-preview-idx'));
      selected.push(previewEntities[idx]);
    }
  }
  if (selected.length === 0) {
    toast('No entities selected');
    return;
  }

  var btn = document.querySelector('.btn-start-upload');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  api('POST', '/api/ingest/confirm', { entities: selected, source: previewSource }).then(function(result) {
    toast('Saved: ' + result.created + ' created, ' + result.updated + ' merged');
    var sumEl = document.getElementById('uploadSummary');
    sumEl.innerHTML = '<div class="upload-summary">' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + result.created + '</div><div class="upload-summary-label">Created</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + result.updated + '</div><div class="upload-summary-label">Merged</div></div>' +
      '</div>';
    btn.textContent = 'Done — View Entities';
    btn.disabled = false;
    btn.onclick = function() {
      hideUploadView();
      api('GET', '/api/search?q=*').then(function(data) {
        allEntities = data.results || [];
        entities = allEntities.slice();
        renderSidebar();
      });
    };
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  }).catch(function(err) {
    toast('Save failed: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Retry Save';
  });
}

function uploadComplete() {
  uploadInProgress = false;
  if (previewEntities.length > 0) {
    // Preview mode — show checklist
    renderPreviewChecklist();
    return;
  }
  var btn = document.getElementById('btnStartUpload');
  btn.textContent = 'Done — View Entities';
  btn.disabled = false;
  btn.onclick = function() {
    hideUploadView();
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  };
  // Also refresh sidebar entity list
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    renderSidebar();
  });
}

/* --- Google Drive Picker --- */
var driveBreadcrumb = [{ id: null, name: 'My Drive' }];
var driveFiles = [];
var driveSelected = {};
var driveIngesting = false;
var driveSearchMode = false;
var driveSearchQuery = '';
var driveFilterTimeout = null;

function showDriveView() {
  selectedId = null;
  selectedView = null;
  driveBreadcrumb = [{ id: null, name: 'My Drive' }];
  driveFiles = [];
  driveSelected = {};
  driveIngesting = false;
  driveSearchMode = false;
  driveSearchQuery = '';
  renderDrivePanel();
  loadDriveFolder(null);
  var items = document.querySelectorAll('.entity-item');
  for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
}

function renderDrivePanel() {
  var h = '<h2 style="font-size:1.2rem;font-weight:700;color:var(--text-primary);margin-bottom:16px;">Import from Google Drive</h2>';

  // Search bar
  h += '<div class="drive-search-bar">';
  h += '<input type="text" id="driveSearchInput" placeholder="Type to filter, press Enter to search all of Drive" value="' + esc(driveSearchQuery) + '" oninput="onDriveFilter()" onkeydown="if(event.key===' + "'" + 'Enter' + "'" + ')driveFullSearch()" />';
  if (driveSearchMode) {
    h += '<button class="drive-search-clear" onclick="clearDriveSearch()">Clear</button>';
  } else {
    h += '<button class="drive-search-btn" onclick="driveFullSearch()">Search</button>';
  }
  h += '</div>';

  if (driveSearchMode) {
    // Search results mode — show tag instead of breadcrumb
    h += '<div class="drive-search-tag">Search results for &ldquo;' + esc(driveSearchQuery) + '&rdquo;</div>';
  } else {
    // Breadcrumb
    h += '<div class="drive-breadcrumb">';
    for (var i = 0; i < driveBreadcrumb.length; i++) {
      if (i > 0) h += '<span class="sep">&rsaquo;</span>';
      if (i < driveBreadcrumb.length - 1) {
        h += '<a onclick="navigateDrive(' + i + ')">' + esc(driveBreadcrumb[i].name) + '</a>';
      } else {
        h += '<span class="current">' + esc(driveBreadcrumb[i].name) + '</span>';
      }
    }
    h += '</div>';
  }

  // Loading or file list
  h += '<div id="driveFileArea"><div class="drive-loading">Loading...</div></div>';

  // Progress log (hidden until ingest starts)
  h += '<div id="driveProgressLog" class="upload-progress-log" style="display:none;"></div>';
  h += '<div id="driveSummary" style="display:none;"></div>';

  // Action bar
  h += '<div id="driveActionBar">';
  var selCount = Object.keys(driveSelected).length;
  h += '<button class="btn-start-upload" id="btnDriveImport" onclick="startDriveIngest()" style="display:' + (selCount > 0 ? 'block' : 'none') + ';">Import ' + selCount + ' file' + (selCount !== 1 ? 's' : '') + '</button>';
  h += '<button class="btn-back-upload" onclick="hideUploadView()">Back to Entities</button>';
  h += '</div>';

  document.getElementById('main').innerHTML = h;
}

function onDriveFilter() {
  clearTimeout(driveFilterTimeout);
  driveFilterTimeout = setTimeout(function() {
    var input = document.getElementById('driveSearchInput');
    var q = input ? input.value.trim().toLowerCase() : '';
    if (driveSearchMode || !q) {
      renderDriveFiles();
      return;
    }
    // Local filter: re-render with filter applied
    renderDriveFiles(q);
  }, 150);
}

function driveFullSearch() {
  var input = document.getElementById('driveSearchInput');
  var q = input ? input.value.trim() : '';
  if (!q) return;
  driveSearchQuery = q;
  driveSearchMode = true;
  driveSelected = {};
  renderDrivePanel();
  // API search
  var area = document.getElementById('driveFileArea');
  if (area) area.innerHTML = '<div class="drive-loading">Searching Drive...</div>';
  api('GET', '/api/drive/files?q=' + encodeURIComponent(q)).then(function(data) {
    driveFiles = data.files || [];
    renderDriveFiles();
  }).catch(function(err) {
    if (area) area.innerHTML = '<div class="drive-empty" style="color:#ef4444;">Search error: ' + esc(err.message) + '</div>';
  });
}

function clearDriveSearch() {
  driveSearchMode = false;
  driveSearchQuery = '';
  driveSelected = {};
  var folderId = driveBreadcrumb[driveBreadcrumb.length - 1].id;
  renderDrivePanel();
  loadDriveFolder(folderId);
}

function loadDriveFolder(folderId) {
  var area = document.getElementById('driveFileArea');
  if (area) area.innerHTML = '<div class="drive-loading">Loading...</div>';

  var url = '/api/drive/files';
  if (folderId) url += '?folderId=' + encodeURIComponent(folderId);

  api('GET', url).then(function(data) {
    driveFiles = data.files || [];
    renderDriveFiles();
  }).catch(function(err) {
    if (area) area.innerHTML = '<div class="drive-empty" style="color:#ef4444;">Error: ' + esc(err.message) + '</div>';
  });
}

function renderDriveFiles(localFilter) {
  var area = document.getElementById('driveFileArea');
  if (!area) return;

  var filtered = driveFiles;
  if (localFilter) {
    filtered = driveFiles.filter(function(f) {
      return f.name.toLowerCase().indexOf(localFilter) !== -1;
    });
  }

  if (filtered.length === 0) {
    area.innerHTML = '<div class="drive-empty">' + (localFilter ? 'No files match &ldquo;' + esc(localFilter) + '&rdquo;' : 'No supported files in this folder') + '</div>';
    updateDriveActionBar();
    return;
  }

  var h = '<div class="drive-file-list">';
  for (var i = 0; i < filtered.length; i++) {
    var f = filtered[i];
    if (f.isFolder) {
      var fChecked = driveSelected[f.id] ? ' checked' : '';
      var fSelCls = driveSelected[f.id] ? ' selected' : '';
      h += '<div class="drive-file-row' + fSelCls + '">';
      h += '<input type="checkbox" class="drive-file-check"' + fChecked + ' onclick="event.stopPropagation(); toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" />';
      h += '<div class="drive-file-icon" onclick="openDriveFolder(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" style="cursor:pointer;">\\ud83d\\udcc1</div>';
      h += '<div class="drive-file-name folder" onclick="openDriveFolder(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" style="cursor:pointer;">' + esc(f.name) + '</div>';
      h += '<div class="drive-file-meta">' + formatDriveDate(f.modifiedTime) + '</div>';
      h += '</div>';
    } else {
      var checked = driveSelected[f.id] ? ' checked' : '';
      var selCls = driveSelected[f.id] ? ' selected' : '';
      h += '<div class="drive-file-row' + selCls + '" onclick="toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')">';
      h += '<input type="checkbox" class="drive-file-check"' + checked + ' onclick="event.stopPropagation(); toggleDriveFile(' + "'" + esc(f.id) + "'" + ', ' + "'" + esc(f.name).replace(/'/g, "\\\\'") + "'" + ')" />';
      h += '<div class="drive-file-icon">' + driveFileIcon(f.mimeType, f.isGoogleNative) + '</div>';
      h += '<div class="drive-file-name">' + esc(f.name) + (f.isGoogleNative ? ' <span style="font-size:0.65rem;color:#4b5563;">(Google)</span>' : '') + '</div>';
      h += '<div class="drive-file-meta">' + (f.size ? formatFileSize(f.size) : '') + '</div>';
      h += '<div class="drive-file-meta">' + formatDriveDate(f.modifiedTime) + '</div>';
      h += '</div>';
    }
  }
  h += '</div>';
  area.innerHTML = h;
  updateDriveActionBar();
}

function driveFileIcon(mimeType, isGoogleNative) {
  if (mimeType === 'application/pdf') return '\\ud83d\\udcc4';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') return '\\ud83d\\udcca';
  if (mimeType.includes('document') || mimeType.includes('wordprocessing')) return '\\ud83d\\udcdd';
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return '\\ud83d\\udcc3';
  if (mimeType === 'application/json') return '{ }';
  return '\\ud83d\\udcc4';
}

function formatDriveDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function openDriveFolder(id, name) {
  driveBreadcrumb.push({ id: id, name: name });
  driveSelected = {};
  renderDrivePanel();
  loadDriveFolder(id);
}

function navigateDrive(index) {
  driveBreadcrumb = driveBreadcrumb.slice(0, index + 1);
  driveSelected = {};
  var folderId = driveBreadcrumb[driveBreadcrumb.length - 1].id;
  renderDrivePanel();
  loadDriveFolder(folderId);
}

function toggleDriveFile(fileId, fileName) {
  if (driveSelected[fileId]) {
    delete driveSelected[fileId];
  } else {
    driveSelected[fileId] = fileName;
  }
  renderDriveFiles();
}

function updateDriveActionBar() {
  var btn = document.getElementById('btnDriveImport');
  if (!btn) return;
  var selCount = Object.keys(driveSelected).length;
  btn.style.display = selCount > 0 ? 'block' : 'none';
  btn.textContent = 'Import ' + selCount + ' file' + (selCount !== 1 ? 's' : '');
}

function startDriveIngest() {
  var ids = Object.keys(driveSelected);
  if (ids.length === 0 || driveIngesting) return;
  driveIngesting = true;

  var btn = document.getElementById('btnDriveImport');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  var log = document.getElementById('driveProgressLog');
  log.style.display = 'block';
  log.innerHTML = '<div class="log-info">Starting import of ' + ids.length + ' file' + (ids.length > 1 ? 's' : '') + ' from Drive...</div>';

  var headers = getAuthHeaders();
  headers['Content-Type'] = 'application/json';
  headers['X-Agent-Id'] = 'wiki-drive';

  fetch('/api/drive/ingest', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify({ fileIds: ids }),
  }).then(function(response) {
    if (!response.ok) {
      return response.json().then(function(e) {
        throw new Error(e.error || 'Import failed (' + response.status + ')');
      });
    }
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';

    function read() {
      return reader.read().then(function(result) {
        if (result.done) {
          driveIngestComplete();
          return;
        }
        buffer += decoder.decode(result.value, { stream: true });
        var lines = buffer.split('\\n');
        buffer = lines.pop();
        for (var i = 0; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          try {
            var evt = JSON.parse(lines[i]);
            handleDriveEvent(evt);
          } catch (e) {}
        }
        return read();
      });
    }
    return read();
  }).catch(function(err) {
    log.innerHTML += '<div class="log-error">Error: ' + esc(err.message) + '</div>';
    log.scrollTop = log.scrollHeight;
    driveIngesting = false;
    btn.disabled = false;
    btn.textContent = 'Retry Import';
  });
}

function handleDriveEvent(evt) {
  var log = document.getElementById('driveProgressLog');
  if (evt.type === 'started') {
    log.innerHTML += '<div class="log-info">Processing ' + evt.total_files + ' file' + (evt.total_files > 1 ? 's' : '') + '...</div>';
  } else if (evt.type === 'file_downloading') {
    log.innerHTML += '<div class="log-info">Downloading file ' + evt.file_index + '...</div>';
  } else if (evt.type === 'file_progress') {
    if (evt.warning) {
      log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.warning) + '</div>';
    } else {
      log.innerHTML += '<div class="log-success">' + esc(evt.file) + ' — ' + evt.entities_created + ' created, ' + evt.entities_updated + ' updated</div>';
    }
  } else if (evt.type === 'file_error') {
    log.innerHTML += '<div class="log-error">' + esc(evt.file) + ' — ' + esc(evt.error) + '</div>';
  } else if (evt.type === 'complete') {
    var s = evt.summary || {};
    var sumEl = document.getElementById('driveSummary');
    sumEl.style.display = 'block';
    sumEl.innerHTML = '<div class="upload-summary">' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.files_processed || 0) + '</div><div class="upload-summary-label">Files</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_created || 0) + '</div><div class="upload-summary-label">Created</div></div>' +
      '<div class="upload-summary-stat"><div class="upload-summary-num">' + (s.entities_updated || 0) + '</div><div class="upload-summary-label">Merged</div></div>' +
      '</div>';
  }
  log.scrollTop = log.scrollHeight;
}

function driveIngestComplete() {
  driveIngesting = false;
  var btn = document.getElementById('btnDriveImport');
  btn.textContent = 'Done — View Entities';
  btn.disabled = false;
  btn.onclick = function() {
    hideUploadView();
    api('GET', '/api/search?q=*').then(function(data) {
      allEntities = data.results || [];
      entities = allEntities.slice();
      renderSidebar();
    });
  };
  api('GET', '/api/search?q=*').then(function(data) {
    allEntities = data.results || [];
    entities = allEntities.slice();
    renderSidebar();
  });
}

function renderCareerLite(data) {
  var e = data.entity || {};
  var cl = data.career_lite || {};
  var name = e.name?.full || '';
  var initials = name.split(/\\s+/).map(function(w) { return w[0]; }).join('').toUpperCase();
  var h = '';

  // Header with avatar
  h += '<div class="section">';
  h += '<div class="cl-header">';
  h += '<div class="cl-avatar">' + esc(initials) + '</div>';
  h += '<div class="cl-header-info">';
  h += '<div class="cl-name">' + esc(name) + '</div>';
  if (cl.headline) h += '<div class="cl-headline">' + esc(cl.headline) + '</div>';
  if (cl.current_role && cl.current_company) {
    h += '<div class="cl-current">' + esc(cl.current_role) + ' @ ' + esc(cl.current_company) + '</div>';
  } else if (cl.current_role || cl.current_company) {
    h += '<div class="cl-current">' + esc(cl.current_role || cl.current_company) + '</div>';
  }
  if (cl.location) h += '<div class="cl-location">' + esc(cl.location) + '</div>';

  // Contact row
  var contacts = [];
  var attrs = data.attributes || [];
  for (var i = 0; i < attrs.length; i++) {
    if (attrs[i].key === 'email' && attrs[i].value) contacts.push('<span class="cl-contact-item">' + esc(attrs[i].value) + '</span>');
    if (attrs[i].key === 'phone' && attrs[i].value) contacts.push('<span class="cl-contact-item">' + esc(attrs[i].value) + '</span>');
  }
  if (cl.linkedin_url) contacts.push('<a href="' + esc(cl.linkedin_url) + '" target="_blank">LinkedIn</a>');
  if (contacts.length > 0) h += '<div class="cl-contact-row">' + contacts.join('') + '</div>';

  h += '<div class="cl-header-actions"><div class="cl-interface-badge">Career Lite Profile</div>';
  h += '<button class="btn-share" onclick="openShareModal()">Share</button></div>';
  h += '</div></div></div>';

  // Summary
  var summary = e.summary?.value || '';
  if (summary) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div>';
    h += '</div>';
  }

  // Experience
  var exp = cl.experience || [];
  if (exp.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Experience (' + exp.length + ')</div>';
    for (var i = 0; i < exp.length; i++) {
      var x = exp[i];
      h += '<div class="cl-exp-card">';
      if (x.company) h += '<div class="cl-exp-company">' + esc(x.company) + '</div>';
      if (x.title) h += '<div class="cl-exp-title">' + esc(x.title) + '</div>';
      var dates = [x.start_date, x.end_date].filter(Boolean).join(' — ');
      if (dates) h += '<div class="cl-exp-dates">' + esc(dates) + '</div>';
      if (x.description) h += '<div class="cl-exp-desc">' + esc(x.description) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Education
  var edu = cl.education || [];
  if (edu.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Education (' + edu.length + ')</div>';
    for (var i = 0; i < edu.length; i++) {
      var ed = edu[i];
      h += '<div class="cl-edu-card">';
      if (ed.institution) h += '<div class="cl-edu-institution">' + esc(ed.institution) + '</div>';
      var degree = [ed.degree, ed.field].filter(Boolean).join(' in ');
      if (degree) h += '<div class="cl-edu-degree">' + esc(degree) + '</div>';
      var years = [ed.start_year, ed.end_year].filter(Boolean).join(' — ');
      if (years) h += '<div class="cl-edu-years">' + esc(years) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Skills
  var skills = cl.skills || [];
  if (skills.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Skills (' + skills.length + ')</div>';
    h += '<div class="cl-skills-wrap">';
    for (var i = 0; i < skills.length; i++) {
      h += '<span class="cl-skill-tag">' + esc(skills[i]) + '</span>';
    }
    h += '</div></div>';
  }

  // Relationships (if any)
  var rels = data.relationships || [];
  if (rels.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connections (' + rels.length + ')</div>';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Observations (collapsed view)
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  if (obs.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Observations (' + obs.length + ')</div>';
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      h += '<div class="obs-card">';
      h += '<div class="obs-text">' + esc(o.observation) + '</div>';
      h += '<div class="obs-meta">';
      h += confidenceBadge(o.confidence, o.confidence_label);
      if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
      h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      h += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
      h += '</div></div>';
    }
    h += '</div>';
  }

  document.getElementById('main').innerHTML = h;
}

// --- Profile Mode Rendering Helpers ---

function formatProfileKey(key) {
  return (key || '').replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
}

function renderProfileSection(id, label, contentHtml, startCollapsed) {
  var collapsed = startCollapsed ? ' collapsed' : '';
  var hidden = startCollapsed ? ' hidden' : '';
  return '<div class="profile-section">'
    + '<div class="profile-section-header' + collapsed + '" onclick="toggleProfileSection(' + "'" + id + "'" + ')" onkeydown="if(event.key===' + "'" + 'Enter' + "'" + ')toggleProfileSection(' + "'" + id + "'" + ')" tabindex="0">'
    + '<span>' + esc(label) + '</span><span class="chevron">&#9660;</span></div>'
    + '<div id="profile-sec-' + id + '" class="profile-section-body' + hidden + '">'
    + contentHtml + '</div></div>';
}

function renderOceanBars(ocean) {
  if (!ocean || typeof ocean !== 'object') return '';
  var traits = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'];
  var h = '';
  for (var i = 0; i < traits.length; i++) {
    var trait = traits[i];
    var data = ocean[trait];
    if (!data) continue;
    var score = 0;
    var noteKey = trait + '_note';
    var disputeNote = ocean[noteKey] || (data && data._note) || '';
    if (typeof data === 'object') {
      score = data.score || data.percentile || 0;
    } else if (typeof data === 'number') {
      score = data;
    }
    var pct = Math.min(100, Math.max(0, typeof score === 'number' ? (score > 1 ? score : score * 100) : 0));
    h += '<div class="profile-bar-wrap">';
    h += '<span class="profile-bar-label">' + formatProfileKey(trait) + '</span>';
    h += '<span class="profile-bar-track"><span class="profile-bar-fill" style="width:' + pct + '%"></span></span>';
    h += '<span class="profile-bar-value">' + (typeof score === 'number' ? (score > 1 ? score.toFixed(0) : (score * 100).toFixed(0)) + '%' : esc(String(score))) + '</span>';
    if (disputeNote) h += '<span class="profile-dispute" title="' + esc(String(disputeNote)) + '">&#9888; disputed</span>';
    h += '</div>';
  }
  return h;
}

function renderProfileValue(val, contextKey) {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    if (val.length === 0) return '';
    // Check if items are objects with 'name' key (e.g., children)
    if (typeof val[0] === 'object' && val[0] !== null) {
      var h = '';
      for (var i = 0; i < val.length; i++) {
        h += '<div class="profile-insight-card"><div class="insight-text">';
        var keys = Object.keys(val[i]);
        for (var k = 0; k < keys.length; k++) {
          h += '<div class="profile-kv-row"><span class="profile-kv-key">' + formatProfileKey(keys[k]) + '</span><span class="profile-kv-val">' + esc(String(val[i][keys[k]])) + '</span></div>';
        }
        h += '</div></div>';
      }
      return h;
    }
    // Check if contextKey suggests tags
    if (contextKey === 'energized_by' || contextKey === 'drained_by' || contextKey === 'blind_spots'
        || contextKey === 'expectations' || contextKey === 'cautions' || contextKey === 'gaps'
        || contextKey === 'data_sources' || contextKey === 'skills' || contextKey === 'languages') {
      var h = '<div>';
      for (var i = 0; i < val.length; i++) {
        h += '<span class="profile-tag">' + esc(String(val[i])) + '</span>';
      }
      h += '</div>';
      return h;
    }
    // Default: bullet list
    var h = '<ul style="margin:4px 0;padding-left:20px">';
    for (var i = 0; i < val.length; i++) {
      h += '<li style="font-size:0.82rem;color:var(--text-primary)">' + esc(String(val[i])) + '</li>';
    }
    h += '</ul>';
    return h;
  }
  if (typeof val === 'object') {
    var h = '';
    var keys = Object.keys(val);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k] === 'interface') continue;
      var subVal = val[keys[k]];
      if (subVal === null || subVal === undefined) continue;
      if (typeof subVal === 'object' && !Array.isArray(subVal)) {
        h += '<div style="margin-top:6px"><strong style="font-size:0.82rem;color:var(--text-secondary)">' + formatProfileKey(keys[k]) + '</strong>';
        h += '<div style="padding-left:12px">' + renderProfileValue(subVal, keys[k]) + '</div></div>';
      } else {
        h += '<div class="profile-kv-row"><span class="profile-kv-key">' + formatProfileKey(keys[k]) + '</span><span class="profile-kv-val">' + renderProfileValue(subVal, keys[k]) + '</span></div>';
      }
    }
    return h;
  }
  return esc(String(val));
}

function renderProfileWhatWorks(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  var h = '';
  for (var i = 0; i < items.length; i++) {
    h += '<div class="profile-green">' + esc(String(items[i])) + '</div>';
  }
  return h;
}

function renderProfileWhatDoesntWork(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  var h = '';
  for (var i = 0; i < items.length; i++) {
    h += '<div class="profile-red">' + esc(String(items[i])) + '</div>';
  }
  return h;
}

function renderProfileInsightCard(obs) {
  var h = '<div class="profile-insight-card">';
  h += '<div class="insight-text">' + esc(obs.observation || obs.text || '') + '</div>';
  if (obs.source) h += '<div class="insight-source">' + esc(obs.source) + '</div>';
  h += '</div>';
  return h;
}

function renderProfileDetail(data) {
  var e = data.entity || {};
  var sa = data.structured_attributes || {};
  var name = e.name?.full || '';
  var preferred = (sa.identity && sa.identity.preferred_name) || e.name?.preferred || '';
  var entityId = e.entity_id || '';
  var summary = e.summary?.value || '';
  var meta = data.extraction_metadata || {};
  var h = '';

  // 1. Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name);
  if (preferred && preferred !== name) h += ' <span style="color:var(--text-tertiary);font-weight:400">(' + esc(preferred) + ')</span>';
  h += '</h2>';
  h += '<span class="profile-badge">Profile Mode</span>';
  h += '<span class="entity-id-badge">' + esc(entityId) + '</span>';
  h += confidenceBadge(meta.extraction_confidence);

  // Source date
  var sourceDate = meta.source_date || '';
  if (sourceDate) {
    var isStale = false;
    try {
      var sd = new Date(sourceDate);
      var sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      if (sd < sixMonthsAgo) isStale = true;
    } catch(ex) {}
    h += '<span class="profile-source-date' + (isStale ? ' stale' : '') + '">Source: ' + esc(sourceDate) + (isStale ? ' (stale)' : '') + '</span>';
  }

  h += '<div style="margin-top:8px">';
  h += '<button class="btn-share" onclick="openShareModal()">Share</button>';
  h += '<button class="btn-delete-entity" style="margin-left:8px" onclick="confirmDeleteEntity(' + "'" + esc(entityId) + "'" + ', ' + "'" + esc(name).replace(/'/g, '') + "'" + ')" title="Delete entity">Delete</button>';
  h += '</div></div>';

  // 2. Summary
  if (summary) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div></div>';
  }

  // 3. Identity
  if (sa.identity) {
    var iBody = renderProfileValue(sa.identity, 'identity');
    if (iBody) h += renderProfileSection('identity', 'Identity', iBody, false);
  }

  // 4. Personality Profile
  if (sa.personality_assessments) {
    var pBody = '';
    var pa = sa.personality_assessments;
    if (pa.mbti) {
      pBody += '<div class="profile-insight-card"><div class="insight-text"><strong>MBTI: ' + esc(pa.mbti.type || '') + '</strong>';
      if (pa.mbti.description) pBody += '<div style="margin-top:4px;font-size:0.8rem;color:var(--text-secondary)">' + esc(pa.mbti.description) + '</div>';
      if (pa.mbti.confidence) pBody += '<div style="font-size:0.72rem;color:var(--text-tertiary)">Confidence: ' + esc(String(pa.mbti.confidence)) + '</div>';
      pBody += '</div></div>';
    }
    if (pa.enneagram) {
      pBody += '<div class="profile-insight-card"><div class="insight-text"><strong>Enneagram: Type ' + esc(String(pa.enneagram.core_type || '')) + (pa.enneagram.wing ? 'w' + esc(String(pa.enneagram.wing)) : '') + '</strong>';
      if (pa.enneagram.tritype) pBody += ' <span style="color:var(--text-tertiary)">(Tritype: ' + esc(String(pa.enneagram.tritype)) + ')</span>';
      if (pa.enneagram.instinctual_variant) pBody += ' <span style="color:var(--text-tertiary)">' + esc(pa.enneagram.instinctual_variant) + '</span>';
      if (pa.enneagram.description) pBody += '<div style="margin-top:4px;font-size:0.8rem;color:var(--text-secondary)">' + esc(pa.enneagram.description) + '</div>';
      pBody += '</div></div>';
    }
    if (pa.ocean) {
      pBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem">OCEAN / Big Five</strong></div>';
      pBody += renderOceanBars(pa.ocean);
    }
    if (pBody) h += renderProfileSection('personality', 'Personality Profile', pBody, false);
  }

  // 5. Behavioral Patterns
  if (sa.behavioral_patterns) {
    var bBody = '';
    var bp = sa.behavioral_patterns;
    if (bp.communication_style) bBody += '<div class="profile-kv-row"><span class="profile-kv-key">Communication Style</span><span class="profile-kv-val">' + esc(String(bp.communication_style)) + '</span></div>';
    if (bp.decision_making) bBody += '<div class="profile-kv-row"><span class="profile-kv-key">Decision Making</span><span class="profile-kv-val">' + esc(String(bp.decision_making)) + '</span></div>';
    if (bp.conflict_style) bBody += '<div class="profile-kv-row"><span class="profile-kv-key">Conflict Style</span><span class="profile-kv-val">' + esc(String(bp.conflict_style)) + '</span></div>';
    if (bp.energized_by && bp.energized_by.length > 0) {
      bBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem;color:var(--text-secondary)">Energized By</strong></div>';
      bBody += renderProfileValue(bp.energized_by, 'energized_by');
    }
    if (bp.drained_by && bp.drained_by.length > 0) {
      bBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem;color:var(--text-secondary)">Drained By</strong></div>';
      bBody += renderProfileValue(bp.drained_by, 'drained_by');
    }
    if (bp.blind_spots && bp.blind_spots.length > 0) {
      bBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem;color:var(--text-secondary)">Blind Spots</strong></div>';
      for (var i = 0; i < bp.blind_spots.length; i++) {
        bBody += '<div class="profile-insight-card"><div class="insight-text">' + esc(String(bp.blind_spots[i])) + '</div></div>';
      }
    }
    if (bBody) h += renderProfileSection('behavioral', 'Behavioral Patterns', bBody, false);
  }

  // 6. Enneagram Dynamics
  if (sa.enneagram_dynamics) {
    var eBody = renderProfileValue(sa.enneagram_dynamics, 'enneagram_dynamics');
    if (eBody) h += renderProfileSection('enneagram', 'Enneagram Dynamics', eBody, false);
  }

  // 7. Family
  if (sa.family) {
    var fBody = renderProfileValue(sa.family, 'family');
    if (fBody) h += renderProfileSection('family', 'Family', fBody, false);
  }

  // 8. Spouse Dynamic
  if (sa.spouse_dynamic) {
    var sdBody = '';
    var sd = sa.spouse_dynamic;
    if (sd.core_dynamic) sdBody += '<div class="profile-kv-row"><span class="profile-kv-key">Core Dynamic</span><span class="profile-kv-val">' + esc(String(sd.core_dynamic)) + '</span></div>';
    if (sd.friction_points && sd.friction_points.length > 0) {
      sdBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem">Friction Points</strong></div>';
      for (var i = 0; i < sd.friction_points.length; i++) {
        sdBody += '<div class="profile-red">' + esc(String(sd.friction_points[i])) + '</div>';
      }
    }
    if (sd.strengths && sd.strengths.length > 0) {
      sdBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem">Strengths</strong></div>';
      for (var i = 0; i < sd.strengths.length; i++) {
        sdBody += '<div class="profile-green">' + esc(String(sd.strengths[i])) + '</div>';
      }
    }
    if (sd.confirmed && sd.confirmed.length > 0) {
      sdBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem;color:#10b981">Confirmed</strong></div>';
      for (var i = 0; i < sd.confirmed.length; i++) {
        sdBody += '<div class="profile-green">' + esc(String(sd.confirmed[i])) + '</div>';
      }
    }
    if (sd.disputed && sd.disputed.length > 0) {
      sdBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem;color:#f59e0b">Disputed</strong></div>';
      for (var i = 0; i < sd.disputed.length; i++) {
        sdBody += '<div class="profile-amber">' + esc(String(sd.disputed[i])) + '</div>';
      }
    }
    if (sd.modified && sd.modified.length > 0) {
      sdBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem;color:#f59e0b">Modified</strong></div>';
      for (var i = 0; i < sd.modified.length; i++) {
        sdBody += '<div class="profile-amber">' + esc(String(sd.modified[i])) + '</div>';
      }
    }
    if (sdBody) h += renderProfileSection('spouse-dynamic', 'Spouse Dynamic', sdBody, false);
  }

  // 9. Relationship with primary user — MOST PROMINENT
  if (sa.relationship_to_primary_user) {
    var rpBody = '';
    var rp = sa.relationship_to_primary_user;
    if (rp.what_works && rp.what_works.length > 0) {
      rpBody += '<div style="margin-bottom:8px"><strong style="font-size:0.82rem;color:#10b981">What Works</strong></div>';
      rpBody += renderProfileWhatWorks(rp.what_works);
    }
    if (rp.what_doesnt_work && rp.what_doesnt_work.length > 0) {
      rpBody += '<div style="margin-top:8px;margin-bottom:8px"><strong style="font-size:0.82rem;color:#ef4444">What Doesn' + "'" + 't Work</strong></div>';
      rpBody += renderProfileWhatDoesntWork(rp.what_doesnt_work);
    }
    if (rp.management_protocol) {
      rpBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem">Management Protocol</strong></div>';
      rpBody += '<div style="font-size:0.82rem;color:var(--text-primary);margin-top:4px;padding:8px 12px;background:var(--bg-secondary);border-radius:var(--radius-md)">' + esc(String(rp.management_protocol)) + '</div>';
    }
    if (rp.mj_analysis) {
      rpBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem">MJ Analysis</strong></div>';
      rpBody += '<div class="profile-insight-card"><div class="insight-text">' + esc(String(rp.mj_analysis)) + '</div><div class="insight-source">Source: MJ/AI Assessment</div></div>';
    }
    if (rp.communication_guidelines) {
      rpBody += '<div style="margin-top:8px"><strong style="font-size:0.82rem">Communication Guidelines</strong></div>';
      if (typeof rp.communication_guidelines === 'string') {
        rpBody += '<div style="font-size:0.82rem;color:var(--text-primary);margin-top:4px">' + esc(rp.communication_guidelines) + '</div>';
      } else {
        rpBody += renderProfileValue(rp.communication_guidelines, 'communication_guidelines');
      }
    }
    if (rpBody) {
      h += '<div class="section" style="border:2px solid var(--accent-primary);border-radius:var(--radius-md);padding:2px">';
      h += renderProfileSection('rel-primary', 'Relationship with Primary User', rpBody, false);
      h += '</div>';
    }
  }

  // 10. AI Interaction Guidelines
  if (sa.ai_interaction_guidelines) {
    var aiBody = '';
    var ai = sa.ai_interaction_guidelines;
    if (ai.expectations && ai.expectations.length > 0) {
      aiBody += '<div style="margin-bottom:6px"><strong style="font-size:0.82rem">Expectations</strong></div>';
      aiBody += renderProfileValue(ai.expectations, 'expectations');
    }
    if (ai.cautions && ai.cautions.length > 0) {
      aiBody += '<div style="margin-top:6px"><strong style="font-size:0.82rem">Cautions</strong></div>';
      aiBody += renderProfileValue(ai.cautions, 'cautions');
    }
    if (ai.preferred_approach) {
      aiBody += '<div class="profile-kv-row"><span class="profile-kv-key">Preferred Approach</span><span class="profile-kv-val">' + esc(String(ai.preferred_approach)) + '</span></div>';
    }
    if (aiBody) h += renderProfileSection('ai-guidelines', 'AI Interaction Guidelines', aiBody, false);
  }

  // 11. Flat Attributes
  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    var aBody = '';
    for (var i = 0; i < attrs.length; i++) {
      aBody += '<div class="profile-kv-row"><span class="profile-kv-key">' + formatProfileKey(attrs[i].key) + '</span><span class="profile-kv-val">' + esc(attrs[i].value || '') + '</span></div>';
    }
    h += renderProfileSection('flat-attrs', 'Attributes (' + attrs.length + ')', aBody, true);
  }

  // 12. Relationships
  var rels = data.relationships || [];
  if (rels.length > 0) {
    var rBody = '';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      rBody += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      rBody += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) rBody += '<span class="rel-context">' + esc(r.context) + '</span>';
      rBody += '</div>';
    }
    h += renderProfileSection('relationships', 'Relationships (' + rels.length + ')', rBody, false);
  }

  // 13. Observations
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  if (obs.length > 0) {
    var oBody = '';
    for (var i = 0; i < obs.length; i++) {
      var o = obs[i];
      oBody += '<div class="obs-card">';
      oBody += '<div class="obs-text">' + esc(o.observation) + '</div>';
      oBody += '<div class="obs-meta">';
      oBody += confidenceBadge(o.confidence, o.confidence_label);
      if (o.source) oBody += '<span class="obs-source">' + esc(o.source) + '</span>';
      oBody += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      oBody += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
      oBody += '</div></div>';
    }
    h += renderProfileSection('observations', 'Observations (' + obs.length + ')', oBody, false);
  }

  // 14. Profile Metadata
  if (sa.profile_metadata) {
    var mBody = renderProfileValue(sa.profile_metadata, 'profile_metadata');
    if (mBody) h += renderProfileSection('profile-meta', 'Profile Metadata', mBody, true);
  }

  document.getElementById('main').innerHTML = h;
}

function renderDetail(data) {
  // Check for Profile Mode
  if (data.structured_attributes && data.structured_attributes.interface === 'profile') {
    return renderProfileDetail(data);
  }
  // Check for Career Lite profile
  if (data.career_lite && data.career_lite.interface === 'career-lite') {
    return renderCareerLite(data);
  }

  var e = data.entity || {};
  var type = e.entity_type || '';

  // Route connected object types to their own renderer
  if (['role', 'credential', 'skill'].indexOf(type) !== -1) {
    return renderConnectedDetail(data);
  }
  var name = type === 'person' ? (e.name?.full || '') : (e.name?.common || e.name?.legal || '');
  var summary = e.summary?.value || '';
  var meta = data.extraction_metadata || {};
  var h = '';

  // Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += confidenceBadge(meta.extraction_confidence);
  h += '<button class="btn-delete-entity" onclick="confirmDeleteEntity(' + "'" + esc(e.entity_id || '') + "'" + ', ' + "'" + esc(name).replace(/'/g, '') + "'" + ')" title="Delete entity">Delete</button>';
  h += '</div>';

  // Summary
  h += '<div class="section">';
  h += '<div class="section-header"><span class="section-title">Summary</span>';
  h += '<button class="btn-sm" id="btnEditSummary" onclick="toggleSummaryEdit()">Edit</button></div>';
  h += '<div id="summaryDisplay" class="summary-text">' + esc(summary) + '</div>';
  h += '<div id="summaryEditSection" style="display:none">';
  h += '<textarea class="summary-edit" id="summaryEdit">' + esc(summary) + '</textarea>';
  h += '<div class="edit-actions"><button class="btn-save" onclick="saveSummary()">Save</button>';
  h += '<button class="btn-cancel" onclick="toggleSummaryEdit()">Cancel</button></div>';
  h += '</div></div>';

  // Attributes
  var attrs = data.attributes || [];
  if (attrs.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Attributes</div>';
    for (var i = 0; i < attrs.length; i++) {
      var a = attrs[i];
      h += '<div class="attr-row"><span class="attr-key">' + esc(a.key) + '</span>';
      h += '<span class="attr-value">' + esc(String(a.value || '')) + '</span>';
      h += confidenceBadge(a.confidence, a.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Relationships
  var rels = data.relationships || [];
  if (rels.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Relationships</div>';
    for (var i = 0; i < rels.length; i++) {
      var r = rels[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name) + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += sentimentBadge(r.sentiment);
      h += confidenceBadge(r.confidence, r.confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Values
  var vals = data.values || [];
  if (vals.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Values</div>';
    for (var i = 0; i < vals.length; i++) {
      h += '<div class="value-item"><span class="value-text">' + esc(vals[i].value || '') + '</span>';
      h += confidenceBadge(vals[i].confidence, vals[i].confidence_label);
      h += '</div>';
    }
    h += '</div>';
  }

  // Observations
  var obs = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  h += '<div class="section"><div class="section-title section-title-only">Observations (' + obs.length + ')</div>';
  if (obs.length === 0) {
    h += '<div style="color:#3a3a4a;font-size:0.82rem;padding:8px 0;">No observations yet</div>';
  }
  for (var i = 0; i < obs.length; i++) {
    var o = obs[i];
    var decay = calcDecay(o.observed_at);
    var opacity = Math.max(0.35, decay);
    h += '<div class="obs-card" style="opacity:' + opacity.toFixed(2) + '">';
    h += '<div class="obs-text">' + esc(o.observation) + '</div>';
    h += '<div class="obs-meta">';
    h += confidenceBadge(o.confidence, o.confidence_label);
    h += layerBadge(o.layer_number);
    if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
    h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
    h += '<span class="obs-decay">' + (decay * 100).toFixed(0) + '% weight</span>';
    h += '<button class="btn-delete" data-id="' + esc(o.observation_id || '') + '" onclick="deleteObs(this.dataset.id)">delete</button>';
    h += '</div></div>';
  }
  h += '</div>';

  // Connected Objects
  var connected = data.connected_objects || [];
  if (connected.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Connected Objects (' + connected.length + ')</div>';
    var groups = { role: [], organization: [], institution: [], credential: [], skill: [] };
    for (var i = 0; i < connected.length; i++) {
      var c = connected[i];
      if (groups[c.entity_type]) groups[c.entity_type].push(c);
    }
    var groupLabels = { role: 'Roles', organization: 'Organizations', institution: 'Institutions', credential: 'Credentials', skill: 'Skills' };
    var groupKeys = ['role', 'organization', 'institution', 'credential', 'skill'];
    for (var g = 0; g < groupKeys.length; g++) {
      var gk = groupKeys[g];
      var items = groups[gk];
      if (items.length === 0) continue;
      h += '<div style="margin-bottom:12px;"><div style="font-size:0.75rem;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">' + groupLabels[gk] + '</div>';
      for (var j = 0; j < items.length; j++) {
        h += '<div class="entity-item" style="padding:6px 10px;cursor:pointer;" onclick="selectEntity(' + "'" + esc(items[j].entity_id) + "'" + ')">';
        h += '<span class="entity-item-name">' + esc(items[j].label) + '</span>';
        h += '<span class="type-badge ' + esc(items[j].entity_type) + '">' + esc(items[j].entity_type) + '</span>';
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
  }

  // Add Observation Form
  h += '<div class="section"><div class="section-title section-title-only">Add Observation</div>';
  h += '<div class="add-obs-form">';
  h += '<textarea class="obs-textarea" id="obsText" placeholder="What did you learn about this entity?"></textarea>';
  h += '<div class="obs-form-row">';
  h += '<select id="obsConfidence"><option value="VERIFIED">Verified</option>';
  h += '<option value="STRONG" selected>Strong</option><option value="MODERATE">Moderate</option>';
  h += '<option value="SPECULATIVE">Speculative</option><option value="UNCERTAIN">Uncertain</option></select>';
  h += '<select id="obsLayer"><option value="L1_OBJECTIVE">L1 Objective</option>';
  h += '<option value="L2_GROUP" selected>L2 Group</option><option value="L3_PERSONAL">L3 Personal</option></select>';
  h += '<button class="btn-add" id="btnAddObs" onclick="addObs()">Add Observation</button>';
  h += '</div></div></div>';

  document.getElementById('main').innerHTML = h;
}

function renderOrgDossier(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  var name = e.name?.common || e.name?.legal || e.name?.full || '';
  var roles = data.roles || [];
  var credentials = data.credentials || [];
  var skills = data.skills || [];
  var observations = (data.observations || []).slice().sort(function(a, b) {
    return new Date(b.observed_at || 0) - new Date(a.observed_at || 0);
  });
  var attributes = data.attributes || [];
  var relationships = data.relationships || [];
  var summary = e.summary?.value || '';
  var industry = data.industry || '';
  var h = '';

  // Compute date range from roles and credentials
  var dateRange = '';
  var earliest = '';
  var latest = '';
  var hasPresent = false;
  for (var i = 0; i < roles.length; i++) {
    var rd = roles[i].role_data || {};
    if (rd.start_date && (!earliest || rd.start_date < earliest)) earliest = rd.start_date;
    if (rd.end_date === 'Present' || rd.end_date === 'present') hasPresent = true;
    else if (rd.end_date && (!latest || rd.end_date > latest)) latest = rd.end_date;
  }
  // Also check credential dates for earliest/latest
  for (var i = 0; i < credentials.length; i++) {
    var cd = credentials[i].credential_data || {};
    var cStart = cd.start_year ? String(cd.start_year) : '';
    var cEnd = cd.end_year ? String(cd.end_year) : '';
    if (cStart && (!earliest || cStart < earliest)) earliest = cStart;
    if (cEnd && (!latest || cEnd > latest)) latest = cEnd;
  }
  if (earliest || latest || hasPresent) {
    dateRange = (earliest || '?') + ' — ' + (hasPresent ? 'Present' : (latest || '?'));
  }

  // Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + esc(type) + '</span>';
  if (industry) h += '<span class="type-badge" style="background:rgba(16,185,129,0.1);color:#10b981;">' + esc(industry) + '</span>';
  if (dateRange) h += '<span style="font-size:0.78rem;color:var(--text-muted);margin-left:8px;">' + esc(dateRange) + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += '<button class="btn-delete-entity" onclick="confirmDeleteEntity(' + "'" + esc(e.entity_id || '') + "'" + ', ' + "'" + esc(name).replace(/'/g, '') + "'" + ')" title="Delete entity">Delete</button>';
  h += '</div>';

  // Section: Your Roles Here
  if (roles.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Your Roles Here (' + roles.length + ')</div>';
    for (var i = 0; i < roles.length; i++) {
      var rd = roles[i].role_data || {};
      h += '<div class="cl-exp-card">';
      if (rd.title) h += '<div class="cl-exp-title">' + esc(rd.title) + '</div>';
      var dates = [rd.start_date, rd.end_date].filter(Boolean).join(' — ');
      if (dates) h += '<div class="cl-exp-dates">' + esc(dates) + '</div>';
      if (rd.employment_type) h += '<div class="cl-exp-dates" style="font-style:italic;">' + esc(rd.employment_type) + '</div>';
      if (rd.description) h += '<div class="cl-exp-desc">' + esc(rd.description) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Section: Credentials
  if (credentials.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Credentials (' + credentials.length + ')</div>';
    for (var i = 0; i < credentials.length; i++) {
      var cd = credentials[i].credential_data || {};
      h += '<div class="cl-edu-card">';
      if (cd.institution) h += '<div class="cl-edu-institution">' + esc(cd.institution) + '</div>';
      var degree = [cd.degree, cd.field].filter(Boolean).join(' in ');
      if (degree) h += '<div class="cl-edu-degree">' + esc(degree) + '</div>';
      var years = [cd.start_year, cd.end_year].filter(Boolean).join(' — ');
      if (years) h += '<div class="cl-edu-years">' + esc(years) + '</div>';
      h += '</div>';
    }
    h += '</div>';
  }

  // Section: Skills
  if (skills.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Skills (' + skills.length + ')</div>';
    h += '<div class="cl-skills-wrap">';
    for (var i = 0; i < skills.length; i++) {
      var sn = (skills[i].skill_data || {}).name || (skills[i].entity || {}).name?.common || '';
      if (sn) h += '<span class="cl-skill-tag">' + esc(sn) + '</span>';
    }
    h += '</div></div>';
  }

  // Section: Key Observations
  if (observations.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">Key Observations (' + observations.length + ')</div>';
    for (var i = 0; i < observations.length; i++) {
      var o = observations[i];
      var decay = calcDecay(o.observed_at);
      var opacity = Math.max(0.5, decay);
      h += '<div class="obs-card" style="opacity:' + opacity.toFixed(2) + '">';
      h += '<div class="obs-text">' + esc(o.observation) + '</div>';
      h += '<div class="obs-meta">';
      h += confidenceBadge(o.confidence, o.confidence_label);
      if (o.source) h += '<span class="obs-source">' + esc(o.source) + '</span>';
      h += '<span class="obs-date">' + esc((o.observed_at || '').slice(0, 10)) + '</span>';
      if (decay < 1) h += '<span style="font-size:0.7rem;color:var(--text-muted);">decay ' + decay.toFixed(2) + '</span>';
      h += '</div></div>';
    }
    h += '</div>';
  }

  // Section: About (Summary + Attributes)
  if (summary || attributes.length > 0) {
    h += '<div class="section">';
    h += '<div class="section-title section-title-only">About</div>';
    if (summary) h += '<div class="summary-text">' + esc(summary) + '</div>';
    for (var i = 0; i < attributes.length; i++) {
      var a = attributes[i];
      h += '<div class="attr-row"><span class="attr-key">' + esc(a.key || '') + '</span><span class="attr-value">' + esc(a.value || '') + '</span></div>';
    }
    h += '</div>';
  }

  // Section: Relationships
  if (relationships.length > 0) {
    h += '<div class="section"><div class="section-title section-title-only">Relationships (' + relationships.length + ')</div>';
    for (var i = 0; i < relationships.length; i++) {
      var r = relationships[i];
      h += '<div class="rel-row"><span class="rel-name">' + esc(r.name || '') + '</span>';
      h += '<span class="rel-type">' + esc(r.relationship_type || '') + '</span>';
      if (r.context) h += '<span class="rel-context">' + esc(r.context) + '</span>';
      h += '</div>';
    }
    h += '</div>';
  }

  document.getElementById('main').innerHTML = h;
}

function renderConnectedDetail(data) {
  var e = data.entity || {};
  var type = e.entity_type || '';
  var name = e.name?.full || e.name?.common || '';
  var parentId = e.parent_entity_id || '';
  var h = '';

  // Header
  h += '<div class="detail-header">';
  h += '<h2>' + esc(name) + '</h2>';
  h += '<span class="type-badge ' + type + '">' + type + '</span>';
  h += '<span class="entity-id-badge">' + esc(e.entity_id || '') + '</span>';
  h += '</div>';

  // Parent link
  if (parentId) {
    h += '<div class="section" style="padding:8px 0;">';
    h += '<span style="font-size:0.82rem;color:var(--text-muted);">Parent: </span>';
    h += '<a href="#" style="font-size:0.82rem;color:#6366f1;text-decoration:none;" onclick="event.preventDefault();selectEntity(' + "'" + esc(parentId) + "'" + ')">' + esc(parentId) + '</a>';
    h += '</div>';
  }

  // Type-specific data
  if (type === 'role' && data.role_data) {
    var rd = data.role_data;
    h += '<div class="section"><div class="section-title section-title-only">Role Details</div>';
    if (rd.title) h += '<div class="attr-row"><span class="attr-key">Title</span><span class="attr-value">' + esc(rd.title) + '</span></div>';
    if (rd.company) h += '<div class="attr-row"><span class="attr-key">Company</span><span class="attr-value">' + esc(rd.company) + '</span></div>';
    if (rd.start_date || rd.end_date) h += '<div class="attr-row"><span class="attr-key">Period</span><span class="attr-value">' + esc(rd.start_date || '?') + ' — ' + esc(rd.end_date || 'Present') + '</span></div>';
    if (rd.description) h += '<div style="margin-top:8px;font-size:0.82rem;color:var(--text-primary);line-height:1.5;">' + esc(rd.description) + '</div>';
    h += '</div>';
  }

  if (type === 'organization' && data.organization_data) {
    h += '<div class="section"><div class="section-title section-title-only">Organization Details</div>';
    h += '<div class="attr-row"><span class="attr-key">Name</span><span class="attr-value">' + esc(data.organization_data.name || name) + '</span></div>';
    h += '</div>';
  }

  if (type === 'credential' && data.credential_data) {
    var cd = data.credential_data;
    h += '<div class="section"><div class="section-title section-title-only">Credential Details</div>';
    if (cd.institution) h += '<div class="attr-row"><span class="attr-key">Institution</span><span class="attr-value">' + esc(cd.institution) + '</span></div>';
    if (cd.degree) h += '<div class="attr-row"><span class="attr-key">Degree</span><span class="attr-value">' + esc(cd.degree) + '</span></div>';
    if (cd.field) h += '<div class="attr-row"><span class="attr-key">Field</span><span class="attr-value">' + esc(cd.field) + '</span></div>';
    if (cd.start_year || cd.end_year) h += '<div class="attr-row"><span class="attr-key">Years</span><span class="attr-value">' + esc(cd.start_year || '?') + ' — ' + esc(cd.end_year || '?') + '</span></div>';
    h += '</div>';
  }

  if (type === 'skill' && data.skill_data) {
    h += '<div class="section"><div class="section-title section-title-only">Skill Details</div>';
    h += '<div class="attr-row"><span class="attr-key">Skill</span><span class="attr-value">' + esc(data.skill_data.name || name) + '</span></div>';
    h += '</div>';
  }

  // Summary if present
  var summary = e.summary?.value || '';
  if (summary) {
    h += '<div class="section"><div class="section-title section-title-only">Summary</div>';
    h += '<div class="summary-text">' + esc(summary) + '</div></div>';
  }

  document.getElementById('main').innerHTML = h;
}

/* --- Actions --- */
function toggleSummaryEdit() {
  var d = document.getElementById('summaryDisplay');
  var e = document.getElementById('summaryEditSection');
  if (e.style.display === 'none') {
    e.style.display = 'block'; d.style.display = 'none';
  } else {
    e.style.display = 'none'; d.style.display = 'block';
  }
}

function saveSummary() {
  var val = document.getElementById('summaryEdit').value;
  api('PATCH', '/api/entity/' + selectedId, { summary: val }).then(function() {
    toast('Summary updated');
    selectEntity(selectedId);
  }).catch(function(err) { toast('Error: ' + err.message); });
}

function addObs() {
  var text = document.getElementById('obsText').value.trim();
  if (!text) return;
  document.getElementById('btnAddObs').disabled = true;
  api('POST', '/api/observe', {
    entity_id: selectedId,
    observation: text,
    confidence_label: document.getElementById('obsConfidence').value,
    facts_layer: document.getElementById('obsLayer').value,
  }).then(function() {
    toast('Observation added');
    selectEntity(selectedId);
  }).catch(function(err) {
    toast('Error: ' + err.message);
    document.getElementById('btnAddObs').disabled = false;
  });
}

function deleteObs(obsId) {
  if (!obsId || !confirm('Delete this observation?')) return;
  api('DELETE', '/api/observe/' + obsId).then(function() {
    toast('Observation deleted');
    selectEntity(selectedId);
  }).catch(function(err) { toast('Error: ' + err.message); });
}

// --- Share functions ---

function openShareModal() {
  if (!selectedId) return;
  api('GET', '/api/shares/' + selectedId).then(function(shares) {
    showShareModal(shares);
  }).catch(function() {
    showShareModal([]);
  });
}

function showShareModal(existingShares) {
  var overlay = document.createElement('div');
  overlay.className = 'share-overlay';
  overlay.id = 'shareOverlay';
  overlay.onclick = function(e) { if (e.target === overlay) closeShareModal(); };

  var sections = [
    { id: 'summary', label: 'Summary', defaultOn: true },
    { id: 'experience', label: 'Experience', defaultOn: true },
    { id: 'education', label: 'Education', defaultOn: true },
    { id: 'skills', label: 'Skills', defaultOn: true },
    { id: 'connections', label: 'Connections', defaultOn: false },
  ];

  var togglesHtml = '<div class="share-section-toggles">';
  for (var i = 0; i < sections.length; i++) {
    var s = sections[i];
    togglesHtml += '<div class="share-toggle-row">' +
      '<label for="share-sec-' + s.id + '">' + esc(s.label) + '</label>' +
      '<input type="checkbox" id="share-sec-' + s.id + '" ' + (s.defaultOn ? 'checked' : '') + '>' +
      '</div>';
  }
  togglesHtml += '</div>';

  var expiryHtml = '<div class="share-expiry-row">' +
    '<label>Expires in</label>' +
    '<select id="shareExpiry">' +
    '<option value="7">7 days</option>' +
    '<option value="30" selected>30 days</option>' +
    '<option value="90">90 days</option>' +
    '<option value="365">1 year</option>' +
    '</select></div>';

  var activeHtml = '';
  if (existingShares.length > 0) {
    activeHtml = '<div class="share-active-list"><h4>Active Links</h4>';
    for (var i = 0; i < existingShares.length; i++) {
      var sh = existingShares[i];
      var expDate = new Date(sh.expiresAt).toLocaleDateString();
      activeHtml += '<div class="share-active-item">' +
        '<div><div class="share-active-info">Expires ' + esc(expDate) + '</div>' +
        '<div class="share-active-sections">' + esc(sh.sections.join(', ')) + '</div></div>' +
        '<button class="btn-revoke" onclick="revokeShare(' + "'" + sh.shareId + "'" + ')">Revoke</button>' +
        '</div>';
    }
    activeHtml += '</div>';
  }

  var html = '<div class="share-modal">' +
    '<h3>Share Profile</h3>' +
    togglesHtml +
    expiryHtml +
    '<div class="share-actions">' +
    '<button class="btn-cancel" onclick="closeShareModal()">Cancel</button>' +
    '<button class="btn-generate" onclick="generateShareLink()">Generate Link</button>' +
    '</div>' +
    '<div id="shareResult"></div>' +
    activeHtml +
    '</div>';

  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

function closeShareModal() {
  var overlay = document.getElementById('shareOverlay');
  if (overlay) overlay.remove();
}

function generateShareLink() {
  var sections = [];
  var ids = ['summary', 'experience', 'education', 'skills', 'connections'];
  for (var i = 0; i < ids.length; i++) {
    var cb = document.getElementById('share-sec-' + ids[i]);
    if (cb && cb.checked) sections.push(ids[i]);
  }
  var expiry = document.getElementById('shareExpiry');
  var days = expiry ? parseInt(expiry.value) : 30;

  api('POST', '/api/share', {
    entityId: selectedId,
    sections: sections,
    expiresInDays: days
  }).then(function(data) {
    var resultDiv = document.getElementById('shareResult');
    if (resultDiv) {
      resultDiv.innerHTML = '<div class="share-result">' +
        '<div class="share-result-url">' + esc(data.shareUrl) + '</div>' +
        '<button class="btn-copy-link" onclick="copyShareLink(' + "'" + data.shareUrl.replace(/'/g, "\\\\'") + "'" + ')">Copy Link</button>' +
        '</div>';
    }
  }).catch(function(err) {
    toast('Error creating share: ' + err.message);
  });
}

function copyShareLink(url) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      toast('Link copied to clipboard');
    }).catch(function() {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toast('Link copied to clipboard'); }
  catch(e) { toast('Copy failed — select the URL manually'); }
  document.body.removeChild(ta);
}

function revokeShare(shareId) {
  if (!confirm('Revoke this share link? Anyone with this link will no longer be able to view the profile.')) return;
  api('DELETE', '/api/share/' + shareId).then(function() {
    toast('Share link revoked');
    closeShareModal();
    openShareModal();
  }).catch(function(err) {
    toast('Error revoking share: ' + err.message);
  });
}
</script>
</body>
</html>`;

// --- Start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  Context Engine - Web Demo + API');
  console.log('  ──────────────────────────────');
  console.log('  UI:     http://localhost:' + PORT);
  console.log('  Wiki:   http://localhost:' + PORT + '/wiki');
  console.log('  Import: http://localhost:' + PORT + '/ingest');
  console.log('  API:    http://localhost:' + PORT + '/api/graph/stats');
  console.log('  Share:  http://localhost:' + PORT + '/shared/:shareId');
  console.log('  Auth:   http://localhost:' + PORT + '/auth/google' + (process.env.GOOGLE_CLIENT_ID ? '' : ' (not configured)'));
  console.log('  Graph:  ' + GRAPH_DIR + (GRAPH_IS_PERSISTENT ? ' (persistent disk)' : ' (local)'));
  console.log('');
});
