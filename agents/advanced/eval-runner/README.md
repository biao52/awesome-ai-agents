# Eval Runner

> An agent that runs evaluations against multiple models (GPT-4o-mini, Claude Haiku) and compares results with quality scores, latency, and cost estimates.

## What You'll Learn

- How to build a model evaluation framework that tests across providers
- How to implement an LLM-as-judge scoring pattern for quality assessment
- How to track and compare latency, token usage, and cost across models
- How to work with both OpenAI and Anthropic SDKs in the same application
- How to structure evaluation data with scoring criteria

## Architecture

```
User provides: task description + evaluation inputs
    |
For each input:
    |
    +--> Run against GPT-4o-mini (OpenAI SDK)
    |       --> Track output, latency, token usage
    |
    +--> Run against Claude Haiku 4.5 (Anthropic SDK)
    |       --> Track output, latency, token usage
    |
    +--> Score each response with LLM judge (GPT-4o-mini)
    |       --> Score 1-10 with reasoning
    |
Aggregate results
    |
Output: Comparison table
    --> Model | Avg Score | Avg Latency | Total Cost | Errors
    --> Winner by quality, speed, and cost
    --> Per-input breakdown
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Estimated cost:** ~$0.02-0.08 per evaluation run (depends on number of inputs)

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

4. Open `.env` and add both API keys.

5. Run with default evaluation data:
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

4. Open `.env` and add both API keys.

5. Run with default evaluation data:
   ```bash
   npx tsx index.ts
   ```

## How It Works

The eval runner sends the same task and inputs to multiple models, then uses an LLM judge to score each response on a 1-10 scale. This gives you an apples-to-apples comparison of quality, speed, and cost across providers.

Each model is called through its native SDK (OpenAI SDK for GPT models, Anthropic SDK for Claude models). The runner tracks wall-clock latency with high-resolution timers and records token usage from each API response. Cost is calculated using the model's published per-token pricing.

The **LLM judge** receives the original input, evaluation criteria, and the model's response, then assigns a score from 1-10 with a brief explanation. Using GPT-4o-mini as the judge keeps evaluation costs low while providing reasonable scoring consistency. The judge uses temperature 0 for reproducibility.

Results are presented in a comparison table showing average score, average latency, total cost, and error count for each model. The runner also identifies winners in each category (highest quality, fastest, cheapest) and provides a per-input breakdown so you can see where models differ.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Model execution, LLM judge, comparison table, and CLI |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Use default task and evaluation data (5 test cases)
python main.py

# Custom task
python main.py --task "Summarize this text concisely"

# Custom evaluation inputs from file
python main.py --task "Answer the question" --inputs eval_data.json

# Save full results to JSON
python main.py --output results.json
```

**Evaluation inputs JSON format:**
```json
[
  {
    "input": "Explain what a closure is in programming.",
    "criteria": "Should mention function, scope, and variable access."
  },
  {
    "input": "What are the three states of water?",
    "criteria": "Must list solid, liquid, and gas."
  }
]
```

**Expected output:**

```
🚀 Starting Eval Runner...
🤖 Models: GPT-4o Mini, Claude Haiku 4.5
🧑‍⚖️ Judge: gpt-4o-mini
📝 Task: You are a helpful assistant. Answer the question or complete the task...
🧪 Inputs: 5

📝 Input 1/5: Explain what a closure is in programming, in 2-3 sentences.
     GPT-4o Mini: score=8/10, latency=845ms -- A closure is a function that...
     Claude Haiku 4.5: score=9/10, latency=1203ms -- A closure is a function...

📝 Input 2/5: What are the three states of water?
     ...

================================================================================
📊 Evaluation Results
================================================================================

Model                Avg Score  Avg Latency   Total Cost   Errors
--------------------------------------------------------------
GPT-4o Mini            7.8/10        823ms   $0.000312        0
Claude Haiku 4.5       8.2/10       1156ms   $0.001840        0
--------------------------------------------------------------

🏆 Highest quality: Claude Haiku 4.5 (8.2/10)
🚀 Fastest: GPT-4o Mini (823ms avg)
💰 Cheapest: GPT-4o Mini ($0.000312)

✅ Done!
```

## Common Issues & Troubleshooting

**"Missing environment variables: ANTHROPIC_API_KEY"**
- Both API keys are required since the runner tests models from both providers.

**Scores vary between runs**
- LLM judges are not perfectly deterministic. Score variations of 1-2 points are normal. Run multiple evaluations and average for more reliable results.

**One model consistently errors**
- Check that your API key has access to the specific model. Claude Haiku 4.5 requires an Anthropic API key with access to that model.

**Latency numbers seem high**
- The runner makes sequential API calls (not parallel) to avoid rate limiting. Network latency is included in the measurements.

## Extend This Example

- **Add more models** -- add entries to MODEL_CONFIGS for GPT-4o, Claude Sonnet, Gemini, or local models via Ollama
- **Parallel execution** -- run all models for an input concurrently with asyncio.gather / Promise.all
- **Statistical analysis** -- run each input multiple times and compute confidence intervals
- **Custom scoring functions** -- support regex, code execution, or custom evaluation scripts alongside LLM judging
- **Visualization** -- generate charts comparing models across dimensions (quality vs cost, quality vs latency)

## Related Examples

- [Prompt Optimizer](../prompt-optimizer) -- Uses LLM judging to iteratively improve prompts
- [Deep Research Agent](../deep-research-agent) -- Multi-model research with cost tracking
- [API Test Generator](../api-test-generator) -- Generates test suites that could be used as eval inputs
