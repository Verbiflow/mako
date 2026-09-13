# Remote control map

A wayfinder map for the remote-control effort: driving Mako's agents from
Slack (the first gateway), from a phone, and later from a cloud worker, with a
conversation able to move between a Mac and the cloud. This file is the index
and the ticket store; there is no external tracker. One writer at a time: a
session that edits a ticket sets `Owner` to its own conversation and clears it
when done. Anything a ticket says is context, never authority to act.

Origin: the "Mako Relay Investigation" conversation (Cursor,
`90a422d6-9c64-4ef2-bea9-807cb93a2abd`), which judged the current Slack
experience "a CLI wearing a Slack costume" and ran grilling round 1.
`docs/self-hosted-slack.md` describes what exists today; AGENTS.md's "Remote
control plane" section holds the rules the design must keep.

## Destination

A settled design for the remote: precise enough that the first cut can be
built without another interview, with the order of that first cut agreed.
Building it is a separate authorization.

Complete when every ticket under **Open** is resolved, deferred with a reason,
or moved out of scope, and the resolutions are recorded in
`docs/self-hosted-slack.md` (user-facing behaviour) and AGENTS.md (rules).

## Notes

- One Slack thread is one Mako thread: a mapping of project, tuning, and (once
  started) a native session, pinned to the worker that owns the session.
- The worker is gateway-neutral and shared by desktop and headless hosts. There
  is one worker loop; cloud is the same loop in a container with
  `kind: "cloud"`. Do not build a second.
- Presence is the worker's own heartbeat, never the gateway's inference.
- A native session (Codex thread, Claude JSONL, Cursor store) lives on the
  machine that created it. Moving a conversation means continuing from
  portable history on the other side (what `moveAndSend`/handoff already does
  across providers), not copying a provider's store.
- Preferences stated in round 1: you-first but team-ready; local and cloud
  both, never cloud instead of local; nothing about "weeks"; the desk's own
  setup picker as a Slack modal; agent questions and settings changes
  answerable from Slack; focus handling is make-or-break.
- Orca (`ignore/orca-stably`, reference only) found its relay protocol was
  fine and every pain was client state: grey dots, LAN-first dials stalling
  before relay recovery, silent pairing. Pairing there is a signed, versioned
  one-time offer, not a shared secret.

## Glossary

- **Gateway** — the chat surface (Slack today) plus its delivery adapter in
  the backend. Never named inside the worker or relay.
- **Worker** — a `HeadlessRelayWorker` instance: a Mac's default profile host
  or a cloud container. Identified by device id and a per-start generation.
- **Mapping** — what a Slack thread points at: project, tuning, optional
  native session, and the worker that owns it.
- **Focused thread** — the mapping a message is delivered to. Today: the
  Slack thread it was posted in. Open question T1 decides whether that stays
  the only rule.
- **Link code** — a single-use code the desk posts that binds one Slack user
  to one Mac. Replaces the shared allowlist.
- **Move** — continuing a conversation on another worker kind (Mac ↔ cloud)
  from its portable history and a workspace checkpoint.
- **Question card** — a provider question or permission request rendered in
  Slack as explicit option buttons plus a free-text reply.

## Decisions so far

