import { useCallback, useEffect, useState } from "react";

/**
 * Live view of one incident's investigation.
 *
 * The agent broadcasts phase events over the same WebSocket the chat uses, but
 * the socket only carries events that happen while the browser is open — a page
 * refresh, or opening the UI an hour after the page fired, would show nothing. So
 * this polls `GET /api/incident/:key` for the authoritative state and treats
 * broadcast events purely as a nudge to poll again immediately.
 */

const PHASES = ["triage", "gather", "hypothesize", "verify", "rca"] as const;
type PhaseName = (typeof PHASES)[number];

const PHASE_ASKS: Record<PhaseName, string> = {
  triage: "What is affected, and what is verifiably not?",
  gather: "What evidence should we collect, specifically?",
  hypothesize: "What could be causing this? Ranked, each falsifiable.",
  verify: "Does the evidence support the leading theory?",
  rca: "The writeup."
};

interface PhaseRow {
  name: PhaseName;
  status: "pending" | "running" | "done" | "failed";
  started_at: string | null;
  finished_at: string | null;
  output: string | null;
}

interface IncidentHeader {
  incidentKey: string;
  title: string;
  source: string;
  severity: string;
  status: string;
  currentPhase: PhaseName | null;
  openedAt: string | null;
}

interface TimelineRow {
  at: string;
  actor: string;
  event: string;
}

interface Payload {
  incident: IncidentHeader;
  phases: PhaseRow[];
  timeline: TimelineRow[];
}

