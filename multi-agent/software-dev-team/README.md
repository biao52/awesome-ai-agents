# Software Dev Team

A multi-agent pipeline that simulates a software development team -- PM, Architect, Developer, and Reviewer -- collaborating to turn a feature request into production-ready code.

## What You'll Build

A 4-agent pipeline where each agent plays a specialized role in the software development lifecycle. You give it a feature request in plain English, and it produces a complete product specification, architecture design, implemented code, and a code review -- just like a real dev team would.

The Reviewer agent can send code back to the Developer for revision, creating a realistic feedback loop that improves code quality across up to 2 revision rounds.

## What You'll Learn

- **Agent specialization** -- how to design focused system prompts that give each agent a distinct personality and expertise
- **Context handoff** -- passing structured output from one agent as input to the next
- **Feedback loops** -- implementing a revision cycle between Developer and Reviewer agents
- **Temperature tuning** -- using different temperature settings for different agent roles
- **Artifact management** -- collecting and saving all intermediate outputs for inspection

## Architecture

```
Feature Request
      |
      v
+------------+    stories &     +------------+
|  PM Agent  | -- criteria -->  | Architect  |
| (temp 0.4) |                  |  (temp 0.3)|
+------------+                  +-----+------+
                                      |
                                design & file structure
                                      |
                                      v
                               +------------+
                               | Developer  |
                               | (temp 0.2) |
                               +------+-----+
                                      |
                                  code impl
                                      |
                                      v
                               +------------+
                         +---->| Reviewer   |
                         |     | (temp 0.3) |
                         |     +------+-----+
                         |            |
                         |    APPROVED or CHANGES_NEEDED
                         |            |
                   revised code       |
                         |            v
                         +--- if CHANGES_NEEDED
                              (max 2 rounds)
```

## Prerequisites

- **Python 3.10+** or **Node.js 18+**
- **OpenAI API key** -- get one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Estimated cost:** ~$0.10-0.30 per feature request (using gpt-4o)

## Quick Start

### Python

```bash
cd python
pip install -r requirements.txt
cp .env.example .env
# Edit .env and add your OpenAI API key

python main.py "Build a REST API for a blog with posts and comments"

# Save all artifacts to a directory
python main.py "Build a CLI task manager" --output ./artifacts
```

### TypeScript

```bash
cd typescript
npm install
cp .env.example .env
# Edit .env and add your OpenAI API key

npx tsx index.ts "Build a REST API for a blog with posts and comments"

# Save all artifacts to a directory
npx tsx index.ts "Build a CLI task manager" --output ./artifacts
```

## How It Works

### Agent Specialization

Each agent has a carefully crafted system prompt that defines its role, responsibilities, and output format. The PM thinks in user stories and acceptance criteria. The Architect thinks in file structures and API contracts. The Developer focuses on writing complete, runnable code. The Reviewer checks for security, performance, and correctness. Different temperature settings reinforce these personalities -- the Developer uses 0.2 for more deterministic code output, while the PM uses 0.4 for slightly more creative product thinking.

### Context Handoff

The pipeline passes each agent's full output to the next agent as context. The Architect receives both the original feature request and the PM's specification, giving it the context to make informed technical decisions. The Developer receives all upstream context -- the feature request, PM spec, and architecture design. This ensures each agent builds on previous work rather than starting from scratch.

### Revision Loop

After the Developer produces code, the Reviewer evaluates it against the PM spec and architecture design. If the verdict is CHANGES_NEEDED, the Reviewer's specific feedback is sent back to the Developer along with all the original context. The Developer then revises the code to address the feedback. This loop can run up to 2 rounds, after which the pipeline proceeds with the best available code.

### Output Artifacts

The pipeline produces several artifacts at each stage: the PM specification, architecture design, code implementation (possibly multiple versions), and review feedback. When you use the `--output` flag, all artifacts are saved as numbered markdown files along with a JSON manifest. This makes it easy to inspect the full chain of reasoning and decisions.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `MODEL` | `gpt-4o` | OpenAI model to use |

You can also override the model via CLI: `--model gpt-4o-mini`

## Key Files

| File | Description |
|------|-------------|
| `python/main.py` | Python implementation of the 4-agent pipeline |
| `python/requirements.txt` | Python dependencies |
| `typescript/index.ts` | TypeScript implementation of the 4-agent pipeline |
| `typescript/package.json` | Node.js dependencies and scripts |

## CLI Usage

```bash
# Basic usage
python main.py "Build a user authentication system with JWT tokens"

# Save artifacts for inspection
python main.py "Build a URL shortener service" --output ./my-artifacts

# Use a different model
python main.py "Build a todo app" --model gpt-4o-mini
```

### Example Output

```
============================================================
  Software Dev Team -- Multi-Agent Pipeline
============================================================

  Feature: Build a REST API for a blog with posts and comments

----------------------------------------
  📋  [14:23:01] PM Agent: Analyzing feature request...
  ✅  [14:23:12] PM Agent: Specification complete
----------------------------------------
  🏗️  [14:23:12] Architect Agent: Designing technical architecture...
  ✅  [14:23:24] Architect Agent: Architecture design complete
----------------------------------------
  💻  [14:23:24] Developer Agent: Implementing code...
  ✅  [14:23:45] Developer Agent: Implementation complete
----------------------------------------
  🔍  [14:23:45] Reviewer Agent: Reviewing code...
  ✅  [14:23:56] Reviewer Agent: Review complete
  🎉  [14:23:56] Code APPROVED by Reviewer!

============================================================
  Pipeline Complete!
============================================================

  Artifacts produced: 5
  Output directory:   ./artifacts
```

## Common Issues & Troubleshooting

**"OPENAI_API_KEY is not set"**
Copy `.env.example` to `.env` and add your API key. Make sure the file is in the same directory you are running from.

**Rate limit errors**
The pipeline includes automatic retry logic with exponential backoff. If you hit rate limits consistently, try using `gpt-4o-mini` which has higher rate limits.

**Large feature requests timing out**
Complex features produce longer outputs. If you experience timeouts, try breaking your feature request into smaller, more focused requests.

**Reviewer always says CHANGES_NEEDED**
This is normal for complex features. The pipeline allows up to 2 revision rounds. If the Reviewer is too strict, you can adjust the reviewer temperature or modify its system prompt.

## Extend This Example

- **Add a QA Agent** that writes test cases based on the PM spec and validates the Developer's code against them
- **Add a DevOps Agent** that generates Dockerfiles, CI/CD configs, and deployment scripts for the implemented code
- **Parallel architecture** -- run multiple Developer agents with different approaches and let the Reviewer pick the best one
- **Persistent memory** -- store past reviews and common feedback patterns so the Developer learns to avoid repeated mistakes
- **Human-in-the-loop** -- add approval gates between agents where a human can review and modify the output before passing it forward

## Related Examples

- [Research Team](../research-team/) -- multi-agent research and synthesis pipeline
- [Chatbot](../../single-agent/chatbot/) -- simple single-agent conversation
