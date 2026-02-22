# MECE-012: DXT/MCPB Package Specification

## Version: 1.0 | Date: 2026-02-22 | Author: CJ Mitchell + Claudine

---

## PURPOSE

Package Context Engine as a one-click Desktop Extension for Claude Desktop. User double-clicks a .dxt file, enters their Render API URL, and Claude instantly gets three new superpowers: build a knowledge graph from project files, query relationships across entities, and auto-update the graph as new information surfaces.

**The user experience:**
```
1. Download context-engine.dxt (one file)
2. Double-click → Claude Desktop installs it
3. Enter your Render API URL + API key when prompted
4. Ask Claude: "Build a graph from my project files"
5. Ask Claude: "How does Steve connect to Amazon?"
6. Claude answers with relationship traversal, not just RAG chunks
```

No terminal. No npm install. No config files. One click.

---

## IMPORTANT: DXT → MCPB NAMING

Anthropic has renamed Desktop Extensions from .dxt to .mcpb (MCP Bundles). The format is identical — just the file extension changed. The CLI tooling is transitioning from `@anthropic-ai/dxt` to `@anthropic-ai/mcpb`. Existing .dxt files still work. We'll build as .dxt for now (broader recognition) but the manifest uses `mcpb_version` per the latest spec.

---

## ARCHITECTURE: THREE SUB-PROBLEMS (MECE)

```
MECE-012: DXT Package
├── D1: MCP Server (The bridge between Claude and Context Engine API)
│   ├── D1.1: Tool Definitions (what Claude can call)
│   ├── D1.2: API Client (how tools talk to Render)
│   └── D1.3: Error Handling (graceful failures)
├── D2: Manifest (How Claude Desktop knows what this extension does)
│   ├── D2.1: Metadata (name, version, author, description)
│   ├── D2.2: Server Config (runtime, entry point, args)
│   ├── D2.3: User Config (API URL + key, stored in OS keychain)
│   └── D2.4: Tool Declarations (what shows in Claude's tool list)
└── D3: Packaging (How we build and distribute the .dxt file)
    ├── D3.1: File Structure (what goes in the ZIP)
    ├── D3.2: Dependencies (node_modules bundled)
    ├── D3.3: Build Script (dxt pack / mcpb pack)
    └── D3.4: Distribution (GitHub release, direct download)
```

---

## D1: MCP SERVER

### D1.1: Tool Definitions — The Three Tools

Context Engine exposes exactly three tools to Claude. Every interaction flows through one of these.

#### Tool 1: `build_graph`

**Purpose:** Read all files in the user's Claude project, extract entities and relationships, build the knowledge graph on the Render backend.

**When Claude should call this:**
- First time user says "build my graph" or "analyze my project"
- User uploads new files and says "update the graph"
- User says "rebuild" or "re-index"

```javascript
{
  name: "build_graph",
  description: "Build or rebuild the knowledge graph from files. Extracts entities (people, organizations, concepts) and their relationships from all provided content. Call this when the user wants to analyze their project files or update the graph with new information.",
  inputSchema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        description: "Array of file objects to process. Each object has 'filename' (string) and 'content' (string, the file's text content). If empty, rebuilds from previously ingested files.",
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
        description: "Optional. Name of the primary person this graph is about (the 'main character'). If provided, this person's entity will be marked as the self-entity for pronoun resolution."
      }
    },
    required: ["files"]
  }
}
```

**Implementation:**
```javascript
async function handleBuildGraph({ files, set_self_entity }) {
  const results = [];
  
  // 1. Send each file to the universal parser endpoint
  for (const file of files) {
    const response = await apiClient.post('/api/ingest/universal', {
      filename: file.filename,
      content: Buffer.from(file.content).toString('base64')
    });
    results.push(response);
  }
  
  // 2. If self_entity provided, set it
  if (set_self_entity) {
    // Search for the entity by name
    const search = await apiClient.get(`/api/search?q=${encodeURIComponent(set_self_entity)}`);
    if (search.entities && search.entities.length > 0) {
      await apiClient.post('/api/self-entity', {
        entity_id: search.entities[0].id,
        entity_name: search.entities[0].name,
        purpose: 'Primary user knowledge graph'
      });
    }
  }
  
  // 3. Return summary
  const entities = await apiClient.get('/api/search?q=&limit=1000');
  return {
    status: "success",
    files_processed: files.length,
    entities_extracted: entities.total || 0,
    self_entity: set_self_entity || null,
    message: `Processed ${files.length} files. Found ${entities.total || 0} entities. Graph is ready for queries.`
  };
}
```

