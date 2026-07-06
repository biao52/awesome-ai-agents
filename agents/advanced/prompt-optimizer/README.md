# Prompt Optimizer

> An agent that iteratively improves a prompt by running it against test cases, scoring results with an LLM judge, and generating refined versions until a quality threshold is met.

## What You'll Learn

- How to implement an LLM-as-judge evaluation pattern
- How to build iterative optimization loops with convergence criteria
- How to score outputs using semantic similarity (not just exact match)
- How to analyze failure patterns and generate targeted improvements
- How to structure test cases for prompt evaluation

## Architecture

```
User provides: initial prompt + test cases (input/expected pairs)
    |
Optimization Loop (max 5 rounds):
    |
    +--> Run prompt against all test cases
    |       --> LLM generates response for each input
    |
    +--> Score each result with LLM judge
    |       --> Score 0-1 (exact match, semantic match, partial, wrong)
    |
    +--> Calculate average score
    |       --> If >= threshold (90%): stop, we're done
    |
    +--> Analyze failures
    |       --> Feed failures + successes to prompt engineer LLM
    |       --> Generate improved prompt
    |
    +--> Repeat with improved prompt
    |
Output: Optimized prompt + score history per round
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.01-0.05 per optimization run (gpt-4o-mini is very cheap)

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

4. Open `.env` and add your OpenAI API key.

5. Run with default sentiment classification task:
   ```bash
   python main.py
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

4. Open `.env` and add your OpenAI API key.

5. Run with default sentiment classification task:
   ```bash
   npx tsx index.ts
   ```

## How It Works

The optimizer runs a tight feedback loop: execute, evaluate, improve, repeat. Each round tests the current prompt against every test case, scores the results, and -- if the score is below the threshold -- generates an improved prompt based on the failure analysis.

Scoring uses an **LLM-as-judge** pattern instead of simple string matching. The judge LLM receives the input, expected output, and actual output, then assigns a score from 0 to 1. This handles cases where the output is semantically correct but uses different wording (e.g., "Positive" vs "positive" vs "The sentiment is positive"). The judge falls back to exact string matching if it fails to produce valid JSON.

The improvement step is where the real optimization happens. The optimizer sends the current prompt, all failures with their details, and a sample of successes to a prompt engineering LLM. This LLM analyzes what went wrong, identifies patterns in the failures, and generates a revised prompt. It might add examples, clarify edge cases, or restructure the instructions.

The loop stops when either the average score meets the threshold (default 90%) or the maximum number of rounds is reached (default 5). If the improved prompt is identical to the current one, the optimizer also stops early to avoid wasted API calls.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the model for execution and judging |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Optimization loop, LLM judge, prompt improvement, and CLI |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Use default sentiment classification task (built-in test cases)
python main.py

# Custom prompt with custom test cases
python main.py --prompt "Classify sentiment" --tests test_cases.json

# Load prompt from a file
python main.py --prompt-file my_prompt.txt --tests cases.json

# Customize optimization parameters
python main.py --rounds 3 --threshold 0.95
```

**Test cases JSON format:**
```json
[
  {"input": "I love this!", "expected": "positive"},
  {"input": "Terrible.", "expected": "negative"},
  {"input": "It's fine.", "expected": "neutral"}
]
```

**Expected output:**

```
🚀 Starting Prompt Optimizer...
🤖 Model: gpt-4o-mini
📝 Initial prompt: Classify the sentiment of the following text as positive, negative, or...
🧪 Test cases: 8
🔄 Max rounds: 5
🎯 Score threshold: 90%

🔄 Round 1/5
📝 Current prompt: Classify the sentiment...

   ✅ [1/8] Expected: positive   | Got: positive             | Score: 1.00
   ✅ [2/8] Expected: negative   | Got: negative             | Score: 1.00
   ❌ [3/8] Expected: neutral    | Got: positive             | Score: 0.00
   ...

📊 Round 1 score: 75.0% (6/8 passed)
🧠 Analyzing failures and generating improved prompt...

🔄 Round 2/5
📝 Current prompt: Classify the sentiment... (improved version)
   ...

📊 Round 2 score: 93.8% (8/8 passed)
🎯 Score threshold met (93.8% >= 90.0%). Stopping.

============================================================
📊 Optimization Results
============================================================

Score History:
  Round 1: [######################--------] 75.0% (6/8)
  Round 2: [############################--] 93.8% (8/8)

📈 Improvement: 75.0% --> 93.8% (+18.8%)

Final Optimized Prompt:
----------------------------------------
Classify the sentiment of the following text...
----------------------------------------

✅ Done!
```

## Common Issues & Troubleshooting

**Scores are inconsistent between runs**
- The judge uses temperature 0, but LLMs are not perfectly deterministic. Small score variations are normal.

**Prompt gets worse after optimization**
- This can happen if the improved prompt overfits to failure cases and breaks successes. Try adding more diverse test cases.

**"Judge parsing failed" fallback messages**
- The judge occasionally returns text instead of JSON. The fallback to exact match is intentional and safe.

**Optimization converges immediately**
- Your initial prompt might already be good. Try lowering the threshold or adding harder test cases.

## Extend This Example

- **Add multiple judge models** -- use a panel of judges and average their scores for more robust evaluation
- **Support custom scoring functions** -- allow users to define scoring logic (regex, contains, custom code)
- **Track prompt diffs** -- show what changed between each round's prompt
- **Add A/B testing** -- generate multiple improved prompts per round and pick the best one
- **Export results** -- save full optimization history to JSON for analysis

## Related Examples

- [Eval Runner](../eval-runner) -- Runs evaluations across multiple models and compares results
- [Research Agent](../../starter/research-agent) -- Uses structured prompts for multi-step research
- [Deep Research Agent](../deep-research-agent) -- Advanced prompt strategies for research tasks