export function PhasePanel({
  incidentKey,
  nudge
}: {
  incidentKey: string;
  /** Increments when the agent broadcasts, to trigger an immediate refetch. */
  nudge: number;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PhaseName | null>(null);
  const [firing, setFiring] = useState<string | null>(null);
  const [fireError, setFireError] = useState<string | null>(null);

  /**
   * Start one of the bundled synthetic incidents. On success the page navigates to
   * that incident so the chat socket and this panel attach to the same instance.
   */
  const fire = useCallback(async (scenario: "pagerduty" | "jira") => {
    setFiring(scenario);
    setFireError(null);
    try {
      const r = await fetch(`/api/demo?scenario=${scenario}`, {
        method: "POST"
      });
      const body = (await r.json()) as { incident?: string; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      const url = new URL(window.location.href);
      url.searchParams.set("incident", body.incident ?? scenario);
      // Reload rather than just setting state: the chat socket is bound to the
      // incident key at mount, so both halves of the page need to re-attach.
      window.location.href = url.toString();
    } catch (e) {
      setFireError(e instanceof Error ? e.message : String(e));
      setFiring(null);
    }
  }, []);

  const load = useCallback(async () => {
    if (!incidentKey) return;
    try {
      const r = await fetch(`/api/incident/${encodeURIComponent(incidentKey)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [incidentKey]);

  useEffect(() => {
    load();
  }, [load, nudge]);

  // Poll while an investigation is in flight; stop once it settles so an idle tab
  // is not hitting the agent every two seconds forever.
  useEffect(() => {
    const inFlight =
      data?.incident.status === "investigating" ||
      data?.phases.some((p) => p.status === "running");
    if (!inFlight) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [data, load]);

  if (error && !data) {
    return (
      <Frame>
        <p className="text-xs text-kumo-danger">
          Could not load <code>{incidentKey}</code>: {error}
        </p>
      </Frame>
    );
  }

  // Nothing has paged this incident yet — offer to fire a synthetic one so the
  // page is useful on a fresh clone without hunting for a curl command.
  const empty =
    !data ||
    (!data!.incident.title && data.phases.every((p) => p.status === "pending"));

  if (empty) {
    return (
      <Frame>
        <p className="text-xs text-kumo-subtle leading-relaxed mb-3">
          Nothing has paged <code className="font-mono">{incidentKey}</code>{" "}
          yet. This agent is webhook-driven, so fire a synthetic incident to
          watch the five phases run:
        </p>
        <DemoButtons busy={firing} onFire={fire} />
        {fireError && (
          <p className="mt-2 text-[11px] text-kumo-danger">{fireError}</p>
        )}
        <p className="mt-3 text-[11px] text-kumo-subtle leading-relaxed">
          Equivalent from a terminal:
        </p>
        <pre className="mt-1 text-[10.5px] font-mono bg-kumo-raised rounded p-2 overflow-auto text-kumo-subtle">
          ./seeds/send.sh pagerduty-tunnel-down.json
        </pre>
      </Frame>
    );
  }

  // `empty` above returns when data is null, so it is non-null here.
  const byName = new Map(data!.phases.map((p) => [p.name, p]));
  const doneCount = data!.phases.filter((p) => p.status === "done").length;

  return (
    <Frame>
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <StatusDot status={data!.incident.status} />
          <span className="text-xs font-mono text-kumo-subtle">
            {data!.incident.incidentKey}
          </span>
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-kumo-raised text-kumo-subtle">
            {data!.incident.source}
          </span>
          {data!.incident.severity && data!.incident.severity !== "unknown" && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-kumo-raised text-kumo-subtle">
              {data!.incident.severity}
            </span>
          )}
        </div>
        <h2 className="text-sm font-semibold text-kumo-default leading-snug">
          {data!.incident.title || "(untitled incident)"}
        </h2>
        <p className="mt-1 text-[11px] text-kumo-subtle">
          {doneCount}/5 phases · {data!.incident.status}
        </p>
      </div>

      <ol className="space-y-1.5">
        {PHASES.map((name, i) => {
          const p = byName.get(name);
          const status = p?.status ?? "pending";
          const isOpen = open === name;
          const hasOutput = Boolean(p?.output);
          return (
            <li key={name}>
              <button
                type="button"
                disabled={!hasOutput}
                onClick={() => setOpen(isOpen ? null : name)}
                className={`w-full text-left rounded px-2 py-1.5 transition-colors ${
                  hasOutput
                    ? "hover:bg-kumo-raised cursor-pointer"
                    : "cursor-default"
                }`}
              >
                <div className="flex items-center gap-2">
                  <PhaseMark status={status} index={i + 1} />
                  <span
                    className={`text-xs font-medium ${
                      status === "done"
                        ? "text-kumo-default"
                        : status === "running"
                          ? "text-kumo-default"
                          : "text-kumo-subtle"
                    }`}
                  >
                    {name}
                  </span>
                  {status === "running" && (
                    <span className="text-[10px] text-kumo-subtle animate-pulse">
                      running…
                    </span>
                  )}
                </div>
                <p className="ml-6 mt-0.5 text-[10.5px] text-kumo-subtle leading-snug">
                  {PHASE_ASKS[name]}
                </p>
              </button>

              {isOpen && p?.output && (
                <pre className="ml-6 mt-1 mb-2 text-[11px] font-mono whitespace-pre-wrap bg-kumo-raised rounded p-2 max-h-72 overflow-auto text-kumo-default">
                  {p.output}
                </pre>
              )}
            </li>
          );
        })}
      </ol>

      <div className="mt-4 pt-3 border-t border-kumo-line">
        <p className="text-[10px] uppercase tracking-wide text-kumo-subtle mb-2">
          Start another
        </p>
        <DemoButtons busy={firing} onFire={fire} />
        {fireError && (
          <p className="mt-2 text-[11px] text-kumo-danger">{fireError}</p>
        )}
      </div>

      {data!.timeline.length > 0 && (
        <div className="mt-4 pt-3 border-t border-kumo-line">
          <p className="text-[10px] uppercase tracking-wide text-kumo-subtle mb-1.5">
            Timeline
          </p>
          <ul className="space-y-1">
            {data!.timeline
              .slice()
              .reverse()
              .map((t, i) => (
                <li
                  key={i}
                  className="text-[10.5px] text-kumo-subtle font-mono"
                >
                  {t.at.slice(11, 19)} {t.actor} — {t.event}
                </li>
              ))}
          </ul>
        </div>
      )}
    </Frame>
  );
}

function DemoButtons({
  busy,
  onFire
}: {
  busy: string | null;
  onFire: (scenario: "pagerduty" | "jira") => void;
}) {
  const scenarios: Array<{ id: "pagerduty" | "jira"; label: string }> = [
    { id: "pagerduty", label: "Tunnel down (PagerDuty)" },
    { id: "jira", label: "Routing churn (Jira)" }
  ];
  return (
    <div className="flex flex-col gap-1.5">
      {scenarios.map((sc) => (
        <button
          key={sc.id}
          type="button"
          disabled={busy !== null}
          onClick={() => onFire(sc.id)}
          className="text-left text-xs px-2.5 py-1.5 rounded ring-1 ring-kumo-line hover:bg-kumo-raised disabled:opacity-50 disabled:cursor-wait transition-colors text-kumo-default"
        >
          {busy === sc.id ? "Starting…" : sc.label}
        </button>
      ))}
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <aside className="w-80 shrink-0 border-r border-kumo-line bg-kumo-base p-4 overflow-y-auto">
      <p className="text-[10px] uppercase tracking-wide text-kumo-subtle mb-3">
        Investigation
      </p>
      {children}
    </aside>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "rca-ready"
      ? "bg-kumo-success"
      : status === "investigating"
        ? "bg-kumo-warning"
        : "bg-kumo-inactive";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} />;
}

function PhaseMark({ status, index }: { status: string; index: number }) {
  if (status === "done") {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-kumo-success text-[9px] text-white font-bold">
        ✓
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-kumo-warning text-[9px] text-white font-bold animate-pulse">
        {index}
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-kumo-danger text-[9px] text-white font-bold">
        !
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-4 h-4 rounded-full ring-1 ring-kumo-line text-[9px] text-kumo-subtle">
      {index}
    </span>
  );
}
