# Contributing to ClickUp Serviteur MCP

Thanks for helping improve the independent ClickUp Serviteur project. This repository accepts bug reports, reproducible test cases, documentation corrections and focused pull requests.

## Before opening a PR

Discuss high-impact API expansion or authentication changes in an issue. Work from an up-to-date `main`; keep changes small enough for strict review. Do not submit ClickUp credentials, customer records, production screenshots, real Workspace IDs, live API outputs or staff information. Use synthetic fixtures.

Run the repository's checks locally or in CI:

```bash
npm ci --ignore-scripts --no-audit --no-fund
python3 scripts/check_repo_policy.py
python3 -m unittest discover -s scripts/tests -p 'test_*.py' -v
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
node scripts/staging-local-smoke.mjs
npm audit --audit-level=high
```

For a new ClickUp API operation, add exact input validation, per-user OAuth and Workspace/List checks, error handling for ambiguous writes and synthetic tests of denied access as well as successful readback. Avoid saying a feature renders natively in ClickUp based solely on API acceptance.

PRs should explain the user-facing behavior, affected permissions, tested failure modes, documentation changes and any migration required. CI and security review need to pass before merge. Deployment to an actual Worker remains a separate, protected manual action.

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities and [the contributor-facing release guide](docs/PUBLIC_RELEASE.md) before modifying worker manifests.
