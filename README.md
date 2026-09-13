# Incident Investigator Agent

A durable, webhook-triggered incident investigation agent built on Cloudflare.

A page fires in PagerDuty or a ticket lands in Jira. A durable agent instance
spins up for that specific incident, runs a five-phase investigation where each
phase is a retryable step, keeps its findings in its own colocated SQLite
database, and lets an on-call engineer watch the phases land in real time and
correct the agent mid-flight.

Built as the Cloudflare AI-powered application assignment.

---

## Why this problem

Most incident tooling summarises. Summarising is the easy half.

The hard half is the discipline an experienced on-call engineer applies: scope the
blast radius **before** theorising, gather named evidence rather than vibes, rank
hypotheses with a falsification test for each, and then actually run the
verification step instead of promoting the most fluent-sounding theory to root
cause. An LLM left to its own devices skips straight to a confident answer, which
is precisely the failure mode that makes engineers stop trusting the tool.

So the investigation here is a **structured workflow with a forced verification
phase**, not a single prompt. The model fills in each phase; the structure stops
it from short-circuiting; the engineer can override any phase from chat.

## Required components

| Requirement                 | How it is implemented                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **LLM**                     | Workers AI, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — called per phase in the Workflow and for the chat loop                                       |
| **Workflow / coordination** | A Cloudflare **Workflow** (`RcaWorkflow`) runs the five phases as durable `step.do()` calls, plus **Durable Objects** for per-incident agent identity |
| **User input via chat**     | Pages-served React chat over the Agents SDK WebSocket transport (`useAgent` / `useAgentChat`)                                                         |
| **Memory / state**          | Each agent instance's own SQLite: `phases`, `findings`, `runbooks`, `timeline`, plus `setState` for the incident header                               |

## Architecture

```
 PagerDuty webhook ─┐
                    ├─► Worker fetch()
 Jira webhook ──────┘     │ 1. verify HMAC signature (fails closed)
                          │ 2. normalise provider payload
                          │ 3. derive a URL-safe incident key
                          │
                          └─► getAgentByName(IncidentAgent, "pd-4821")
                                  │   one durable instance per incident
                                  │
                                  ├── SQLite ── phases · findings · runbooks · timeline
                                  │
                                  ├── runWorkflow("RCA_WORKFLOW")
                                  │      │
                                  │      ├─ step: load runbooks from agent SQL
                                  │      ├─ step: triage      ─┐
                                  │      ├─ step: gather       │ each step is durable,
                                  │      ├─ step: hypothesize  │ retried 3× with backoff,
                                  │      ├─ step: verify       │ and recorded back into
                                  │      └─ step: rca         ─┘ the agent via RPC
                                  │
                                  ├── onWorkflowProgress() → broadcast() → live phase view
                                  └── onChatMessage()      → engineer steers, with tools
                                                              (queryMetric, searchLogs,
                                                               recordFinding, saveRunbook)
```

### Why a Workflow rather than a loop in the agent

An investigation is long-lived and its expensive steps are flaky. A page can fire
at 03:00 and sit for an hour; a model call can rate-limit; an isolate can be
evicted between phases. Running the phases as Workflow steps means Cloudflare
persists each completed phase and retries only the step that failed — losing four
finished phases because the fifth model call timed out would be a much worse
product. Scheduling (`this.schedule`) is used for time-based nudges instead; the
two primitives solve different problems.

### The model call lives on the agent, not in the Workflow

The Workflow orchestrates phases; the **agent** makes the model call
(`IncidentAgent.runPhaseModel`). That split was forced by a real constraint and
then turned out to be the better design.

The constraint: the AI binding is remote (Workers AI has no local simulation)
while Workflows always execute locally. In local development the remote proxy is
not plumbed into a Workflow's execution context, so `env.AI.run()` inside a
`step.do()` fails with an opaque `internal error; reference = …`. The identical
call from the Worker's fetch handler and from the Durable Object succeeds. Moving
model access onto the agent fixed it — and it is cleaner anyway: one component
owns model access, another owns sequencing.

