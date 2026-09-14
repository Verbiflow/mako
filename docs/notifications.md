# Notifications

How Mako reaches you when an agent needs you, and the plan for reaching you
somewhere other than the desk.

## What ships today

Three outcomes exist. Every provider's events reduce to them:

| Kind     | Meaning                                       | Source transitions                                                        |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| `ready`  | A turn finished; there is an answer to read.  | Live `running → ready` with no queue and no cancel; native run `done`; a built-in tab that stops streaming. |
| `ask`    | The agent is blocked on you.                  | A new permission request or question (keyed by its id).                    |
| `failed` | The run stopped with an error.                | Live `→ failed`; native run `failed`.                                      |

A question is an `ask` with `questions`, not a fourth kind. Starting, tool
calls, and attach/detach never notify: the working mark is enough.

### Where it lives

- `src/state/notifications.ts` is the attention centre. React-free. It
  owns the item list, the policy, the burst coalescer, the badge count, and
  the seen bookkeeping. `scripts/test-notifications.ts` drives it against a
  fake environment.
- `src/state/notifications-desk.ts` binds the centre to the window: which
  thread is on screen, whether the window is in front, and how to open a
  thread from a banner. Preview windows observe but never announce.
- `src/lib/notification-text.ts` turns markdown into a banner body: first
  paragraph, plain text, 200 characters, cut at a word.
- `electron/desktop-notifications.ts` is the platform side, Electron-free:
  one banner per thread, retained until it reports, badge writes deduplicated
  and capped at `99+`. `desktop-notifications-electron.ts` supplies the real
  `Notification` and dock calls; both the desktop client and the standalone
  host use it. `src/dev/web-notifications.ts` answers the same channels in a
  browser with the page Notification API and the tab title.
- Outcomes are noted at the sites that already decide rail attention:
  `syncThreadStatus` in `acp-live.ts` (live conversations), `applyThreadRun`
  in `thread-status.ts` (native runs), and the tab turn tracking in
  `session.ts` (built-in tabs).

### The policy

`decideDelivery` in `notifications.ts` is the whole rule, as a pure function
of four facts: the outcome's kind, whether its thread is on screen, whether
the window is in front, and whether this is a replay.

| Thread on screen | Window in front | Result                                   |
| ---------------- | --------------- | ---------------------------------------- |
| yes              | yes             | Seen at once. One cue. Nothing else.     |
| no               | yes             | An in-app card you click to go there; a cue. |
| any              | no              | A desktop banner. Silent unless sounds are on. |

Three rules sit on top of the table:

- **Transitions, never states.** An `ask` carries its permission id; a
  `ready` carries the turn. The same fact twice is one item. Hydration and
  reconnect replays are recorded so the badge stays honest, but never
  announced, because a reconnect must not re-ring every banner you lived
  through.
- **A thread that starts again retires its unseen items.** The answer you
  did not read is the one you just replied to. An answered permission retires
  only the `ask`.
- **Bursts are one banner.** Desktop banners wait 600 ms; four or more in
  that window become "4 answers ready" with the names in the body. Fewer
  stay individual, and the platform replaces an earlier banner for the same
  thread instead of stacking.

Failures are never toasted by the centre: the run's own error toast already
says what broke. They still badge and still banner when you are away.

### What you see

- **The app icon** counts distinct threads with something unseen. Not
  events, not running agents. It clears as you open threads, and Settings
  can turn it off.
- **The rail** marks each thread: an unread answer is the brightest mark a
  row carries, an ask and a failure wear their own, and the Status view
  groups threads by what they need. The titlebar carried a pill with the
  same count over its own list; the chrome does not need to repeat what the
  list beside it already shows, so the pill is gone.
- **Cmd+Shift+U** opens the next thread that needs you. "Mark every
  notification seen" is in the palette.
- **Settings > Notifications** holds the desktop toggle (enabling asks the
  system for permission), the app-icon count, a test banner, the three
  "tell me when" switches, and the sounds. The permission readout re-reads
  on window focus because macOS only lets System Settings flip it.

Clicking a banner surfaces the window that asked (`app.focus({steal:true})`
on macOS) and sends `notification-activated` with the subject; the renderer
opens the thread the way the rail would.

### macOS authorization, verified

Electron 43 exposes no notification authorization API (`isSupported`,
`getHistory`, `remove*` only), and `show()` returns before macOS decides.
Two facts were checked on macOS 26.6 rather than assumed:

- The checkout's ad-hoc `Electron.app` cannot notify at all. `show()` is
  answered by a `failed` event ten milliseconds later with
  `UNErrorDomain error 1`, `getHistory()` stays empty, and macOS never
  prompts because the binary is not signed. The notifier therefore refuses
  before touching the platform (`reason: "unsigned"`) and Settings says so.
  Only the packaged, signed app notifies; it appears as Mako.
- `UNUserNotificationCenter` does answer from a tiny Swift helper, but only
  from inside the bundle: run from `/tmp` it aborts (exit 134); run from
  `Contents/MacOS` it prints `{"authorization":"not-determined",…}`.
  `scripts/build-notification-status.mjs` compiles
  `native/notification-status-macos/main.swift` with the app's bundle id
  embedded as an `__info_plist` section (so `codesign` derives
  `dev.mako.app` for it, verified), packaging places it beside the Electron
  executable and lists it for signing, and
  `electron/notification-authorization.ts` reads it with a shared in-flight
  call. Authorized with alert style "None" reads as denied.

