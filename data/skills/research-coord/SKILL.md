# Research Coordination

Multi-agent research coordination skill for the MeAI researcher system.

## When to use

- When proposing, discussing, accepting, or rejecting research topics
- When claiming a topic to work on
- When checking the status of ongoing research
- When generating organization health summaries (Omega only)

## Topic Types

- **research**: Investigation, benchmark, risk assessment → produces analysis memo
- **design**: Architecture proposal, refactor plan → produces design document
- **implementation**: Code change → produces PR
- **review**: Code audit → produces review report

## Topic Lifecycle

proposed → discussing → accepted (requires critique + decision) → claimed → implementing → pr_open → merged

## Accept Decision Requirements

Every accept must include: scope, nonGoals, successCheck, riskNote.

## Fairness Rules

- Same bot cannot claim 2 topics in a row without 1h cooldown
- Bot with open PR cannot claim new implementation topic
- Expired leases are auto-released by watchdog
