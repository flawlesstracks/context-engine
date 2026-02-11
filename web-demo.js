#!/usr/bin/env node

const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk').default;

require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const app = express();
app.use(express.json());

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

function buildPrompt(type, text) {
  const schema = type === 'person' ? PERSON_SCHEMA : BUSINESS_SCHEMA;
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

// --- API endpoint ---

app.post('/extract', async (req, res) => {
  const { text, type } = req.body;

  if (!text || !type) {
    return res.status(400).json({ error: 'Missing text or type' });
  }
  if (!['person', 'business'].includes(type)) {
    return res.status(400).json({ error: 'Type must be person or business' });
  }

  try {
    const prompt = buildPrompt(type, text);
    const raw = await callClaude(prompt);
    const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Serve the UI ---

app.get('/', (req, res) => {
  res.send(HTML);
});

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Context Engine</title>
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

var SAMPLE_TEXT = "Dr. Sarah Chen is a 38-year-old AI research lead at Meridian Labs in San Francisco. She previously spent six years at DeepMind working on reinforcement learning before joining Meridian in 2023 to build their applied AI division. Sarah holds a PhD from MIT in computational neuroscience and a BS from Stanford in computer science. She is known for her work on multi-agent systems and has published over 40 papers. Her close collaborators include Dr. James Park, CTO of Meridian Labs, and Professor Ana Ruiz at UC Berkeley who co-authored several papers with her. Sarah values rigorous experimentation and open science. She prefers written communication over meetings and is known for detailed technical memos. Outside of work she mentors undergrad researchers through a program called NextGen AI and is an avid rock climber.";

function loadSample() {
  document.getElementById('input').value = SAMPLE_TEXT;
}

function showActionButtons() {
  document.getElementById('btn-copy').classList.add('visible');
  document.getElementById('btn-download').classList.add('visible');
}

function hideActionButtons() {
  document.getElementById('btn-copy').classList.remove('visible');
  document.getElementById('btn-download').classList.remove('visible');
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
  var name = lastResult.name?.full || lastResult.name?.common || lastResult.name?.legal || 'context';
  var filename = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-context.json';
  var blob = new Blob([JSON.stringify(lastResult, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function syntaxHighlight(json) {
  const str = JSON.stringify(json, null, 2);
  return str.replace(
    /("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g,
    function(match) {
      let cls = 'json-number';
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = 'json-key';
          match = match.replace(/^"/, '"').replace(/":\\s*$/, '":');
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

function buildStats(data) {
  const stats = [];
  if (data.entity_type === 'person') {
    if (data.name?.full) stats.push({ v: data.name.full, l: '' });
    if (data.attributes?.role) stats.push({ v: data.attributes.role, l: '' });
    stats.push({ v: data.relationships?.length || 0, l: 'relationships' });
    stats.push({ v: data.active_projects?.length || 0, l: 'projects' });
    stats.push({ v: data.values?.length || 0, l: 'values' });
    stats.push({ v: data.key_facts?.length || 0, l: 'key facts' });
  } else {
    if (data.name?.common || data.name?.legal) stats.push({ v: data.name.common || data.name.legal, l: '' });
    if (data.industry) stats.push({ v: data.industry, l: '' });
    stats.push({ v: data.products_services?.length || 0, l: 'products' });
    stats.push({ v: data.customers?.segments?.length || 0, l: 'segments' });
    stats.push({ v: data.key_people?.length || 0, l: 'key people' });
    stats.push({ v: data.key_facts?.length || 0, l: 'key facts' });
  }
  return '<div class="stats">' + stats.map(function(s) {
    return '<div class="stat"><span class="stat-value">' + s.v + '</span><span class="stat-label">' + s.l + '</span></div>';
  }).join('') + '</div>';
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
  result.innerHTML = '<div class="loading"><div class="spinner"></div><div class="loading-text">Extracting ' + type + ' context...</div></div>';

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
      result.innerHTML = buildStats(data) + '<pre>' + syntaxHighlight(data) + '</pre>';
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

// --- Start server ---

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('');
  console.log('  Context Engine - Web Demo');
  console.log('  ─────────────────────────');
  console.log('  http://localhost:' + PORT);
  console.log('');
});
