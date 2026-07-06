"""
API Test Generator -- Reads an OpenAPI/Swagger spec and generates a comprehensive
test suite with happy path, edge case, and auth tests.

Uses Anthropic Claude to analyze endpoints and generate test code.
"""

import os
import sys
import json
import asyncio
import argparse
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_ENDPOINTS_PER_BATCH = 10

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# OpenAPI spec parsing
# ---------------------------------------------------------------------------


def load_spec(file_path: str) -> dict[str, Any]:
    """Load an OpenAPI spec from a JSON or YAML file."""
    if not os.path.isfile(file_path):
        print(f"File not found: {file_path}")
        sys.exit(1)

    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Try JSON first
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        pass

    # Try YAML
    try:
        import yaml
        return yaml.safe_load(content)
    except ImportError:
        print("YAML file detected but PyYAML is not installed.")
        print("Install it with: pip install pyyaml")
        sys.exit(1)
    except Exception as e:
        print(f"Failed to parse spec file: {e}")
        sys.exit(1)


def extract_endpoints(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract endpoint details from an OpenAPI spec."""
    endpoints: list[dict[str, Any]] = []
    paths = spec.get("paths", {})
    base_url = ""

    # Extract base URL from servers or host
    servers = spec.get("servers", [])
    if servers:
        base_url = servers[0].get("url", "")
    elif "host" in spec:
        scheme = spec.get("schemes", ["https"])[0]
        base_path = spec.get("basePath", "")
        base_url = f"{scheme}://{spec['host']}{base_path}"

    # Extract security schemes
    security_schemes = {}
    components = spec.get("components", spec.get("securityDefinitions", {}))
    if isinstance(components, dict):
        security_schemes = components.get("securitySchemes",
                                          components.get("securityDefinitions", {}))

    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        for method, details in methods.items():
            if method.lower() in ("get", "post", "put", "patch", "delete", "head", "options"):
                if not isinstance(details, dict):
                    continue

                endpoint: dict[str, Any] = {
                    "path": path,
                    "method": method.upper(),
                    "summary": details.get("summary", ""),
                    "description": details.get("description", ""),
                    "operation_id": details.get("operationId", ""),
                    "parameters": [],
                    "request_body": None,
                    "responses": {},
                    "security": details.get("security", spec.get("security", [])),
                }

                # Extract parameters
                params = details.get("parameters", [])
                # Include path-level parameters
                path_params = methods.get("parameters", [])
                if isinstance(path_params, list):
                    params = path_params + params

                for param in params:
                    if isinstance(param, dict):
                        # Handle $ref (simplified -- just note it)
                        if "$ref" in param:
                            endpoint["parameters"].append({
                                "name": param["$ref"].split("/")[-1],
                                "in": "unknown",
                                "required": False,
                                "schema": {"type": "string"},
                            })
                        else:
                            endpoint["parameters"].append({
                                "name": param.get("name", ""),
                                "in": param.get("in", "query"),
                                "required": param.get("required", False),
                                "schema": param.get("schema", {"type": "string"}),
                                "description": param.get("description", ""),
                            })

                # Extract request body
                request_body = details.get("requestBody", {})
                if isinstance(request_body, dict):
                    content = request_body.get("content", {})
                    json_content = content.get("application/json", {})
                    if json_content:
                        endpoint["request_body"] = {
                            "required": request_body.get("required", False),
                            "schema": json_content.get("schema", {}),
                        }

                # Extract responses
                responses = details.get("responses", {})
                for status_code, response in responses.items():
                    if isinstance(response, dict):
                        resp_content = response.get("content", {})
                        json_resp = resp_content.get("application/json", {})
                        endpoint["responses"][str(status_code)] = {
                            "description": response.get("description", ""),
                            "schema": json_resp.get("schema", {}),
                        }

                endpoints.append(endpoint)

    return endpoints


def get_spec_summary(spec: dict[str, Any], endpoints: list[dict[str, Any]]) -> str:
    """Create a human-readable summary of the spec."""
    info = spec.get("info", {})
    title = info.get("title", "Unknown API")
    version = info.get("version", "unknown")
    description = info.get("description", "")

    lines = [
        f"API: {title} v{version}",
        f"Description: {description}" if description else "",
        f"Total endpoints: {len(endpoints)}",
        "",
        "Endpoints:",
    ]

    for ep in endpoints:
        params_str = ", ".join(
            f"{p['name']}({'required' if p.get('required') else 'optional'})"
            for p in ep["parameters"]
        )
        body_str = " [has request body]" if ep["request_body"] else ""
        lines.append(f"  {ep['method']} {ep['path']} -- {ep['summary'] or 'No summary'}")
        if params_str:
            lines.append(f"    Params: {params_str}")
        if body_str:
            lines.append(f"    {body_str.strip()}")

    return "\n".join(line for line in lines if line is not None)


# ---------------------------------------------------------------------------
# Test generation via Claude
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an expert test engineer. You generate comprehensive API test suites
from OpenAPI specifications. Your tests are production-grade and cover:

1. **Happy path tests**: Valid requests that should succeed (2xx responses)
2. **Edge case tests**: Missing required fields, invalid types, boundary values, empty strings
3. **Auth tests**: Requests without credentials, with invalid credentials

Rules:
- Generate complete, runnable test files with no placeholders or TODOs
- Use the exact endpoints, methods, and parameter schemas from the spec
- Include descriptive test names that explain what is being tested
- Add comments explaining the test strategy for each endpoint
- Use environment variables for base URL and API keys (never hardcode)
- Group tests by endpoint
- Include setup/teardown where appropriate
- Handle both JSON request bodies and query parameters correctly
- Test response status codes AND response body structure where schemas are provided
- For edge cases, test each required field being missing individually"""


async def generate_tests_for_batch(
    client: AsyncAnthropic,
    model: str,
    language: str,
    endpoints: list[dict[str, Any]],
    spec_summary: str,
    batch_index: int,
) -> str:
    """Generate test code for a batch of endpoints."""
    endpoints_json = json.dumps(endpoints, indent=2, default=str)

    if language == "python":
        framework_instructions = """Generate Python tests using pytest and httpx.

Structure:
- Use pytest fixtures for base_url and auth headers
- Use httpx.AsyncClient for requests
- Use @pytest.mark.asyncio for async tests
- Group tests in classes by endpoint (e.g., class TestGetUsers, class TestCreateUser)
- Use os.environ.get("BASE_URL", "http://localhost:3000") for the base URL
- Use os.environ.get("API_KEY", "test-key") for auth tokens

Required imports: pytest, httpx, os, json"""
    else:
        framework_instructions = """Generate TypeScript tests using vitest and fetch.

Structure:
- Use describe blocks grouped by endpoint
- Use native fetch for HTTP requests
- Use process.env.BASE_URL || "http://localhost:3000" for the base URL
- Use process.env.API_KEY || "test-key" for auth tokens
- Use expect() assertions from vitest

Required imports: { describe, it, expect } from 'vitest'"""

    prompt = f"""Generate a test suite for the following API endpoints.

## API Overview
{spec_summary}

## Endpoints to Test (batch {batch_index + 1})
{endpoints_json}

## Instructions
{framework_instructions}

Generate the complete test file now. Include all happy path, edge case, and auth tests."""

    response = await client.messages.create(
        model=model,
        max_tokens=8192,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
    )

    # Extract code from response
    text = ""
    for block in response.content:
        if block.type == "text":
            text += block.text

    # Try to extract code block
    code = extract_code_block(text, language)
    return code


def extract_code_block(text: str, language: str) -> str:
    """Extract the code block from the model's response."""
    lang_tag = "python" if language == "python" else "typescript"

    # Look for fenced code blocks
    markers = [f"```{lang_tag}", "```"]
    for marker in markers:
        if marker in text:
            parts = text.split(marker)
            if len(parts) >= 2:
                code_part = parts[1]
                # Find the closing ```
                if "```" in code_part:
                    code_part = code_part.split("```")[0]
                return code_part.strip()

    # If no code block found, return the whole text (model might have returned raw code)
    return text.strip()


# ---------------------------------------------------------------------------
# Output handling
# ---------------------------------------------------------------------------


def get_output_filename(language: str, batch_index: int, total_batches: int) -> str:
    """Generate the output filename for a test batch."""
    if total_batches == 1:
        if language == "python":
            return "test_api.py"
        return "test_api.test.ts"
    else:
        if language == "python":
            return f"test_api_part{batch_index + 1}.py"
        return f"test_api_part{batch_index + 1}.test.ts"


def save_tests(code: str, output_dir: str, filename: str) -> str:
    """Save generated test code to a file."""
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(code)
    return filepath


# ---------------------------------------------------------------------------
# Main agent logic
# ---------------------------------------------------------------------------


async def run_generator(
    spec_path: str,
    language: str,
    output_dir: str | None,
    model: str,
) -> None:
    """Run the test generation pipeline."""
    client = AsyncAnthropic()

    # Step 1: Load and parse spec
    log("📄", f"Loading spec: {spec_path}")
    spec = load_spec(spec_path)
    endpoints = extract_endpoints(spec)

    if not endpoints:
        print("No endpoints found in the spec. Check that the file is a valid OpenAPI/Swagger spec.")
        sys.exit(1)

    log("🔍", f"Found {len(endpoints)} endpoints")
    spec_summary = get_spec_summary(spec, endpoints)
    print()
    print(spec_summary)
    print()

    # Step 2: Batch endpoints
    batches: list[list[dict[str, Any]]] = []
    for i in range(0, len(endpoints), MAX_ENDPOINTS_PER_BATCH):
        batches.append(endpoints[i:i + MAX_ENDPOINTS_PER_BATCH])

    log("🧪", f"Generating {language} tests in {len(batches)} batch(es)...")
    print()

    # Step 3: Generate tests for each batch
    all_results: list[tuple[str, str]] = []
    for batch_index, batch in enumerate(batches):
        endpoint_names = [f"{ep['method']} {ep['path']}" for ep in batch]
        log("🤖", f"Batch {batch_index + 1}/{len(batches)}: {', '.join(endpoint_names[:5])}"
            + (f" (+{len(endpoint_names) - 5} more)" if len(endpoint_names) > 5 else ""))

        try:
            code = await generate_tests_for_batch(
                client=client,
                model=model,
                language=language,
                endpoints=batch,
                spec_summary=spec_summary,
                batch_index=batch_index,
            )

            filename = get_output_filename(language, batch_index, len(batches))
            all_results.append((filename, code))
            log("✅", f"Generated: {filename} ({len(code)} chars)")

        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "overloaded" in error_str:
                log("warning", f"Rate limited on batch {batch_index + 1}, retrying in 5s...")
                await asyncio.sleep(5)
                try:
                    code = await generate_tests_for_batch(
                        client=client,
                        model=model,
                        language=language,
                        endpoints=batch,
                        spec_summary=spec_summary,
                        batch_index=batch_index,
                    )
                    filename = get_output_filename(language, batch_index, len(batches))
                    all_results.append((filename, code))
                    log("✅", f"Generated on retry: {filename}")
                except Exception as retry_err:
                    log("error", f"Failed batch {batch_index + 1}: {retry_err}")
            else:
                log("error", f"Failed batch {batch_index + 1}: {e}")

    # Step 4: Output results
    if not all_results:
        print("\nNo tests were generated. Check your API key and try again.")
        sys.exit(1)

    print()
    if output_dir:
        log("💾", f"Saving tests to: {output_dir}")
        for filename, code in all_results:
            filepath = save_tests(code, output_dir, filename)
            log("📁", f"  Saved: {filepath}")
    else:
        for filename, code in all_results:
            print(f"\n{'=' * 60}")
            print(f"File: {filename}")
            print("=" * 60)
            print(code)
            print()

    # Summary
    total_tests = sum(
        code.count("def test_") if language == "python" else code.count("it(")
        for _, code in all_results
    )
    print()
    log("📊", "Summary:")
    log("  ", f"Endpoints processed: {len(endpoints)}")
    log("  ", f"Test files generated: {len(all_results)}")
    log("  ", f"Approximate test count: {total_tests}")
    log("  ", f"Language: {language}")
    if output_dir:
        log("  ", f"Output directory: {os.path.abspath(output_dir)}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Entry point for the API test generator."""
    validate_env()

    parser = argparse.ArgumentParser(
        description="Generate API test suites from OpenAPI/Swagger specs",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python main.py --file openapi.json
  python main.py --file swagger.yaml --language typescript
  python main.py --file api-spec.json --output tests/
  python main.py --file spec.yaml --language python --output generated_tests/""",
    )

    parser.add_argument(
        "--file",
        required=True,
        help="Path to the OpenAPI/Swagger spec file (JSON or YAML)",
    )
    parser.add_argument(
        "--language",
        choices=["python", "typescript"],
        default="python",
        help="Language for generated tests (default: python)",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Directory to save generated test files (prints to stdout if not set)",
    )

    args = parser.parse_args()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    log("🚀", "Starting API Test Generator...")
    log("🤖", f"Model: {model}")
    log("📄", f"Spec: {args.file}")
    log("🔧", f"Language: {args.language}")
    if args.output:
        log("💾", f"Output: {args.output}")
    print()

    try:
        await run_generator(
            spec_path=args.file,
            language=args.language,
            output_dir=args.output,
            model=model,
        )
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)

    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
