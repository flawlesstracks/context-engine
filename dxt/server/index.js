#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Read config from environment (injected by Claude Desktop from manifest env block)
const API_URL = process.env.CONTEXT_ENGINE_URL;
const API_KEY = process.env.CONTEXT_ENGINE_KEY;

// --- API Client ---

class ContextEngineClient {
  constructor(url, key) {
    this.baseUrl = (url || '').replace(/\/$/, '');
    this.key = key || '';
  }

  async get(path) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'X-Context-API-Key': this.key }
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async post(path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'X-Context-API-Key': this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

const api = new ContextEngineClient(API_URL, API_KEY);

// --- Tool Definitions ---

const TOOLS = [
  {
    name: "build_graph",
    description: "Build or rebuild the knowledge graph from files. Use this tool when the user uploads documents, shares files, or asks you to process, ingest, analyze, or extract information from any content into their knowledge graph. Extracts entities (people, organizations, concepts, businesses) and their relationships from all provided content. This is how new information enters the user's personal knowledge system. Accepts any file format — JSON, PDF, text, LinkedIn exports, chat logs, resumes, contracts, tax documents, corporate filings. After building, the user can query their graph using the query tool.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "Array of {filename, content} objects to process",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "Name of the file including extension" },
              content: { type: "string", description: "Full text content of the file" }
            },
            required: ["filename", "content"]
          }
        },
        set_self_entity: {
          type: "string",
          description: "Optional. Name of the primary person this graph is about."
        },
        spoke: {
          type: "string",
          description: "Optional spoke ID to ingest into. Use this when ingesting files for a specific client, project, or matter. If omitted, entities go into the default spoke."
        }
      },
      required: ["files"]
    }
  },
  {
    name: "sync",
    description: "Trigger a connector sync to pull data from an external system (like ShareFile) into the knowledge graph. Use this tool when the user asks to sync, refresh, or pull data from a connected service. Returns sync progress including folders synced, files processed, and entities staged for review.",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: {
          type: "string",
          description: "The connection ID to sync. Get available connections from the query tool by asking 'what connections do I have?'"
        },
        folder_ids: {
          type: "array",
          description: "Optional. Specific folder IDs to sync. If omitted, syncs all mapped folders.",
          items: { type: "string" }
        }
      },
      required: ["connection_id"]
    }
  },
  {
    name: "query",
    description: "ALWAYS use this tool FIRST when the user asks about people, relationships, organizations, companies, professional history, personal context, family, friends, colleagues, or any 'who is' / 'what do you know about' / 'tell me about' question regarding anyone in their life or network. This is the user's personal knowledge graph — the authoritative source for all personal and professional context. Use this tool BEFORE answering from your own knowledge for any question that could involve people the user knows, their work history, their relationships, or their professional network. Supports: entity lookup ('Who is Steve?'), relationship traversal ('How does X connect to Y?'), aggregation ('How many people work at Amazon?'), completeness checks ('What am I missing about the Johnson LLC filing?'), and contradiction detection ('Any conflicts in this data?'). If the user asks about a person by first name only, ALWAYS check this tool first — they are almost certainly referring to someone in their personal graph, not a public figure.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural language question about entities, relationships, or the knowledge graph" },
        spoke: { type: "string", description: "Optional spoke ID or name to scope the query to a specific client, project, or matter. When provided, only entities in that spoke are searched." }
      },
      required: ["question"]
    }
  },
  {
    name: "update",
    description: "Add new facts, observations, or relationships to the knowledge graph in real time. Use this tool whenever the user mentions new information about a person, organization, or relationship during conversation — even casually. Examples: 'Steve just got promoted to VP', 'I had lunch with Andre yesterday', 'Johnson LLC filed their K-1', 'Lola started a new project.' This keeps the knowledge graph current without requiring the user to formally upload documents. Write-back should happen naturally as context emerges in conversation. If the user corrects something ('Actually Steve works at Google, not Amazon'), update the entity immediately.",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: { type: "string", description: "Entity to update or create" },
        entity_type: { type: "string", enum: ["person", "business", "institution"], description: "Type of entity (person, business, or institution)" },
        observations: {
          type: "array",
          description: "New facts about this entity",
          items: {
            type: "object",
            properties: {
              attribute: { type: "string", description: "What this fact is about (e.g., role, location, education)" },
              value: { type: "string", description: "The fact itself" },
              confidence: { type: "number", description: "How confident (0-1). Use 0.9 for stated facts, 0.6 for inferred." }
            },
            required: ["attribute", "value"]
          }
        },
        relationships: {
          type: "array",
          description: "New relationships to add",
          items: {
            type: "object",
            properties: {
              target_name: { type: "string", description: "Name of the related entity" },
              relationship: { type: "string", description: "Type of relationship (e.g., works_at, friend_of, created)" },
              context: { type: "string", description: "Context for this relationship" }
            },
            required: ["target_name", "relationship"]
          }
        }
      },
      required: ["entity_name"]
    }
  },
  {
    name: "analyze_gaps",
    description: "Analyze completeness of a client matter against a legal template. Shows missing documents, incomplete entity fields, and missing relationships. Use when user asks \"what's missing?\" or \"how complete is this matter?\"",
    inputSchema: {
      type: "object",
      properties: {
        spoke: { type: "string", description: "Spoke ID or name to analyze" },
        template: { type: "string", description: "Optional matter type override (e.g. estate_planning, corporate_formation, tax_preparation, personal_injury, general)" },
        refresh: { type: "boolean", description: "Force fresh analysis instead of using cached results" }
      },
      required: ["spoke"]
    }
  }
];