Worth knowing if you build on this: an opaque Workers AI `internal error` inside a
Workflow step is more likely a binding-context problem than a bad prompt. Isolating
the same call from `fetch()` distinguishes them in about a minute.

### Why one agent per incident

The agent instance name _is_ the incident key, so `pd-4821` has its own durable
identity, its own SQLite database, and its own conversation. Two incidents cannot
contaminate each other's findings, and the record survives hibernation between the
page firing and someone picking it up. This is what makes "memory" mean something
more than a chat scrollback.

## The five phases

| Phase           | Question it answers                                                        | Deliberate constraint                                                                  |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Triage**      | What is affected, what is verifiably _not_ affected, is the severity right | Forbidden from proposing causes                                                        |
| **Gather**      | Which metrics, log patterns and windows to pull                            | Must be concrete enough to run without a follow-up question                            |
| **Hypothesize** | Two or three ranked candidate causes                                       | Each needs a falsification test                                                        |
| **Verify**      | Does the evidence support the leading hypothesis                           | Must pick support / contradict / insufficient — hedging across all three is disallowed |
| **RCA**         | The writeup                                                                | Inconclusive findings go under "What we do not know", not softened into the cause      |

`Verify` exists because it is the phase an LLM most wants to skip.

## Agent Skills

`src/skills/*/SKILL.md` holds the investigation playbooks — `triage`,
`tunnel-down`, `routing-instability` — as on-demand instructions in Cloudflare's
Agent Skills layout. Each encodes ordering (check reachability before protocol
state), scoping questions (one peer or many), and the traps that produce wrong
conclusions (a tunnel flapping faster than the scrape interval reads as healthy;
reset counts without a time base are meaningless).

## Running it

