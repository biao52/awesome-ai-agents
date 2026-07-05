"""
Coding Agent -- Reads a codebase, plans changes, writes code, and runs tests
in a plan-code-test-fix loop.

Uses Anthropic Claude with filesystem and command tools.
"""

import os
import sys
import json
import asyncio
import subprocess
from typing import Any

from dotenv import load_dotenv
from anthropic import AsyncAnthropic

load_dotenv()

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MODEL = "claude-sonnet-4-20250514"
MAX_ITERATIONS = 30
MAX_TEST_RETRIES = 3
COMMAND_TIMEOUT = 30

# ---------------------------------------------------------------------------
# Environment validation
# ---------------------------------------------------------------------------


def validate_env() -> None:
    required = ["ANTHROPIC_API_KEY"]
    missing = [var for var in required if not os.getenv(var)]
    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        print("   Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)


def log(emoji: str, message: str) -> None:
    print(f"{emoji} {message}")


# ---------------------------------------------------------------------------
# Sandbox validation
# ---------------------------------------------------------------------------


def is_within_project(path: str, project_dir: str) -> bool:
    """Ensure a path is within the project directory (prevent directory traversal)."""
    abs_path = os.path.abspath(os.path.join(project_dir, path))
    abs_project = os.path.abspath(project_dir)
    return abs_path.startswith(abs_project)


# ---------------------------------------------------------------------------
# Tool implementations
# ---------------------------------------------------------------------------


def tool_read_directory(project_dir: str, path: str = ".") -> str:
    """List files and directories at the given path."""
    if not is_within_project(path, project_dir):
        return "Error: Path is outside the project directory."

    target = os.path.join(project_dir, path)
    if not os.path.isdir(target):
        return f"Error: Not a directory: {path}"

    entries = []
    try:
        for entry in sorted(os.listdir(target)):
            full = os.path.join(target, entry)
            if entry in ("node_modules", ".git", "__pycache__", "dist", ".env"):
                continue
            entry_type = "dir" if os.path.isdir(full) else "file"
            entries.append(f"  {entry_type}: {entry}")
    except PermissionError:
        return f"Error: Permission denied: {path}"

    return f"Directory: {path}\n" + "\n".join(entries) if entries else f"Directory: {path} (empty)"


def tool_read_file(project_dir: str, path: str) -> str:
    """Read the contents of a file."""
    if not is_within_project(path, project_dir):
        return "Error: Path is outside the project directory."

    target = os.path.join(project_dir, path)
    if not os.path.isfile(target):
        return f"Error: File not found: {path}"

    try:
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        if len(content) > 50_000:
            content = content[:50_000] + "\n... (truncated)"
        return content
    except PermissionError:
        return f"Error: Permission denied: {path}"


def tool_write_file(project_dir: str, path: str, content: str) -> str:
    """Write content to a file (creates directories if needed)."""
    if not is_within_project(path, project_dir):
        return "Error: Path is outside the project directory."

    target = os.path.join(project_dir, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)

    try:
        with open(target, "w", encoding="utf-8") as f:
            f.write(content)
        return f"File written: {path} ({len(content)} chars)"
    except PermissionError:
        return f"Error: Permission denied: {path}"


def tool_run_command(project_dir: str, command: str) -> str:
    """Run a shell command within the project directory."""
    # Basic safety: block dangerous commands
    dangerous = ["rm -rf /", "rm -rf ~", "sudo", "mkfs", "dd if="]
    for d in dangerous:
        if d in command:
            return f"Error: Blocked dangerous command: {command}"

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT,
            cwd=project_dir,
        )
        output = ""
        if result.stdout:
            output += result.stdout
        if result.stderr:
            output += ("\n" if output else "") + result.stderr
        if not output:
            output = "(no output)"
        output += f"\n\nExit code: {result.returncode}"
        return output[:10_000]  # Truncate very long output
    except subprocess.TimeoutExpired:
        return f"Error: Command timed out after {COMMAND_TIMEOUT}s"
    except Exception as e:
        return f"Error running command: {e}"


# ---------------------------------------------------------------------------
# Tool definitions for Anthropic
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "read_directory",
        "description": "List files and directories at a path within the project. Use '.' for the root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative path within the project (e.g., '.', 'src', 'src/routes')"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "read_file",
        "description": "Read the contents of a file within the project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative file path (e.g., 'index.js', 'src/app.py')"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Write content to a file. Creates parent directories if needed. Overwrites existing files.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Relative file path to write"},
                "content": {"type": "string", "description": "The full file content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_command",
        "description": "Run a shell command in the project directory. Use for: installing deps (npm install), running tests (npm test), starting servers, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to execute (e.g., 'npm test', 'npm install express')"},
            },
            "required": ["command"],
        },
    },
]

