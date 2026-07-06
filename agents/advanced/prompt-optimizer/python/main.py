"""
Prompt Optimizer -- Iteratively improves a prompt based on test cases.

Takes an initial prompt and a set of test cases (input/expected output pairs),
runs the prompt against each test case, scores results using an LLM judge,
analyzes failures, and generates an improved prompt. Repeats until the score
threshold is met or max rounds are reached.

Uses OpenAI GPT-4o-mini for both execution and judging.
"""

import os
import sys
import json
import asyncio
import argparse
from typing import Any

from dotenv import load_dotenv
from openai import AsyncOpenAI

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "gpt-4o-mini"
MAX_ROUNDS = 5
SCORE_THRESHOLD = 0.9  # Stop if average score >= 90%
DEFAULT_TEST_CASES: list[dict[str, str]] = [
    {
        "input": "I love this product! Best purchase ever.",
        "expected": "positive",
    },
    {
        "input": "Terrible quality. Broke after one day.",
        "expected": "negative",
    },
    {
        "input": "It's okay, nothing special.",
        "expected": "neutral",
    },
    {
        "input": "Absolutely fantastic, exceeded all expectations!",
        "expected": "positive",
    },
    {
        "input": "Worst customer service I've ever experienced.",
        "expected": "negative",
    },
    {
        "input": "The product arrived on time and works as described.",
        "expected": "neutral",
    },
    {
        "input": "Not worth the money. Very disappointed.",
        "expected": "negative",
    },
    {
        "input": "Five stars! Will buy again.",
        "expected": "positive",
    },
]

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    """Validate required environment variables are set."""
    required = ["OPENAI_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    """Print a status message with emoji prefix."""
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Test case loading
# ---------------------------------------------------------------------------


def load_test_cases(file_path: str | None) -> list[dict[str, str]]:
    """Load test cases from a JSON file or return defaults."""
    if not file_path:
        log("📋", "Using default test cases (sentiment classification)")
        return DEFAULT_TEST_CASES

    if not os.path.isfile(file_path):
        print(f"Test cases file not found: {file_path}")
        sys.exit(1)

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            cases = json.load(f)

        if not isinstance(cases, list):
            print("Test cases file must contain a JSON array.")
            sys.exit(1)

        for i, case in enumerate(cases):
            if "input" not in case or "expected" not in case:
                print(f"Test case {i} must have 'input' and 'expected' fields.")
                sys.exit(1)

        log("📋", f"Loaded {len(cases)} test cases from {file_path}")
        return cases
    except json.JSONDecodeError as e:
        print(f"Invalid JSON in test cases file: {e}")
        sys.exit(1)


def load_prompt(prompt_arg: str | None, prompt_file: str | None) -> str:
    """Load the initial prompt from argument or file."""
    if prompt_arg:
        return prompt_arg

    if prompt_file:
        if not os.path.isfile(prompt_file):
            print(f"Prompt file not found: {prompt_file}")
            sys.exit(1)
        with open(prompt_file, "r", encoding="utf-8") as f:
            return f.read().strip()

    # Default prompt for sentiment classification
    return "Classify the sentiment of the following text as positive, negative, or neutral. Respond with only one word."


# ---------------------------------------------------------------------------
# LLM execution
# ---------------------------------------------------------------------------


async def run_prompt(
    client: AsyncOpenAI,
    model: str,
    prompt: str,
    test_input: str,
) -> str:
    """Run a prompt against a single test input."""
    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": test_input},
            ],
            temperature=0.0,
            max_tokens=256,
        )
        return (response.choices[0].message.content or "").strip()
    except Exception as e:
        return f"[ERROR: {e}]"


async def judge_result(
    client: AsyncOpenAI,
    model: str,
    test_input: str,
    expected: str,
    actual: str,
) -> dict[str, Any]:
    """Use an LLM judge to score a result on a 0-1 scale."""
    judge_prompt = """You are a strict evaluation judge. Score how well the actual output matches the expected output.

Consider:
1. Exact match: If the actual output exactly matches the expected, score 1.0
2. Semantic match: If the meaning is equivalent but wording differs, score 0.8-0.9
3. Partial match: If the output is partially correct, score 0.3-0.7
4. Wrong: If the output is incorrect, score 0.0-0.2

Respond with ONLY a JSON object: {"score": <float 0-1>, "reason": "<brief explanation>"}"""

    judge_input = f"""Input: {test_input}
Expected output: {expected}
Actual output: {actual}"""

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": judge_prompt},
                {"role": "user", "content": judge_input},
            ],
            temperature=0.0,
            max_tokens=256,
        )
        result_text = (response.choices[0].message.content or "").strip()

        # Parse JSON from response
        # Handle potential markdown code blocks
        if result_text.startswith("```"):
            lines = result_text.split("\n")
            result_text = "\n".join(lines[1:-1])

        parsed = json.loads(result_text)
        return {
            "score": float(parsed.get("score", 0.0)),
            "reason": str(parsed.get("reason", "No reason given")),
        }
    except (json.JSONDecodeError, ValueError, KeyError):
        # Fallback: exact match check
        is_match = expected.lower().strip() == actual.lower().strip()
        return {
            "score": 1.0 if is_match else 0.0,
            "reason": "Exact match" if is_match else "No match (judge parsing failed)",
        }
    except Exception as e:
        return {"score": 0.0, "reason": f"Judge error: {e}"}


# ---------------------------------------------------------------------------
# Prompt improvement
# ---------------------------------------------------------------------------


async def generate_improved_prompt(
    client: AsyncOpenAI,
    model: str,
    current_prompt: str,
    test_results: list[dict[str, Any]],
    round_num: int,
) -> str:
    """Analyze failures and generate an improved prompt."""
    failures = [r for r in test_results if r["score"] < 0.8]
    successes = [r for r in test_results if r["score"] >= 0.8]

    analysis_prompt = """You are a prompt engineering expert. Analyze the test results below and generate an improved version of the prompt.

Rules:
- Focus on fixing the failures while keeping the successes working
- Be specific and explicit in your instructions
- Add examples if the current prompt lacks them
- Clarify edge cases that caused failures
- Keep the prompt concise -- don't add unnecessary verbosity
- Return ONLY the improved prompt text, nothing else (no quotes, no explanation, no markdown)"""

    results_text = f"""## Current Prompt (Round {round_num})
{current_prompt}

## Results
Average score: {sum(r['score'] for r in test_results) / len(test_results):.2%}
Successes: {len(successes)}/{len(test_results)}
Failures: {len(failures)}/{len(test_results)}

## Failure Details"""

    for r in failures:
        results_text += f"""
- Input: {r['input']}
  Expected: {r['expected']}
  Actual: {r['actual']}
  Score: {r['score']:.2f}
  Reason: {r['reason']}"""

    results_text += "\n\n## Success Examples"
    for r in successes[:3]:
        results_text += f"""
- Input: {r['input']}
  Expected: {r['expected']}
  Actual: {r['actual']}"""

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": analysis_prompt},
                {"role": "user", "content": results_text},
            ],
            temperature=0.3,
            max_tokens=1024,
        )
        improved = (response.choices[0].message.content or "").strip()
        # Strip any surrounding quotes the model might add
        if improved.startswith('"') and improved.endswith('"'):
            improved = improved[1:-1]
        return improved
    except Exception as e:
        log("⚠️", f"Failed to generate improved prompt: {e}")
        return current_prompt


