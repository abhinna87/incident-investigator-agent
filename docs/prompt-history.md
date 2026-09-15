# Prompt history

**This document is curated, not a verbatim transcript.** Cloudflare's assignment
asks for prompt history alongside the code. Rather than dump the raw session — most
of which is UI-scoped back-and-forth about run commands and CSS — this is the
subset of prompts and decisions that actually shaped the submission, with the
model's mistake and how it was corrected recorded next to each one.

The raw-extraction script (`scripts/export-prompt-history.mjs`) is still in the
repo; running it against the source JSONL produces the full session, redacted by
the same rules used here (employer names, internal codenames, ticket IDs,
credentials, private IPs). Both files are available; this one is the one worth
reading.

Model: Claude (via Claude Code). The prompts below are mine; the assistant work
they steer is what became this repo.

---

## 1. Choose the problem — a real one, in a domain I know

> "Cloudflare has a fast-track assignment: build an AI-powered application on their
> platform. I want to build something I can defend in an interview, not a generic
> chat demo. My team at work runs a production AI debugging agent on top of a
> different stack (LangChain deepagents + Bedrock, with skill workflows and MCP
> tools). Design a Cloudflare-native mirror of that pattern. What are the concrete
> mappings, and what have I got that most candidates won't?"

**What that produced.** A design document mapping every piece of my team's system
to a Cloudflare primitive: skill workflows → Agent Skills (same `SKILL.md`
layout), MCP tools → Agents SDK's `addMcpServer` client, the async
`investigate_alert` job → `runWorkflow` + `onWorkflowProgress`, filesystem
context → each Durable Object's own SQLite. The interview story writes itself:
"I architected this shape in production; here it is on your primitives; here's
what your platform made easier and what I would want changed."

**Correction that mattered.** The first draft suggested using Workflows _or_
Durable Objects. The docs page listing coordination primitives called out both, so
I pushed back: "the assignment lists three primitives (Workers/DO/Workflows), use
two so the completeness signal is unambiguous." The final design uses both — DO
for per-incident identity and memory, Workflow for the retryable multi-step
investigation.

---

## 2. Read the docs deeply before writing code

> "Don't scaffold yet. Fetch the actual Cloudflare Agents docs — API reference,
> WebSocket page, scheduling, state, webhook channel, MCP-as-client, Workflow
> integration. Quote the real code. I don't want to build against marketing
> overviews and then rewrite when the API isn't what we assumed."