#### Tool 2: `query`

**Purpose:** Ask a natural language question about the knowledge graph. Returns relationship-aware answers that RAG cannot provide.

**When Claude should call this:**
- User asks about a person, org, or concept ("Who is Steve?")
- User asks about connections ("How does X relate to Y?")
- User asks for counts or lists ("How many people are in my network?")
- User asks about gaps ("What am I missing about Steve?")
- User asks about conflicts ("Any contradictions in my data?")

```javascript
{
  name: "query",
  description: "Query the knowledge graph with a natural language question. Supports five query types: entity lookup ('Who is X?'), relationship traversal ('How does X connect to Y?'), aggregation ('How many people?'), completeness checks ('What am I missing about X?'), and contradiction detection ('Any conflicts in X's data?'). Returns structured answers with entity references, relationship paths, and confidence scores.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "Natural language question about entities, relationships, or the knowledge graph"
      }
    },
    required: ["question"]
  }
}
```

**Implementation:**
```javascript
async function handleQuery({ question }) {
  const response = await apiClient.get(`/api/query?q=${encodeURIComponent(question)}`);
  
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
```

#### Tool 3: `update`

**Purpose:** Add new information to the graph without re-processing all files. Used when the user mentions new facts in conversation that should be captured.

**When Claude should call this:**
- User mentions new information about a known entity ("Steve just got promoted to VP")
- User wants to add a new relationship ("Steve and Andre went to college together")
- User wants to correct information ("Actually, Steve works at Google, not Meta")

```javascript
{
  name: "update",
  description: "Update the knowledge graph with new information. Use this to add observations about existing entities, create new entities, or add relationships — without reprocessing all files. Call this when the user mentions new facts about people, organizations, or concepts in the graph.",
  inputSchema: {
    type: "object",
    properties: {
      entity_name: {
        type: "string",
        description: "Name of the entity to update or create"
      },
      entity_type: {
        type: "string",
        enum: ["PERSON", "ORG", "CONCEPT"],
        description: "Type of entity"
      },
      observations: {
        type: "array",
        description: "New facts about this entity",
        items: {
          type: "object",
          properties: {
            attribute: { type: "string", description: "What this fact is about (e.g., 'role', 'location', 'education')" },
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
            relationship: { type: "string", description: "Type of relationship (e.g., 'works_at', 'friend_of', 'created')" },
            context: { type: "string", description: "Context for this relationship" }
          },
          required: ["target_name", "relationship"]
        }
      }
    },
    required: ["entity_name"]
  }
}
```

**Implementation:**
```javascript
async function handleUpdate({ entity_name, entity_type, observations, relationships }) {
  // 1. Search for existing entity
  const search = await apiClient.get(`/api/search?q=${encodeURIComponent(entity_name)}`);
  let entity = search.entities?.[0];
  
  // 2. If not found, create new entity
  if (!entity) {
    entity = await apiClient.post('/api/entity', {
      name: entity_name,
      type: entity_type || 'PERSON',
      source: 'conversation',
      observations: []
    });
  }
  
  // 3. Add observations
  if (observations && observations.length > 0) {
    for (const obs of observations) {
      await apiClient.post(`/api/entity/${entity.id}/observe`, {
        attribute: obs.attribute,
        value: obs.value,
        confidence: obs.confidence || 0.8,
        source: 'conversation',
        truth_level: 'MODERATE'
      });
    }
  }
  
  // 4. Add relationships
  if (relationships && relationships.length > 0) {
    for (const rel of relationships) {
      // Find or create target entity
      const targetSearch = await apiClient.get(`/api/search?q=${encodeURIComponent(rel.target_name)}`);
      let target = targetSearch.entities?.[0];
      if (!target) {
        target = await apiClient.post('/api/entity', {
          name: rel.target_name,
          type: 'PERSON',
          source: 'conversation'
        });
      }
      
      await apiClient.post(`/api/entity/${entity.id}/relationship`, {
        target_id: target.id,
        relationship: rel.relationship,
        context: rel.context || '',
        confidence: 0.8,
        source: 'conversation'
      });
    }
  }
  
  return {
    status: "success",
    entity_id: entity.id,
    entity_name: entity_name,
    observations_added: observations?.length || 0,
    relationships_added: relationships?.length || 0,
    message: `Updated ${entity_name}: ${observations?.length || 0} observations, ${relationships?.length || 0} relationships added.`
  };
}
```

