# Sync cost: what a streamed reply costs on the wire

`npm run bench:sync-latency` (`scripts/bench-sync-latency.ts`), fake gateway, run on 2026-10-30 against `main` at `32d0e391` and against this change, three times each, alternating. Five steady turns of 150 words at a word every 20 ms. The bench now also plays each device's window: its live arrivals go through the window's own `StreamFrames`, so `paint` says when each word was painted there, from the model's write. The reports are `before-<n>.json` and `after-<n>.json`.

## Results

Means of the three pairs. Budgets: 0.5 messages and 150 bytes a token on every hop.

| Hop | Messages / token | Bytes / token | Word to paint, p50 / p95 (ms) |
|---|---|---|---|
| Owner (Mac A's windows) | 0.70 → 0.49 | 422 → 269 | 42.6 / 71.0 → 29.6 / 52.8 |
| Phone | 0.70 → 0.49 | 495 → 320 | 43.5 / 71.9 → 31.1 / 55.1 |
| Second Mac (B's windows) | 0.70 → 0.49 | 422 → 269 | 43.7 / 72.1 → 31.4 / 55.5 |
| Cloud Thread watchers (each) | 0.70 → 0.49 | 495 → 320 | 43.4 / 71.8 → 31.0 / 54.9 |

Messages per token now meet the budget on every hop, at 0.491 or 0.492 in each run. Bytes per token are a third lower and still over it; see what's left.

**Relay**, p95 ms past the owner's own window, from the third pair: phone 2.6 → 1.7, second Mac 2.9 → 2.1, cloud watchers 2.3 → 1.6. The first two pairs read 1.7 to 2.5 before and 3.6 after, because the bench's own link proxies kept Nagle's delay, which held a frame back for the next one to coalesce with and fell differently on the new spacing; a WebSocket's socket turns it off, and the proxies now do too, as of the third pair.

**Status**, p95 ms, before → after (phone, second Mac): start 14.0 → 14.3, 44.5 → 45.5; end 21.2 → 21.4, 1.0 → 1.1; waiting 2.3 → 2.2, 1.5 → 1.5; title 2.7 → 2.6, 3.5 → 3.3; new and archive within a millisecond; nothing missed. Status doesn't wait for a frame: a turn starting or ending, a question and an approval flush at once.

## Where the bytes went

Every message of the steady turns was kept and its fields measured.

- **A batch every 33 ms against a paint every 50.** The host batched a stream on 33 ms, the window paints at most every 50 (`StreamFrames`). The two beat: a third of the batches were painted over unseen, on every hop and in the journal, and the median word was painted 43 ms after the model wrote it, 72 ms at p95. The host now batches on the paint's own frame (`LIVE_FRAME_MS`, which `StreamFrames` takes too), so each batch paints as it lands: 30 ms at the median, 52 at p95. A word reaches the owner's host later (p95 34 → 51 ms past the model's write), and every screen sooner.
- **Unchanged values restated whole.** A batch carries a field like the conversation's control (2.3 KB here: bindings, the execution context, the store's path) whenever it's a new object. The code that changes a conversation builds these anew, so a turn sent its control five times, four of them equal to the last. A batch now carries a whole value, and a request, only when its content changed (`sharedFields`, beside `sharedSession`).
- **Every answer sent twice.** Codex's record lands at a message's end with its whole text, which the batch sent whole again (950 characters a turn here). It now travels as the end it adds, nothing here, and its frames, as a call's restated output already did (`deliverLiveUpdates`).

## What's left, and why it isn't here

After this change, per token on the owner's hop (269 bytes): 70 are the stream frames each text update names (`stream`: a 125-character file name and a range, repeated on every update), 64 are requests restated whole on each change to one of their fields (delivery evidence, snapshots, spend, turn changes: nine or ten restatements a turn), 83 are each batch's own envelope (conversation id, epoch, revision, block coordinates), 11 the control's one real change a turn, and 28 the text updates themselves. The phone and the cloud watchers pay 51 more for the route header of each line.

None of those can shrink in a form every reader already reads: an older Mac or web client given a file-less frame keeps only its first range, and given part of a request replaces the whole request with it. Readers behind the gateway don't say what they read, so the owner can't send a smaller form only to those who can read it. Meeting 150 bytes a token takes a negotiated live form: subscribers saying the form they read, the gateway telling the runtime which conversations every watcher reads it for (`watch`), and the runtime sending that form only there.
