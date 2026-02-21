# CeeCee Day 5 Startup Prompt
## Paste this into a fresh Claude Code terminal

```
CONTEXT: You're CeeCee, working on Context Architecture at 
~/context-architecture. Read CLAUDE.md first — it has your 
full project memory.

TODAY'S MISSION: Push EXTRACT from Level 3 to Level 8.

Before you build anything:
1. Read CLAUDE.md (your project memory)
2. Read CA_EXTRACT_Upgrade_Spec_Day5.docx (today's build plan)
   - CJ will upload this to the project directory
3. Confirm git status is clean and Render matches localhost
4. Confirm entity count: ls watch-folder/graph/tenant-eefc79c7/*.json | wc -l

BUILD ORDER (do them in sequence):

BUILD 1: URL Paste → Extract (Level 5)
- POST /api/extract-url endpoint
- Fetches any URL, strips HTML, feeds to extraction pipeline  
- URL input field in wiki next to file upload
- Source attribution on every extracted observation
- Test: paste a company About page URL

BUILD 2: LinkedIn PDF Auto-Detection (Level 6a)
- detectLinkedInPDF() function in extraction pipeline
- Specialized prompt maps to Career Lite fields
- Routes LinkedIn PDFs to career-specific extraction
- Test: upload a LinkedIn PDF export

BUILD 3: Proxycurl LinkedIn Integration (Level 6b)  
- POST /api/extract-linkedin endpoint
- Calls Proxycurl API with LinkedIn URL
- Maps response to entity schema + Career Lite
- Auto-creates org entities for each employer
- Needs: PROXYCURL_API_KEY in .env
- CJ will provide the API key
- Test: paste a LinkedIn profile URL

BUILD 4: X + Instagram Bio Extraction (Level 6c)
- Smart URL router detects linkedin/x/instagram URLs
- Parses meta tags for bio, handle, follower count
- Enriches existing entities if name matches
- Test: paste an X profile URL

BUILD 5: Company Auto-Enrichment (Level 8)
- When org entity is created, auto-fetch company website
- Optional: Proxycurl company endpoint for LinkedIn company data
- "Enrich from Web" button on org detail pages
- Test: create an org entity, verify auto-enrichment fires

BUILD 6: Update Custom GPT + OpenAPI Spec
- Add extract-url and extract-linkedin to openai-actions-spec.yaml
- Update GPT system prompt: "offer to look up people not in graph"
- Test: in GPT, say "look up [name] on LinkedIn"

After EACH build: git add, commit with descriptive message, push.
After ALL builds: verify everything works on Render.

The full spec with code patterns, endpoint signatures, and test 
cases is in CA_EXTRACT_Upgrade_Spec_Day5.docx. Read it before 
you start building.

What's your git status?
```

## Setup Steps (before pasting the prompt)

1. Copy CLAUDE.md to ~/context-architecture/CLAUDE.md
2. Copy CA_EXTRACT_Upgrade_Spec_Day5.docx to ~/context-architecture/
3. Open fresh terminal
4. Run: cd ~/context-architecture && claude --dangerously-skip-permissions
5. Paste the prompt above
6. When she asks for the Proxycurl key, go to https://nubela.co/proxycurl 
   and sign up for the $10 starter credit. Paste the API key when asked.