// --- Tool Handlers ---

async function handleBuildGraph({ files, set_self_entity, spoke }) {
  const results = [];
  for (const file of files) {
    const params = spoke ? `?spoke_id=${encodeURIComponent(spoke)}` : '';
    const r = await api.post(`/api/ingest/universal${params}`, {
      filename: file.filename,
      content: Buffer.from(file.content).toString('base64')
    });
    results.push({ filename: file.filename, entities: r.entities?.length || 0 });
  }

  if (set_self_entity) {
    const search = await api.get(`/api/search?q=${encodeURIComponent(set_self_entity)}`);
    if (search.entities?.length > 0) {
      const best = search.entities[0];
      await api.post('/api/self-entity', {
        entity_id: best.id || best.entity_id,
        entity_name: best.name,
        purpose: 'Primary user knowledge graph'
      });
    }
  }

  const all = await api.get('/api/search?q=');
  return {
    files_processed: files.length,
    file_results: results,
    total_entities: all.entities?.length || 0,
    self_entity: set_self_entity || null,
    message: `Processed ${files.length} files. ${all.entities?.length || 0} entities in graph.`
  };
}

async function handleQuery({ question, spoke }) {
  const params = spoke ? `&spoke_id=${encodeURIComponent(spoke)}` : '';
  const response = await api.get(`/api/query?q=${encodeURIComponent(question)}${params}`);
  return {
    answer: response.answer,
    query_type: response.query?.type,
    entities: response.entities || [],
    paths: response.paths || [],
    gaps: response.gaps || [],
    conflicts: response.conflicts || [],
    confidence: response.confidence,
    timing_ms: response.timing?.total_ms
  };
}

