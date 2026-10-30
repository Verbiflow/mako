# Sync latency: the first baseline

How long one device takes to see what another does, measured with `npm run bench:sync-latency` on 2026-10-28 at `dbc1d948` (`main`). Nothing here is fixed yet: these are the numbers the fixes are measured against, and many are over budget by design.

## What ran

- **Mac A.** A screenless host of the checkout, running a sealed Codex 0.164 against the stand-in model, paced to a word every 20 ms (about 50 tokens a second). Every word is unique (`t<turn>w<n>`), so its first arrival on any device is found by its text.
- **Mac B.** A second screenless host on the same account. It opens A's conversation as a window does, and reads it again on a revision gap, as a window does.
- **Phone.** Played at the protocol level through the web client's own `Gateway`. It follows the account's list, and follows A's conversation as `src/web-client/conversations.ts` does (follow again after 250 ms, then read a snapshot).
- **Cloud Thread.** The real `MachineRuntime`, in the bench's process, fed A's live batches as they happen. Three clients watch its Thread from its head.
- **Links.** Each device reaches the gateway through a proxy of its own, which the bench can stall (nothing moves, nothing closes) or cut.
- **Clock.** One clock, the bench's, times every hop.
- **Turns.** Five steady turns of 150 words; an approval answered from the phone; the phone and B sending at once; three renames; five link disturbances mid-turn; an archive.

There are two runs:

- **Fake gateway** (`fake-gateway.json`). No URL: the protocol's fake gateway behind the routes a host and a browser use, in the bench's process (`scripts/lib/sync-bench-cloud.ts`). This measures the hosts' own hops and needs nothing private. The fake keeps no presence, so it has no quiet phase.
- **Local gateway** (`local-gateway.json`). Mako's hosted gateway, run on this Mac with a database of its own, with `--quiet`. Local means no network, so live hops here are single milliseconds that a real network adds tens to.

## Results

### Live content

p50 / p95 / max in ms, over 750 words. Owner is from the model's write to A's host's event stream. Every other row is the time past A's emission.

| Hop | Fake gateway | Local gateway | Budget (p95) |
|---|---|---|---|
| Owner (model to A's host) | 17.9 / 19.5 / 31.8 | 18.6 / 19.9 / 22.7 | none |
| Phone | 0.5 / 0.7 / 4 | 0.9 / 2 / 12.1 | 10 |
| Second Mac | 0.8 / 1 / 10 | 1.2 / 2.8 / 12.6 | 10 |
| Cloud Thread watchers (3) | 0.5 / 0.6 / 3.9 | 1.9 / 3.8 / 12.4 | 10 |

### Status

p50 / p95 ms from the change on A to the device showing it, on the local gateway. Budget: 300 ms p95.

| Change | Phone (its list) | Second Mac |
|---|---|---|
| Start (working) | 742 / 1,742 (n=6, 1 never shown) | 1.2 / 3.9 |
| End (idle) | 653 / 1,694 (n=7) | 1.1 / 2.1 |
| Waiting on an approval | 120 (n=1) | 1.5 |
| New Thread | 465 | 465 |
| Title (Thread renamed) | 1,460 / 1,513 (n=3) | never shown (3 of 3) |
| Archived | 205 | 206 |

- **B is fast for status.** B follows the conversation, so its live batches carry each status change at once.
- **The phone is slow.** The phone's list waits for A's report tick: 1 s, jittered, and postponed while the host is busy.
- **Renames.** On the fake gateway only one rename of three reached the list. On the local gateway all three arrived, but about 1.5 s late. B's windows never heard any of them while following the conversation.

### Reconnect

Each disturbance happens mid-turn. "Time to current" runs from the link returning (the cut, or the thaw) until the device has shown every word A emitted more than 50 ms before. Local gateway figures:

| Disturbance | Device | Words missed | Time to current | Rereads | Stall noticed |
|---|---|---|---|---|---|
| Phone's link cut | phone | 0 | 289 ms | 2 | |
| B's link stalled 8 s | B | 0 | 19 ms after the thaw | 0 | not while stalled |
| B's link cut | B | 0 | 1,039 ms | 1 | |
| A's link stalled 5 s | phone, B | 0 | 52 ms after the thaw | 0 | not while stalled |
| A's link cut | phone, B | 0 | 1,180 ms | 1 each | |

No device lost a word for good, but the means differ:

- **Cuts.** Every cut recovers by reading a whole snapshot.
- **The 1 s waits.** B's first retry waits 1 s, and A's watched frames wait for its next report tick.
- **Stalls.** A stall is never noticed while it lasts. The device catches up only when the bytes flow again.

### Quiet devices

Local gateway, waiting at most 150 s for each. Budgets: 35 s after a kill, 90 s after a freeze, 2 s after a quit.

| How A or B went away | Phone said it was quiet after |
|---|---|
| Killed (`SIGKILL`) | 120.0 s |
| Quit (`SIGTERM`) | 120.0 s |
| Frozen (`SIGSTOP`, a sleeping Mac) | not within 150 s |

### Cost

Steady turns, per hop:

| Hop | Messages per token | Bytes per token |
|---|---|---|
| Owner, second Mac | 1.08 | 598 |
| Phone, cloud watchers | 1.08 | 710 |

The budgets are 0.5 messages and 150 bytes per token. Today the host sends a batch for nearly every word, and each batch carries far more envelope than text.

## Budgets

- **Local gateway:** 23 of 49 met.
- **Fake gateway:** 26 of 46 met.

The reports list every one that's over (`budgets.over`). The budgets are the sync plan's targets for local runs:

- **Live:** 10 ms p95 past emission (50 ms against a gateway on another computer).
- **Status:** 300 ms p95 (500 ms remote).
- **Reconnect:** current within 1 s, no word missed, no whole snapshot, a stall noticed within 5 s.
- **Quiet:** as above.
- **Cost:** as above.

## Running it

- `npm run bench:sync-latency -- --report-only` runs against the fake gateway. It takes about two minutes and needs a Codex CLI on `PATH`.
- Without `--report-only`, it exits 1 past any budget.
- `--cloud <url>` runs against a gateway, with a helper on stdin and stdout playing the person there. The gateway's own repository has that helper.
- `--quiet` adds the quiet phase, up to 150 s for each of the three (`--quiet-wait`).

It isn't in CI:

- A run takes over two minutes.
- It needs a real Codex CLI, which the runners don't have, set up with its Linux sandbox for the approval turn.
- Today's numbers fail budgets by design, so CI could only run it report-only. That would prove the bench still runs, not that sync is fast.
