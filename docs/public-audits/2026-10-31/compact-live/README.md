# Compact live form: what a streamed reply costs on the wire, negotiated

`npm run bench:sync-latency` (`scripts/bench-sync-latency.ts`), fake gateway, run on 2026-10-31 against `main` at `2c54c2ba` and against this change, three times each, alternating (`before-<n>.json`, `after-<n>.json`; `ci-1.json` is CI's run). Five steady turns of 150 words at a word every 20 ms. Each device's arrivals are decoded in the form it says it reads and painted through its window's own `StreamFrames`. The machine was loaded throughout (other work ran beside the bench), which puts the p95s here about 8 ms above a quiet run of either build; each pair ran back to back under the same load.

## Results

Means of the three pairs. Budgets: 0.5 messages and 150 bytes a token on every hop.

| Hop | Bytes / token | Messages / token | Word to paint, p50 / p95 (ms) | Relay p95 (ms) |
|---|---|---|---|---|
| Owner (Mac A's windows) | 266.6 → 133.1 | 0.490 → 0.491 | 30.9 / 60.5 → 29.6 / 60.5 | |
| Phone | 317.6 → 133.1 | 0.490 → 0.491 | 33.1 / 64.4 → 30.9 / 61.8 | 1.5 → 1.2 |
| Second Mac (B's windows) | 266.6 → 133.1 | 0.490 → 0.491 | 33.5 / 64.7 → 31.8 / 64.2 | 2.0 → 1.5 |
| Cloud Thread watchers (each) | 317.6 → 133.1 | 0.490 → 0.491 | 33.0 / 64.3 → 30.8 / 61.7 | 1.4 → 1.0 |

Bytes per token are half on the owner's and a second Mac's hop and under half on the phone's and the cloud's, the same on every hop now. Messages per token are what they were: the form changes what a message holds, not how many go.

**Status**, p95 ms, before → after (phone, second Mac): start 11.0 → 7.9, 48.4 → 39.2; end 23.2 → 20.5, 1.6 → 1.2; waiting 1.6 → 2.0, 1.6 → 1.7; title 2.8 → 2.3, 3.9 → 3.4; nothing missed.

**On a CI runner**, the new `sync-bench` job, one run: 134.2 bytes and 0.496 messages a token on every hop, word to paint 32.6 / 62.7 ms on the owner's windows and 34.2 / 63.1 on the phone; all 54 budgets met.

## How readers and the owner agree

- A reader says the form it reads: a gateway client with `?live=2` on its connection, a window on its own host with `x-mako-live` on `/events`. One that says nothing reads form 1, as every build before this does.
- The gateway (link version 13) tells the owner, per watched conversation, the form every current watcher reads (`watch`'s `forms`), and per Thread (`live-form`), again whenever a reader comes or goes.
- The owner writes compact only there, and marks it (`form` on `live` and `event`). An update written before the owner heard of a form-1 reader reaches that reader as the notice to read the conversation again, under the same number (`frameFor`); a run of them in a Thread's backlog, as one (`logFor`).
- Both the desktop renderer and the web client apply a batch through one decoder (`applyLiveBatch`, `src/state/live-recovery.ts`, by way of `expandLiveBatch`).

## Where the bytes went

Every message of the steady turns was kept and its fields measured. Bytes per token on the owner's hop, from one run of each (261 bytes before, 132 after):

| Part | Before | After |
|---|---|---|
| Each batch's envelope (id, epoch, revision, block coordinates) | 88.1 | 73.5 |
| Stream frames named on each text update | 69.9 | 1.1 |
| Requests restated whole on a change to one field | 56.6 | 20.5 |
| Updates, text included | 33.4 | 35.1 |
| The control's one real change a turn | 10.8 | 0 |
| Session | 2.2 | 2.2 |
| Route header (phone and cloud only) | 50.6 | 0 |

- A text update that only grew goes as `more`, and its stream frame only when it starts or moves.
- A changed request or binding goes as the fields that changed.
- The implied `changedFrom` and `blockCount` go.
- The batch is alone on its line, read by its first characters (`readEventLine`), so the phone's and the cloud's line carries no route header.

## A stall at a turn's end went unnoticed

"A's link stalled 5 s" was noticed at 3.8 s in every run of the base, and missed in 2 of the 10 runs of this branch before the fix below. The bench stalls the owner's link at a turn's 30th word, 2.4 s before its last.

The owner asks a link whether it's alive only as it sends into one silent for 3 s (`CloudLink.probeIfSilent`). In every run it asked as the turn started (0.7 s before the stall), so it asked again at 2.3 s, with the turn's last updates. A diagnostic run recording the owner's link showed what moves that first ask: the link's own heartbeat, every 25 s, answered 4.1 s before the stall on this branch's schedule. One answered in the 3 s before a turn starts means no ask at the start; the next falls after the turn's last update, and nothing asks at all. The watchers then show the turn running until the link's 60-second silence limit. The base's schedule keeps its heartbeat out of that window; this branch's moved it close, which is the only part this change played.

The link now asks once it has been silent long enough, unless it hears from it first, when what went out came too soon after it last heard (`test-cloud-link.ts`, which fails without it). That costs a turn at most one more ping. `after-3.json` is from before the fix and shows the miss. The two runs after it (`fixed-1.json`, `fixed-2.json`) met all 54 budgets, at 131.4 and 130.4 bytes a token, the stall noticed at 2.6 and 3.8 s.

## What's left

- **Messages per token have little room**: 0.49 here, 0.496 on CI, against 0.5. About 0.39 of it is the text, a batch per paint frame (50 ms at a word every 20 ms). The rest is about fifteen other batches a turn, most of them in the turn's first 10 ms (status and request changes as it starts), and one batch a turn that changes nothing (no updates, no request changes). Dropping that empty batch, and folding a turn's opening changes into one, is the next lever; both touch when the host commits a batch to its journal, so neither is here.
- **The web client** reads compact once it ships with this build; until then a phone says nothing and its conversations are written whole while it watches.