### D1.2: API Client

Simple HTTP client that wraps all calls to the Render-hosted Context Engine API.

```javascript
class ContextEngineClient {
  constructor(apiUrl, apiKey) {
    this.baseUrl = apiUrl.replace(/\/$/, ''); // trim trailing slash
    this.apiKey = apiKey;
  }
  
  async get(path) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      headers: { 'X-Context-API-Key': this.apiKey }
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  }
  
  async post(path, body) {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Context-API-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
    return res.json();
  }
}
```

### D1.3: Error Handling

Every tool call wraps in try/catch and returns structured errors:

```javascript
async function safeTool(handler, args) {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await handler(args), null, 2) }] };
  } catch (error) {
    const message = error.message || 'Unknown error';
    
    if (message.includes('401') || message.includes('403')) {
      return { content: [{ type: "text", text: JSON.stringify({
        error: "Authentication failed. Check your API key in extension settings.",
        hint: "Go to Claude Desktop → Settings → Extensions → Context Engine → Update API Key"
      }) }] };
    }
    
    if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
      return { content: [{ type: "text", text: JSON.stringify({
        error: "Cannot reach Context Engine API. Check your API URL in extension settings.",
        hint: "Verify your Render deployment is running at the configured URL"
      }) }] };
    }
    
    return { content: [{ type: "text", text: JSON.stringify({
      error: `Tool failed: ${message}`,
      hint: "Try again. If the problem persists, check the extension logs."
    }) }] };
  }
}
```

---

## D2: MANIFEST

### D2.1-D2.4: Complete manifest.json

```json
{
  "mcpb_version": "0.1",
  "name": "context-engine",
  "version": "1.0.0",
  "display_name": "Context Engine",
  "description": "Knowledge graph superpowers for Claude. Extracts entities and relationships from your project files, then answers questions RAG can't — like 'How does Steve connect to Amazon?' with multi-hop graph traversal.",
  "author": {
    "name": "CJ Mitchell",
    "url": "https://github.com/flawlesstracks/context-engine"
  },
  "repository": "https://github.com/flawlesstracks/context-engine",
  "license": "MIT",
  "keywords": ["knowledge-graph", "entities", "relationships", "context", "RAG"],
  
  "server": {
    "type": "node",
    "entry_point": "server/index.js",
    "mcp_config": {
      "command": "node",
      "args": ["${__dirname}/server/index.js"],
      "env": {
        "CONTEXT_ENGINE_URL": "${user_config.api_url}",
        "CONTEXT_ENGINE_KEY": "${user_config.api_key}"
      }
    }
  },
  
  "tools": [
    {
      "name": "build_graph",
      "description": "Build or rebuild the knowledge graph from files. Extracts entities (people, organizations, concepts) and their relationships."
    },
    {
      "name": "query",
      "description": "Query the knowledge graph with natural language. Supports entity lookup, relationship traversal, aggregation, completeness checks, and contradiction detection."
    },
    {
      "name": "update",
      "description": "Add new observations or relationships to the knowledge graph from conversation context."
    }
  ],
  "tools_generated": false,
  
  "user_config": {
    "api_url": {
      "type": "string",
      "title": "Context Engine API URL",
      "description": "Your Render deployment URL (e.g., https://context-engine-xxxx.onrender.com)",
      "required": true,
      "default": "https://context-engine.onrender.com"
    },
    "api_key": {
      "type": "string",
      "title": "API Key",
      "description": "Your Context Engine API key (starts with ctx-)",
      "sensitive": true,
      "required": true
    }
  },
  
  "compatibility": {
    "claude_desktop": ">=1.0.0",
    "platforms": ["darwin", "win32", "linux"]
  }
}
```

