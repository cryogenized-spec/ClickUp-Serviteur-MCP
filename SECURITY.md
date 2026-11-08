# Security policy

ClickUp Serviteur is a self-hosted OAuth-protected remote MCP. A public source repository does **not** authorize access to any private Worker, ClickUp account or Workspace.

## Privately report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/cryogenized-spec/ClickUp-Serviteur-MCP/security/advisories/new), if enabled for the repository. Do **not** open a public issue with live tokens, customer data, employee identities, account details, ClickUp task content or unpatched exploit steps. If private reporting is unavailable, contact the repository maintainers through an approved private channel rather than disclosing a working exploit publicly.

Include affected commit/version, deployment model, reproducible conditions on synthetic/test-only data, likely impact and suggested mitigation. Never test a vulnerability against another person's ClickUp Workspace or Worker.

## Supported release line

The current source candidate is **v0.3.0-beta.1**. Security fixes are applied to supported mainline source; old staging proof-of-concept deployments and historic archives are not maintained releases. Check GitHub releases and deployed `service_info.build_sha` before comparing versions.

## Security boundaries

Every request must retain both authenticated MCP-client identity and the individual's ClickUp OAuth grant. Workspace/List authorization, deny-by-default configuration, explicit write scopes, safe handling of rate limits, bounded responses, no implicit retries after uncertain mutations and strict confirmation of destructive requests must not be weakened in a convenience patch. Cloudflare/OAuth secrets must not enter Git, build logs or AI prompts.

A self-hosted operator is responsible for Cloudflare account security, OAuth clients, secrets rotation, explicit trusted-user allowlists, ClickUp permissions, deployment origin, monitoring and safe cleanup. See [deployment guidance](docs/PUBLIC_RELEASE.md) for scope and migration limitations.
