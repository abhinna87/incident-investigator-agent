---
name: routing-instability
description: Investigate route flapping, session resets between routing peers, unexpected route withdrawals, or a control plane that is churning. Use when the alert mentions session resets, route churn, hold timer expiry, or convergence problems.
---

# Routing instability

## When this applies

Routing sessions are resetting, routes are being withdrawn and re-advertised, or
convergence is taking longer than it should. The distinguishing feature versus a
single tunnel fault is **churn**: the system is doing work repeatedly rather than
sitting in a failed state.

## The question that orders everything else

**Is this a cause or a consequence?** Routing churn is downstream of almost
everything — a flapping link, a busy control plane, a peer restarting. Establish
whether routing is the source or the symptom before investigating routing itself.

Cheap test: does the churn start before or after the first anomaly in CPU,
link state, and peer availability? Order the timestamps.

## Order of checks

1. **Count the resets and find the period.**
   A steady reset interval that matches the hold timer means the session is
   timing out rather than being torn down deliberately. That points at the
   keepalive path — CPU starvation, queue drops, or a path that loses small
   packets.

2. **Scope it.** One peer, one region, or global? Global churn with a single
   shared component in the path is the shared component until proven otherwise.

3. **Check the control plane's own health.**
   Hold-timer expiry under high CPU is usually resource starvation, not a
   protocol fault. Look for CPU saturation _preceding_ the first reset.

4. **Look for scale non-linearity.**
   If the churn began after a growth threshold rather than a change, suspect work
   that scales worse than linearly with peer or prefix count — a per-peer
   operation under a shared lock, or a full table walk per update. Evidence:
   cost per event rising with fleet size, and onset correlating with growth rather
   than a deploy.

5. **Confirm graceful-restart / non-stop-forwarding behaviour.**
   Where those features exist and are not enabled, a control-plane restart
   becomes a data-plane outage. That is worth stating explicitly in the RCA
   because the fix is configuration, not code.

## Signals worth pulling

- Session reset counters per peer over 1h and 24h — the shape matters more than
  the absolute number
- Time-to-converge after each reset
- Control-plane CPU, memory, and run-queue depth
- Route withdrawal and advertisement counts
- Log patterns: `hold timer expired`, `session reset`, `peer closed connection`,
  `notification sent`

## Traps

- **Reset counts without a time base are meaningless.** 400 resets over a week is
  background noise; 400 in five minutes is an outage.
- **A version change is not automatically the cause.** If the same code ran fine
  at lower scale, prefer the scale explanation and say what measurement would
  distinguish the two.
- **Do not stop at "the session reset."** That is the observation, not the cause.
  The cause is why the keepalive was not answered in time.

## What good output looks like

The reset rate with its time base, the scope, an explicit cause-versus-consequence
call with the timestamps that justify it, and either a named mechanism or a named
missing measurement.
