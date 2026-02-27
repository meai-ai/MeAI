# claude-code

Delegate ALL coding tasks and substantial reasoning tasks here. Uses Max subscription — free.

## Always delegate: coding (any size)

- Writing any function, script, class, or module
- Fixing or debugging code
- Refactoring or improving existing code
- Explaining or reviewing code / diffs
- Generating tests
- Searching a codebase

## Always delegate: reasoning (response > ~100 words)

- Analysis or evaluation (comparing options, trade-offs, pros/cons)
- Research or multi-step reasoning
- Planning or strategy
- Mathematical or logical problems
- Long-form writing (summaries, reports, explanations, recommendations)
- Any question whose answer would take more than a short paragraph

## Never delegate

- Weather, calendar → use the relevant skill
- Simple yes/no or one-liner answers → reply directly
- Memory operations → use memory_set / memory_get

## Saving documents

When generating a document, report, summary, or analysis that should be kept:
- Save to `data/documents/` (use English filenames, e.g. `agent-os-summary.txt`)
- After saving, use `memory_set` to index it: key = `documents.<topic>`, value = title + path + one-line summary

## After getting a result

MeAI should extract the key conclusion and store it with memory_set if it's worth keeping.

## Requirements

- `claude` CLI installed: `npm install -g @anthropic-ai/claude-code`
- Logged in to Claude.ai Max account (no ANTHROPIC_API_KEY in environment)

## Notes

- Runs with `--dangerously-skip-permissions`
- Output capped at 8,000 characters
- Default timeout: 5 minutes