**Key design decisions:**

- `api_key` has `sensitive: true` → stored in OS keychain (macOS Keychain, Windows Credential Manager), never in plaintext
- `api_url` lets each user point to their own Render instance (multi-tenant from day one)
- `tools_generated: false` → we declare all three tools upfront, no runtime discovery needed
- `env` block passes user config to the server process as environment variables — clean separation

---

## D3: PACKAGING

### D3.1: File Structure

```
context-engine/
├── manifest.json              # Extension metadata (from D2 above)
├── icon.png                   # 512x512 extension icon
├── server/
│   └── index.js               # MCP server entry point (from D1 above)
├── node_modules/
│   ├── @modelcontextprotocol/
│   │   └── sdk/               # MCP SDK for stdio transport
│   └── ... (minimal deps)
├── package.json
└── README.md
```

**Dependency budget:** The only runtime dependency is `@modelcontextprotocol/sdk`. We use Node's built-in `fetch` (available in Node 18+ which ships with Claude Desktop). No axios, no express, no heavy frameworks. Target: < 2MB total package size.

### D3.2: server/index.js — Full MCP Server

The entry point that Claude Desktop launches:

```javascript
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
    this.baseUrl = url.replace(/\/$/, '');
    this.key = key;
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
              filename: { type: "string" },
              content: { type: "string" }
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
        question: { type: "string", description: "Natural language question" }
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
        entity_type: { type: "string", enum: ["PERSON", "ORG", "CONCEPT"] },
        observations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              attribute: { type: "string" },
              value: { type: "string" },
              confidence: { type: "number" }
            },
            required: ["attribute", "value"]
          }
        },
        relationships: {
          type: "array",
          items: {
            type: "object",
            properties: {
              target_name: { type: "string" },
              relationship: { type: "string" },
              context: { type: "string" }
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
      await api.post('/api/self-entity', {
        entity_id: search.entities[0].id,
        entity_name: search.entities[0].name,
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
  return await api.get(`/api/query?q=${encodeURIComponent(question)}`);
}

async function handleUpdate({ entity_name, entity_type, observations, relationships }) {
  // Search for existing entity
  const search = await api.get(`/api/search?q=${encodeURIComponent(entity_name)}`);
  let entity = search.entities?.[0];
  
  // Create if not found
  if (!entity) {
    entity = await api.post('/api/entity', {
      name: entity_name,
      type: entity_type || 'PERSON',
      source: 'conversation'
    });
  }
  
  let obsAdded = 0, relsAdded = 0;
  
  if (observations) {
    for (const obs of observations) {
      await api.post(`/api/entity/${entity.id}/observe`, {
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
      const ts = await api.get(`/api/search?q=${encodeURIComponent(rel.target_name)}`);
      let target = ts.entities?.[0];
      if (!target) {
        target = await api.post('/api/entity', {
          name: rel.target_name, type: 'PERSON', source: 'conversation'
        });
      }
      await api.post(`/api/entity/${entity.id}/relationship`, {
        target_id: target.id,
        relationship: rel.relationship,
        context: rel.context || '',
        confidence: 0.8,
        source: 'conversation'
      });
      relsAdded++;
    }
  }
  
  return {
    entity_id: entity.id,
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
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }]
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
```

### D3.3: Build Script

