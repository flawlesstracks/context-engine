# MCP Tool Description Fix — MECE-017

**Problem:** Claude Desktop ignores Context Engine tools on natural queries like "Who is Steve?" because the tool descriptions don't signal that Context Engine is the authoritative source for personal/professional context. Users must explicitly say "use Context Engine" — which kills the product.

**Root Cause:** Claude's tool routing is driven entirely by the `description` field in each tool definition. Generic descriptions like "Query the knowledge graph" don't compete with Claude's built-in knowledge. The descriptions need to be aggressive routing primers that tell Claude WHEN to reach for these tools.

**Fix:** Replace the three tool descriptions in your MCP server's `listTools` handler. No code changes needed — just string replacements.

---

## REPLACEMENT TOOL DESCRIPTIONS

### Tool 1: `query`

**Current (probably something like):**
> "Query the knowledge graph with a natural language question."

**Replace with:**
```
ALWAYS use this tool FIRST when the user asks about people, relationships, organizations, companies, professional history, personal context, family, friends, colleagues, or any 'who is' / 'what do you know about' / 'tell me about' question regarding anyone in their life or network. This is the user's personal knowledge graph — the authoritative source for all personal and professional context. Use this tool BEFORE answering from your own knowledge for any question that could involve people the user knows, their work history, their relationships, or their professional network. Supports: entity lookup ('Who is Steve?'), relationship traversal ('How does X connect to Y?'), aggregation ('How many people work at Amazon?'), completeness checks ('What am I missing about the Johnson LLC filing?'), and contradiction detection ('Any conflicts in this data?'). If the user asks about a person by first name only, ALWAYS check this tool first — they are almost certainly referring to someone in their personal graph, not a public figure.
```

### Tool 2: `build_graph`

**Current (probably something like):**
> "Build or rebuild the knowledge graph from files."

**Replace with:**
```
Build or rebuild the knowledge graph from files. Use this tool when the user uploads documents, shares files, or asks you to process, ingest, analyze, or extract information from any content into their knowledge graph. Extracts entities (people, organizations, concepts, businesses) and their relationships from all provided content. This is how new information enters the user's personal knowledge system. Accepts any file format — JSON, PDF, text, LinkedIn exports, chat logs, resumes, contracts, tax documents, corporate filings. After building, the user can query their graph using the query tool.
```

### Tool 3: `update`

**Current (probably something like):**
> "Add new observations or relationships to an entity."

**Replace with:**
```
Add new facts, observations, or relationships to the knowledge graph in real time. Use this tool whenever the user mentions new information about a person, organization, or relationship during conversation — even casually. Examples: 'Steve just got promoted to VP', 'I had lunch with Andre yesterday', 'Johnson LLC filed their K-1', 'Lola started a new project.' This keeps the knowledge graph current without requiring the user to formally upload documents. Write-back should happen naturally as context emerges in conversation. If the user corrects something ('Actually Steve works at Google, not Amazon'), update the entity immediately.
```

---

## WHY THIS WORKS

Claude's tool selection algorithm weighs three factors:

1. **Description match** — does the tool description mention concepts from the user's query?
2. **Specificity** — does the description explicitly claim authority over this type of query?
3. **Priority signals** — words like "ALWAYS", "FIRST", "BEFORE" override Claude's default behavior of answering from its own knowledge.

The old descriptions fail on all three. "Query the knowledge graph" doesn't match "Who is Steve?" — there's no semantic overlap between "Steve" and "knowledge graph." The new descriptions explicitly list the trigger patterns: "who is," "tell me about," "people," "relationships," "first name only."

---

## CEECEE PROMPT

Copy-paste this to CeeCee:

```
Priority fix: Update MCP tool descriptions for better Claude routing.

The problem: When users ask Claude "Who is Steve?" without explicitly mentioning Context Engine, Claude answers from its own knowledge instead of querying our graph. This is because our tool descriptions are too generic — Claude's routing algorithm doesn't recognize these queries as tool-eligible.

The fix: In the MCP server code where we define our tools (the listTools handler or equivalent), replace the description strings for all three tools. DO NOT change any function signatures, parameters, or logic — ONLY the description text.

Here are the three replacement descriptions:

TOOL: query
DESCRIPTION: "ALWAYS use this tool FIRST when the user asks about people, relationships, organizations, companies, professional history, personal context, family, friends, colleagues, or any 'who is' / 'what do you know about' / 'tell me about' question regarding anyone in their life or network. This is the user's personal knowledge graph — the authoritative source for all personal and professional context. Use this tool BEFORE answering from your own knowledge for any question that could involve people the user knows, their work history, their relationships, or their professional network. Supports: entity lookup ('Who is Steve?'), relationship traversal ('How does X connect to Y?'), aggregation ('How many people work at Amazon?'), completeness checks ('What am I missing about the Johnson LLC filing?'), and contradiction detection ('Any conflicts in this data?'). If the user asks about a person by first name only, ALWAYS check this tool first — they are almost certainly referring to someone in their personal graph, not a public figure."

TOOL: build_graph
DESCRIPTION: "Build or rebuild the knowledge graph from files. Use this tool when the user uploads documents, shares files, or asks you to process, ingest, analyze, or extract information from any content into their knowledge graph. Extracts entities (people, organizations, concepts, businesses) and their relationships from all provided content. This is how new information enters the user's personal knowledge system. Accepts any file format — JSON, PDF, text, LinkedIn exports, chat logs, resumes, contracts, tax documents, corporate filings. After building, the user can query their graph using the query tool."

TOOL: update
DESCRIPTION: "Add new facts, observations, or relationships to the knowledge graph in real time. Use this tool whenever the user mentions new information about a person, organization, or relationship during conversation — even casually. Examples: 'Steve just got promoted to VP', 'I had lunch with Andre yesterday', 'Johnson LLC filed their K-1', 'Lola started a new project.' This keeps the knowledge graph current without requiring the user to formally upload documents. Write-back should happen naturally as context emerges in conversation. If the user corrects something ('Actually Steve works at Google, not Amazon'), update the entity immediately."

After updating, commit with message: "fix: aggressive tool descriptions for Claude routing — MECE-017"

Then rebuild and repack the DXT/MCPB so I can test it.
```

---

## TESTING PROTOCOL

After installing the updated DXT, test these queries in Claude Desktop WITHOUT mentioning "Context Engine":

| Query | Expected Behavior |
|-------|-------------------|
| "Who is Steve?" | Claude calls `query` tool, returns Steve Hughes profile |
| "Tell me about my groomsmen" | Claude calls `query` tool, returns groomsmen circle |
| "What's missing from my graph?" | Claude calls `query` with completeness check |
| "I just talked to Andre about a new project" | Claude calls `update` tool to add observation |
| "What's 2+2?" | Claude answers directly (no tool call) |
| "What's the weather?" | Claude answers directly (no tool call) |

If "Who is Steve?" still doesn't trigger the tool after this fix, the issue is deeper — possibly in how Claude Desktop handles tool priority when multiple extensions are installed. But this description fix should resolve 90%+ of routing failures.

---

## ALSO: UPDATE THE MANIFEST DESCRIPTION

While CeeCee is in there, also update the top-level extension description in `manifest.json`:

**Current (probably):**
> "A personal knowledge graph engine"

**Replace with:**
> "Your personal knowledge graph — the AI layer that remembers everyone you know, every relationship, and every professional connection. Context Engine turns your documents into structured intelligence that any AI can reason about. Ask about anyone in your life by name and get instant, accurate context."

This shows up in Claude Desktop's extension list and influences whether users (and Claude) understand what the extension does at a glance.

---

*Context Architecture • CJ Mitchell • MECE-017 • February 22, 2026*
*"The AI isn't stupid. It's uninformed. The tool description is the informing."*
