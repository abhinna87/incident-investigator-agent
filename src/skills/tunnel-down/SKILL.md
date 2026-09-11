---
name: tunnel-down
description: Investigate a network tunnel or VPN session that has dropped, flapped, or failed to re-establish. Use when the alert mentions tunnel down, session reset, phase 1/phase 2 failure, or a peer that stopped forwarding.
---

# Tunnel down

## When this applies

The page names a tunnel, VPN session, or peer that is down or flapping. It does
**not** apply to slow-but-up tunnels — throughput problems have a different
shape and belong in a capacity investigation.

## Order of checks

Work outside-in. Most tunnel pages resolve at step 1 or 2, and starting at the
data plane wastes the first ten minutes.

1. **Is the peer reachable at all?**
   Check underlay reachability before anything protocol-specific. A tunnel cannot
   negotiate across a black-holed path, and the tunnel alert is then a symptom
   rather than the fault.

2. **Did the session negotiate and then drop, or never come up?**
   These have disjoint cause sets:
   - _Never came up_ → configuration or credential mismatch, proposal mismatch,
     policy change, certificate expiry.
   - _Came up then dropped_ → keepalive/hold-timer expiry, rekey failure,
     resource exhaustion on either endpoint, path change.

3. **Is it one peer or many?**
   One peer points at that peer or its path. Many peers at once points at the
   shared component: the head-end, the control plane, or a change that landed.
   Ask explicitly how many are affected before theorising.

4. **Did anything change?**
   Correlate the first failure timestamp against deploys, config pushes, and
   certificate expiry dates. A cause that cannot be tied to a change needs a
   stronger evidentiary bar.

5. **Is the standby path actually healthy?**
   A failover that did not happen looks identical to a failover that happened and
   also failed. Confirm the backup path independently rather than assuming.

## Signals worth pulling

- Tunnel/session up-down state per peer, 1h window, at the finest resolution available
- Session reset or renegotiation counters — a rising count with a flat up-state
  means it is flapping faster than the scrape interval
- Control-plane CPU and memory on both endpoints
- Log patterns: `hold timer expired`, `no proposal chosen`, `authentication failed`,
  `connection reset by peer`
- Route withdrawals coinciding with the drop

## Traps

- **A flapping tunnel can read as "up"** if the scrape interval is longer than the
  flap period. Trust the reset counter over the state gauge.
- **Both-ends-look-fine is a real answer.** If each endpoint reports healthy and
  traffic still is not forwarding, the fault is in the path between them; say that
  rather than picking an endpoint to blame.
- **Do not conclude from a single datapoint.** One missed scrape is not an outage.

## What good output looks like

State how many peers are affected, whether sessions dropped or never formed,
which change (if any) correlates, and whether the standby path is verified
healthy. If any of those is unknown, list it as unknown — an RCA with an honest
gap is more useful than one with a confident guess.
