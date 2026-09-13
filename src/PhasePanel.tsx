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

  if (!incidentKey) {
    return (
      <Frame>
        <p className="text-xs text-kumo-subtle leading-relaxed">
          No incident selected. Send one in:
        </p>
        <pre className="mt-2 text-[11px] font-mono bg-kumo-raised rounded p-2 overflow-auto text-kumo-subtle">
          npm run walkthrough
        </pre>
        <p className="mt-2 text-xs text-kumo-subtle leading-relaxed">
          Then append <code>?incident=pd-4821</code> to this page&rsquo;s URL.
        </p>
      </Frame>
    );
  }

  if (error && !data) {
    return (
      <Frame>
        <p className="text-xs text-kumo-danger">
          Could not load <code>{incidentKey}</code>: {error}
        </p>
      </Frame>
    );
  }

  if (!data) {
    return (
      <Frame>
        <p className="text-xs text-kumo-subtle">Loading {incidentKey}…</p>
      </Frame>
    );
  }

  const byName = new Map(data.phases.map((p) => [p.name, p]));
  const doneCount = data.phases.filter((p) => p.status === "done").length;

  return (
    <Frame>
      <div className="mb-3">
        <div className="flex items-center gap-2 mb-1">
          <StatusDot status={data.incident.status} />
          <span className="text-xs font-mono text-kumo-subtle">
            {data.incident.incidentKey}
          </span>
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-kumo-raised text-kumo-subtle">
            {data.incident.source}
          </span>
          {data.incident.severity && data.incident.severity !== "unknown" && (
            <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-kumo-raised text-kumo-subtle">
              {data.incident.severity}
            </span>
          )}
        </div>
        <h2 className="text-sm font-semibold text-kumo-default leading-snug">
          {data.incident.title || "(untitled incident)"}
        </h2>
        <p className="mt-1 text-[11px] text-kumo-subtle">
          {doneCount}/5 phases · {data.incident.status}
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

      {data.timeline.length > 0 && (
        <div className="mt-4 pt-3 border-t border-kumo-line">
          <p className="text-[10px] uppercase tracking-wide text-kumo-subtle mb-1.5">
            Timeline
          </p>
          <ul className="space-y-1">
            {data.timeline
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
