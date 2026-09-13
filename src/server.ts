import { createWorkersAI } from "workers-ai-provider";
import { callable, getAgentByName, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

import { MAX_PHASE_TOKENS, MODEL, SYSTEM_PROMPT } from "./prompts";
import { verifyWebhook } from "./webhooks/verify";
import {
  normalizeJira,
  normalizePagerDuty,
  type IncidentInput,
  type JiraPayload,
  type PagerDutyPayload
} from "./webhooks/normalize";
import type { PhaseName, PhaseRecord, IncidentState } from "./types";
import { PHASES } from "./types";

/**
 * One IncidentAgent instance per incident.
 *
 * Routing an incident to its own durable instance is what makes the "memory"
 * requirement real: the agent for INC-123 keeps that incident's findings,
 * conversation and runbook lookups in its own colocated SQLite database, and
 * survives hibernation between the page firing and an engineer picking it up
 * hours later.
 */
export class IncidentAgent extends AIChatAgent<Env, IncidentState> {
  maxPersistedMessages = 200;
  chatRecovery = true;
  waitForMcpConnections = true;

  initialState: IncidentState = {
    incidentKey: "",
    title: "",
    source: "manual",
    severity: "unknown",
    status: "new",
    currentPhase: null,
    workflowInstanceId: null,
    openedAt: null
  };

  /**
   * Schema lives here rather than in a migration file because a Durable Object's
   * SQLite database is created lazily per instance — there is no central schema
   * to migrate. `IF NOT EXISTS` makes this idempotent across hibernation wakes.
   */
  async onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phase TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        confidence REAL DEFAULT 0,
        created_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS phases (
        name TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        output TEXT
      )
    `;
    // Runbooks are intentionally per-incident-agent rather than global: an
    // engineer pastes the runbook that is relevant to *this* incident, and it
    // stays attached to it for the postmortem.
    this.sql`
      CREATE TABLE IF NOT EXISTS runbooks (
        name TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        saved_at TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor TEXT NOT NULL,
        event TEXT NOT NULL
      )
    `;
  }

  // ---------------------------------------------------------------------------
  // Webhook intake
  // ---------------------------------------------------------------------------

  /**
   * Called by the Worker after signature verification. Seeds incident state and
   * kicks off the investigation workflow.
   */
  async ingest(input: IncidentInput) {
    const now = new Date().toISOString();

    this.setState({
      ...this.state,
      incidentKey: input.key,
      title: input.title,
      source: input.source,
      severity: input.severity,
      status: "investigating",
      openedAt: this.state.openedAt ?? now
    });

    this.note(input.source, `Incident ingested: ${input.title}`);

    for (const phase of PHASES) {
      this.sql`
        INSERT INTO phases (name, status) VALUES (${phase}, 'pending')
        ON CONFLICT(name) DO NOTHING
      `;
    }

    // The five-phase RCA is a Workflow rather than an inline loop so each phase
    // is a durable step: if a model call fails or the isolate is evicted
    // mid-investigation, Cloudflare retries that step instead of restarting the
    // whole investigation.
    const instanceId = await this.runWorkflow("RCA_WORKFLOW", {
      incidentKey: input.key,
      title: input.title,
      description: input.description,
      severity: input.severity,
      source: input.source,
      agentName: input.key
    });

    this.setState({ ...this.state, workflowInstanceId: instanceId });
    return { ok: true, instanceId };
  }

  // ---------------------------------------------------------------------------
  // Workflow callbacks — these are what drive the live phase view in the UI
  // ---------------------------------------------------------------------------

  async onWorkflowProgress(
    _workflowName: string,
    _instanceId: string,
    progress: unknown
  ) {
    const p = progress as {
      phase?: PhaseName;
      status?: string;
      output?: string;
    };
    if (p.phase) {
      this.setState({ ...this.state, currentPhase: p.phase });
      this.sql`
        UPDATE phases
           SET status = ${p.status ?? "running"},
               output = COALESCE(${p.output ?? null}, output),
               started_at = COALESCE(started_at, ${new Date().toISOString()})
         WHERE name = ${p.phase}
      `;
    }
    this.broadcast(JSON.stringify({ type: "phase-progress", progress }));
  }

  /**
   * Called by the workflow as its final step. Kept separate from
   * onWorkflowComplete because that callback requires the workflow to report
   * completion explicitly, so it cannot be relied on to move the incident out of
   * "investigating".
   */
  async completeInvestigation(rca: string) {
    this.setState({ ...this.state, currentPhase: null, status: "rca-ready" });
    this.note("agent", "Investigation complete; draft RCA ready for review.");
    this.broadcast(
      JSON.stringify({ type: "investigation-complete", rca: rca.slice(0, 400) })
    );
  }

  async onWorkflowComplete(
    _workflowName: string,
    _instanceId: string,
    result: unknown
  ) {
    this.setState({ ...this.state, status: "rca-ready", currentPhase: null });
    this.note("agent", "Investigation complete; draft RCA ready for review.");
    this.broadcast(JSON.stringify({ type: "investigation-complete", result }));
  }

  // ---------------------------------------------------------------------------
  // Methods the Workflow calls back into (RPC), and the UI calls via stub
  // ---------------------------------------------------------------------------

  /** Record a phase result. Called by the Workflow after each step. */
  async recordPhase(phase: PhaseName, output: string, confidence = 0) {
    const now = new Date().toISOString();
    this.sql`
      UPDATE phases SET status='done', finished_at=${now}, output=${output} WHERE name=${phase}
    `;
    this.sql`
      INSERT INTO findings (phase, summary, detail, confidence, created_at)
      VALUES (${phase}, ${output.slice(0, 200)}, ${output}, ${confidence}, ${now})
    `;
    this.broadcast(JSON.stringify({ type: "phase-done", phase, output }));
  }

  @callable()
  async getIncidentState(): Promise<IncidentState> {
    return this.state;
  }

  @callable()
  async getPhases(): Promise<PhaseRecord[]> {
    return this.sql<PhaseRecord>`
      SELECT name, status, started_at, finished_at, output FROM phases
    `;
  }

  @callable()
  async getTimeline() {
    return this
      .sql`SELECT at, actor, event FROM timeline ORDER BY id DESC LIMIT 50`;
  }

  @callable()
  async saveRunbook(name: string, body: string) {
    this.sql`
      INSERT INTO runbooks (name, body, saved_at)
      VALUES (${name}, ${body}, ${new Date().toISOString()})
      ON CONFLICT(name) DO UPDATE SET body=excluded.body, saved_at=excluded.saved_at
    `;
    this.note("engineer", `Runbook saved: ${name}`);
    return { ok: true, name };
  }

  /**
   * Run one phase's model call.
   *
   * This lives on the agent rather than in the Workflow because the AI binding is
   * remote while Workflows execute locally, and in local development the remote
   * proxy is not plumbed into a Workflow's execution context — the call fails
   * there with an opaque "internal error". The agent is a Durable Object that
   * does have access, so the Workflow orchestrates and the agent owns model
   * access. That split is also the cleaner design: one component talks to the
   * model, one decides what order to do things in.
   */
  async runPhaseModel(prompt: string, phase: PhaseName): Promise<string> {
    try {
      const result = await this.env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You are an incident investigation assistant. Be terse and concrete. Never present a guess as a finding."
          },
          { role: "user", content: prompt }
        ],
        // Workers AI defaults max_tokens to 256, which truncates the RCA draft
        // mid-sentence.
        max_tokens: MAX_PHASE_TOKENS,
        temperature: 0.3
      });
      const text = extractModelText(result);
      if (!text) throw new Error("model returned empty output");
      return text;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`phase ${phase}: model call failed: ${reason}`);
      return [
        `_Model unavailable for the ${phase} phase._`,
        "",
        `Reason: ${reason}`,
        "",
        "Other phases are unaffected. Ask in chat to re-run this phase."
      ].join("\n");
    }
  }

  /** Exposed so the Workflow can ground its reasoning in saved runbooks. */
  async listRunbooks(): Promise<Array<{ name: string; body: string }>> {
    return this.sql<{
      name: string;
      body: string;
    }>`SELECT name, body FROM runbooks`;
  }

  private note(actor: string, event: string) {
    this.sql`
      INSERT INTO timeline (at, actor, event)
      VALUES (${new Date().toISOString()}, ${actor}, ${event})
    `;
  }

  // ---------------------------------------------------------------------------
  // Chat — an engineer can steer the investigation mid-flight
  // ---------------------------------------------------------------------------

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const phases = await this.getPhases();
    const runbooks = await this.listRunbooks();

    const result = streamText({
      // Llama 3.3 on Workers AI, as recommended for the assignment.
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: SYSTEM_PROMPT({
        incident: this.state,
        phases,
        runbookNames: runbooks.map((r) => r.name)
      }),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from any connected observability server.
        ...this.mcp.getAITools(),

        queryMetric: tool({
          description:
            "Query a time series for this incident's window. Returns recent datapoints.",
          inputSchema: z.object({
            metric: z
              .string()
              .describe("Metric name, e.g. tunnel_up, bgp_session_state"),
            window: z
              .string()
              .default("1h")
              .describe("Lookback window, e.g. 15m, 1h, 24h")
          }),
          execute: async ({ metric, window }) => mockMetric(metric, window)
        }),

        searchLogs: tool({
          description:
            "Search recent logs for a pattern within this incident's window.",
          inputSchema: z.object({
            pattern: z.string(),
            window: z.string().default("1h")
          }),
          execute: async ({ pattern, window }) => mockLogs(pattern, window)
        }),

        saveRunbook: tool({
          description:
            "Persist a runbook so future phases and future incidents on this agent can use it.",
          inputSchema: z.object({
            name: z.string(),
            body: z.string()
          }),
          // Writing to durable state on the model's initiative is exactly the
          // kind of action that should need a human nod.
          needsApproval: async () => true,
          execute: async ({ name, body }) => this.saveRunbook(name, body)
        }),

        recordFinding: tool({
          description: "Record a finding on the incident record.",
          inputSchema: z.object({
            phase: z.enum(PHASES),
            summary: z.string(),
            confidence: z.number().min(0).max(1).default(0.5)
          }),
          execute: async ({ phase, summary, confidence }) => {
            await this.recordPhase(phase, summary, confidence);
            return { recorded: true };
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

/**
 * Workers AI returns different envelopes depending on the model and input shape.
 * Llama 3.3 with a `messages` array answers OpenAI-style
 * (`choices[0].message.content`); some models and the `prompt` input form answer
 * `{ response }`. Handle both rather than assuming one.
 */
export function extractModelText(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (!result || typeof result !== "object") return "";
  const r = result as {
    response?: string;
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };
  const fromChoices = r.choices?.[0]?.message?.content ?? r.choices?.[0]?.text;
  return (fromChoices ?? r.response ?? "").trim();
}

// ---------------------------------------------------------------------------
// Mock observability. The real deployment would point these at Prometheus and
// a log store; they are stubbed so the demo is self-contained and so this public
// repo carries no employer endpoints or credentials.
// ---------------------------------------------------------------------------

function mockMetric(metric: string, window: string) {
  const now = Date.now();
  const points = Array.from({ length: 12 }, (_, i) => {
    const t = new Date(now - (11 - i) * 5 * 60_000).toISOString();
    // Degrade in the second half so the agent has something to find.
    const healthy = i < 6;
    return { t, v: healthy ? 1 : Math.random() < 0.7 ? 0 : 1 };
  });
  return { metric, window, points, note: "synthetic data for demo" };
}

function mockLogs(pattern: string, window: string) {
  const samples = [
    "hold timer expired, session reset",
    "peer went down: connection reset by peer",
    "tunnel renegotiation failed after 3 attempts",
    "route withdrawal received for prefix batch",
    "health probe timeout on standby path"
  ];
  return {
    pattern,
    window,
    matches: samples
      .filter((s) => s.includes(pattern.toLowerCase()) || pattern === "*")
      .slice(0, 5)
      .map((line, i) => ({
        t: new Date(Date.now() - i * 60_000).toISOString(),
        line
      })),
    note: "synthetic data for demo"
  };
}

/**
 * Synthetic incidents for the demo endpoint, inlined rather than read from
 * seeds/*.json because a deployed Worker has no filesystem. They mirror those
 * files; both are fictional and contain no real service, customer or ticket.
 */
const DEMO_SEEDS: Record<
  string,
  | { source: "pagerduty"; payload: PagerDutyPayload }
  | { source: "jira"; payload: JiraPayload }
> = {
  pagerduty: {
    source: "pagerduty",
    payload: {
      event: {
        event_type: "incident.triggered",
        data: {
          id: "PDEMO01",
          number: 4821,
          title: "Tunnel sessions dropping in region alpha",
          urgency: "high",
          html_url: "https://example.pagerduty.com/incidents/PDEMO01",
          service: { summary: "edge-gateway" },
          priority: { summary: "P1" },
          description:
            "Automated monitor: tunnel_up dropped below 60% of expected peers for 10 minutes in region alpha. Standby path reporting healthy."
        }
      }
    }
  },
  jira: {
    source: "jira",
    payload: {
      webhookEvent: "jira:issue_created",
      issue: {
        key: "OPS-142",
        fields: {
          summary:
            "Routing sessions resetting on a 30s cadence in cluster three",
          priority: { name: "High" },
          issuetype: { name: "Incident" },
          project: { name: "Operations" },
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Session reset counter climbing steadily since 01:40Z. Resets appear evenly spaced at roughly the hold-timer interval. Control-plane CPU on the primary node rose from ~40% to >90% shortly before the first reset. Fleet grew ~18% last week with no deploy in the window."
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Worker entrypoint. Webhooks are a first-class channel: PagerDuty and Jira POST
// here, we verify the signature, normalise the payload, then hand it to the
// durable agent instance named after the incident.
// ---------------------------------------------------------------------------

export { RcaWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, model: MODEL });
    }

    // Fire one of the bundled synthetic incidents, so the UI can demo itself
    // without the visitor having to find a curl command. Deliberately restricted
    // to the two known seeds — this must not become a way to inject arbitrary
    // incidents into a deployed instance.
    if (request.method === "POST" && url.pathname === "/api/demo") {
      const which = url.searchParams.get("scenario") ?? "pagerduty";
      const seed = DEMO_SEEDS[which];
      if (!seed) {
        return Response.json(
          {
            error: `unknown scenario; choose one of ${Object.keys(DEMO_SEEDS).join(", ")}`
          },
          { status: 400 }
        );
      }
      const incident =
        seed.source === "pagerduty"
          ? normalizePagerDuty(seed.payload)
          : normalizeJira(seed.payload);
      if (!incident) {
        return Response.json(
          { error: "seed failed to normalise" },
          { status: 500 }
        );
      }
      const agent = await getAgentByName(env.IncidentAgent, incident.key);
      const started = await agent.ingest(incident);
      return Response.json({
        ...started,
        incident: incident.key,
        scenario: which
      });
    }

    // Read the current state of one incident: header, phase progress, timeline.
    // Used by the phase panel in the UI and by scripts/walkthrough.mjs.
    if (request.method === "GET" && url.pathname.startsWith("/api/incident/")) {
      const key = url.pathname.slice("/api/incident/".length);
      if (!key)
        return Response.json(
          { error: "missing incident key" },
          { status: 400 }
        );
      const agent = await getAgentByName(env.IncidentAgent, key);
      return Response.json({
        incident: await agent.getIncidentState(),
        phases: await agent.getPhases(),
        timeline: await agent.getTimeline()
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/webhooks/")) {
      const provider = url.pathname.split("/")[2];
      const raw = await request.text();

      const verified = await verifyWebhook(provider, request, raw, env);
      if (!verified.ok) {
        return Response.json({ error: verified.reason }, { status: 401 });
      }

      let incident: IncidentInput | null = null;
      try {
        const payload = JSON.parse(raw);
        incident =
          provider === "pagerduty"
            ? normalizePagerDuty(payload)
            : provider === "jira"
              ? normalizeJira(payload)
              : null;
      } catch {
        return Response.json({ error: "malformed json" }, { status: 400 });
      }

      if (!incident) {
        return Response.json(
          { error: `unsupported provider: ${provider}` },
          { status: 400 }
        );
      }

      // One agent per incident key — this is the durable identity.
      const agent = await getAgentByName(env.IncidentAgent, incident.key);
      const result = await agent.ingest(incident);
      return Response.json({
        accepted: true,
        incident: incident.key,
        ...result
      });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
