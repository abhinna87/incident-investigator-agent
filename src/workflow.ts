import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { getAgentByName } from "agents";

import {
  MAX_PHASE_TOKENS,
  MODEL,
  PHASE_PROMPTS,
  type PhaseContext
} from "./prompts";
import { PHASES, type PhaseName, type RcaWorkflowParams } from "./types";

/**
 * The investigation runs as a Workflow rather than a loop inside the agent for
 * one reason: durability. A page can fire at 03:00, the model call for one phase
 * can fail or rate-limit, and the isolate can be evicted between phases. Each
 * phase here is a `step.do()`, so Cloudflare persists its result and retries
 * only the step that failed instead of restarting the investigation.
 */
export class RcaWorkflow extends WorkflowEntrypoint<Env, RcaWorkflowParams> {
  async run(event: WorkflowEvent<RcaWorkflowParams>, step: WorkflowStep) {
    const params = event.payload;
    const agent = await getAgentByName(
      this.env.IncidentAgent,
      params.agentName
    );

    // Runbooks the engineer attached to this incident. Fetched once and fed into
    // the gather phase so the model reasons from the team's own documented
    // procedure rather than inventing a generic one.
    const runbooks = await step.do("load-runbooks", async () => {
      const rows = await agent.listRunbooks();
      if (rows.length === 0) return "";
      return rows
        .map((r) => `## ${r.name}\n${r.body}`)
        .join("\n\n")
        .slice(0, 4000);
    });

    const previous: Partial<Record<PhaseName, string>> = {};

    for (const phase of PHASES) {
      // Progress is reported before the step runs so the UI can show the phase
      // as in-flight while the model is thinking.
      await step.do(`announce-${phase}`, async () => {
        await agent.onWorkflowProgress("RCA_WORKFLOW", event.instanceId, {
          phase,
          status: "running"
        });
      });

      const output = await step.do(
        `phase-${phase}`,
        {
          // Model calls are the flaky part; give them room to retry with backoff.
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "2 minutes"
        },
        async () => {
          const ctx: PhaseContext = {
            title: params.title,
            severity: params.severity,
            source: params.source,
            description: params.description,
            previous,
            runbooks: runbooks || undefined,
            // Synthetic signals keep the demo self-contained; a real deployment
            // would pull these from the observability MCP server.
            signals:
              phase === "hypothesize" || phase === "verify"
                ? syntheticSignals()
                : undefined
          };

          return await callModel(this.env, PHASE_PROMPTS[phase](ctx), phase);
        }
      );

      previous[phase] = output;

      // Persist into the agent's SQLite so the finding survives independently of
      // the workflow's own retention.
      await step.do(`record-${phase}`, async () => {
        await agent.recordPhase(phase, output);
      });
    }

    return {
      incidentKey: params.incidentKey,
      rca: previous.rca ?? "",
      phases: previous
    };
  }
}

/**
 * Call the model for one phase.
 *
 * The step around this already retries, so by the time we surface an error the
 * model has genuinely failed several times. When that happens we record a marker
 * rather than throwing: an investigation that loses four completed phases because
 * the fifth model call was rate-limited is worse than one with a visible gap, and
 * the engineer can re-run the phase from the chat.
 */
async function callModel(
  env: Env,
  prompt: string,
  phase: PhaseName
): Promise<string> {
  try {
    const result = await env.AI.run(MODEL, {
      messages: [
        {
          role: "system",
          content:
            "You are an incident investigation assistant. Be terse and concrete. Never present a guess as a finding."
        },
        { role: "user", content: prompt }
      ],
      // Workers AI defaults max_tokens to 256, which truncates the RCA draft
      // mid-sentence. Set it explicitly.
      max_tokens: MAX_PHASE_TOKENS,
      temperature: 0.3
    });

    const text =
      typeof result === "string"
        ? result
        : ((result as { response?: string }).response ??
          JSON.stringify(result));
    const trimmed = text.trim();
    if (!trimmed) throw new Error("model returned empty output");
    return trimmed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`phase ${phase}: model call failed after retries: ${reason}`);
    return [
      `_Model unavailable for the ${phase} phase._`,
      "",
      `Reason: ${reason}`,
      "",
      "The other phases are unaffected. Ask in chat to re-run this phase once the",
      "model is reachable."
    ].join("\n");
  }
}

/**
 * Stand-in for observability data. Deliberately shows a clean first half and a
 * degrading second half so the phases have a real signal to reason about, and
 * deliberately includes one ambiguous series so the verify phase has something
 * to be honestly uncertain about.
 */
function syntheticSignals(): string {
  return [
    "tunnel_up{region=a}: 1,1,1,1,1,1,0,0,1,0,0,0  (last 60m, 5m buckets)",
    "bgp_session_resets{peer=edge-1}: 0,0,0,0,0,2,7,9,11,14,13,15",
    "control_plane_cpu{node=primary}: 41,43,44,47,52,68,81,88,91,93,92,94  (percent)",
    "standby_path_health: 1,1,1,1,1,1,1,1,1,1,1,1  (no change observed)",
    "log sample: 'hold timer expired, session reset' ×47 in last 15m"
  ].join("\n");
}
