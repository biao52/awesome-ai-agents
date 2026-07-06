"""
Eval Runner -- Runs evaluations against multiple models and compares results.

Takes a prompt/task and a set of test inputs, runs each input against multiple
models (GPT-4o-mini, Claude Haiku), scores each response using an LLM judge,
and outputs a comparison table with average score, latency, and cost estimates.

Uses both OpenAI and Anthropic SDKs.
"""

import os
import sys
import json
import time
import asyncio
import argparse
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

JUDGE_MODEL = "gpt-4o-mini"

MODEL_CONFIGS: list[dict[str, Any]] = [
    {
        "id": "gpt-4o-mini",
        "provider": "openai",
        "display_name": "GPT-4o Mini",
        "cost_per_1k_input": 0.00015,
        "cost_per_1k_output": 0.0006,
    },
    {
        "id": "claude-haiku-4-5-20251001",
        "provider": "anthropic",
        "display_name": "Claude Haiku 4.5",
        "cost_per_1k_input": 0.0008,
        "cost_per_1k_output": 0.004,
    },
]

DEFAULT_EVAL_DATA: list[dict[str, str]] = [
    {
        "input": "Explain what a closure is in programming, in 2-3 sentences.",
        "criteria": "Should mention: function, enclosing scope/variables, retain access. Should be concise.",
    },
    {
        "input": "What are the three states of water?",
        "criteria": "Must list: solid (ice), liquid (water), gas (steam/vapor). Should be clear and correct.",
    },
    {
        "input": "Write a Python function that checks if a string is a palindrome.",
        "criteria": "Must be valid Python. Should handle basic cases. Function should return a boolean.",
    },
    {
        "input": "Summarize the concept of supply and demand in economics in one paragraph.",
        "criteria": "Should cover: supply, demand, price relationship, equilibrium. Should be accurate and concise.",
    },
    {
        "input": "List 5 best practices for writing secure passwords.",
        "criteria": "Should include practical, accurate advice. Should list exactly 5 items.",
    },
]

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Input loading
# ---------------------------------------------------------------------------


def load_eval_data(file_path: str | None) -> list[dict[str, str]]:
    """Load evaluation data from a JSON file or return defaults."""
    if not file_path:
        log("📋", "Using default evaluation data (5 test cases)")
        return DEFAULT_EVAL_DATA

    if not os.path.isfile(file_path):
        print(f"Input file not found: {file_path}")
        sys.exit(1)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if not isinstance(data, list):
            print("Input file must contain a JSON array.")
            sys.exit(1)

        for i, item in enumerate(data):
            if "input" not in item:
                print(f"Item {i} must have an 'input' field.")
                sys.exit(1)

        log("📋", f"Loaded {len(data)} evaluation inputs from {file_path}")
        return data
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in input file: {e}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Model execution
# ---------------------------------------------------------------------------


async def run_openai(
    client: AsyncOpenAI,
    model_id: str,
    task: str,
    test_input: str,
) -> dict[str, Any]:
    """Run a prompt through an OpenAI model and track latency."""
    start = time.monotonic()
    try:
        response = await client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": task},
                {"role": "user", "content": test_input},
            ],
            temperature=0.3,
            max_tokens=1024,
        )
        elapsed = time.monotonic() - start
        output = (response.choices[0].message.content or "").strip()
        usage = response.usage
        input_tokens = usage.prompt_tokens if usage else 0
        output_tokens = usage.completion_tokens if usage else 0

        return {
            "output": output,
            "latency_ms": round(elapsed * 1000),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "error": None,
        }
    except Exception as e:
        elapsed = time.monotonic() - start
        return {
            "output": "",
            "latency_ms": round(elapsed * 1000),
            "input_tokens": 0,
            "output_tokens": 0,
            "error": str(e),
        }


async def run_anthropic(
    client: AsyncAnthropic,
    model_id: str,
    task: str,
    test_input: str,
) -> dict[str, Any]:
    """Run a prompt through an Anthropic model and track latency."""
    start = time.monotonic()
    try:
        response = await client.messages.create(
            model=model_id,
            max_tokens=1024,
            system=task,
            messages=[{"role": "user", "content": test_input}],
            temperature=0.3,
        )
        elapsed = time.monotonic() - start
        output = ""
        for block in response.content:
            if block.type == "text":
                output += block.text

        return {
            "output": output.strip(),
            "latency_ms": round(elapsed * 1000),
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "error": None,
        }
    except Exception as e:
        elapsed = time.monotonic() - start
        return {
            "output": "",
            "latency_ms": round(elapsed * 1000),
            "input_tokens": 0,
            "output_tokens": 0,
            "error": str(e),
        }


# ---------------------------------------------------------------------------
# LLM Judge
# ---------------------------------------------------------------------------