```bash
#!/bin/bash
# build-dxt.sh — Build the Context Engine Desktop Extension

set -e

echo "📦 Building Context Engine DXT..."

# 1. Create clean build directory
rm -rf dist/dxt-build
mkdir -p dist/dxt-build/server

# 2. Copy manifest
cp dxt/manifest.json dist/dxt-build/

# 3. Copy server
cp dxt/server/index.js dist/dxt-build/server/

# 4. Copy icon
cp dxt/icon.png dist/dxt-build/ 2>/dev/null || echo "⚠️  No icon.png found, skipping"

# 5. Install production dependencies
cd dist/dxt-build
cat > package.json << 'EOF'
{
  "name": "context-engine-dxt",
  "version": "1.0.0",
  "type": "module",
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
EOF
npm install --production
cd ../..

# 6. Pack with dxt CLI (or just zip)
if command -v dxt &> /dev/null; then
  cd dist/dxt-build
  dxt pack
  mv *.dxt ../context-engine.dxt
  cd ../..
  echo "✅ Built with dxt CLI: dist/context-engine.dxt"
elif command -v mcpb &> /dev/null; then
  cd dist/dxt-build
  mcpb pack
  mv *.mcpb ../context-engine.mcpb
  cd ../..
  echo "✅ Built with mcpb CLI: dist/context-engine.mcpb"  
else
  # Fallback: manual zip
  cd dist/dxt-build
  zip -r ../context-engine.dxt manifest.json server/ node_modules/ package.json
  cd ../..
  echo "✅ Built manually: dist/context-engine.dxt"
fi

echo "📏 Size: $(du -sh dist/context-engine.dxt 2>/dev/null || du -sh dist/context-engine.mcpb 2>/dev/null)"
echo "🚀 Ready to install!"
```

### D3.4: Distribution

**Phase 1 (Now):** GitHub Release
- Upload .dxt file as release artifact on flawlesstracks/context-engine
- README with installation instructions
- Direct download link for sharing

**Phase 2 (Later):** Extension Directory
- Submit to Anthropic's extension directory for community discovery
- Requires security review

---

## IMPLEMENTATION PLAN

### File Structure in Repo

```
context-engine/
├── ... (existing files)
├── dxt/                        # NEW — DXT package source
│   ├── manifest.json           # Extension manifest
│   ├── server/
│   │   └── index.js            # MCP server (the full server code above)
│   ├── package.json            # Dependencies for the DXT
│   └── icon.png                # Extension icon (512x512)
├── build-dxt.sh                # Build script
└── dist/                       # Build output (gitignored)
    └── context-engine.dxt      # The distributable file
```

### Build Order

| Step | What | Test | Est. Time |
|------|------|------|-----------|
| 1 | Create `dxt/manifest.json` | Validate with `dxt validate` or manual JSON parse | 10 min |
| 2 | Create `dxt/server/index.js` with MCP server scaffold (imports, server setup, transport) | Server starts without errors on stdio | 15 min |
| 3 | Implement `build_graph` handler | Call with mock files → hits `/api/ingest/universal` → returns entity count | 20 min |
| 4 | Implement `query` handler | Call with question → hits `/api/query` → returns structured answer | 10 min |
| 5 | Implement `update` handler | Call with entity + observations → hits `/api/entity` endpoints → returns confirmation | 20 min |
| 6 | Add error handling (auth, connection, unknown tool) | Trigger each error path → returns helpful message | 10 min |
| 7 | Create `build-dxt.sh`, run it, verify .dxt file structure | Unzip .dxt → manifest.json present, server/index.js present, node_modules present | 15 min |
| 8 | Integration test: install in Claude Desktop, test all 3 tools against live Render API | build_graph processes a file, query returns an answer, update adds an observation | 20 min |

**Total estimated: ~2 hours**

### Test Plan

**Unit tests (Steps 2-6):**
```bash
# Test that server starts and responds to ListTools
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  CONTEXT_ENGINE_URL=http://localhost:3099 \
  CONTEXT_ENGINE_KEY=ctx-test \
  node dxt/server/index.js

# Should return JSON with 3 tools
```

