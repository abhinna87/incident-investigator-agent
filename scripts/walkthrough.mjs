#!/usr/bin/env node
/**
 * walkthrough.mjs — narrate one investigation from the terminal.
 *
 * Fires a synthetic incident at a locally running agent, then polls the incident
 * API and prints each phase as it lands, with the model's actual output. Useful
 * for seeing what the agent is doing without opening the chat UI, and for
 * demonstrating the run to someone else.
 *
 * Usage:
 *   npm run dev                       # in another terminal
 *   node scripts/walkthrough.mjs      # defaults to the PagerDuty seed
 *   node scripts/walkthrough.mjs jira
 *   node scripts/walkthrough.mjs jira http://localhost:8787
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const SEEDS = {
  pagerduty: {
    file: "seeds/pagerduty-tunnel-down.json",
    provider: "pagerduty",
    key: "pd-4821"
  },
  jira: {
    file: "seeds/jira-routing-churn.json",
    provider: "jira",
    key: "ops-142"
  },
  // Adversarial: a version bump correlates with onset and is the obvious answer,
  // but the evidence does not support it. Exercises the verify phase.
  "reset-loop": {
    file: "seeds/pagerduty-reset-loop.json",
    provider: "pagerduty",
    key: "pd-5177"
  }
};

const PHASE_ORDER = ["triage", "gather", "hypothesize", "verify", "rca"];
const PHASE_QUESTION = {
  triage: "What is affected, and what is verifiably not?",
  gather: "What evidence should we collect, specifically?",
  hypothesize: "What could be causing this? Ranked, each falsifiable.",
  verify: "Does the evidence actually support the leading theory?",
  rca: "Write it up."
};

// ANSI helpers. Disabled when not a TTY so piping to a file stays readable.
const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = c("1");
const dim = c("2");
const green = c("32");
const yellow = c("33");
const blue = c("36");
const red = c("31");

const which = (process.argv[2] ?? "pagerduty").toLowerCase();
const base = process.argv[3] ?? "http://localhost:8787";
const seed = SEEDS[which];

if (!seed) {
  console.error(
    `unknown seed "${which}" — choose one of: ${Object.keys(SEEDS).join(", ")}`
  );
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Erase the transient "…phase in progress" line before printing real output. */
function clearLine() {
  if (tty) process.stdout.write("\r" + " ".repeat(46) + "\r");
}

function rule(char = "─") {
  console.log(dim(char.repeat(74)));
}

/**
 * Model output is meant to be plain text but occasionally arrives with markdown
 * emphasis, which shows up as literal asterisks in a terminal. Mirrors
 * src/markdown.ts.
 */
function stripMarkdown(text) {
  return String(text ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[*•]\s+/gm, "- ")
    .replace(/\*\*/g, "")
    .trim();
}

function wrap(text, indent = "   ", width = 70) {
  return stripMarkdown(text)
    .split("\n")
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const words = line.split(" ");
      const out = [];
      let cur = "";
      for (const w of words) {
        if ((cur + " " + w).trim().length > width) {
          out.push(cur.trim());
          cur = w;
        } else {
          cur += " " + w;
        }
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    })
    .map((l) => indent + l)
    .join("\n");
}

