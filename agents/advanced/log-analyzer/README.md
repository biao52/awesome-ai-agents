# Log Analyzer

> An agent that analyzes application log files to find anomalies, error patterns, and root causes, combining statistical pre-processing with AI-powered analysis.

## What You'll Learn

- How to pre-process unstructured data before sending it to an LLM (reducing cost and improving accuracy)
- How to handle large files that exceed context limits (smart sampling with error-line preservation)
- How to build a hybrid analysis pipeline (deterministic stats + AI reasoning)
- How to detect patterns in log data (level distribution, repeated messages, known error signatures)

## Architecture

```
User provides log file (--file) or pipes from stdin
    |
    v
Pre-processing (deterministic, no API calls):
    -> Count log levels (ERROR/WARN/INFO/DEBUG)
    -> Detect timestamp format
    -> Find known error patterns (OOM, timeouts, etc.)
    -> Identify repeated messages (log storms)
    |
    v
Smart sampling (if log > 1000 lines):
    -> First 500 lines
    -> Last 500 lines
    -> ALL error lines from the middle
    |
    v
Send pre-analysis stats + sampled log to Claude
    |
    v
Output: Error frequency, anomalies, root cause analysis,
        timeline, and recommended actions
```

## Prerequisites

- **Python 3.11+** or **Node.js 20+**
- **Anthropic API key** -- get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **Estimated cost:** ~$0.01-0.05 per analysis (depends on log size)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env   # Then add your API key
python main.py --file /path/to/app.log
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env   # Then add your API key
npx tsx index.ts --file /path/to/app.log
```

## How It Works

The agent uses a two-phase approach: deterministic pre-processing followed by AI-powered analysis. This hybrid strategy is more accurate and cost-effective than sending raw logs directly to an LLM.

**Pre-processing phase** runs entirely locally with no API calls. It counts log level distribution (what percentage are errors vs. info), detects the timestamp format, scans for known error signatures (OOM, connection refused, timeouts, disk full, etc.), and identifies repeated messages that might indicate a log storm. This gives the LLM structured context to work with instead of raw text.

**Smart sampling** handles logs that are too large for the context window. Instead of naively truncating, it takes the first 500 lines (to see the start state), the last 500 lines (to see the current state), and ALL error/fatal/critical lines from the middle section. This ensures no errors are lost even in million-line log files.

**AI analysis phase** sends the pre-computed statistics and sampled log text to Claude, which produces a structured report: error frequency tables, anomaly detection, root cause analysis with confidence levels, a chronological timeline, and prioritized recommended actions.

The `--context` flag lets you provide additional information (e.g., "we deployed v2.3.1 at 3pm") that helps Claude correlate log events with known changes.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Yes | -- | Your Anthropic API key |
| `MODEL` | No | `claude-sonnet-4-20250514` | Override the Claude model |

## Key Files

| File | Purpose |
|------|---------|
| `main.py` / `index.ts` | Log reading, pre-processing, sampling, and Claude analysis |
| `.env.example` | Template for required environment variables |

## CLI Usage

```bash
# Analyze a log file
python main.py --file app.log

# Pipe from another command
cat /var/log/syslog | python main.py

# Add context about recent changes
python main.py --file app.log --context "Deployed v2.3.1 at 15:00 UTC"

# Analyze Docker container logs
docker logs my-container 2>&1 | python main.py

# Show help
python main.py --help
```

**Example output:**

```
🔍 Pre-processing logs...

Total lines: 15432
Timestamp format detected: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}
Log level distribution:
  INFO: 12850 (83.3%)
  WARN: 1923 (12.5%)
  ERROR: 659 (4.3%)
Error/Fatal/Critical lines: 659
Known error patterns detected:
  Connection Error: 412 occurrences
  Timeout: 247 occurrences
Frequently repeated messages (possible log storms):
  [412x] Failed to connect to downstream service at N.N.N.N:N

📊 Log Analysis Report
============================================================

## Log Analysis Summary
The application is experiencing a cascading failure triggered by
connection timeouts to the downstream payment service. Error rate
spiked from 0.1% to 4.3% starting at 14:32 UTC.

## Root Cause Analysis
- **Symptom:** 412 connection refused errors to 10.0.1.15:8080
- **Likely cause:** Payment service became unreachable, possibly
  due to a deployment or host failure
- **Evidence:** First error at 2024-01-15T14:32:01Z, all errors
  reference the same host:port combination
- **Confidence:** High
```

## Common Issues & Troubleshooting

**"No log data provided"**
- Make sure you are using `--file path/to/log` or piping data via stdin.

**Analysis seems shallow for large files**
- The agent samples large files to fit context limits. All error lines are preserved, but some context around INFO-level events may be lost.

**Binary or non-UTF8 log files**
- The agent reads files with UTF-8 encoding and replaces invalid bytes. Binary log formats (e.g., systemd journal binary) need to be exported to text first: `journalctl --no-pager > journal.log`

**Very large files (100MB+)**
- Reading into memory is fine for most log files, but extremely large files may need to be split first: `tail -n 50000 huge.log > recent.log`

## Extend This Example

- Add `--output report.md` to save the analysis report to a file
- Add `--watch` mode to monitor a log file in real-time and alert on anomalies
- Add support for structured JSON logs (parse and analyze field values)
- Integrate with PagerDuty or Slack to send alerts when critical patterns are detected
- Add multi-file analysis to correlate events across services

## Related Examples

- [Incident Responder](../incident-responder) -- Takes the analysis output and produces an incident response plan
- [Deep Research Agent](../deep-research-agent) -- Similar multi-step analysis pattern for research
- [Data Analyst Agent](../../starter/data-analyst-agent) -- Analyzes structured data (CSV) instead of logs
