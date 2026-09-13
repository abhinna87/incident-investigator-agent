import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { getAgentByName } from "agents";

import { PHASE_PROMPTS, type PhaseContext } from "./prompts";
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
                ? syntheticSignals(params.scenario)
                : undefined
          };

          // Delegated to the agent: see IncidentAgent.runPhaseModel for why.
          return await agent.runPhaseModel(PHASE_PROMPTS[phase](ctx), phase);
        }
      );

      previous[phase] = output;

      // Persist into the agent's SQLite so the finding survives independently of
      // the workflow's own retention.
      await step.do(`record-${phase}`, async () => {
        await agent.recordPhase(phase, output);
      });
    }

    // Mark the investigation finished by calling the agent directly rather than
    // relying on the onWorkflowComplete callback: that callback only fires if the
    // workflow explicitly reports completion, and without this the incident stayed
    // at "investigating" forever even after all five phases had landed.
    await step.do("finish", async () => {
      await agent.completeInvestigation(previous.rca ?? "");
    });

    return {
      incidentKey: params.incidentKey,
      rca: previous.rca ?? "",
      phases: previous
    };
  }
}

/**
 * Stand-in for observability data. Deliberately shows a clean first half and a
 * degrading second half so the phases have a real signal to reason about, and
 * deliberately includes one ambiguous series so the verify phase has something
 * to be honestly uncertain about.
 */
function syntheticSignals(scenario?: string): string {
  if (scenario === "reset-loop") {
    // Shaped so the tempting correlation (a version bump) and the real one (peer
    // growth crossing a cost threshold) are both present. A model that stops at
    // the first plausible story will blame the upgrade; the evidence does not
    // support it, and the verify phase is where that should surface.
    return [
      "peer_state_transitions{tenant=northwind}: 4,6,9,14,22,38,61,94,131,168,202,241  (per 5m — climbing, not settling)",
      "peer_established_duration_p99_seconds: 31,33,36,38,41,44,47,49,52,55,58,61  (hold timer is 30s)",
      "peer_established_duration_p50_seconds: 4,5,6,7,9,11,14,17,21,24,27,29  (still under the timer)",
      "route_export_evaluations_total{tenant=northwind}: 2.1M,4.8M,11M,26M,48M,71M,88M  (per convergence attempt)",
      "route_export_evaluations_total{tenant=other-tenants}: 2210,2240,2190,2260,2230,2250,2240  (flat)",
      "lock_wait_seconds_p99{object=route_server}: 0.4,0.9,2.1,5.6,11.2,18.9,24.4,28.1",
      "tenant_site_count{tenant=northwind}: 1740,1755,1790,1840,1910,1985,2040,2075,2098  (last 9 days, +20%)",
      "daemon_version: 4.1.0 until 2026-09-04T00:00Z, then 4.2.0  (upgrade was 9 days ago)",
      "first_loop_observed: 2026-09-13T01:40Z  (8 days AFTER the upgrade)",
      "rollback_node_7 to 4.1.0 at 2026-09-13T02:10Z: loop re-formed at 02:14Z",
      "suppression_profile_applied{tenant=northwind}: 0   (every other tenant: 1)",
      "log sample: 'hold timer expired, session reset' x214 in last 15m",
      "log sample: 'route export cancelled: peer no longer established' x198 in last 15m"
    ].join("\n");
  }
  return [
    "tunnel_up{region=a}: 1,1,1,1,1,1,0,0,1,0,0,0  (last 60m, 5m buckets)",
    "bgp_session_resets{peer=edge-1}: 0,0,0,0,0,2,7,9,11,14,13,15",
    "control_plane_cpu{node=primary}: 41,43,44,47,52,68,81,88,91,93,92,94  (percent)",
    "standby_path_health: 1,1,1,1,1,1,1,1,1,1,1,1  (no change observed)",
    "log sample: 'hold timer expired, session reset' x47 in last 15m"
  ].join("\n");
}
