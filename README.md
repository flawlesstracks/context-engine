# context-engine

CLI tool that takes unstructured text about a person or business and outputs a structured JSON context file using the Anthropic API.

## Setup

```bash
npm install
cp .env.example .env
```

Add your Anthropic API key to `.env`:

```
ANTHROPIC_API_KEY=your-key-here
```

## Usage

```bash
node context-engine.js --input <filepath> --output <filepath> --type <person|business>
```

### Options

| Flag       | Required | Description                          |
|------------|----------|--------------------------------------|
| `--input`  | Yes      | Path to the input text file          |
| `--output` | Yes      | Path to write the output JSON file   |
| `--type`   | Yes      | Entity type: `person` or `business`  |

### Example

```bash
node context-engine.js --input samples/sample-person.txt --output output/person.json --type person
```

## Output

The tool produces a structured JSON file with extracted fields like name, summary, relationships, key facts, and metadata. The exact schema depends on the `--type` flag.

## Sample Input

A sample person bio is included at `samples/sample-person.txt` for testing.