**What that produced.** Concrete, quoted API surface before a single file was
written: `import { Agent, routeAgentRequest, callable } from "agents"`, the exact
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` model id, the `useAgent` / `useAgentChat`
React hooks, the `new_sqlite_classes` migration line, `getSkills()` returning a
skill catalogue, `runWorkflow()` + `onWorkflowProgress()` for coordination, and
the fact that Workers AI has _no local simulation_ and always proxies remote.

**Correction that mattered.** The initial docs pass returned an overview page
summary. I rejected it: "that's marketing, not the API. Give me the pages under
`/agents/runtime/*` and quote real code." Without that push we would have written
against imagined signatures.

---

## 3. The five-phase structure, with `verify` as a separate step

> "Design the investigation as phases. But an LLM asked to both propose and check
> a hypothesis will ratify itself — that's the failure mode that makes engineers
> stop trusting these tools. Separate them. Force a verification phase whose only
> job is to say support / contradict / not enough evidence, no hedging across all
> three. Write per-phase prompts that make each phase narrow."

**What that produced.** `src/prompts.ts` — one prompt per phase, each with word
limits and shape constraints. Triage is forbidden from proposing causes. Gather
must be concrete enough to run without follow-up. Hypothesize must include a
falsification test for each candidate. Verify must pick one of three verdicts
without hedging. RCA must put gaps under _What we do not know_ rather than
softening the leading cause.

**Correction that mattered.** First draft of `verify` allowed "possibly supported,
possibly contradicted" as an answer. Removed. Adding the explicit "you may not
hedge across all three" line is what makes the phase adversarial rather than
another summarisation step.

---

## 4. Workflow, not agent loop, for the durable path

> "Should the phase loop be inside the agent or a Workflow? Argue both sides. I
> care about what happens when the isolate is evicted between phases and when the
> model call rate-limits."

**What that produced.** Workflow. Each phase is a `step.do()` with `retries:
{ limit: 3, backoff: "exponential" }`. If the model call fails on phase 3, the
runtime retries phase 3, not phases 1-2. If the isolate is evicted at 03:00 and
the agent wakes at 08:00, the completed phases are still recorded. Scheduling
(`this.schedule`) is used for time-based nudges instead — different primitive,
different job.

---

## 5. The version red-herring scenario — testing the design against a real case

> "Real incident from work: routing peers in a reset loop, one large tenant. A
> version upgrade landed nine days earlier and is the obvious suspect. It's
> wrong — the tenant ran that version fine for eight days, rollback didn't stop
> the loop, the fleet grew 20% in the same window, and only this tenant lacks a
> route-suppression profile. The real cause is per-reconnect work growing
> faster-than-linear with peer count until it crosses a 30s hold timer. Build
> this as a synthetic scenario. Fictionalise everything (tenant name, ticket ID,
> version numbers). I want to see whether the agent avoids the bait."

**What that produced.** `seeds/pagerduty-reset-loop.json` +
`src/skills/reset-loop/SKILL.md` + a scenario-specific signal set in
`src/workflow.ts` shaped so the version correlation is present _and_ the scale
correlation is present. The description explicitly names the version upgrade as
"the obvious suspect" — bait the model would only decline for the right reason.

**Correction that mattered — twice.** First run went smoothly, hypothesize never
mentioned the version, I wrote in the README "the guardrails work, it doesn't
blame the version." I pushed back on myself: "that's n=1, run it again before you
publish." Second run led with the version. Verify caught it both times, but the
generation phase is _not_ consistent. Corrected the README to reflect two runs
and named a real weakness the second run exposed: after verify rejected the
version, the RCA promoted a _different_ unsupported hypothesis (network packet
loss) — the writeup reads earlier phases but is not currently forced to carry
verify's verdict forward.

---

## 6. Debug — model calls fail inside the Workflow step

> "Full pipeline runs, all five phases execute, but every model call inside
> `step.do()` returns `internal error; reference = ...` from Workers AI. The
> identical call from a `fetch()` handler works. Isolate it before we ship."

**What that produced.** A temporary `/debug/ai` route testing the same input
shape from three call sites: Worker fetch handler (works), a Durable Object RPC
(works), a Workflow step (fails). The AI binding is remote (no local simulation)
while Workflows always execute locally, and the remote proxy is not plumbed into
a Workflow's execution context in local dev.

**Fix.** Move model access to the agent (`IncidentAgent.runPhaseModel`); the
Workflow calls it over RPC. The Workflow keeps sequencing and durability; the
agent owns model access. Also the better separation of concerns regardless of the
platform quirk. Documented in the README under "why model access lives on the
agent".

---

## 7. Debug — wrong response envelope

> "The RCA has raw JSON leaking in. What is the actual response shape from
> `@cf/meta/llama-3.3-70b-instruct-fp8-fast`?"

**What that produced.** Llama 3.3 with a `messages` array returns
`choices[0].message.content` (OpenAI-shaped). My first extractor only handled
`{ response }` and fell through to `JSON.stringify` on everything else — which
was writing the full envelope into the RCA text. Would not have failed any test
because "resume: 8235 chars" is a valid response shape and passes the
type check.

**Fix.** `extractModelText()` in `src/server.ts` handles both envelopes. Would
not have caught this by reading the docs — it required actually running the model
and inspecting the output.

---

## 8. Rule: assert that edits applied

> "You just said 'success' but the ingest call is unchanged. Every edit you make
> from now on that must apply, assert it did. `assert old in s, 'anchor missing'`
> before write."

**Context.** A Python edit-script `.replace()`'d a string that wasn't present, so
the demo endpoint's `agent.ingest(incident)` never received the scenario hint. The
Workflow saw `scenario = undefined` and used the default signal set instead of the
adversarial one, and I only caught it by logging `params.scenario` at workflow
start. The transcript "success" was silent when the pattern hadn't matched.

**Rule now applied everywhere I do search-and-replace against source: match must
be non-empty; abort otherwise.**

---

## 9. Webhook signatures — real, not decorative

> "Verify PagerDuty and Jira webhook signatures properly: HMAC-SHA256 over the raw
> body, constant-time compare, fail-closed when no secret is configured, tolerate
> signature rotation. Write tests that would catch a body-tamper-with-preserved-
> signature. Local dev needs an explicit opt-in flag to accept unsigned; prod
> rejects."

**What that produced.** `src/webhooks/verify.ts` + 17 tests covering: correct
signature, rotation (two `v1=...` values, either matches), wrong signature,
tampered body with the signature that was valid for the _original_ body, missing
header, unknown provider, fail-closed with no secret, opt-in bypass for local
dev, Jira hex and URL-token fallbacks. The tests deliberately don't load the
Cloudflare vite plugin (see `vitest.config.ts`) so they run without an account.

---

## 10. `any` → structural types → real latent bug

> "Replace `any` in the webhook normalisers with structural types describing only
> the fields we actually read."

**What that produced.** `PagerDutyPayload` and `JiraPayload` interfaces with every
field optional (untrusted input). TypeScript then rejected
`payload.event.event_type` — legitimately, because `data` being present did not
guarantee `event` was. `any` had hidden a real crash on malformed payloads.

**Fix.** Optional-chain. Not a stylistic tightening — the stricter typing found a
bug.

---

## 11. UI empty state — the recruiter test

> "The panel shows nothing on a fresh clone. That's the first thing anyone
> evaluating this hits. Detect empty state and offer buttons that fire the
> synthetic incidents directly from the UI, no terminal needed. Restrict the
> endpoint to the two known scenarios; it must not become a way to inject
> arbitrary incidents into a deployed instance."

**What that produced.** `POST /api/demo?scenario=pagerduty|jira|reset-loop` with
inlined payloads (Workers have no filesystem) and a fixed scenario list. Panel
detects `!data || phases.every(pending)` and renders `<DemoButtons>`; clicking
fires the endpoint and navigates to the incident so both the chat socket and the
panel re-attach.

---

## 12. Markdown asterisks in phase output — fix at both ends

> "The phase output is showing literal `**bold**` in the UI. Fix the prompt to
> forbid markdown, and strip it on display anyway — output already in the
> database should read cleanly without re-running any investigation."

**What that produced.** Explicit "no markdown, ever, output is shown in a
monospace pane" rule in the house style, plus `src/markdown.ts` (used by
`PhasePanel` and by the terminal walkthrough). Seven tests over real samples
from live runs, including that a lone asterisk in `"rate is 3 * 4"` survives.

---

## 13. Prompt history — treat it as a first-class deliverable

> "Cloudflare wants prompt history submitted alongside code. Write it as a
> curated document showing where the model was wrong and how I steered it, not a
> raw transcript. Bake a redaction check into the extractor so employer names,
> internal codenames, ticket IDs, and credentials can't slip through."

**What that produced.** This file, plus `scripts/export-prompt-history.mjs` for
the raw path if a reader wants it. The extractor exits non-zero if any of the
redaction patterns still matches its own output — belt-and-suspenders. Both files
are in the repo; this is the one worth reading.

---

## What is deliberately NOT in this history

- **Presentation and UX iteration.** README wording, header spacing, button
  copy, screenshot layout. Real work, uninteresting.
- **Test scaffolding and CI plumbing.** Necessary, mechanical.
- **Terminal-command fumbling.** Where I typed `vite dev` and got a
  workers.dev-subdomain error, then switched to `wrangler dev`, then made
  `npm run dev` do the right thing. Documented in the README, not worth
  narrating.
- **An unrelated project sharing the same Claude Code session.** Different
  problem, different repo; dropped entirely from this file so the record is
  about the Cloudflare submission and nothing else.

If a raw dump was expected, run `scripts/export-prompt-history.mjs
<transcript.jsonl> --out docs/prompt-history.raw.md`.