**Integration test (Step 8):**
1. Install .dxt in Claude Desktop
2. Open a conversation with project files
3. Say: "Build a graph from my project files" → should call build_graph
4. Say: "Who is Steve Hughes?" → should call query → return entity profile
5. Say: "Steve just got promoted to Senior Director" → should call update
6. Say: "How does Steve connect to Amazon?" → should call query → return path
7. Say: "What am I missing about Steve?" → should call query → return gaps

---

## API ENDPOINTS REQUIRED (Existing vs New)

| Endpoint | Status | Used By |
|----------|--------|---------|
| `POST /api/ingest/universal` | ✅ EXISTS | build_graph |
| `GET /api/search?q=` | ✅ EXISTS | build_graph, update |
| `GET /api/query?q=` | ✅ EXISTS | query |
| `POST /api/self-entity` | ✅ EXISTS | build_graph |
| `GET /api/self-entity` | ✅ EXISTS | (internal) |
| `POST /api/entity` | ⚠️ VERIFY | update (create new entity) |
| `POST /api/entity/:id/observe` | ⚠️ VERIFY | update (add observation) |
| `POST /api/entity/:id/relationship` | ⚠️ VERIFY | update (add relationship) |

**CeeCee needs to verify** that the three ⚠️ endpoints exist and work as expected. If they don't, she needs to add them to web-demo.js before building the DXT.

---

## WHAT THIS SPEC DOES NOT COVER (Parked)

- Auto-provisioning: User doesn't have a Render instance yet → onboarding flow that spins one up (future)
- File reading from local filesystem: DXT reads project files via Claude passing content, not direct filesystem access (simpler, more secure)
- Automatic graph rebuild on file change: Would require filesystem watcher in DXT (future)
- Multi-tenant selection: User picks which graph to query (future, when they have multiple)
- Offline mode: All queries go through Render API (future: local SQLite fallback)
- Extension auto-update: Handled by Claude Desktop natively via manifest version

---

## SUCCESS CRITERIA

The DXT is DONE when:

1. ✅ `dxt pack` (or manual zip) produces a valid .dxt file < 5MB
2. ✅ Double-click installs in Claude Desktop without errors
3. ✅ User prompted for API URL + API key (key stored in OS keychain)
4. ✅ `build_graph` processes files and returns entity count
5. ✅ `query` answers "Who is Steve?" with entity profile from graph
6. ✅ `query` answers "How does Steve connect to Amazon?" with traversal path
7. ✅ `update` adds an observation and confirms success
8. ✅ Error messages are helpful (bad API key, unreachable server)
9. ✅ All 3 tools appear in Claude's tool list
10. ✅ README with installation instructions published to GitHub

---

## THE DEMO SCRIPT

When you record the YouTube demo, this is the flow:

```
[Screen: Claude Desktop, empty conversation]

CJ: "I just installed Context Engine. Let me show you what it does."

CJ: "Build a knowledge graph from my project files."
     → Claude calls build_graph
     → "Processed 47 files. Found 96 entities. Graph is ready."

CJ: "Who is Steve Hughes?"
     → Claude calls query
     → "Steve Hughes is a 40-year-old resident of Atlanta. He works at Meta
        and is part of your inner circle. Connected to 12 other entities."

CJ: "How does Steve connect to Amazon?"
     → Claude calls query (RELATIONSHIP type)
     → "Steve is connected to Amazon through you. Steve is your friend,
        and you work at Amazon as a Principal Product Manager. 2 hops."

CJ: "What am I missing about Steve?"
     → Claude calls query (COMPLETENESS type)  
     → "Steve has 78% coverage. Missing: email, education history,
        career timeline. Suggested: find LinkedIn profile."

CJ: "Steve actually just got promoted to VP of Engineering at Meta."
     → Claude calls update
     → "Updated Steve Hughes: +1 observation (role: VP of Engineering)."

CJ: "Now who is Steve Hughes?"
     → Claude calls query
     → Now includes "VP of Engineering at Meta" in the profile.

CJ: "That's Context Engine. It doesn't just search your files — 
     it understands how everything connects."

[End]
```

Time: ~3 minutes. This is the viral demo.
