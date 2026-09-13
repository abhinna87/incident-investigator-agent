import type { IncidentState, PhaseName, PhaseRecord } from "./types";

/**
 * Llama 3.3 70B on Workers AI. The assignment recommends this model; it is also
 * a reasonable default here because every phase prompt is short and structured,
 * which is where a mid-size instruct model holds up well.
 *
 * Note: Workers AI defaults `max_tokens` to 256. Phase prompts below therefore
 * ask for tight output, and the workflow sets an explicit limit.
 */
export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Keep phase output short enough to read at 3am and cheap enough to retry. */
export const MAX_PHASE_TOKENS = 700;

const HOUSE_STYLE = `
Style rules:
- Lead with the conclusion, then the evidence.
- Quantify when you can. If you cannot, say what measurement is missing.
- Never present a guess as a finding. Label confidence explicitly.
- If the evidence does not support a conclusion, say so and name the next check.
- Plain text only. No markdown: no **, no __, no backticks, no # headings, no
  bullet characters. Output is shown in a monospace pane, so ** renders as two
  literal asterisks rather than bold. Use plain numbered or dashed lines.
`.trim();

export function SYSTEM_PROMPT(args: {
  incident: IncidentState;
  phases: PhaseRecord[];
  runbookNames: string[];
}) {
  const { incident, phases, runbookNames } = args;
  const done = phases.filter((p) => p.status === "done");

  return `
You are an incident investigation assistant working alongside an on-call engineer.

Current incident
  key:      ${incident.incidentKey || "(none)"}
  title:    ${incident.title || "(none)"}
  source:   ${incident.source}
  severity: ${incident.severity}
  status:   ${incident.status}
  phase:    ${incident.currentPhase ?? "idle"}

Phases already completed: ${done.length ? done.map((p) => p.name).join(", ") : "none"}
Runbooks available on this incident: ${runbookNames.length ? runbookNames.join(", ") : "none"}

You have tools to query metrics, search logs, record findings and save runbooks.
Prefer calling a tool over speculating. The engineer can and will correct you —
when they do, treat their correction as ground truth over your own prior output.

${HOUSE_STYLE}
`.trim();
}

/**
 * One prompt per phase. These are deliberately narrow: a single phase that tries
 * to do everything produces confident mush, which is the failure mode that makes
 * engineers stop trusting the tool.
 */
export const PHASE_PROMPTS: Record<PhaseName, (ctx: PhaseContext) => string> = {
  triage: (c) =>
    `
An incident has just been raised.

  title:       ${c.title}
  severity:    ${c.severity}
  reported by: ${c.source}
  description: ${c.description}

Establish scope only. Do not theorise about cause yet.

Answer in at most 120 words covering:
1. What appears to be affected, and what does not appear to be affected.
2. Whether the reported severity looks right, and why.
3. The two signals you would look at first.

${HOUSE_STYLE}
`.trim(),

  gather: (c) =>
    `
Incident: ${c.title}
Triage notes: ${c.previous.triage ?? "(none)"}
${c.runbooks ? `Runbooks attached to this incident:\n${c.runbooks}` : "No runbooks attached."}

List the specific evidence to collect next: name the metrics, the log patterns,
and the time windows. Be concrete enough that someone could run them without
asking you a follow-up question. At most 150 words, as a list.

${HOUSE_STYLE}
`.trim(),

  hypothesize: (c) =>
    `
Incident: ${c.title}
Triage: ${c.previous.triage ?? "(none)"}
Evidence gathered: ${c.previous.gather ?? "(none)"}
${c.signals ? `Observed signals:\n${c.signals}` : ""}

Give two or three candidate causes, ranked. For each: the mechanism in one
sentence, the evidence that supports it, and the single observation that would
falsify it. At most 180 words.

${HOUSE_STYLE}
`.trim(),

  verify: (c) =>
    `
Incident: ${c.title}
Candidate causes: ${c.previous.hypothesize ?? "(none)"}
${c.signals ? `Observed signals:\n${c.signals}` : ""}

Take the leading hypothesis and state whether the available evidence supports it,
contradicts it, or is insufficient. If insufficient, name the one check that would
settle it. Do not hedge across all three. At most 140 words.

${HOUSE_STYLE}
`.trim(),

  rca: (c) =>
    `
Draft an incident writeup.

  title:    ${c.title}
  severity: ${c.severity}

Triage:     ${c.previous.triage ?? "(none)"}
Evidence:   ${c.previous.gather ?? "(none)"}
Hypotheses: ${c.previous.hypothesize ?? "(none)"}
Verification: ${c.previous.verify ?? "(none)"}

Use these headings exactly, each on its own line as plain text with no "#"
and no asterisks: Summary, Impact, What we know, What we do not know,
Leading cause, Next actions. Keep it under 300 words. Where the investigation is
inconclusive, put it under "What we do not know" rather than softening the
leading cause.

${HOUSE_STYLE}
`.trim()
};

export interface PhaseContext {
  title: string;
  severity: string;
  source: string;
  description: string;
  previous: Partial<Record<PhaseName, string>>;
  runbooks?: string;
  signals?: string;
}