Delivery is honest as well: `notify` resolves on `show` (delivered),
`failed` (denied) or after a 1.5 s grace, so the test button's toast and the
fallback in-app toast reflect what the platform did.

### External activity

Claude Code's session registry and Mako's OpenCode plugin report
`needs-input` for a terminal session that is waiting, keyed by `since`; the
activity engine polls each provider and `threads.ts` emits a
`thread-activity` event only on change. Those transitions are outcomes:
`needs-input` asks you, answering retires the ask, working then open is a
finished turn. A process that vanished mid-turn says nothing, because an
exit is not an answer. Codex, Cursor, and Grok probes only report `open`, so
they never ask through this path.

### Known limits

- Two clients on one host (the desktop app and a `npm run web` tab) each
  announce. Preview windows do not.
- The helper is arm64 only, matching the packaged target. A machine without
  the Command Line Tools cannot package; `--require` makes that explicit.

## The plan: beyond the desk

The user asked whether a queue is overkill. For the desk it is: the renderer
is the only thing that knows what you are looking at, delivery is
synchronous, and a lost banner costs nothing because the badge and the pill
carry the same fact. Local is flushed immediately and that stays.

Remote channels are different in three ways that force a queue: delivery is
asynchronous and can fail, a duplicate is a real interruption on someone's
phone, and "did the user already see this on the desk" is a fact that
changes after the event fired. So the design is an **outbox with receipts**,
not a message bus.

### Phase 1 — host-owned attention ledger (no new channels yet)

Move the outcome derivation from the renderer's attention sites to the host,
as one provider-neutral stream. The host already sees every transition
(`live-batch`, `thread-run`, session meta); it emits
`attention` events `{ kind, subject, marker, at, body }` and the renderer's
centre consumes them instead of deriving its own. The renderer keeps the
policy (it still owns "on screen"), and reports **seen receipts** back:
`mako:attention-seen { subject, marker, at }`.

The host keeps a small SQLite table beside the journals:
`attention(subject, marker, kind, at, body, seen_at)`. Bounded (30 days /
1,000 rows), idempotent on `(subject, marker)`. This is what makes the
badge survive a renderer restart and what every remote channel reads.

Why first: it removes the only duplication (three derivation sites) and
gives remote channels a single truth without touching the desk UX.

### Phase 2 — presence and the escalation ladder

A remote channel must not ring for something you are looking at. Every
client heartbeats presence to the host: visible, focused, the subject on
screen, last real input (never advanced by the heartbeat itself), and on
Electron the OS idle time. The host computes one plan per outcome:

1. Some client is focused on the subject → nobody is told.
2. Some client was active in the last 3 minutes → that client's desk
   announces (already true today).
3. Otherwise → the outbox takes it.

An outbox row is created only in step 3, with a **hold** of 20 seconds. If a
seen receipt for the subject arrives during the hold, the row is cancelled.
This is the cheap answer to "I got a Slack ping for the thing I was reading":
most of those are the desk and the phone racing, and the hold wins the race
for the desk.

### Phase 3 — the outbox and the first remote channel (Slack)

`@mako/relay` already owns jobs, cursors, workers, and a storage contract,
and the backend has `RelayDeliveryAdapter` per gateway. Notifications ride
the same road in the other direction:

- `outbox(id, subject, marker, kind, body, channel, state, attempts,
  next_at, hold_until)` on the host. States: `held → due → sent | cancelled
  | dead`. At-least-once delivery with exponential backoff to 10 minutes and
  a 24-hour dead line; idempotency key `subject:marker:channel` so a retry
  after a crash cannot double-send.
- The desktop relay worker (`relay-worker.ts`) drains due rows to the
  backend as a new `notify` request with the same short-lived device tokens
  it already uses. The backend's Slack adapter posts into the thread that
  the subject is mapped to (`relay-conversations.ts` already keeps that
  mapping), or a DM when it has none, with an **Open in Mako** deep link
  and, for `ask`, the same allow/deny controls the Slack ingress already
  understands. A permission answered from Slack flows back through the
  existing control path and retires the outbox row.
- The Slack message is edited, not re-sent, when the subject moves on:
  "needs you" becomes "answered", "ready" becomes "read" once a seen
  receipt lands. That is the remote equivalent of replacing the banner.

Per-channel preferences live on the host, not in localStorage:
which kinds, quiet hours, and a per-project mute. Failures are excluded from
remote channels by default; they are frequent, self-explanatory in situ, and
rarely time-sensitive.

### Phase 4 — push and anything else

Push (an APNs relay or a web push endpoint) is one more `channel` value and
one more adapter. Because the outbox already carries hold, receipts, and
idempotency, a new channel is an adapter plus a preference row. The desk and
the phone never both ring: the plan picks one recipient, and a receipt from
either cancels the rest.

### What stays out

- No notification history surface beyond the titlebar list. The ledger
  keeps 30 days for the badge and the remote channels, not for browsing.
- No "still working after N minutes" alerts until someone asks; the rail
  already shows elapsed time.
- No per-thread mute until per-project mute proves insufficient.

### Order of work

1. Ledger + host `attention` events + seen receipts (renderer derivation
   deleted). Tests: `scripts/test-attention-ledger.ts` against a temporary
   profile; the existing notification test keeps covering the policy.
2. Presence heartbeats and the plan function, pure and unit-tested like
   `agent-attention-policy` in Paseo.
3. Outbox with hold and receipts; Slack adapter; `packages/relay/test`
   covers state transitions, idempotency, and cancellation on receipt.
4. Push adapter.

Each step ships on its own and none of them changes what the desk does
today.