# ---------------------------------------------------------------------------
# Optimization loop
# ---------------------------------------------------------------------------


async def run_optimization(
    initial_prompt: str,
    test_cases: list[dict[str, str]],
    model: str,
    max_rounds: int,
    threshold: float,
) -> dict[str, Any]:
    """Run the iterative optimization loop."""
    client = AsyncOpenAI()
    current_prompt = initial_prompt
    score_history: list[dict[str, Any]] = []

    for round_num in range(1, max_rounds + 1):
        log("🔄", f"Round {round_num}/{max_rounds}")
        log("📝", f"Current prompt: {current_prompt[:100]}{'...' if len(current_prompt) > 100 else ''}")
        print()

        # Run prompt against all test cases
        test_results: list[dict[str, Any]] = []
        for i, case in enumerate(test_cases):
            actual = await run_prompt(client, model, current_prompt, case["input"])
            judgment = await judge_result(
                client, model, case["input"], case["expected"], actual,
            )

            result = {
                "input": case["input"],
                "expected": case["expected"],
                "actual": actual,
                "score": judgment["score"],
                "reason": judgment["reason"],
            }
            test_results.append(result)

            # Show result
            status = "pass" if judgment["score"] >= 0.8 else "FAIL"
            icon = "✅" if status == "pass" else "❌"
            print(f"   {icon} [{i + 1}/{len(test_cases)}] "
                  f"Expected: {case['expected']:10s} | Got: {actual:20s} | "
                  f"Score: {judgment['score']:.2f}")

        # Calculate average score
        avg_score = sum(r["score"] for r in test_results) / len(test_results)
        pass_count = sum(1 for r in test_results if r["score"] >= 0.8)

        round_result = {
            "round": round_num,
            "prompt": current_prompt,
            "avg_score": avg_score,
            "pass_count": pass_count,
            "total_count": len(test_cases),
            "results": test_results,
        }
        score_history.append(round_result)

        print()
        log("📊", f"Round {round_num} score: {avg_score:.2%} ({pass_count}/{len(test_cases)} passed)")

        # Check if threshold is met
        if avg_score >= threshold:
            log("🎯", f"Score threshold met ({avg_score:.2%} >= {threshold:.2%}). Stopping.")
            break

        # Check if this is the last round
        if round_num == max_rounds:
            log("⏰", f"Max rounds reached ({max_rounds}).")
            break

        # Generate improved prompt
        log("🧠", "Analyzing failures and generating improved prompt...")
        improved_prompt = await generate_improved_prompt(
            client, model, current_prompt, test_results, round_num,
        )

        if improved_prompt == current_prompt:
            log("⚠️", "Prompt unchanged. Stopping early.")
            break

        current_prompt = improved_prompt
        print()

    return {
        "final_prompt": current_prompt,
        "score_history": score_history,
        "total_rounds": len(score_history),
    }


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def print_results(results: dict[str, Any]) -> None:
    """Print the optimization results in a readable format."""
    print()
    print("=" * 60)
    log("📊", "Optimization Results")
    print("=" * 60)

    # Score history
    print()
    print("Score History:")
    for entry in results["score_history"]:
        bar_len = int(entry["avg_score"] * 30)
        bar = "#" * bar_len + "-" * (30 - bar_len)
        print(f"  Round {entry['round']}: [{bar}] {entry['avg_score']:.2%} "
              f"({entry['pass_count']}/{entry['total_count']})")

    # Improvement
    first_score = results["score_history"][0]["avg_score"]
    last_score = results["score_history"][-1]["avg_score"]
    improvement = last_score - first_score

    print()
    if improvement > 0:
        log("📈", f"Improvement: {first_score:.2%} --> {last_score:.2%} (+{improvement:.2%})")
    elif improvement == 0:
        log("➡️", f"No change: {first_score:.2%}")
    else:
        log("📉", f"Regression: {first_score:.2%} --> {last_score:.2%} ({improvement:.2%})")

    # Final prompt
    print()
    print("Final Optimized Prompt:")
    print("-" * 40)
    print(results["final_prompt"])
    print("-" * 40)
    print()
    log("💡", f"Total rounds: {results['total_rounds']}")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    """Entry point for the prompt optimizer."""
    validate_env()

    parser = argparse.ArgumentParser(
        description="Iteratively optimize a prompt using test cases and LLM judging",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Examples:
  python main.py --prompt "Classify sentiment" --tests test_cases.json
  python main.py --prompt-file my_prompt.txt --tests cases.json
  python main.py  # Uses default sentiment classification task
  python main.py --prompt "Summarize in one sentence" --tests summarization_tests.json --rounds 3""",
    )

    parser.add_argument(
        "--prompt",
        default=None,
        help="Initial prompt text (inline)",
    )
    parser.add_argument(
        "--prompt-file",
        default=None,
        help="Path to a file containing the initial prompt",
    )
    parser.add_argument(
        "--tests",
        default=None,
        help="Path to a JSON file with test cases [{input, expected}, ...]",
    )
    parser.add_argument(
        "--rounds",
        type=int,
        default=MAX_ROUNDS,
        help=f"Maximum optimization rounds (default: {MAX_ROUNDS})",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=SCORE_THRESHOLD,
        help=f"Score threshold to stop early (default: {SCORE_THRESHOLD})",
    )

    args = parser.parse_args()
    model = os.getenv("MODEL", DEFAULT_MODEL)

    # Load prompt and test cases
    initial_prompt = load_prompt(args.prompt, args.prompt_file)
    test_cases = load_test_cases(args.tests)

    log("🚀", "Starting Prompt Optimizer...")
    log("🤖", f"Model: {model}")
    log("📝", f"Initial prompt: {initial_prompt[:80]}{'...' if len(initial_prompt) > 80 else ''}")
    log("🧪", f"Test cases: {len(test_cases)}")
    log("🔄", f"Max rounds: {args.rounds}")
    log("🎯", f"Score threshold: {args.threshold:.0%}")
    print()

    try:
        results = await run_optimization(
            initial_prompt=initial_prompt,
            test_cases=test_cases,
            model=model,
            max_rounds=args.rounds,
            threshold=args.threshold,
        )
        print_results(results)
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\nError: {e}")
        sys.exit(1)

    log("✅", "Done!")


if __name__ == "__main__":
    asyncio.run(main())
