"""
OpenAI Agents SDK Quickstart -- Example Runner
================================================

Entry point for running individual examples.

Usage:
    python main.py        # List all examples
    python main.py 1      # Run 01_basic_agent
    python main.py 3      # Run 03_handoffs
"""

import asyncio
import importlib
import sys

EXAMPLES = {
    "1": ("01_basic_agent", "Basic Agent -- system prompt + user input"),
    "2": ("02_tools", "Agent with Tools -- function calling"),
    "3": ("03_handoffs", "Multi-Agent Handoffs -- triage routing"),
    "4": ("04_guardrails", "Input/Output Guardrails -- safety checks"),
    "5": ("05_full_example", "Full Example -- all patterns combined"),
}


def show_menu() -> None:
    """Display available examples."""
    print("OpenAI Agents SDK Quickstart Examples")
    print("=" * 45)
    print()
    for key, (_, description) in EXAMPLES.items():
        print(f"  {key}. {description}")
    print()
    print("Usage: python main.py <number>")
    print("Example: python main.py 1")


def main() -> None:
    """Parse arguments and run the selected example."""
    if len(sys.argv) < 2:
        show_menu()
        return

    choice = sys.argv[1]
    if choice not in EXAMPLES:
        print(f"Unknown example: {choice}")
        print(f"Valid choices: {', '.join(EXAMPLES.keys())}")
        sys.exit(1)

    module_name, description = EXAMPLES[choice]
    print(f"Running: {description}")
    print()

    module = importlib.import_module(module_name)
    asyncio.run(module.main())


if __name__ == "__main__":
    main()