async function main() {
  // 0. Is the agent running?
  try {
    const health = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(4000)
    });
    const body = await health.json();
    console.log();
    console.log(bold("Incident Investigator Agent — walkthrough"));
    rule("═");
    console.log(`  agent:  ${green("up")} at ${base}`);
    console.log(`  model:  ${body.model}`);
  } catch {
    console.error(red(`\n  Cannot reach ${base}.`));
    console.error(
      `  Start it first, in another terminal:\n\n    npm run dev\n`
    );
    process.exit(1);
  }

  // 1. Show what is about to be sent, so the input is not a mystery.
  const payload = JSON.parse(readFileSync(join(ROOT, seed.file), "utf8"));
  const title =
    payload.event?.data?.title ??
    payload.issue?.fields?.summary ??
    "(untitled)";

  console.log(`  source: ${seed.provider}`);
  console.log(`  seed:   ${seed.file}`);
  console.log();
  console.log(bold("1. A monitoring system raises an incident"));
  console.log(
    dim("   Nothing here is a human typing — this is the webhook payload")
  );
  console.log(dim("   PagerDuty or Jira would POST on its own."));
  console.log();
  console.log(`   title:    ${bold(title)}`);
  console.log();

  // 2. Deliver it exactly as the provider would.
  console.log(bold("2. It arrives at the agent"));
  console.log(dim(`   POST ${base}/webhooks/${seed.provider}`));
  console.log(
    dim("   The worker verifies the signature, normalises the payload, and")
  );
  console.log(
    dim("   routes it to a durable agent instance named after the incident.")
  );

  const res = await fetch(`${base}/webhooks/${seed.provider}`, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const accepted = await res.json();
  if (!res.ok || !accepted.accepted) {
    console.error(red(`\n   rejected: ${JSON.stringify(accepted)}`));
    process.exit(1);
  }
  console.log();
  console.log(`   ${green("accepted")}  incident ${bold(accepted.incident)}`);
  console.log(`   workflow instance ${dim(accepted.instanceId)}`);
  console.log();

  // 3. Watch the phases land.
  console.log(bold("3. Five phases run, each a durable retryable step"));
  console.log(
    dim("   Polling the incident API. Each phase asks the model one narrow")
  );
  console.log(
    dim("   question; the structure is what stops it jumping to an answer.")
  );
  console.log();

  const seen = new Set();
  const started = Date.now();
  const TIMEOUT_MS = 5 * 60_000;

  while (seen.size < PHASE_ORDER.length && Date.now() - started < TIMEOUT_MS) {
    let data;
    try {
      const r = await fetch(`${base}/api/incident/${accepted.incident}`, {
        signal: AbortSignal.timeout(15_000)
      });
      data = await r.json();
    } catch {
      await sleep(2000);
      continue;
    }

    const byName = new Map((data.phases ?? []).map((p) => [p.name, p]));

    for (const name of PHASE_ORDER) {
      if (seen.has(name)) continue;
      const p = byName.get(name);
      if (!p || p.status !== "done" || !p.output) break; // keep strict order

      seen.add(name);
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      clearLine();
      rule();
      console.log(
        `${blue(bold(name.toUpperCase()))}  ${dim(`(${seen.size}/5, ${elapsed}s)`)}`
      );
      console.log(dim(`   asks: ${PHASE_QUESTION[name]}`));
      console.log();
      console.log(wrap(p.output));
      console.log();
    }

    if (seen.size < PHASE_ORDER.length) {
      // Only draw the transient spinner on a TTY: when piped, \r does not erase
      // and the line repeats on every poll.
      if (tty) {
        const next = PHASE_ORDER.find((n) => !seen.has(n));
        process.stdout.write(dim(`\r   …${next} in progress   `));
      }
      await sleep(2500);
    }
  }

  clearLine();

  if (seen.size < PHASE_ORDER.length) {
    console.log(yellow(`\n  Timed out with ${seen.size}/5 phases complete.`));
    console.log(dim("  Check the wrangler dev output for errors."));
    process.exit(1);
  }

  // 4. Show that it persisted.
  const final = await (
    await fetch(`${base}/api/incident/${accepted.incident}`)
  ).json();
  rule("═");
  console.log(bold("4. It is all persisted in this incident's own database"));
  console.log();
  console.log(`   status:   ${final.incident.status}`);
  console.log(`   severity: ${final.incident.severity}`);
  console.log(
    `   phases:   ${final.phases.filter((p) => p.status === "done").length}/5 done`
  );
  console.log();
  console.log(dim("   timeline:"));
  for (const t of (final.timeline ?? []).slice().reverse()) {
    console.log(
      dim(`     ${t.at.slice(11, 19)}  ${t.actor.padEnd(10)} ${t.event}`)
    );
  }
  console.log();
  console.log(
    dim("   This survives restarts. The alert can fire at 03:00 and the")
  );
  console.log(dim("   findings are still here when someone looks at 08:00."));
  console.log();
  console.log(bold("Next:"));
  console.log(
    `  open ${base} to chat with this incident and correct the agent`
  );
  console.log(`  curl ${base}/api/incident/${accepted.incident} | jq`);
  console.log();
}

main().catch((e) => {
  console.error(red(`\nwalkthrough failed: ${e.message}`));
  process.exit(1);
});