SYSTEM_PROMPT = """You are an expert coding agent. You can read, write, and execute code within a project directory.

Your workflow:
1. EXPLORE: First, read the directory structure and key files to understand the project
2. PLAN: Describe what changes you'll make and why (show the plan to the user)
3. IMPLEMENT: Write the code changes using write_file
4. TEST: Run tests using run_command to verify your changes work
5. FIX: If tests fail, read the errors, fix the code, and test again (max 3 retries)

Rules:
- Always explore the project structure before making changes
- Read existing files before modifying them to understand the current code
- Write complete file contents (not patches) when using write_file
- Run tests after every change to verify nothing is broken
- If tests fail, read the error carefully and fix the specific issue
- Keep your changes minimal and focused on the task
- Follow the project's existing code style and conventions
- Don't modify files outside the project directory
- Explain your changes as you make them

When you're done, provide a summary of all changes made."""


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------


async def run_agent(task: str, project_dir: str, model: str) -> str:
    """Run the coding agent on a task."""
    client = AsyncAnthropic()
    abs_project = os.path.abspath(project_dir)

    messages: list[dict[str, Any]] = [
        {"role": "user", "content": f"Project directory: {abs_project}\n\nTask: {task}"},
    ]

    for iteration in range(MAX_ITERATIONS):
        try:
            response = await client.messages.create(
                model=model,
                max_tokens=8192,
                system=SYSTEM_PROMPT,
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

        # Collect assistant content
        assistant_content = response.content

        # Print any text from the assistant
        for block in assistant_content:
            if block.type == "text" and block.text.strip():
                print(f"\n{block.text}")

        # Add assistant message
        messages.append({"role": "assistant", "content": assistant_content})

        # If stop reason is end_turn (no tool use), we're done
        if response.stop_reason == "end_turn":
            final_text = ""
            for block in assistant_content:
                if block.type == "text":
                    final_text += block.text
            return final_text

        # Process tool calls
        tool_results = []
        for block in assistant_content:
            if block.type != "tool_use":
                continue

            tool_name = block.name
            tool_input = block.input

            if tool_name == "read_directory":
                path = tool_input.get("path", ".")
                log("📂", f"Reading directory: {path}")
                result = tool_read_directory(abs_project, path)

            elif tool_name == "read_file":
                path = tool_input.get("path", "")
                log("📄", f"Reading file: {path}")
                result = tool_read_file(abs_project, path)

            elif tool_name == "write_file":
                path = tool_input.get("path", "")
                content = tool_input.get("content", "")
                log("✏️", f"Writing file: {path}")
                result = tool_write_file(abs_project, path, content)

            elif tool_name == "run_command":
                command = tool_input.get("command", "")
                log("🔧", f"Running: {command}")
                result = tool_run_command(abs_project, command)
                # Show command output
                for line in result.split("\n")[:20]:
                    print(f"   {line}")
                if result.count("\n") > 20:
                    print("   ... (output truncated)")

            else:
                result = f"Unknown tool: {tool_name}"

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": result,
            })

        messages.append({"role": "user", "content": tool_results})

    return "Agent reached maximum iterations."


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


async def main() -> None:
    validate_env()

    model = os.getenv("MODEL", DEFAULT_MODEL)
    args = sys.argv[1:]

    if "--help" in args or "-h" in args:
        print("Usage: python main.py [--project DIR] [TASK]")
        print()
        print("Arguments:")
        print("  --project DIR  Path to the project directory (default: ../sample_project)")
        print("  TASK           Description of the coding task (prompts if not given)")
        print()
        print("Examples:")
        print('  python main.py --project ../sample_project "Add input validation to the POST endpoint"')
        print('  python main.py "Add a /health endpoint that returns server uptime"')
        sys.exit(0)

    project_dir: str | None = None
    task_parts: list[str] = []

    i = 0
    while i < len(args):
        if args[i] == "--project" and i + 1 < len(args):
            project_dir = args[i + 1]
            i += 2
        else:
            task_parts.append(args[i])
            i += 1

    if not project_dir:
        default = os.path.join(os.path.dirname(__file__), "..", "sample_project")
        if os.path.isdir(default):
            project_dir = default
        else:
            print("❌ Please specify a project directory with --project DIR")
            sys.exit(1)

    if not os.path.isdir(project_dir):
        print(f"❌ Project directory not found: {project_dir}")
        sys.exit(1)

    task = " ".join(task_parts) if task_parts else None
    if not task:
        task = input("💻 What coding task should I do? ").strip()
    if not task:
        print("❌ Please provide a task description.")
        sys.exit(1)

    log("🚀", "Starting coding agent...")
    log("🤖", f"Model: {model}")
    log("📁", f"Project: {os.path.abspath(project_dir)}")
    log("📋", f"Task: {task}")
    print()

    try:
        result = await run_agent(task, project_dir, model)
    except KeyboardInterrupt:
        print("\n❌ Cancelled.")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)

    print("\n" + "=" * 60)
    log("✅", "Coding agent complete!")


if __name__ == "__main__":
    asyncio.run(main())
