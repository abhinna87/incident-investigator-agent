---
name: reset-loop
description: Investigate peers or sessions caught in a self-sustaining reconnect loop — up, then down before converging, then up again. Use when sessions cycle rather than simply failing, when a restart clears it only briefly, or when the problem affects one large tenant and not others.
---

# Self-sustaining reset loop

## What distinguishes this from an ordinary session failure

A session that fails stays down. A session in a reset loop keeps _succeeding_ and
then dying before it finishes its work. The tell is the cycle:
`Established → work begins → timeout → teardown → reconnect`.

The important consequence: **the loop can outlive its trigger**. Once every
reconnect creates enough work to cause the next timeout, the system sustains the
failure on its own. Removing whatever started it does not stop it. This is why
"we rolled back and it is still broken" is not evidence that the rollback was
wrong.

## The question to ask before anything else

**Is the work per reconnect a function of how many peers are reconnecting?**

If yes, you have a feedback loop and the cause is structural. If no, look for an
external trigger.

Cheap way to tell: does a restart clear it briefly and then re-form? A restart
forces every peer to reconnect at once, which is the worst case for per-peer work.
If the loop reliably re-forms shortly after a restart, the reconnect itself is
manufacturing the load.

## Order of checks

1. **Scope it to a tenant or a shared component.**
   One large tenant affected and others fine, on the same code and the same fleet,
   is strong evidence against a code defect and for something about that tenant's
   configuration or scale.

2. **Compare against the timeout that is actually killing the session.**
   Find the hold timer or equivalent deadline, then compare it to how long the
   per-reconnect work takes. A loop appears when work time crosses that deadline.
   That crossing point is the whole incident: below it everything is fine, above it
   nothing converges. Small changes in load can flip it.

3. **Establish whether cost grows faster than linearly with peers.**
   Look for per-peer work that touches per-peer state — a full table export
   computed once per peer, over a table whose size is itself proportional to peer
   count, is quadratic. Symptoms: convergence time rising sharply rather than
   proportionally as the fleet grows, and onset correlating with growth rather than
   with a deploy.

4. **Check for lock contention between the read path and the write path.**
   A single shared lock protecting both a frequently-read structure and an
   occasionally-written one will serialise work that looks independent. In Go
   specifically, `sync.RWMutex` blocks _new readers_ while a writer is waiting, to
   stop writer starvation — so one queued write can stall every in-flight peer
   transition. If each reconnect also triggers a write, reconnects and exports
   contend with each other by construction.

5. **Only then consider the version.** See below.

## The version red herring

A deploy shortly before onset is the most tempting correlation available and it is
frequently wrong. Discriminating questions:

- **Did this same version run fine on this same tenant, before?** If it ran for
  days and then failed, the version did not cause it. Something crossed a
  threshold.
- **Did rolling back fix it?** If the loop re-forms on the old version, the version
  is at most a margin, not the mechanism.
- **Did the fleet grow?** Growth moves you across a threshold with no code change
  at all.

A version change can legitimately _shift the margin_ — make a system that was
narrowly surviving start failing — without being the cause. Say exactly that when
it applies, because "upgrade caused it, roll back" sends people to do work that
will not help, and a rollback restart will itself recreate the worst-case load.

## What the fix usually is

For a quadratic-work loop, adding capacity or tuning the timeout buys margin but
leaves the shape intact. The durable fix is to **reduce the work**, typically by
not propagating information the far end does not need. If some tenants have a
suppression or aggregation profile applied and the affected one does not, that
asymmetry is the first thing to examine — and it is usually a deliberate product
trade-off (someone wanted the detailed visibility), so the decision belongs to
whoever made that trade, not to the engineer on call.

## Traps

- **"Rollback did not help, so the upgrade was not the problem"** — incomplete. The
  rollback restart recreates the mass-reconnect worst case, so a rollback can look
  like it made things worse while still being neutral.
- **Averages hide cliff behaviour.** A p50 convergence time well under the hold
  timer tells you nothing when the p99 is over it.
- **Do not stop at "the session timed out."** That is the deadline being exceeded,
  not the reason the work took that long.

## What good output looks like

State whether the work per reconnect scales with peer count, name the deadline
being crossed and what crosses it, and give an explicit verdict on the version
question rather than leaving it as an open suspicion. If the evidence says the
version is a margin rather than a cause, say so plainly.
