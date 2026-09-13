import type { IncidentSource } from "../types";

/**
 * Both providers get flattened to this shape so the agent and workflow never
 * need to know which system paged. Adding a third source means adding one
 * normaliser, not touching the investigation logic.
 */
export interface IncidentInput {
  /** Stable, URL-safe id. Doubles as the durable agent instance name. */
  key: string;
  title: string;
  description: string;
  severity: string;
  source: IncidentSource;
  url?: string;
  /** Demo-only hint selecting a synthetic signal set. */
  scenario?: string;
}

/**
 * Pick a synthetic signal set for the bundled demo incidents.
 *
 * Only exists so the demo scenarios are self-describing: the same seed produces
 * the same signals whether it arrives from the UI button or from curl. A real
 * deployment reads signals from an observability backend and ignores this.
 */
function inferScenario(...text: Array<string | undefined>): string | undefined {
  const blob = text.filter(Boolean).join(" ").toLowerCase();
  if (/reconnect loop|reset loop|cycling established/.test(blob))
    return "reset-loop";
  return undefined;
}

/** Agent names become part of a URL, so keep them conservative. */
function slug(value: string, fallback: string): string {
  const s = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || fallback;
}

/**
 * The subset of a PagerDuty v3 webhook envelope that we read. Everything is
 * optional because this is untrusted external input — a payload shape change
 * upstream should degrade to a missing field, not throw.
 */
export interface PagerDutyPayload {
  event?: {
    event_type?: string;
    data?: {
      id?: string;
      number?: number;
      title?: string;
      urgency?: string;
      html_url?: string;
      description?: string;
      service?: { summary?: string };
      priority?: { summary?: string };
    };
  };
}

/**
 * PagerDuty v3 webhook envelope:
 *   { event: { event_type, occurred_at, data: { id, number, title, urgency,
 *              html_url, service: { summary }, priority: { summary } } } }
 */
export function normalizePagerDuty(
  payload: PagerDutyPayload
): IncidentInput | null {
  const data = payload?.event?.data;
  if (!data) return null;

  const number = data.number ?? data.id;
  const key = slug(`pd-${number}`, `pd-${Date.now()}`);
  const service = data.service?.summary ?? "unknown service";
  const priority = data.priority?.summary;

  return {
    key,
    title: data.title ?? "Untitled PagerDuty incident",
    description: [
      `Service: ${service}`,
      priority ? `Priority: ${priority}` : null,
      data.urgency ? `Urgency: ${data.urgency}` : null,
      payload.event?.event_type ? `Trigger: ${payload.event.event_type}` : null,
      data.description && data.description !== data.title
        ? `Detail: ${data.description}`
        : null
    ]
      .filter(Boolean)
      .join("\n"),
    // PagerDuty models this as urgency (high/low) rather than a numeric sev.
    severity: priority ?? data.urgency ?? "unknown",
    source: "pagerduty",
    url: data.html_url,
    scenario: inferScenario(data.title, data.description)
  };
}

/** Jira Cloud sends rich text as an Atlassian Document Format tree. */
export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  /** Present on the document root that Jira Cloud sends. */
  version?: number;
}

/** The subset of a Jira webhook envelope that we read. */
export interface JiraPayload {
  webhookEvent?: string;
  issue?: {
    key?: string;
    self?: string;
    fields?: {
      summary?: string;
      description?: AdfNode | string | null;
      priority?: { name?: string };
      issuetype?: { name?: string };
      project?: { name?: string };
    };
  };
}

/**
 * Jira webhook envelope (issue created / updated):
 *   { webhookEvent, issue: { key, fields: { summary, description, priority,
 *                            issuetype, project } } }
 */
export function normalizeJira(payload: JiraPayload): IncidentInput | null {
  const issue = payload?.issue;
  if (!issue?.key) return null;

  const f = issue.fields ?? {};
  return {
    key: slug(issue.key, `jira-${Date.now()}`),
    title: f.summary ?? issue.key,
    description: [
      f.issuetype?.name ? `Type: ${f.issuetype.name}` : null,
      f.project?.name ? `Project: ${f.project.name}` : null,
      payload.webhookEvent ? `Trigger: ${payload.webhookEvent}` : null,
      // Jira Cloud sends description as ADF (a document tree) rather than text.
      f.description ? `Detail: ${flattenAdf(f.description)}` : null
    ]
      .filter(Boolean)
      .join("\n"),
    severity: f.priority?.name ?? "unknown",
    source: "jira",
    url: payload.issue?.self,
    scenario: inferScenario(f.summary, flattenAdf(f.description))
  };
}

/**
 * Jira Cloud descriptions arrive as Atlassian Document Format. Walk the tree and
 * keep the text nodes; anything richer is noise for our purposes.
 */
function flattenAdf(
  node: AdfNode | AdfNode[] | string | null | undefined
): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flattenAdf).join(" ");
  if (node.type === "text" && typeof node.text === "string") return node.text;
  if (node.content) return flattenAdf(node.content);
  return "";
}
