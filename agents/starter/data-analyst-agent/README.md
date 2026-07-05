# Data Analyst Agent

> An agent that takes a CSV file and natural language questions, writes Python analysis code, runs it in a sandbox, and explains the results -- like having a data scientist on call.

## What You'll Build

A CLI tool that lets you ask questions about any CSV file in plain English. The agent inspects the data, writes pandas code to answer your question, executes it in a sandboxed subprocess, and explains the results. It can generate charts (saved as PNG files) and handles code errors by reading the traceback and retrying with fixed code.

## What You'll Learn

- How to build a code interpreter agent (write code, execute, interpret results)
- How to sandbox code execution using subprocess with timeouts
- How to implement a retry loop when generated code fails (agent reads errors and fixes)
- How to use OpenAI function calling to give agents executable tools
- How to build an interactive CLI with multi-turn conversation support

## Architecture

```
User provides CSV file + question
    ↓
Agent inspects CSV (columns, types, 5 sample rows)
    ↓
Agent writes Python code (pandas + matplotlib)
    ↓
run_analysis_code tool executes in subprocess:
    -> 30-second timeout
    -> Captures stdout + stderr
    -> Checks for saved chart files
    ↓
If code fails (exit code != 0):
    -> Error fed back to agent
    -> Agent reads traceback, writes fixed code
    -> Retry (up to 3 attempts)
    ↓
If code succeeds:
    -> stdout + chart paths returned to agent
    ↓
Agent interprets results in plain English
    ↓
Output: Natural language answer + saved charts in output/
```

## Prerequisites

- **Python 3.11+** and **Node.js 20+**
- **Python packages:** pandas, matplotlib (for the generated analysis code)
- **OpenAI API key** -- get one at [platform.openai.com](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.005-0.02 per question (gpt-4o-mini is very cheap)

**Important:** Both the Python and TypeScript versions generate Python scripts for analysis (pandas is the standard for data work). Make sure `python3`, `pandas`, and `matplotlib` are installed on your system.

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

5. Run the agent with the included sample data:
   ```bash
   python main.py --file ../sample_data/sales.csv "What is the total revenue by region?"
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

3. Make sure Python analysis dependencies are installed:
   ```bash
   pip install pandas matplotlib
   ```

4. Set up your environment:
   ```bash
   cp .env.example .env
   ```

5. Open `.env` and add your OpenAI API key.

6. Run the agent:
   ```bash
   npx tsx index.ts --file ../sample_data/sales.csv "What is the total revenue by region?"
   ```

## How It Works

This agent uses the **code interpreter pattern** -- instead of trying to answer data questions directly (which LLMs are bad at), it writes code to compute the answer. The agent gets a summary of the CSV structure (columns, types, sample rows) in its system prompt, then uses OpenAI function calling to invoke a `run_analysis_code` tool that executes Python in a subprocess.

The subprocess sandbox is simple but effective. Generated code runs in a separate Python process with a 30-second timeout. The code gets two pre-defined variables: `CSV_PATH` (path to the data file) and `OUTPUT_DIR` (where to save charts). stdout is captured and returned to the agent. If the process exits with a non-zero code, the stderr (traceback) is fed back to the agent, which reads the error and writes corrected code. This retry loop runs up to 3 times.

The CSV inspection step is critical for good results. Before the agent writes any code, it sees the column names, inferred types (numeric vs string), row count, and 5 sample rows. This gives the model enough context to write correct pandas code on the first try most of the time. Without this context, the model would guess column names and types, leading to frequent errors.

Charts work by having the agent save matplotlib figures to `OUTPUT_DIR`. After code execution, the tool checks for new PNG/JPG/SVG files in that directory and reports them back. The agent then mentions the saved charts in its response. All charts are saved to an `output/` directory relative to the example root.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_API_KEY` | Yes | -- | Your OpenAI API key |
| `MODEL` | No | `gpt-4o-mini` | Override the OpenAI model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Entry point: CLI, CSV inspection, agent loop, code execution |
| `../sample_data/sales.csv` | 100 rows of sample sales data for testing |
| `../output/` | Generated charts are saved here (created automatically) |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# One-shot question with included sample data
python main.py --file ../sample_data/sales.csv "What is the total revenue by region?"

# Generate a chart
python main.py --file ../sample_data/sales.csv "Create a bar chart of monthly revenue"

# Interactive mode (keeps asking for questions)
python main.py --file ../sample_data/sales.csv

# Uses sample_data/sales.csv automatically if no --file given
python main.py "What product has the highest revenue?"
```

**Example output:**

```
🚀 Starting data analyst agent...
🤖 Model: gpt-4o-mini
📄 CSV: sales.csv

📊 Data summary:
   CSV File: sales.csv
   Rows: 100
   Columns: 6
   Column Details:
     1. date (string)
     2. product (string)
     3. region (string)
     4. revenue (numeric)

💻 Running analysis code (attempt 1)...
✓ Code executed successfully

Based on the analysis, here are the total revenue figures by region:

| Region | Total Revenue |
|--------|--------------|
| East   | $41,670.95   |
| North  | $45,822.80   |
| South  | $32,822.70   |
| West   | $42,961.45   |

The North region leads in total revenue at $45,822.80, while the South
region has the lowest at $32,822.70.
```

## Common Issues & Troubleshooting

**"ModuleNotFoundError: No module named 'pandas'"**
- The generated analysis code needs pandas installed system-wide (or in your active venv).
- Run: `pip install pandas matplotlib`

**"Code execution timed out after 30 seconds"**
- The generated code is taking too long. This usually means it's processing too much data or stuck in a loop.
- Try a more specific question, or use a smaller CSV file.

**"Code failed" with a traceback**
- The agent will automatically retry up to 3 times, reading the error and fixing the code.
- If it still fails, try rephrasing your question to be more specific.

**Charts don't appear**
- Charts are saved to the `output/` directory (created automatically next to `sample_data/`).
- Check that matplotlib is installed: `pip install matplotlib`
- On headless servers, matplotlib uses the Agg backend by default (no display needed).

**TypeScript version says "python3 not found"**
- The TypeScript version runs generated Python scripts via `python3`. Make sure Python is in your PATH.

## Extend This Example

- **Add seaborn support** -- install seaborn and tell the agent it's available for prettier statistical charts
- **Multi-file analysis** -- accept multiple CSV files and let the agent join/merge them with pandas
- **Export results** -- add a `--output` flag to save the agent's analysis to a markdown or HTML report
- **Add memory** -- remember previous questions and results so the agent can build on earlier analysis
- **Security hardening** -- run the subprocess in a Docker container or use RestrictedPython for tighter sandboxing

## Related Examples

- [SQL Agent](../sql-agent) -- Similar pattern but queries a SQLite database instead of CSV files
- [Research Agent](../research-agent) -- Uses the same OpenAI tool-calling loop but for web research instead of data analysis
- [PDF Chatbot](../../../rag/pdf-chatbot) -- RAG-based Q&A over documents instead of structured data
