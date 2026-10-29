# Sync: reconnects pick up where they were

What a dropped or stalled link costs another device, before and after numbering each watched conversation's stream, keeping its last updates in the gateway, sending again what a dead link swallowed, and asking a silent link whether it's alive. Measured with `npm run bench:sync-latency` on 2026-10-29, against Mako's hosted gateway run on this Mac with a database of its own (no network, so the times here are the protocol's and the devices' own, not a network's).

## What ran

The bench as `docs/public-audits/2026-10-28/sync-latency/` describes it: two screenless hosts on one account (A runs a sealed Codex against the stand-in model at about 50 words a second; B opens A's conversation as a window does), a phone played through the web client's `Gateway`, and a cloud Thread's `MachineRuntime` fed A's batches. Each device's link is a proxy the bench stalls (nothing moves, nothing closes) or cuts. This change adds a sixth disturbance: **A's last batch lost**. A's link stalls just before a turn ends, so the turn's last words and its end go into a socket that's then cut. Nothing comes after them to show a gap.

Three runs:

- `before-main-bench.json`: `main` (`32eb5007`) with its own bench, gateway at `main`, `--quiet`.
- `before.json`: `main`'s hosts and gateway with this change's bench (the sixth disturbance, and the two figures below measured as they should be). Its phone follows as this change's web client does, against a gateway that sends no notice, so it reads a snapshot after every drop, as `main`'s does.
- `after.json`: this change, hosts and gateway, `--quiet`.

## Reconnect

"Time to current" runs from the link returning (the cut, or the thaw) until the device has shown every word A emitted more than 50 ms before. Budget: 1,000 ms, no word missed, no snapshot read.

| Disturbance | Device | Before: time to current, snapshots | After: time to current, snapshots |
|---|---|---|---|
| Phone's link cut | phone | 282 ms, 2 | 0 ms, 0 |
| B's link stalled 8 s | B | 7 ms after the thaw, 0 | 17 ms after the thaw, 0 |
| B's link cut | B | 1,024 ms, 1 | 0 ms, 0 |
| A's link stalled 5 s | phone, B | 40 ms after the thaw, 0 | 27 ms after the thaw, 0 |
| A's link cut | phone, B | 1,391 ms, 1 each | 241 ms, 0 |
| A's last batch lost | phone, B | the turn's end never shown; its last words only when something else came 8 s on | 239 ms, turn end shown, 0 |

A stall noticed while it lasts (budget 5 s):

| Stall | Before | After |
|---|---|---|
| B's link stalled 8 s | not noticed | 4.5 s: B's follow, silent 3 s while the conversation worked, pinged and replaced its connection |
| A's link stalled 5 s | not noticed | 3.8 s: A's runtime link, silent while sending what B and the phone watch, pinged and replaced |

The first five "before" rows are `before-main-bench.json`; the last is `before.json`. That run measured the first five again on `main` at 125, 7, 1,025, 30 and 583 ms, with the same snapshots: how long a cut takes before depends on where the retry's first second and the backoff fall, from a tenth of a second to more than one.

## Status figures the bench had wrong

Two figures in the first baseline were the bench's, not the product's:

- **A turn's start on the phone (`n=0`).** The phone's list says a conversation is at work before A's own batch does (#217 reports the start as the prompt is taken), so a start timed from A's batch was never counted. It's timed from the send now: 7 ms p50, 15 ms p95 on `main`; 6 ms, 19 ms after.
- **A new Thread on the phone (2,234 ms).** The row was in the phone's first list read, before its stream was followed, and counted only at the next change. The phone follows its list before A starts now, and a list read counts too: 34 ms on `main`, 40 ms after.

## Budgets

After: every live, status, reconnect and quiet budget is met (49 of 57). The eight over are messages and bytes per token on each hop, unchanged by this (0.70 messages and 418 bytes a token on the owner's hop, before and after).

## With traces

`after-with-traces.json` is the same run with one batch in 25 traced (and every one that starts or ends a turn, or asks or answers the person): it carries `emittedAt` and a trace that every hop logs. Every budget it met before it meets; bytes per token on the owner's hop went from 418 to 424. One trace, `st-328a1b52-86df`, as each hop logged it:

- A's host: `sync traced update sent trace=st-328a1b52-86df conversation=6ffc4282-… n=1793248272032`
- the gateway: `{"msg":"live trace","trace":"st-328a1b52-86df","conversation":"6ffc4282-…","seq":1793248281598,"watchers":2}`
- B's host: `sync traced update heard trace=st-328a1b52-86df conversation=6ffc4282-… lagMs=1`

Settings › Diagnostics shows the readings as Sync (a development build, its fixture readings): `sync-readout-light.png`, `sync-readout-dark.png`.
