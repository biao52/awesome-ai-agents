"""
Data Analyst Agent -- Takes a CSV file and natural language questions, writes
Python analysis code, executes it in a sandboxed subprocess, and returns
answers with optional chart generation.

Uses OpenAI for code generation and reasoning.
"""

import os
import sys
import csv
import json
import asyncio
import subprocess
import tempfile
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_RETRIES = 3
MAX_CODE_ATTEMPTS = 3  # How many times the agent can retry failed code
SUBPROCESS_TIMEOUT = 30  # Seconds before killing the analysis subprocess
MAX_ITERATIONS = 15  # Max agent loop iterations

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        print("   Get your OpenAI key at: https://platform.openai.com/api-keys")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# CSV inspection
# ---------------------------------------------------------------------------


def inspect_csv(file_path: str) -> str:
    """Read a CSV file and return a summary for the agent (columns, types, sample rows)."""
    abs_path = os.path.abspath(file_path)
    if not os.path.isfile(abs_path):
        print(f"❌ File not found: {file_path}")
        sys.exit(1)

    try:
        with open(abs_path, "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            rows = list(reader)
    except Exception as e:
        print(f"❌ Could not read CSV: {e}")
        sys.exit(1)

    if len(rows) < 2:
        print("❌ CSV file is empty or has only headers.")
        sys.exit(1)

    headers = rows[0]
    data_rows = rows[1:]
    sample = data_rows[:5]

    # Infer types from first few rows
    col_types: list[str] = []
    for col_idx in range(len(headers)):
        values = [row[col_idx] for row in data_rows[:20] if col_idx < len(row)]
        # Try numeric
        numeric_count = 0
        for v in values:
            try:
                float(v.replace(",", ""))
                numeric_count += 1
            except ValueError:
                pass
        if numeric_count > len(values) * 0.8:
            col_types.append("numeric")
        else:
            col_types.append("string")

    summary = f"CSV File: {os.path.basename(abs_path)}\n"
    summary += f"Rows: {len(data_rows):,}\n"
    summary += f"Columns: {len(headers)}\n\n"
    summary += "Column Details:\n"
    for i, (name, ctype) in enumerate(zip(headers, col_types)):
        summary += f"  {i+1}. {name} ({ctype})\n"
    summary += "\nSample Rows (first 5):\n"
    summary += ",".join(headers) + "\n"
    for row in sample:
        summary += ",".join(row) + "\n"

    return summary


# ---------------------------------------------------------------------------
# Code execution sandbox
# ---------------------------------------------------------------------------


def execute_code(code: str, csv_path: str) -> dict[str, Any]:
    """Execute Python code in a subprocess sandbox. Returns stdout, stderr, and exit code."""
    abs_csv = os.path.abspath(csv_path)

    # Create output directory for charts
    output_dir = os.path.join(os.path.dirname(abs_csv), "..", "output")
    os.makedirs(output_dir, exist_ok=True)
    abs_output = os.path.abspath(output_dir)

    # Prepend CSV path and output dir as variables the generated code can use
    preamble = f"""import warnings
warnings.filterwarnings('ignore')
CSV_PATH = {repr(abs_csv)}
OUTPUT_DIR = {repr(abs_output)}
"""
    full_code = preamble + code

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(full_code)
        script_path = f.name

    try:
        result = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=SUBPROCESS_TIMEOUT,
            cwd=os.path.dirname(abs_csv),
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Error: Code execution timed out after {SUBPROCESS_TIMEOUT} seconds.",
            "exit_code": 1,
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": f"Error running code: {e}",
            "exit_code": 1,
        }
    finally:
        try:
            os.unlink(script_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Agent with tool calling
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_analysis_code",
            "description": (
                "Execute Python code to analyze the CSV data. "
                "The code has access to `CSV_PATH` (path to the CSV file) and `OUTPUT_DIR` (directory to save charts). "
                "Use pandas to read the CSV and matplotlib/seaborn for charts. "
                "Print results to stdout. Save any charts to OUTPUT_DIR. "
                "pandas, matplotlib, and seaborn are available."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "Python code to execute. Use pandas to read CSV_PATH and analyze the data.",
                    },
                },
                "required": ["code"],
            },
        },
    },
]

TOOL_MAP = {"run_analysis_code": None}  # Handled inline


def build_system_prompt(csv_summary: str) -> str:
    """Build the system prompt with CSV context."""
    return f"""You are a data analyst agent. You analyze CSV data by writing and executing Python code.

You have access to a CSV file with this structure:

{csv_summary}

Your process:
1. Understand the user's question about the data
2. Write Python code using pandas to analyze the CSV
3. Use the run_analysis_code tool to execute your code
4. Interpret the results and provide a clear, natural language answer

Rules:
- Always read the CSV using: pd.read_csv(CSV_PATH)
- Print your analysis results to stdout using print()
- For charts: save to OUTPUT_DIR using plt.savefig(f"{{OUTPUT_DIR}}/chart_name.png", dpi=150, bbox_inches='tight')
- Use plt.close() after saving charts to free memory
- Handle edge cases: check for NaN values, handle empty results
- If your code fails, read the error message carefully and fix the issue
- Be precise with numbers: use appropriate rounding, include units
- When done, provide a clear summary of your findings in plain English

Available libraries: pandas, matplotlib, seaborn (pre-installed)"""