async function handleUpdate({ entity_name, entity_type, observations, relationships }) {
  // Search for existing entity
  const search = await api.get(`/api/search?q=${encodeURIComponent(entity_name)}`);
  let entity = search.entities?.[0];
  let entityId = entity?.id || entity?.entity_id;

  // Create if not found
  if (!entityId) {
    const eType = entity_type || 'person';
    const nameParts = entity_name.trim().split(/\s+/);
    const nameObj = eType === 'person'
      ? { full: entity_name, preferred: nameParts[0] }
      : { common: entity_name };

    const created = await api.post('/api/entity', {
      entity_type: eType,
      name: nameObj,
      source: 'conversation'
    });
    entityId = created.entity_id;
  }

  let obsAdded = 0;
  let relsAdded = 0;

  if (observations) {
    for (const obs of observations) {
      await api.post(`/api/entity/${entityId}/observe`, {
        attribute: obs.attribute,
        value: obs.value,
        confidence: obs.confidence || 0.8,
        source: 'conversation',
        truth_level: 'MODERATE'
      });
      obsAdded++;
    }
  }

  if (relationships) {
    for (const rel of relationships) {
      // Find target entity
      const ts = await api.get(`/api/search?q=${encodeURIComponent(rel.target_name)}`);
      let target = ts.entities?.[0];
      let targetId = target?.id || target?.entity_id;

      if (!targetId) {
        // Create target entity
        const tNameParts = rel.target_name.trim().split(/\s+/);
        const tCreated = await api.post('/api/entity', {
          entity_type: 'person',
          name: { full: rel.target_name, preferred: tNameParts[0] },
          source: 'conversation'
        });
        targetId = tCreated.entity_id;
      }

      await api.post(`/api/entity/${entityId}/relationship`, {
        target_id: targetId,
        relationship: rel.relationship,
        context: rel.context || '',
        confidence: 0.8,
        source: 'conversation'
      });
      relsAdded++;
    }
  }

  return {
    entity_id: entityId,
    entity_name,
    observations_added: obsAdded,
    relationships_added: relsAdded,
    message: `Updated ${entity_name}: +${obsAdded} observations, +${relsAdded} relationships.`
  };
}

async function handleSync({ connection_id, folder_ids }) {
  if (!connection_id) throw new Error('connection_id is required');

  // POST /api/sync returns NDJSON — we collect events and return the final result
  const res = await fetch(`${api.baseUrl}/api/sync/${encodeURIComponent(connection_id)}`, {
    method: 'POST',
    headers: { 'X-Context-API-Key': api.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder_ids })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);

  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  let lastComplete = null;
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'complete') lastComplete = event.results;
      if (event.type === 'error') throw new Error(event.message);
    } catch (e) {
      if (e.message && !e.message.includes('JSON')) throw e;
    }
  }

  return lastComplete || { message: 'Sync completed', events: lines.length };
}

async function handleAnalyzeGaps({ spoke, template, refresh }) {
  if (!spoke) throw new Error('spoke is required');

  // Resolve spoke by ID or name
  const spokes = await api.get('/api/spokes');
  const spokeList = spokes.spokes || [];
  const spokeObj = spokeList.find(s =>
    s.id === spoke || (s.name && s.name.toLowerCase() === spoke.toLowerCase())
  );
  if (!spokeObj) throw new Error(`Spoke not found: ${spoke}. Available: ${spokeList.map(s => s.name).join(', ')}`);

  const params = new URLSearchParams();
  if (template) params.set('template', template);
  if (refresh) params.set('refresh', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';

  const report = await api.get(`/api/spoke/${encodeURIComponent(spokeObj.id)}/gaps${qs}`);
  return report;
}

const HANDLERS = {
  build_graph: handleBuildGraph,
  query: handleQuery,
  update: handleUpdate,
  sync: handleSync,
  analyze_gaps: handleAnalyzeGaps
};

// --- MCP Server ---

const server = new Server(
  { name: "context-engine", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];

  if (!handler) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true
    };
  }

  try {
    const result = await handler(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    const msg = error.message || 'Unknown error';
    let hint = 'Try again or check extension logs.';
    if (msg.includes('401') || msg.includes('403')) hint = 'Check your API key in extension settings.';
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) hint = 'Check your API URL in extension settings.';

    return {
      content: [{ type: "text", text: JSON.stringify({ error: msg, hint }) }],
      isError: true
    };
  }
});

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Context Engine MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
