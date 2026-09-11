/**
 * The five phases mirror how an on-call engineer actually works a page:
 * establish blast radius before theorising, and force a verification step so a
 * plausible-sounding hypothesis cannot become the RCA on its own.
 */
export const PHASES = [
  "triage",
  "gather",
  "hypothesize",
  "verify",
  "rca"
] as const;

export type PhaseName = (typeof PHASES)[number];

export const PHASE_LABEL: Record<PhaseName, string> = {
  triage: "Triage — scope and severity",
  gather: "Gather — signals and runbooks",
  hypothesize: "Hypothesize — ranked candidate causes",
  verify: "Verify — test the leading hypothesis",
  rca: "RCA — draft writeup"
};

export type PhaseStatus = "pending" | "running" | "done" | "failed";

export interface PhaseRecord {
  name: PhaseName;
  status: PhaseStatus;
  started_at: string | null;
  finished_at: string | null;
  output: string | null;
}

export type IncidentSource = "pagerduty" | "jira" | "manual";

export interface IncidentState {
  incidentKey: string;
  title: string;
  source: IncidentSource;
  severity: string;
  status: "new" | "investigating" | "rca-ready" | "closed";
  currentPhase: PhaseName | null;
  workflowInstanceId: string | null;
  openedAt: string | null;
}

export interface RcaWorkflowParams {
  incidentKey: string;
  title: string;
  description: string;
  severity: string;
  source: IncidentSource;
  /** Agent instance name, so the workflow can call back into the right agent. */
  agentName: string;
}
