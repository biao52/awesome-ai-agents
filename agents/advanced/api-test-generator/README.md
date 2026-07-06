# API Test Generator

> An agent that reads an OpenAPI/Swagger spec and generates a comprehensive test suite with happy path, edge case, and auth tests for every endpoint.

## What You'll Learn

- How to parse and extract structured data from OpenAPI/Swagger specifications
- How to use an LLM to generate production-grade test code from API schemas
- How to batch large specs into manageable chunks for processing
- How to handle both JSON and YAML spec formats
- How to build a CLI tool that outputs to stdout or saves to files

## Architecture

```
User provides OpenAPI spec file (JSON or YAML)
    |
Parse spec --> extract endpoints, methods, parameters, schemas
    |
Batch endpoints (max 10 per batch)
    |
For each batch:
    --> Send endpoint details + spec summary to Claude
    --> Claude generates test code covering:
        - Happy path (valid requests, expected 2xx)
        - Edge cases (missing fields, invalid types)
        - Auth tests (no creds, bad creds)
    |
Output: Test files (pytest/httpx or vitest/fetch)
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- An OpenAPI/Swagger spec file (JSON or YAML) for the API you want to test
- **Estimated cost:** ~$0.02-0.10 per spec (depends on number of endpoints)

## Quick Start

### Python

1. Navigate to the Python directory:
   ```bash
   cd python
   ```

2. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your Anthropic API key.

5. Run the generator:
   ```bash
   python main.py --file ../path/to/openapi.json
   ```

### TypeScript

1. Navigate to the TypeScript directory:
   ```bash
   cd typescript
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up your environment:
   ```bash
   cp .env.example .env
   ```

4. Open `.env` and add your Anthropic API key.

5. Run the generator:
   ```bash
   npx tsx index.ts --file ../path/to/openapi.json
   ```

## How It Works

The agent starts by loading your OpenAPI spec (JSON or YAML) and parsing it to extract every endpoint's method, path, parameters, request body schema, and response schemas. It also pulls out global information like security schemes and base URL. This structured extraction means Claude gets clean, focused data instead of raw spec text.

Endpoints are batched into groups of 10 to stay within context limits and produce focused test files. For each batch, the agent sends the endpoint details plus a summary of the full API to Claude with specific instructions about test framework, assertions, and coverage requirements. Claude generates complete, runnable test files -- not snippets or pseudocode.

The generated tests cover three categories. Happy path tests send valid requests and assert on status codes and response body structure. Edge case tests systematically remove each required field, send invalid types, and test boundary values. Auth tests send requests without credentials and with invalid credentials to verify the API rejects them correctly.

Output can go to stdout for quick review or to a directory with `--output`. For large specs with many endpoints, the agent produces multiple numbered test files (e.g., `test_api_part1.py`, `test_api_part2.py`) to keep each file manageable.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Spec parsing, batching, test generation, and CLI |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Generate Python tests from a JSON spec
python main.py --file openapi.json

# Generate TypeScript tests
python main.py --file openapi.json --language typescript

# Save to a directory
python main.py --file swagger.yaml --output tests/

# Combine options
python main.py --file api-spec.yaml --language typescript --output generated/
```

**Expected output:**

```
🚀 Starting API Test Generator...
🤖 Model: claude-sonnet-4-20250514
📄 Spec: openapi.json
🔧 Language: python

📄 Loading spec: openapi.json
🔍 Found 12 endpoints

API: Pet Store v1.0.0
Total endpoints: 12

Endpoints:
  GET /pets -- List all pets
  POST /pets -- Create a pet
  GET /pets/{petId} -- Get a pet by ID
  ...

🧪 Generating python tests in 2 batch(es)...

🤖 Batch 1/2: GET /pets, POST /pets, GET /pets/{petId}, ...
✅ Generated: test_api_part1.py (4523 chars)
🤖 Batch 2/2: DELETE /pets/{petId}, GET /stores, ...
✅ Generated: test_api_part2.py (3891 chars)

📊 Summary:
   Endpoints processed: 12
   Test files generated: 2
   Approximate test count: 36
   Language: python
✅ Done!
```

## Common Issues & Troubleshooting

**"YAML file detected but PyYAML is not installed"**
- Run `pip install pyyaml` to add YAML support.

**"No endpoints found in the spec"**
- Verify your file is a valid OpenAPI 3.x or Swagger 2.0 spec with a `paths` section.

**Generated tests reference wrong base URL**
- The tests use `os.environ.get("BASE_URL", "http://localhost:3000")` by default. Set the `BASE_URL` environment variable when running the tests.

**Rate limiting on large specs**
- The agent retries once after a 5-second delay. For very large specs (50+ endpoints), consider splitting the spec file.

## Extend This Example

- **Add spec validation** -- use a library like `openapi-spec-validator` to catch spec errors before generation
- **Support GraphQL** -- parse GraphQL schemas and generate query/mutation tests
- **Add test runner integration** -- automatically run the generated tests against a live API
- **Generate mock servers** -- produce a mock server alongside the tests using the response schemas
- **Add coverage tracking** -- compare generated tests against the spec to find untested endpoints

## Related Examples

- [Code Review Agent](../../starter/code-review-agent) -- Reviews code quality, could review the generated tests
- [Coding Agent](../coding-agent) -- Writes and tests code in a plan-code-test loop
- [Eval Runner](../eval-runner) -- Runs evaluations across multiple models
