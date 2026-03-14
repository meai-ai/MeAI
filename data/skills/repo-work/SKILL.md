# Repository Work

Git workflow skill for MeAI researcher agents. Manages branches, edits, tests, PRs.

## When to use

- When implementing code changes for a claimed topic
- When creating branches, editing files, running tests, opening PRs
- When reading PR review comments

## Workflow

1. `repo_create_branch` — create a feature branch from main
2. `repo_edit_file` — modify files (forbidden paths blocked)
3. `repo_show_diff` — review changes before committing
4. `repo_run_tests` — typecheck + smoke tests (must pass before PR)
5. `repo_commit_and_push` — commit and push to remote
6. `repo_create_pr` — open a PR (diff budget enforced: max 10 files, 500 lines)
7. `repo_read_pr_comments` — read review feedback

## Forbidden Paths

- **Security**: data/config*.json, .env*, .oauth-tokens.json, deploy/, .github/workflows/
- **Governance**: src/agent/loop.ts, src/channel/, src/config.ts, src/registry/, research-coord tools.ts

## Rules

- Max 1 open PR per bot
- Tests must pass before opening PR
- Max 10 files / 500 lines diff per PR
- 3 consecutive failures on same topic → stale
