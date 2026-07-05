# Competitor Monitor

Track changes on competitor websites over time. This agent reads competitor pages, diffs them against previous snapshots, and uses Claude to produce competitive intelligence reports.

## How It Works

1. **Crawl** - Fetches each competitor URL through Reader, which converts web pages to clean markdown
2. **Snapshot** - Saves the current content as a local JSON file (one per URL)
3. **Diff** - Compares the current content against the previous snapshot to find added and removed sections
4. **Analyze** - Sends the diff to Claude for competitive analysis: what changed, why it matters, and what to do about it
5. **Report** - Outputs a structured change report to the terminal and saves it as JSON

On the first run for any URL, the agent captures a baseline snapshot with no analysis. Subsequent runs detect and analyze changes.

## Use Cases

- Track pricing page changes across competitors
- Monitor feature lists for new capabilities
- Detect messaging and positioning shifts
- Get alerted to new product launches or deprecations
- Build a historical record of competitor evolution

## Prerequisites

- Python 3.10+ or Node.js 18+
- An Anthropic API key for Claude analysis
- Reader requires no API key and is free to use

## Quick Start (Python)

```bash
cd python
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

pip install -r requirements.txt

# Monitor one or more competitor pages
python main.py "https://example.com/pricing" "https://example.com/features"

# Run again later to see what changed
python main.py "https://example.com/pricing" "https://example.com/features"
```

## Quick Start (TypeScript)

```bash
cd typescript
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm install

# Monitor competitor pages
npx tsx index.ts "https://example.com/pricing" "https://example.com/features"

# Run again later to detect changes
npx tsx index.ts "https://example.com/pricing" "https://example.com/features"
```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key for Claude analysis |

Reader is used for page reading and requires no configuration or API key.

## CLI Reference

```bash
# Monitor specific pages
python main.py "https://competitor.com/pricing"

# Monitor multiple pages at once
python main.py "https://a.com/pricing" "https://b.com/features" "https://c.com/about"

# URLs without https:// are auto-prefixed
python main.py competitor.com/pricing

# Clear all saved snapshots to start fresh
python main.py --reset
```

## Output

The agent produces two types of output:

**Terminal report** with sections for:
- Baseline captures (first-run pages)
- Unchanged pages
- Change analysis for each page with detected differences

**JSON report** saved to the `snapshots/` directory with structured data for each analyzed page.

## Snapshot Storage

Snapshots are stored as JSON files in a `snapshots/` directory next to the source code. Each URL gets its own file, named using a SHA-256 hash of the URL. The snapshot includes:

- The full markdown content from Reader
- The page title
- Word count
- Capture timestamp

This means you can run the monitor on a schedule (cron, CI, etc.) and it will accumulate a history of changes over time.

## Analysis Details

When changes are detected, Claude receives the diff and produces a report covering:

1. **Change Summary** - Overview of what changed on the page
2. **Key Changes** - Specific items that were added, removed, or modified
3. **Competitive Implications** - What the changes signal about the competitor's strategy
4. **Recommended Actions** - Suggested responses to the detected changes

Minor changes like formatting or typo fixes are identified as such to avoid false alarms.

## Architecture

```
CLI args (URLs)
    |
    v
Reader (r.reader.dev)  -->  Clean markdown for each page
    |
    v
Snapshot store          -->  Load previous / save current
    |
    v
Diff engine             -->  Line-level comparison, block grouping
    |
    v
Claude analysis         -->  Competitive intelligence report
    |
    v
Terminal + JSON output
```

## Running on a Schedule

For continuous monitoring, run the agent on a schedule:

```bash
# Cron job every 6 hours
0 */6 * * * cd /path/to/competitor-monitor/python && python main.py "https://competitor.com/pricing" >> monitor.log 2>&1
```

Reports accumulate in the `snapshots/` directory with timestamps, giving you a historical record.

## Limitations

- Diff is line-based, so reformatted content (same text, different line breaks) may appear as changes
- JavaScript-rendered content depends on Reader's ability to process the page
- Rate limiting on target sites may affect reliability for large URL lists
- Snapshots are local; use version control or cloud storage for team sharing

## Project Structure

```
competitor-monitor/
  python/
    main.py              # Python implementation
    requirements.txt     # Dependencies
    .env.example         # Environment template
    snapshots/           # Created at runtime
  typescript/
    index.ts             # TypeScript implementation
    package.json         # Dependencies
    tsconfig.json        # TypeScript config
    .env.example         # Environment template
    snapshots/           # Created at runtime
  README.md              # This file
```

## License

MIT
