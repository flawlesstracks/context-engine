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
    description: "Build or rebuild the knowledge graph from files. Extracts entities (people, organizations, concepts) and their relationships from all provided content. Call this when the user wants to analyze their project files or update the graph with new information.",
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
        }
      },
      required: ["files"]
    }
  },
  {
    name: "query",
    description: "Query the knowledge graph with a natural language question. Supports: entity lookup ('Who is X?'), relationship traversal ('How does X connect to Y?'), aggregation ('How many people?'), completeness checks ('What am I missing about X?'), contradiction detection ('Any conflicts?').",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural language question about entities, relationships, or the knowledge graph" }
      },
      required: ["question"]
    }
  },
  {
    name: "update",
    description: "Add new observations or relationships to an entity in the knowledge graph. Use when the user mentions new facts in conversation.",
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
  }
];

// --- Tool Handlers ---

async function handleBuildGraph({ files, set_self_entity }) {
  const results = [];
  for (const file of files) {
    const r = await api.post('/api/ingest/universal', {
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

async function handleQuery({ question }) {
  const response = await api.get(`/api/query?q=${encodeURIComponent(question)}`);
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

const HANDLERS = {
  build_graph: handleBuildGraph,
  query: handleQuery,
  update: handleUpdate
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
