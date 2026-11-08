# PR #25 — workspace-scoped authority candidate (21 October 2026 SAST)

**Status:** Code candidate, NOT an accepted permission-policy expansion. Decision D-025 is PROPOSED. No live enablement, merge, staging deployment, or production authorization has occurred.

## Why a change is necessary

ClickUp's documented `PUT /api/v2/task/{id}` does not expose an atomic precondition requiring the task to remain in its preflight home List. An external task move therefore invalidates any server-side List-only check. An MCP-side mutex, replayed read, or post-write verification cannot solve this against ClickUp actors outside the MCP.

The required 48 operations also include moving tasks and adding tasks to secondary Lists. Those actions cannot operate meaningfully with exactly one allowed home List. The two requirements conflict without a policy change or a new upstream conditional API.

## Proposed authorization model

- **Legacy default:** `CLICKUP_RESOURCE_SCOPE` unset or `list`: the previous List-only search and task-creation operations remain available, but task-ID reads/writes/time-in-status, cross-List moves, current-user time-entry operations and similar racy actions explicitly reject with `CLICKUP_WORKSPACE_SCOPE_REQUIRED`. All 48 catalogue names remain registered, but affected calls are not executable in this mode. This prevents a false security promise.
- **Opt-in candidate:** `CLICKUP_RESOURCE_SCOPE=workspace` in a protected Cloudflare staging configuration ONLY after owner approval. The catalogue accepts List IDs in the configured ClickUp Workspace (verified via that Workspace's Spaces), allowing task transfers between Serviteur Lists. Workspace task search uses `GET /team/{workspace_id}/task`; model-supplied Workspace IDs must match the OAuth-verified Workspace.
- **Credential boundary:** A ClickUp OAuth consent must report exactly the configured Serviteur Workspace via `GET /api/v2/team`. Multiple authorized Workspaces fail consent in candidate mode. The encrypted staff-token vault stores a non-secret `workspaceExclusive` proof alongside the credential; legacy tokens have no proof, are denied expanded access and must reconnect. Each user still authenticates independently and is subject to their ClickUp permissions.
- **ClickUp remains final authority:** If an external actor moves a task to another List in the **same authorised Workspace**, the action no longer crosses the agreed resource boundary. If they move it to another Workspace, ClickUp **must** reject the scoped user's token at the actual task-ID endpoint. This platform behavior still needs live, repeated, cross-account verification. A proof at consent time does not rule out later changes in upstream app authorizations: verify revocation and reauthorization lifecycle in acceptance.
- The existing `CLICKUP_LIVE_ENABLED` and OAuth grants still gate access. Do not turn them on merely because mocked tests pass.

## Synthetic tests and release gates

- All 48 names remain registered and scope-sensitive tools reject in legacy List mode **before outbound HTTP**.
- Full Workspace test: create or move between List A and List B in the same verified Workspace with a separate user's token. Foreign-Workspace destinations are denied before a write. Workspace task search stays on the Workspace endpoint.
- OAuth tests: exactly one authorised Workspace can connect; two or more fail before storing; legacy credentials without verified exclusivity cannot activate Workspace mode.
- Credential vault tests: authenticated subject isolation, AES-GCM encrypted token, atomic storage of verified Workspace consent metadata, and deletion on disconnect.
- **Required beyond these tests:** fresh strict CI and specialist security review at the exact latest head; ClickUp live List A→B race (within granted Workspace), A→foreign Workspace denial under each separate staff OAuth token, real cross-Workspace token selection and reauthorization, and native ClickUp attribution for staged disposable writes.
- Do not enable Workspace mode, merge as security-cleared, or claim complete security remediation without owner acceptance of this broader boundary and independently recorded live upstream behavior.

## Scope of change

No extra audit journal, rollback engine, monitoring worker, staff-shared API tokens, alternate approval UI, or new production endpoint. Cloudflare remains remote runtime; GitHub Actions remains the build/deployment runner.
