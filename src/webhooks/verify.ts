/**
 * Webhook signature verification.
 *
 * A webhook endpoint that skips verification is an open door to anyone who can
 * guess the URL — and this one spawns durable state and burns model tokens per
 * request, so it is worth doing properly.
 *
 * Both providers here sign with HMAC-SHA256 over the raw body. The raw body must
 * be used, not a re-serialised object, because key order would change the bytes.
 */

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Constant-time compare so a timing side channel cannot leak the signature. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) return null;
  const pairs = hex.match(/.{2}/g);
  if (!pairs) return null;
  return Uint8Array.from(pairs, (byte) => Number.parseInt(byte, 16));
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacSha256(
  secret: string,
  message: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
}

/**
 * PagerDuty v3 webhooks send `X-PagerDuty-Signature: v1=<hex>[,v1=<hex>]`.
 * Multiple signatures appear during secret rotation, so any match is accepted.
 */
async function verifyPagerDuty(
  request: Request,
  raw: string,
  secret: string
): Promise<VerifyResult> {
  const header = request.headers.get("X-PagerDuty-Signature");
  if (!header) return { ok: false, reason: "missing X-PagerDuty-Signature" };

  const expected = await hmacSha256(secret, raw);
  const candidates = header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => hexToBytes(s.slice(3)))
    .filter((b): b is Uint8Array => b !== null);

  if (candidates.length === 0)
    return { ok: false, reason: "no v1 signature in header" };
  for (const c of candidates) {
    if (timingSafeEqual(c, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/**
 * Jira automation webhooks do not sign by default. Where a secret is configured
 * on the automation rule, it arrives base64-encoded in `X-Hub-Signature-256` as
 * `sha256=<base64>`. Where no secret is set we fall back to a shared token in
 * the URL query, which is weaker but still better than an open endpoint.
 */
async function verifyJira(
  request: Request,
  raw: string,
  secret: string
): Promise<VerifyResult> {
  const header = request.headers.get("X-Hub-Signature-256");
  if (header) {
    const value = header.startsWith("sha256=")
      ? header.slice("sha256=".length)
      : header;
    const provided = hexToBytes(value) ?? base64ToBytes(value);
    if (!provided) return { ok: false, reason: "unparseable signature" };
    const expected = await hmacSha256(secret, raw);
    return timingSafeEqual(provided, expected)
      ? { ok: true }
      : { ok: false, reason: "signature mismatch" };
  }

  const token = new URL(request.url).searchParams.get("token");
  if (!token) return { ok: false, reason: "missing signature and token" };
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(secret);
  return timingSafeEqual(a, b)
    ? { ok: true }
    : { ok: false, reason: "bad token" };
}

export async function verifyWebhook(
  provider: string,
  request: Request,
  raw: string,
  env: Env
): Promise<VerifyResult> {
  // Local development convenience: with no secret configured, accept unsigned
  // requests so `curl` against `wrangler dev` works. Fails closed in production
  // because the deploy sets the secret.
  const secret =
    provider === "pagerduty"
      ? env.PAGERDUTY_WEBHOOK_SECRET
      : provider === "jira"
        ? env.JIRA_WEBHOOK_SECRET
        : undefined;

  if (!secret) {
    if (env.ALLOW_UNSIGNED_WEBHOOKS === "true") return { ok: true };
    return { ok: false, reason: `no secret configured for ${provider}` };
  }

  switch (provider) {
    case "pagerduty":
      return verifyPagerDuty(request, raw, secret);
    case "jira":
      return verifyJira(request, raw, secret);
    default:
      return { ok: false, reason: `unknown provider ${provider}` };
  }
}