Workers AI has **no local simulation** — [the docs are explicit about
this](https://developers.cloudflare.com/workers/local-development/), and setting
`remote: false` on the binding is an error — so the `ai` binding always proxies to
the real service. A Cloudflare account is therefore required even for local
development. The free plan is sufficient.

Durable Objects and Workflows are the opposite: they are always local and cannot be
made remote. So in dev, the agent and the workflow run on your machine while only
the model call leaves it.

```sh
npm install
npx wrangler login        # free account is fine
npm run dev               # http://localhost:8787
```

`npm run dev` runs `wrangler dev` rather than `vite dev`. That is deliberate: the
Vite plugin opens a remote proxy session for the AI binding, which additionally
requires a workers.dev subdomain to be registered on the account, and fails with

```
You need to register a workers.dev subdomain before running the dev command in
remote mode  (API error 10063 on /workers/subdomain/edge-preview)
```

`wrangler dev` needs no such subdomain and gives exactly the bindings this project
wants:

```
env.IncidentAgent   Durable Object   local
env.RCA_WORKFLOW    Workflow         local
env.AI              AI               remote
```

The agent and the workflow run on your machine; only the model call leaves it. If
you want the Vite dev server with hot module reloading for UI work, register a
subdomain and use `npm run dev:vite`.

Send a synthetic incident:

```sh
./seeds/send.sh pagerduty-tunnel-down.json
./seeds/send.sh jira-routing-churn.json
```

Each returns the incident key and the workflow instance it started:

```json
{
  "accepted": true,
  "incident": "pd-4821",
  "ok": true,
  "instanceId": "wf_dsa2I-FAoeIdm7L5wZskz"
}
```

### Watching it work

`npm run walkthrough` narrates a whole investigation in the terminal — it posts a
synthetic incident, then prints each phase as it lands with the model's actual
output:

```sh
npm run dev                      # terminal 1
npm run walkthrough              # terminal 2  (PagerDuty seed)
node scripts/walkthrough.mjs jira
```

```
1. A monitoring system raises an incident
   title:    Tunnel sessions dropping in region alpha

2. It arrives at the agent
   accepted  incident pd-4821
   workflow instance wf_CMoDMViT0K9bSnechNyZM

3. Five phases run, each a durable retryable step
──────────────────────────────────────────────────────────────
TRIAGE  (1/5, 5s)
   asks: What is affected, and what is verifiably not?

   Tunnel sessions in region alpha are affected, with a 40% drop in
   expected peers. The standby path appears unaffected. …
──────────────────────────────────────────────────────────────
HYPOTHESIZE  (3/5, 10s)
   asks: What could be causing this? Ranked, each falsifiable.

   1. BGP session reset issue: … Falsification - No increase in
      bgp_session_resets during tunnel session drops. …
──────────────────────────────────────────────────────────────

4. It is all persisted in this incident's own database
   status:   rca-ready
   phases:   5/5 done
   timeline:
     21:47:28  pagerduty  Incident ingested: Tunnel sessions dropping…
     21:47:43  agent      Investigation complete; draft RCA ready…
```

A full run takes about 15 seconds.

Or inspect an incident directly:

```sh
curl http://localhost:8787/api/incident/pd-4821 | jq
```

Then open the UI to chat with that incident. You can interrupt at any point and
tell the agent it is wrong; corrections take precedence over its own prior output.

### Tests

```sh
npm test
```

17 unit tests over the parts most likely to be silently wrong: HMAC verification
(including body tampering, signature rotation, and fail-closed behaviour when no
secret is configured) and provider payload normalisation (including flattening
Jira's ADF description trees so they do not reach the prompt as raw JSON). They
run in plain Node with no Cloudflare account and no network, which is why
`vitest.config.ts` deliberately does not load the app's vite config.

### Deploying

```sh
npx wrangler secret put PAGERDUTY_WEBHOOK_SECRET
npx wrangler secret put JIRA_WEBHOOK_SECRET
npm run deploy
```

Point PagerDuty at `https://<worker>/webhooks/pagerduty` and a Jira automation
rule at `https://<worker>/webhooks/jira`. Unsigned requests are rejected in
production: `ALLOW_UNSIGNED_WEBHOOKS` exists only in the local dev vars.

## Security notes

- Webhook signatures are verified with HMAC-SHA256 over the **raw** body, compared
  in constant time. Re-serialising the JSON first would change the bytes and break
  verification.
- Missing secret plus no explicit opt-in means **reject**, not accept.
- The `saveRunbook` chat tool is gated behind `needsApproval` — the model writing
  to durable state on its own initiative should need a human nod.
- Observability tools (`queryMetric`, `searchLogs`) are stubbed with synthetic
  data. That is a deliberate scope decision, not an oversight: wiring them to a
  real metrics backend would mean putting an employer's endpoints and credentials
  in a public repository.

## What is deliberately not here

- **Real observability backends.** Stubbed, for the reason above. The MCP client
  path (`addMcpServer`) is wired, so pointing it at a real Prometheus MCP server
  is a config change rather than a rewrite.
- **Voice.** Cloudflare Realtime would fit the 03:00 use case well and is the
  first thing I would add next. Chat came first because it is where correction
  and steering actually happen.
- **Write-back to PagerDuty / Jira.** The RCA is drafted and stored; posting it
  back is an API call away but needs a token I would not commit.
- **Multi-tenant auth.** Single-tenant demo.

## Prompt history

The assignment asks for prompt history. `docs/prompt-history.md` is the real
session log, extracted from the Claude Code transcript by
`scripts/export-prompt-history.mjs` and redacted by the rules in that script
(employer names, internal system and metric names, ticket ids, hosts, credentials).
Regenerate with `npm run prompt-history`.

It is worth reading for the corrections rather than the successes — the places
where the model's first answer was wrong and had to be redirected are the parts
that show how the work was actually steered.

## Layout

```
src/
  server.ts              IncidentAgent + Worker entrypoint and webhook routes
  workflow.ts            RcaWorkflow — the five durable phases
  prompts.ts             model id, system prompt, one prompt per phase
  types.ts               phases, incident state, workflow params
  webhooks/
    verify.ts            HMAC-SHA256 signature verification, constant-time
    normalize.ts         PagerDuty and Jira payloads → one internal shape
    webhooks.test.ts     17 unit tests
  skills/*/SKILL.md      investigation playbooks
  app.tsx, client.tsx    chat UI
seeds/                   synthetic incidents + sender script
scripts/                 prompt-history export
docs/prompt-history.md   generated, redacted
```

## License

MIT
