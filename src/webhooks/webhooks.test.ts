import { describe, expect, it } from "vitest";

import { normalizeJira, normalizePagerDuty } from "./normalize";
import { verifyWebhook } from "./verify";

/**
 * These cover the two places a webhook endpoint actually goes wrong: accepting a
 * request it should have rejected, and mangling a provider payload into a bad
 * agent name. Both are cheap to test and neither needs Cloudflare credentials.
 */

const SECRET = "test-secret-value";

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { method: "POST", headers });
}

describe("verifyWebhook — PagerDuty", () => {
  const env = { PAGERDUTY_WEBHOOK_SECRET: SECRET } as unknown as Env;
  const body = JSON.stringify({ event: { data: { id: "1" } } });

  it("accepts a correct signature", async () => {
    const sig = await sign(SECRET, body);
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty", {
        "X-PagerDuty-Signature": `v1=${sig}`
      }),
      body,
      env
    );
    expect(r.ok).toBe(true);
  });

  it("accepts when one of several rotated signatures matches", async () => {
    const good = await sign(SECRET, body);
    const bad = "a".repeat(64);
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty", {
        "X-PagerDuty-Signature": `v1=${bad},v1=${good}`
      }),
      body,
      env
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const sig = await sign("some-other-secret", body);
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty", {
        "X-PagerDuty-Signature": `v1=${sig}`
      }),
      body,
      env
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a tampered body even with a signature that was valid for the original", async () => {
    const sig = await sign(SECRET, body);
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty", {
        "X-PagerDuty-Signature": `v1=${sig}`
      }),
      body.replace('"1"', '"2"'),
      env
    );
    expect(r.ok).toBe(false);
  });

  it("rejects a missing header", async () => {
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty"),
      body,
      env
    );
    expect(r.ok).toBe(false);
  });

  it("fails closed when no secret is configured and unsigned is not allowed", async () => {
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty"),
      body,
      {} as Env
    );
    expect(r.ok).toBe(false);
  });

  it("allows unsigned only when explicitly opted in (local dev)", async () => {
    const r = await verifyWebhook(
      "pagerduty",
      req("https://x/webhooks/pagerduty"),
      body,
      {
        ALLOW_UNSIGNED_WEBHOOKS: "true"
      } as Env
    );
    expect(r.ok).toBe(true);
  });
});

describe("verifyWebhook — Jira", () => {
  const env = { JIRA_WEBHOOK_SECRET: SECRET } as unknown as Env;
  const body = JSON.stringify({ issue: { key: "OPS-1" } });

  it("accepts a hex signature", async () => {
    const sig = await sign(SECRET, body);
    const r = await verifyWebhook(
      "jira",
      req("https://x/webhooks/jira", {
        "X-Hub-Signature-256": `sha256=${sig}`
      }),
      body,
      env
    );
    expect(r.ok).toBe(true);
  });

  it("falls back to a URL token when the rule sends no signature", async () => {
    const r = await verifyWebhook(
      "jira",
      req(`https://x/webhooks/jira?token=${SECRET}`),
      body,
      env
    );
    expect(r.ok).toBe(true);
  });

  it("rejects a wrong URL token", async () => {
    const r = await verifyWebhook(
      "jira",
      req("https://x/webhooks/jira?token=nope"),
      body,
      env
    );
    expect(r.ok).toBe(false);
  });
});

describe("verifyWebhook — unknown provider", () => {
  it("rejects", async () => {
    const r = await verifyWebhook(
      "github",
      req("https://x/webhooks/github"),
      "{}",
      {
        PAGERDUTY_WEBHOOK_SECRET: SECRET
      } as Env
    );
    expect(r.ok).toBe(false);
  });
});

describe("normalizePagerDuty", () => {
  it("extracts a URL-safe key and flattens context into the description", () => {
    const out = normalizePagerDuty({
      event: {
        event_type: "incident.triggered",
        data: {
          id: "PABC123",
          number: 4821,
          title: "Tunnel down in region A",
          urgency: "high",
          html_url: "https://acme.pagerduty.com/incidents/PABC123",
          service: { summary: "edge-gateway" },
          priority: { summary: "P1" }
        }
      }
    });

    expect(out).not.toBeNull();
    expect(out!.key).toBe("pd-4821");
    expect(out!.key).toMatch(/^[a-z0-9-]+$/); // safe as an agent instance name
    expect(out!.severity).toBe("P1");
    expect(out!.source).toBe("pagerduty");
    expect(out!.description).toContain("edge-gateway");
    expect(out!.description).toContain("incident.triggered");
  });

  it("falls back to urgency when no priority is set", () => {
    const out = normalizePagerDuty({
      event: { data: { id: "P1", number: 7, title: "x", urgency: "low" } }
    });
    expect(out!.severity).toBe("low");
  });

  it("returns null for a payload that is not a PagerDuty event", () => {
    expect(
      normalizePagerDuty({ hello: "world" } as unknown as Parameters<
        typeof normalizePagerDuty
      >[0])
    ).toBeNull();
  });
});

describe("normalizeJira", () => {
  it("lowercases the issue key and flattens ADF descriptions to text", () => {
    const out = normalizeJira({
      webhookEvent: "jira:issue_created",
      issue: {
        key: "OPS-142",
        fields: {
          summary: "Routing churn in cluster 3",
          priority: { name: "High" },
          issuetype: { name: "Incident" },
          project: { name: "Operations" },
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Sessions resetting" },
                  { type: "text", text: " every 30s" }
                ]
              }
            ]
          }
        }
      }
    });

    expect(out!.key).toBe("ops-142");
    expect(out!.severity).toBe("High");
    expect(out!.source).toBe("jira");
    expect(out!.description).toContain("Sessions resetting");
    expect(out!.description).toContain("every 30s");
    // The ADF tree must not leak into the prompt as JSON.
    expect(out!.description).not.toContain('"type"');
  });

  it("tolerates a missing description", () => {
    const out = normalizeJira({
      issue: { key: "OPS-9", fields: { summary: "t" } }
    });
    expect(out!.title).toBe("t");
  });

  it("returns null when there is no issue key", () => {
    expect(normalizeJira({ issue: { fields: {} } })).toBeNull();
  });
});
