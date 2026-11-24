# Webhook ingestion

The optional POST /clickup/webhook route is disabled unless CLICKUP_WEBHOOK_ENABLED=true and CLICKUP_WEBHOOK_REGISTRATIONS is supplied as a protected Worker secret. The secret is a JSON array of operator-provisioned records containing webhookId, workspaceId, subject (github:<numeric-id>) and secret (the signing secret ClickUp returned when the webhook was created). Never commit or expose this configuration. The configured Workspace and staff allowlist must match each record.

The receiver verifies the native X-Signature HMAC on the exact request bytes, then persists only task ID, event type, receipt time and deduplication key into a private Durable Object partitioned by Workspace and actor. ClickUp's webhook ID plus history item ID forms the replay key; exact body digest is used if no history IDs exist. Storage is bounded to 5000 hints per partition, with seven-day expiry. It acknowledges only after successful persistence. No raw comments, descriptions, attachments or secret values are persisted in the event store.

The Worker has no public event-listing route. The Workspace attention report optionally includes up to ten recently changed tasks, verified through fresh upstream task reads with the caller's OAuth token. It reports incomplete coverage on denied tasks and storage errors. It does not label these changes as actual Inbox items, and explicit List-scoped reports do not receive Workspace hints. Subscription creation, rotation and deletion via MCP remain subsequent work. No live webhook registration or secret configuration has been performed.

References: https://developer.clickup.com/docs/webhooks, https://developer.clickup.com/docs/webhooksignature, https://developer.clickup.com/docs/webhookhealth.
