/**
 * Secrets are not declared in wrangler.jsonc (they are set with
 * `wrangler secret put`), so wrangler cannot generate types for them. Merge them
 * into the generated Env interface here.
 *
 * Both are optional: local dev runs without them and falls back to
 * ALLOW_UNSIGNED_WEBHOOKS, while a deploy sets them and webhook verification
 * becomes mandatory.
 */
declare namespace Cloudflare {
  interface Env {
    PAGERDUTY_WEBHOOK_SECRET?: string;
    JIRA_WEBHOOK_SECRET?: string;
  }
}

interface Env {
  PAGERDUTY_WEBHOOK_SECRET?: string;
  JIRA_WEBHOOK_SECRET?: string;
}