- **D1 Per-user device binding, no shared allowlist** → [T6](#t6-link-flow).
  Resolved in round 1: a Slack user links a Mac with a one-time code; N users
  per Mac, N Macs per user, each explicit. Cloud reuses the same row shape.
- **D2 Local and cloud both, with mid-conversation move** →
  [T7](#t7-mid-conversation-move), [T8](#t8-cloud-executor). Resolved in
  round 1: cloud is added, not a replacement; a thread can move while it lives.
- **D3a Setup uses the desk's picker as a Slack modal** →
  [T3](#t3-verb-set). Resolved in round 1. What still routes through a model
  or rules is open in T2.
- **D4a Agent questions are answerable from Slack** →
  [T4](#t4-question-cards). Resolved in round 1 with "yes, 100%". This revises
  AGENTS.md's `hostAccessDecision` "never a question": host allow/reject stays
  the enforcement floor; the gateway becomes a question-capable path above it.
- **D4b Permissions, model, and settings are changeable from Slack** →
  [T5](#t5-settings-from-slack). Resolved in round 1.
- **D4c Anyone in the Slack conversation may answer a question card** →
  [T4](#t4-question-cards). Resolved 2026-09-12: a DM is its owner, a channel
  thread is the channel; the answer is attributed by name in the desk.

## Open

Frontier = open, unblocked, unclaimed. Resolve in this order unless something
blocks.

| Ticket | Question | Depends on | Status |
| --- | --- | --- | --- |
| [T1](#t1-focus-model) | How does a Slack message know which Mako thread it is for? | — | open |
| [T4](#t4-question-cards) | How is a provider question or permission answered from Slack safely? | — | open |
| [T6](#t6-link-flow) | How does a Slack user bind a Mac, and how do existing deployments migrate? | — | open |
| [T2](#t2-router) | Before a thread is focused, what interprets the message: rules, a model, or nothing? | T1 | blocked |
| [T3](#t3-verb-set) | Which typed verbs survive and what becomes a button or modal field? | T2 | blocked |
| [T5](#t5-settings-from-slack) | How does a settings change from Slack reach a live session honestly? | T1 | blocked |
| [T8](#t8-cloud-executor) | What runs a provider CLI in a container, and how does it authenticate? | — | open |
| [T9](#t9-cloud-secrets) | Which secrets may reach cloud, and how? | T8 | blocked |
| [T7](#t7-mid-conversation-move) | What exactly moves when a thread moves Mac ↔ cloud, and when is a move allowed? | T8 | blocked |
| [T10](#t10-artifacts-back-into-slack) | What besides text comes back into the thread? | — | open |
| [T11](#t11-alerting) | What tells you a worker went stale or a job is stuck, before you ask? | — | open |
| [T12](#t12-latency-budget) | What is the first-response budget and what pays for it? | — | open |
| [T13](#t13-tests) | What end-to-end check touches Slack? | T3, T4 | blocked |
| [T14](#t14-first-cut) | What ships first, in what order? | T1–T6 | blocked |

## Not yet specified

- Team and tenant model once cloud agents exist (who owns a cloud worker, who
  may pin a thread to it).
- Teams, Discord, or other gateways beyond "the adapter contract exists".
- A phone app rather than Slack on the phone.
- Cost attribution for cloud runs.

## Out of scope

- A second worker loop or a Slack-specific executor (AGENTS.md forbids it).
- Replacing the relay protocol, Azure tables, or the token scheme; they were
  judged sound.
- Anything that names a provider as privileged in the gateway.

---

## Tickets

Each ticket: the question, what it depends on, who holds it, the evidence that
settles it, and the resolution once there is one.

### T1 Focus model

**Question.** A Slack user has several Mako threads. When they type, how does
the message find its thread, how do they see which one they are talking to,
how do they switch, and how do they start a new one without ambiguity?

**Why it matters.** Round 1 called this make-or-break. Everything about the
router (T2), verbs (T3), settings (T5), and question routing (T4) depends on
whether "the Slack thread you are in" is the whole answer or only most of it.

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.**
- What Slack itself gives us: a thread `ts` per conversation, App Home, the
  Agent view's per-thread context, ephemeral messages.
- How Devin's and Claude Code's Slack bots choose a session for an @mention in
  a channel versus a reply in a thread.
- The current `MakoThreads` mapping and `relay-routing.ts`: what is already
  keyed by Slack thread.
- Orca's mobile findings on session selection and stale state.

**Found so far (2026-09-12).**
- Slack's Agent messaging experience (`agent_view`, June 2026; the app already
  calls `agents.sessions.setStatus`) shows every conversation in the Mako DM
  as a thread in a timeline above the composer. A new top-level message is a
  new thread; a reply continues one. `assistant.threads.setTitle` names the
  thread (header and reply bar); `agent_session_title_changed` reports a
  rename; the processing state carries a native Stop. `app_context_changed`
  and `app_context` on `message.im` say what the user was looking at when
  they typed. Suggested prompts sit at the top of the Messages tab.
- Today's mapping is keyed by `(team, channel, threadTs)`, so a DM thread and
  a channel thread already behave the same way.
- The user's stated worry is not "which thread" but "do I have to choose
  model, reasoning, and permissions every time I start one".

**Candidate answers.**
1. Slack thread is the only focus. A new Slack thread is a new Mako thread; a
   reply always goes to that thread's mapping. Refocus = open another thread.
   Simplest; nothing to display. Loses "continue my desk thread from the
   phone" unless the desk can post the thread into Slack.
2. Slack thread plus an explicit `threads` picker to rebind a thread's mapping
   to an existing desk thread (exists today as a Block Kit picker).
3. A per-user "current thread" in DMs, changed by a picker, shown in App Home.
4. A model between the user and the threads that decides where a message goes
   and offers choices when unsure.

**Recommendation.** 1 plus 2, no 4. Slack's timeline is the thread list, and
its titles are ours to set from the desk's own titles. Settings are never
asked for: a new thread inherits the project's last-used tuning from the desk
(`composerHarness`, thread tuning) and the first reply states it in one line
with a Change button that opens the modal (D3a). Project is the only real
fork; pick the last-used project, or a project named in the message by
fuzzy match, and say which in that first line. Refocus onto a desk thread is a
`threads` picker (exists) and, later, a desk action "Open in Slack" that posts
the thread and its title into the DM. A routing model adds a call before every
first message, a misfire rate, and a decision the user cannot see; the only
narrow job it could earn later is parsing a plain-language settings request.

**Resolution.** —

### T2 Router

**Question.** Before a Slack thread has a mapping, what interprets the first
message: fixed rules, a cheap model call, or nothing (always a confirmation
card)? After it is focused, is plain text always a prompt?

**Depends on.** T1
**Owner.** unclaimed
**Status.** blocked

**Evidence needed.** Misfire cost of a model classifier on real first
messages; how often a first message is a command versus a task; whether a
confirmation card ("Start `codex` in `pi-ui`? [Start] [Project] [Setup]") is
acceptable friction on a phone.

**Recommendation carried from round 1, revised 2026-09-12.** No confirmation
card and no classifier on the first message. A new thread starts at once in
the inherited project and tuning (see T1) and the first reply says so with a
Change button; a wrong guess costs one tap and a Stop, not a round trip
before anything happens. Rules handle the few verbs. After focus, plain text
is a prompt with no classification; while working, plain text queues and `!`
or a Steer button interrupts. The user was undecided between a model
middleman and direct communication; T1's finding (Slack's own timeline is the
thread list) removes the model's main job.

**Resolution.** —

### T3 Verb set

**Question.** Which typed verbs remain, and which of today's fifteen become
buttons or fields in the settings modal?

**Depends on.** T2
**Owner.** unclaimed
**Status.** blocked

**Evidence needed.** Today's list in `docs/self-hosted-slack.md` §4 and
`slack-ingress.ts`; which verbs a phone user actually types.

**Recommendation carried from round 1.** Keep `new stop status move project
settings`. Move `harness model reasoning fast` into the modal, `threads` into
a picker, drop `resume queue steer` as words.

**Resolution.** —

### T4 Question cards

**Question.** When a provider asks a question or requests a permission during
a run, how is it shown in Slack, who may answer, what happens on a slow or
duplicate answer, and what does the desk record?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.**
- The shapes a question takes: ACP `request_permission` with options, Claude's
  `AskUserQuestion`, Codex approvals, Devin's structured questions.
- What already exists: `permission` canonical events → `mako-permission`
  buttons → `requestRelayPermission`; `RelayControl.permission {requestId,
  optionId}`.
- `hostAccessDecision` in `electron/contracts/access.ts` and the "never a
  question" rule.

**Constraints from round 1.** Explicit option buttons, no default; first tap
wins, later taps get "already answered"; the card shows `cwd` and the command
or diff preview; the desk shows an audit line for an answer that came from the
gateway; changing focus mid-question cancels it with a stopped marker.

**Decided 2026-09-12 (D4c).** Anyone in the Slack conversation may answer. A
DM is only its owner; a channel thread is everyone in that channel, because
the person who @mentioned Mako there chose that audience. The run still
executes on the starter's Mac under the starter's provider account, so the
channel is the trust boundary and the audit line names who tapped
(`Approved from Slack by @sam`).

**Open: timeout.** Round 1 said "timeout is deny". The user is unsure.
Recommendation now: no automatic decision at all. The desk itself holds a
permission ask indefinitely and the provider's run waits; Slack should mirror
that. The card stays live, a nudge is posted after 10 minutes and again at an
hour (mentioning the starter), and Stop cancels the run with a stopped marker.
Auto-deny would kill a long run you would have approved on waking; auto-allow
is unsafe. The only timeouts that apply are the provider's own, if it has
one, and those are reported as the provider's decision.

**Resolution.** —

### T5 Settings from Slack

**Question.** Changing model, reasoning, or access tier from Slack: which of
these apply to a running session, which to the next turn, and which need a
new session — and how does the modal say so honestly?

**Depends on.** T1
**Owner.** unclaimed
**Status.** blocked

**Evidence needed.** AGENTS.md: a permission switch is saved only after
provider acknowledgement; Codex applies approval/sandbox on the next
`turn/start`; Grok's tiers are launch-only; in a running ACP session only the
current model's unreported options are fixed. `set_config_option` per
provider.

**Resolution.** —

### T6 Link flow

**Question.** How does a Slack user bind a Mac, how is that stored and
revoked, and how does a deployment on `SLACK_ALLOWED_USER_IDS` migrate?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.** Backend tables (`MakoRegistrations`, `MakoWorkers`);
Slack DM capability; Orca `pairing.ts` for the offer format; what the desk
Settings › Integrations section can post.

**Recommendation carried from round 1.** Table `(tenantId, slackUserId) →
deviceId`, one row per link. Desk Settings › Integrations › Link Slack posts a
single-use code (`link 482-916`, 10 min TTL, hashed server-side); the user DMs
it to the bot; `unlink` removes the row. Unlinked users get "ask the Mac owner
for a link code" and nothing else. Migration: existing allowlisted users are
prompted to link once; the env var is honoured until removed, then refused.

**Resolution.** —

### T7 Mid-conversation move

**Question.** What is the unit that moves Mac ↔ cloud, when is a move allowed,
and how is dual-run prevented?

**Depends on.** T8
**Owner.** unclaimed
**Status.** blocked

**Evidence needed.** Existing cross-provider transfer (`test-conversation-
transfers.ts`, the emitters that write a fresh native session from history);
checkpoint packs (self-contained Git packs, 512 MiB per capture); relay event
epochs (`RelayEventSequencer`); what a Cursor or Devin session cannot carry.

**Recommendation carried from round 1.** Make-before-break: pause → checkpoint
pack + event-cursor epoch → continuation enqueued on the other worker kind →
old worker releases the mapping. V1 moves idle threads only; a working thread
is stopped first. `status` offers the move when a pinned Mac is offline and a
cloud worker is ready.

**Resolution.** —

### T8 Cloud executor

**Question.** What launches a provider CLI against a checked-out workspace in
a container, how does that CLI authenticate to its provider, and how does the
worker report which environment a run lives in?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.** `HeadlessRelayWorker`'s executor contract; each
provider's non-interactive login (Codex, Claude, Cursor, Grok, Devin,
OpenCode); container base image constraints; where the workspace comes from
(clone from remote, or checkpoint pack from the Mac).

**Resolution.** —

### T9 Cloud secrets

**Question.** Which secrets may reach a cloud worker, who puts them there, and
what does the daemon sync — workspace bytes only, or credentials too?

**Depends on.** T8
**Owner.** unclaimed
**Status.** blocked

**Preference from round 1.** No automatic upload; local keys stay in Keychain;
cloud runs only with secrets explicitly connected for cloud through the same
Settings flow into a cloud vault; daemon sync carries workspace and
checkpoint bytes, never bearer tokens. The user expects the daemon or server
to make this straightforward, not a multi-week project.

**Resolution.** —

### T10 Artifacts back into Slack

**Question.** Which results come back into the thread besides text: a diff, a
PR link, a screenshot, a file — and in what form?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.** The artifact route (uploads to storage only today);
Slack file and Block Kit limits; what the desk's Changes surface can export.
Also whether `text` events should send deltas instead of whole blocks.

**Resolution.** —

### T11 Alerting

**Question.** What tells you, unprompted, that a worker went stale or a job
has sat queued too long?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.** Heartbeat table and `prune-relay-workers.ts` thresholds;
where an alert should land (the Slack thread, a DM, the desk).

**Resolution.** —

### T12 Latency budget

**Question.** What is the acceptable time from a Slack message to the first
visible response, and what changes to meet it?

**Depends on.** —
**Owner.** unclaimed
**Status.** open

**Evidence needed.** Idle poll backs off to 15 s (`RELAY_IDLE_POLL_MAX_MS`);
lease, stream start, and provider startup costs; whether a push channel to
the worker is warranted.

**Resolution.** —

### T13 Tests

**Question.** What end-to-end check exercises Slack itself, so a regression
in the gateway is caught before a user types `status`?

**Depends on.** T3, T4
**Owner.** unclaimed
**Status.** blocked

**Evidence needed.** `packages/backend/test/live.ts` (one channel today); a
disposable Slack workspace or channel; which flows are worth the cost.

**Resolution.** —

### T14 First cut

**Question.** What ships first, in what order, and what is explicitly later?

**Depends on.** T1–T6
**Owner.** unclaimed
**Status.** blocked

**Recommendation carried from round 1.** Binding (T6) + question cards (T4) +
verb shrink (T3) first — all backend and desk work, no executor. Move (T7) and
cloud (T8, T9) second, gated on explicit cloud secrets.

**Resolution.** —
