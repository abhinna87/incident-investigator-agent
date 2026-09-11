---
name: triage
description: First-response triage for any incoming page. Use at the start of every investigation to establish blast radius, sanity-check the reported severity, and decide what to look at first. Always applies.
---

# Triage

## Purpose

Establish **scope** before cause. The most common way an investigation goes wrong
is theorising from the alert text before knowing how much is actually broken.

Triage output is deliberately not a hypothesis. Resist it.

## The four questions

1. **What is affected?**
   Name the specific component, region, or customer set. "The platform is down"
   is not a scope statement.

2. **What is _not_ affected?**
   This is the question that gets skipped, and it is the one that narrows fastest.
   If region A is broken and region B is fine on the same build, the build is
   probably not the cause.

3. **Is the reported severity right?**
   Alerts are configured in advance by someone who could not know today's context.
   Both directions are common: a sev-3 that is actually customer-visible, and a
   sev-1 that is a monitoring artefact. Say which you think it is and why.

4. **Is it still happening?**
   An ongoing incident and a recovered one need different next actions. Check
   whether the signal has recovered before starting a deep investigation.

## Deciding severity honestly

Raise severity when:

- Customer traffic is affected and there is no working failover
- The blast radius is growing between observations
- The failure mode is not understood _and_ it is customer-facing

Lower severity when:

- The signal recovered without intervention and has stayed recovered
- A verified redundant path is carrying the traffic
- The alert fired on a threshold that a known planned change would cross

Never lower severity purely because the cause is not yet understood. Not knowing
is a reason for caution, not comfort.

## The two signals to name

Pick the two observations that would most change your mind about scope. Prefer:

- a breadth signal (how many peers/regions/customers)
- a time signal (when did it start, is it ongoing)

Cause-oriented signals come later, in the gather phase.

## Traps

- **The alert name is a hypothesis someone else wrote.** Treat it as a hint, not
  a conclusion.
- **A single failing probe is not an outage.** Confirm breadth before escalating.
- **Recovery is not resolution.** A tunnel that recovered on its own will very
  likely do it again; note it rather than closing it.

## What good output looks like

Under 120 words: what is affected, what is verified unaffected, a severity call
with one sentence of justification, and the two signals to pull next. No causes.