async def judge_response(
    client: AsyncOpenAI,
    test_input: str,
    criteria: str,
    response_text: str,
) -> dict[str, Any]:
    """Score a model's response using an LLM judge."""
    judge_prompt = """You are a strict but fair evaluation judge. Score the response on a scale of 1-10 based on how well it addresses the input and meets the evaluation criteria.

Scoring guide:
- 9-10: Excellent. Fully addresses the input, meets all criteria, well-written.
- 7-8: Good. Addresses the input well, meets most criteria, minor issues.
- 5-6: Adequate. Partially addresses the input, misses some criteria.
- 3-4: Poor. Significant gaps, multiple criteria missed.
- 1-2: Very poor. Fails to address the input meaningfully.

Respond with ONLY a JSON object: {"score": <int 1-10>, "reason": "<brief 1-2 sentence explanation>"}"""

    judge_input = f"""Input: {test_input}

Evaluation criteria: {criteria}

Response to evaluate:
{response_text}"""

    try:
        response = await client.chat.completions.create(
            model=JUDGE_MODEL,
            messages=[
                {"role": "system", "content": judge_prompt},
                {"role": "user", "content": judge_input},
            ],
            temperature=0.0,
            max_tokens=256,
        )
        result_text = (response.choices[0].message.content or "").strip()

        # Handle markdown code blocks
        if result_text.startswith("```"):
            lines = result_text.split("\n")
            result_text = "\n".join(lines[1:-1])

        parsed = json.loads(result_text)
        return {
            "score": max(1, min(10, int(parsed.get("score", 5)))),
            "reason": str(parsed.get("reason", "No reason given")),
        }
    except (json.JSONDecodeError, ValueError):
        return {"score": 5, "reason": "Judge failed to produce valid JSON"}
    except Exception as e:
        return {"score": 0, "reason": f"Judge error: {e}"}


# ---------------------------------------------------------------------------
# Evaluation pipeline
# ---------------------------------------------------------------------------


async def run_evaluation(
    task: str,
    eval_data: list[dict[str, str]],
    models: list[dict[str, Any]],
) -> dict[str, Any]:
    """Run the full evaluation pipeline."""
    openai_client = AsyncOpenAI()
    anthropic_client = AsyncAnthropic()

    results: dict[str, list[dict[str, Any]]] = {m["id"]: [] for m in models}

    for input_idx, item in enumerate(eval_data):
        test_input = item["input"]
        criteria = item.get("criteria", "Response should be accurate, clear, and complete.")

        log("📝", f"Input {input_idx + 1}/{len(eval_data)}: {test_input[:80]}{'...' if len(test_input) > 80 else ''}")

        for model_config in models:
            model_id = model_config["id"]
            provider = model_config["provider"]
            display_name = model_config["display_name"]

            # Run the model
            if provider == "openai":
                response = await run_openai(openai_client, model_id, task, test_input)
            elif provider == "anthropic":
                response = await run_anthropic(anthropic_client, model_id, task, test_input)
            else:
                response = {"output": "", "latency_ms": 0, "input_tokens": 0, "output_tokens": 0, "error": f"Unknown provider: {provider}"}

            if response["error"]:
                log("❌", f"  {display_name}: Error - {response['error']}")
                judgment = {"score": 0, "reason": f"Error: {response['error']}"}
            else:
                # Judge the response
                judgment = await judge_response(
                    openai_client, test_input, criteria, response["output"],
                )
                output_preview = response["output"][:60].replace("\n", " ")
                if len(response["output"]) > 60:
                    output_preview += "..."
                log("  ", f"  {display_name}: score={judgment['score']}/10, "
                    f"latency={response['latency_ms']}ms -- {output_preview}")

            # Calculate cost
            cost_input = (response["input_tokens"] / 1000) * model_config["cost_per_1k_input"]
            cost_output = (response["output_tokens"] / 1000) * model_config["cost_per_1k_output"]

            results[model_id].append({
                "input": test_input,
                "output": response["output"],
                "score": judgment["score"],
                "reason": judgment["reason"],
                "latency_ms": response["latency_ms"],
                "input_tokens": response["input_tokens"],
                "output_tokens": response["output_tokens"],
                "cost": cost_input + cost_output,
                "error": response["error"],
            })

        print()

    return {
        "task": task,
        "models": models,
        "results": results,
        "eval_data": eval_data,
    }


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def print_comparison_table(eval_results: dict[str, Any]) -> None:
    """Print a comparison table of results across models."""
    models = eval_results["models"]
    results = eval_results["results"]

    print()
    print("=" * 80)
    log("📊", "Evaluation Results")
    print("=" * 80)

    # Header
    print()
    print(f"{'Model':<20} {'Avg Score':>10} {'Avg Latency':>12} {'Total Cost':>12} {'Errors':>8}")
    print("-" * 62)

    model_summaries: list[dict[str, Any]] = []

    for model_config in models:
        model_id = model_config["id"]
        display_name = model_config["display_name"]
        model_results = results[model_id]

        valid_results = [r for r in model_results if not r["error"]]
        error_count = sum(1 for r in model_results if r["error"])

        if valid_results:
            avg_score = sum(r["score"] for r in valid_results) / len(valid_results)
            avg_latency = sum(r["latency_ms"] for r in valid_results) / len(valid_results)
            total_cost = sum(r["cost"] for r in model_results)
        else:
            avg_score = 0.0
            avg_latency = 0.0
            total_cost = 0.0

        model_summaries.append({
            "display_name": display_name,
            "avg_score": avg_score,
            "avg_latency": avg_latency,
            "total_cost": total_cost,
            "error_count": error_count,
        })

        print(f"{display_name:<20} {avg_score:>9.1f}/10 {avg_latency:>10.0f}ms ${total_cost:>10.6f} {error_count:>8}")

    print("-" * 62)

    # Winner
    if model_summaries:
        best = max(model_summaries, key=lambda m: m["avg_score"])
        fastest = min(model_summaries, key=lambda m: m["avg_latency"])
        cheapest = min(model_summaries, key=lambda m: m["total_cost"])

        print()
        log("🏆", f"Highest quality: {best['display_name']} ({best['avg_score']:.1f}/10)")
        log("🚀", f"Fastest: {fastest['display_name']} ({fastest['avg_latency']:.0f}ms avg)")
        log("💰", f"Cheapest: {cheapest['display_name']} (${cheapest['total_cost']:.6f})")

    # Per-input breakdown
    print()
    print("Per-Input Breakdown:")
    print("-" * 80)

    eval_data = eval_results["eval_data"]
    for input_idx, item in enumerate(eval_data):
        input_preview = item["input"][:60]
        if len(item["input"]) > 60:
            input_preview += "..."
        print(f"\n  Input {input_idx + 1}: {input_preview}")

        for model_config in models:
            model_id = model_config["id"]
            display_name = model_config["display_name"]
            result = results[model_id][input_idx]

            if result["error"]:
                print(f"    {display_name:<18} ERROR: {result['error'][:50]}")
            else:
                print(f"    {display_name:<18} Score: {result['score']:>2}/10  "
                      f"Latency: {result['latency_ms']:>5}ms  "
                      f"Reason: {result['reason'][:40]}")