async def run_agent(question: str, csv_path: str, model: str) -> str:
    """Run the data analyst agent on a question about the CSV data."""
    client = AsyncOpenAI()
    csv_summary = inspect_csv(csv_path)
    system_prompt = build_system_prompt(csv_summary)

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": question},
    ]

    code_attempts = 0

    for iteration in range(MAX_ITERATIONS):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS,
                temperature=0.2,
            )
        except Exception as e:
            error_str = str(e).lower()
            if "rate" in error_str or "overloaded" in error_str:
                wait = 2 ** (iteration % 3 + 1)
                log("⏳", f"API rate limit, retrying in {wait}s...")
                await asyncio.sleep(wait)
                continue
            raise

        choice = response.choices[0]
        message = choice.message
        messages.append(message.model_dump())

        # If no tool calls, the agent is done
        if not message.tool_calls:
            return message.content or ""

        # Process tool calls
        for tool_call in message.tool_calls:
            fn_name = tool_call.function.name
            fn_args = json.loads(tool_call.function.arguments)

            if fn_name == "run_analysis_code":
                code = fn_args.get("code", "")
                code_attempts += 1
                log("💻", f"Running analysis code (attempt {code_attempts})...")

                result = execute_code(code, csv_path)

                if result["exit_code"] == 0:
                    log("✓", "Code executed successfully")
                    output = result["stdout"]
                    if not output.strip():
                        output = "(Code ran successfully but produced no output)"

                    # Check if any charts were saved
                    output_dir = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(csv_path)), "..", "output"))
                    if os.path.isdir(output_dir):
                        charts = [f for f in os.listdir(output_dir) if f.endswith((".png", ".jpg", ".svg"))]
                        if charts:
                            output += f"\n\nSaved charts: {', '.join(charts)}"
                            log("📊", f"Charts saved: {', '.join(charts)}")

                    result_str = output
                else:
                    error_msg = result["stderr"] or "Unknown error"
                    log("⚠️", f"Code failed: {error_msg[:100]}...")
                    result_str = f"Error:\n{error_msg}"

                    if code_attempts >= MAX_CODE_ATTEMPTS:
                        result_str += f"\n\nYou have used {MAX_CODE_ATTEMPTS} code attempts. Please provide your best answer based on what you know."

                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": result_str,
                })
            else:
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": f"Unknown tool: {fn_name}",
                })

    return "Analysis took too many iterations. Please try a simpler question."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Main entry point for the data analyst agent."""
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    # Parse arguments
    file_path: str | None = None
    question_parts: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--file" and i + 1 < len(args):
            file_path = args[i + 1]
            i += 2
        elif args[i] in ("--help", "-h"):
            print("Usage: python main.py --file <CSV_FILE> [QUESTION]")
            print()
            print("Arguments:")
            print("  --file PATH    Path to the CSV file to analyze")
            print("  QUESTION       Your question about the data (optional, prompts if not given)")
            print()
            print("Examples:")
            print('  python main.py --file ../sample_data/sales.csv "What is the total revenue by region?"')
            print('  python main.py --file ../sample_data/sales.csv "Show me monthly sales trends"')
            print("  python main.py --file ../sample_data/sales.csv   # Interactive mode")
            sys.exit(0)
        else:
            question_parts.append(args[i])
            i += 1

    if not file_path:
        # Check if sample_data exists relative to script
        default_csv = os.path.join(os.path.dirname(__file__), "..", "sample_data", "sales.csv")
        if os.path.isfile(default_csv):
            file_path = default_csv
            log("📂", "Using sample_data/sales.csv")
        else:
            print("❌ Please provide a CSV file with --file <path>")
            sys.exit(1)

    question = " ".join(question_parts) if question_parts else None

    log("🚀", "Starting data analyst agent...")
    log("🤖", f"Model: {model}")
    log("📄", f"CSV: {os.path.basename(file_path)}")

    # Show CSV summary
    summary = inspect_csv(file_path)
    print()
    log("📊", "Data summary:")
    for line in summary.split("\n")[:8]:
        print(f"   {line}")
    print()

    # Interactive loop
    while True:
        if question is None:
            try:
                question = input("❓ Ask a question about the data (or 'quit' to exit): ").strip()
            except (KeyboardInterrupt, EOFError):
                print("\n👋 Goodbye!")
                break

        if not question:
            question = None
            continue
        if question.lower() in ("quit", "exit", "q"):
            print("👋 Goodbye!")
            break

        log("🔍", f"Analyzing: {question}")
        print()

        try:
            answer = await run_agent(question, file_path, model)
        except KeyboardInterrupt:
            print("\n❌ Cancelled.")
            break
        except Exception as e:
            print(f"\n❌ Error: {e}")
            print("   Check your OPENAI_API_KEY and network connection.")
            question = None
            continue

        print()
        print(answer)
        print()

        # Reset for next question (interactive mode)
        if question_parts:
            break  # Was a one-shot question from CLI
        question = None


if __name__ == "__main__":
    asyncio.run(main())