def save_results(eval_results: dict[str, Any], output_path: str) -> None:
    """Save full evaluation results to a JSON file."""
    # Convert to serializable format
    serializable = {
        "task": eval_results["task"],
        "models": eval_results["models"],
        "results": eval_results["results"],
        "summary": {},
    }

    for model_config in eval_results["models"]:
        model_id = model_config["id"]
        model_results = eval_results["results"][model_id]
        valid = [r for r in model_results if not r["error"]]

        serializable["summary"][model_id] = {
            "display_name": model_config["display_name"],
            "avg_score": sum(r["score"] for r in valid) / len(valid) if valid else 0,
            "avg_latency_ms": sum(r["latency_ms"] for r in valid) / len(valid) if valid else 0,
            "total_cost": sum(r["cost"] for r in model_results),
            "error_count": sum(1 for r in model_results if r["error"]),
        }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(serializable, f, indent=2)

    log("💾", f"Full results saved to: {output_path}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Entry point for the eval runner."""
    validate_env()

    parser = argparse.ArgumentParser(
        description="Run evaluations against multiple models and compare results",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python main.py --task "Summarize this text"
  python main.py --task "Answer the question" --inputs eval_data.json
  python main.py  # Uses default task and test cases
  python main.py --task "Explain like I'm 5" --output results.json""",
    )

    parser.add_argument(
        "--task",
        default="You are a helpful assistant. Answer the question or complete the task clearly and concisely.",
        help="System prompt / task description for the models",
    )
    parser.add_argument(
        "--inputs",
        default=None,
        help="Path to JSON file with evaluation inputs [{input, criteria?}, ...]",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Path to save full results as JSON",
    )

    args = parser.parse_args()

    # Load eval data
    eval_data = load_eval_data(args.inputs)

    log("🚀", "Starting Eval Runner...")
    log("🤖", f"Models: {', '.join(m['display_name'] for m in MODEL_CONFIGS)}")
    log("🧑\u200d⚖️", f"Judge: {JUDGE_MODEL}")
    log("📝", f"Task: {args.task[:80]}{'...' if len(args.task) > 80 else ''}")
    log("🧪", f"Inputs: {len(eval_data)}")
    print()

    try:
        eval_results = await run_evaluation(
            task=args.task,
            eval_data=eval_data,
            models=MODEL_CONFIGS,
        )

        print_comparison_table(eval_results)

        if args.output:
            save_results(eval_results, args.output)

    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)

    print()
    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
