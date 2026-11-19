import { z } from "zod"
import type { LiveRequest, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import { personPromptedAt } from "@mako/host/contracts/worked-at"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { JsonValue } from "@mako/host/contracts/json"
import {
  AutomationDefinitionSchema,
  automationFingerprint,
  automationClientKey,
  cloudTriggerWaiting,
  triggerFiresHere,
  type AutomationDefinition,
  type AutomationDefinitionInput,
  type AutomationDraft,
  type AutomationHook,
  type AutomationRunOf,
  type AutomationLocal,
  type AutomationProjectReading,
  type AutomationProposal,
  type AutomationRun,
  type AutomationRunNowResult,
  type AutomationsReading,
  type AutomationTemplate,
  type AutomationView,
} from "@mako/host/contracts/automations"
import type { ThreadRef } from "@/lib/types"

/*
 * Automations for the mock desk: three projects, a dozen automations in every standing (off, on, paused after
 * failures and after a changed file, running, waiting for the cloud), runs in every status whose Threads open, cloud
 * event causes with their links, `runWhen` checks that passed and skipped, a pending change with a real diff, a
 * pending create, decided proposals of each kind, and templates. `?app=automations` adds the run Threads and the
 * proposing Thread as live conversations, its proposal an ask in the Inbox. The bridge's writes change this state and
 * say so as the host would, `automations-changed` and `automation-run`.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = Date.now()

export const AUTOMATION_PROJECTS = { mako: "/Users/you/mako", site: "/Users/you/verbiflow-site", api: "/Users/you/api" } as const

/** Live conversations a run started, each a Thread the mock opens. */
export const RUN_THREADS = {
  triageRunning: { conversation: "a7000000-0001-4000-8000-0000000000a1", title: "Nightly CI triage · Thu 19 Nov", harness: "claude" },
  triageDone: { conversation: "a7000000-0002-4000-8000-0000000000a2", title: "Nightly CI triage · Wed 18 Nov", harness: "claude" },
  triageBlocked: { conversation: "a7000000-0003-4000-8000-0000000000a3", title: "Nightly CI triage · Tue 17 Nov", harness: "claude" },
  depsFailed: { conversation: "a7000000-0004-4000-8000-0000000000a4", title: "Weekly dependency bumps", harness: "codex" },
  releaseNotes: { conversation: "a7000000-0005-4000-8000-0000000000a5", title: "Release notes for v0.171.0", harness: "claude" },
  docsCheck: { conversation: "a7000000-0006-4000-8000-0000000000a6", title: "Check the schema doc after 4be81c2", harness: "codex" },
  sentry: { conversation: "a7000000-0007-4000-8000-0000000000a7", title: "Sentry: TypeError in checkout", harness: "claude" },
  proposer: { conversation: "a7000000-0009-4000-8000-0000000000a9", title: "Speed up the nightly triage", harness: "claude" },
  byHand: { conversation: "a7000000-0010-4000-8000-0000000000b0", title: "Run by hand", harness: "claude" },
} as const

const JSON_VALUE = z.json()

/** A definition as the wire carries it. */
function json(value: AutomationDefinition): JsonValue {
  return JSON_VALUE.parse(JSON.parse(JSON.stringify(value)))
}

const PROPOSAL_ASK = "a7000000-ask0-4000-8000-0000000000aa"

function definition(input: AutomationDefinitionInput): AutomationDefinition {
  return AutomationDefinitionSchema.parse(input)
}

const TRIAGE = definition({
  id: "nightly-ci-triage",
  name: "Nightly CI triage",
  prompt: {
    objective: "Read last night's failed CI runs on main, find the cause of each, and fix the ones that are ours.",
    doneWhen: ["Every failure has a cause in the report", "Each fix has a passing test"],
    boundaries: ["Don't touch the release branch", "No new dependencies"],
    output: "Each failure, its cause, and the pull request that fixes it",
  },
  start: { harness: "claude", model: "claude-opus-5-5", reasoning: "high", access: "edits", place: "here", workspace: { base: "main", branch: "auto/{automation}/{date}" } },
  triggers: [{ kind: "schedule", cron: "0 7 * * 1-5", timezone: "Europe/London" }],
  gate: { command: "gh run list --branch main --status failure --limit 20 --json databaseId --jq 'if length > 0 then {key: (map(.databaseId) | join(\",\")), failures: length} else halt_error(1) end'", timeoutS: 60 },
  limits: { overlap: "skip", maxRunsPerDay: 2, timeoutMin: 90, tokenBudget: 2_000_000 },
  result: "pull-request",
})

const DEFINITIONS = {
  [AUTOMATION_PROJECTS.mako]: [
    TRIAGE,
    definition({
      id: "weekly-deps",
      name: "Weekly dependency bumps",
      prompt: { objective: "Bump patch and minor versions of our npm dependencies, run the suites, and open one pull request with what passes.", boundaries: ["No major versions", "Leave electron alone"] },
      start: { harness: "codex", model: "gpt-5.5-codex", access: "edits", place: "here", workspace: { base: "main", branch: "deps/{date}" } },
      triggers: [{ kind: "schedule", cron: "0 6 * * 1", timezone: "Europe/London" }],
      limits: { overlap: "skip", timeoutMin: 120 },
      result: "pull-request",
    }),
    definition({
      id: "release-notes",
      name: "Draft release notes",
      prompt: { objective: "Write release notes for the release that was just published, from the merged pull requests since the last one.", output: "The notes, ready to paste" },
      start: { harness: "claude", access: "chat", place: "here", whenAway: "cloud" },
      triggers: [{ kind: "github", event: "release", repo: "Verbiflow/mako", runWhen: "It's a minor or major release, not a patch" }],
      result: "report",
    }),
    definition({
      id: "schema-doc",
      name: "Keep the schema doc honest",
      prompt: { objective: "A commit changed a migration. Check docs/schema.md still matches the tables and fix it if not." },
      start: { harness: "codex", access: "edits", place: "here" },
      triggers: [{ kind: "commit", branch: "main", runWhen: "The commit touches packages/sessions/src/migrations" }],
      limits: { overlap: "queue", timeoutMin: 20 },
      result: "act",
    }),
    definition({
      id: "flaky-tests",
      name: "Hunt flaky tests",
      prompt: { objective: "Rerun the UI suites five times and report any test that passes and fails on the same commit." },
      start: { harness: "claude", access: "edits", place: "cloud" },
      triggers: [{ kind: "schedule", cron: "30 2 * * *", timezone: "UTC" }],
      limits: { overlap: "skip", timeoutMin: 240, tokenBudget: 500_000 },
      result: "report",
    }),
    definition({
      id: "check-failed-fix",
      name: "Fix a failing check",
      prompt: { objective: "A check failed on a pull request. Read its log, fix what's ours, and push to that branch." },
      start: { harness: "claude", access: "edits", place: "here", whenAway: "queue", workspace: { branch: "{run}" } },
      triggers: [{ kind: "github", event: "check_failed", repo: "Verbiflow/mako", filters: { branch: ["main", "release"] } }],
      result: "act",
    }),
  ],
  [AUTOMATION_PROJECTS.site]: [
    definition({
      id: "broken-links",
      name: "Broken links on the site",
      prompt: { objective: "Crawl the built site and fix links that 404." },
      start: { harness: "opencode", access: "edits", place: "here" },
      triggers: [{ kind: "schedule", cron: "0 9 1 * *", timezone: "America/New_York" }],
      result: "pull-request",
    }),
    definition({
      id: "sentry-triage",
      name: "Triage new Sentry issues",
      prompt: { objective: "Investigate the new Sentry issue, find the commit that caused it, and prepare a fix." },
      start: { harness: "claude", access: "edits", place: "here", whenAway: "cloud" },
      triggers: [{ kind: "sentry", event: "issue_created", project: "verbiflow-web" }],
      limits: { overlap: "queue", maxRunsPerDay: 10, timeoutMin: 45 },
      result: "pull-request",
    }),
    definition({
      id: "slack-questions",
      name: "Answer #support questions",
      prompt: { objective: "Draft an answer to the support question, grounded in the code, for a person to send." },
      start: { harness: "claude", access: "chat", place: "here" },
      triggers: [{ kind: "slack", event: "message", channels: ["support"], runWhen: "It's a technical question about the product" }],
      result: "report",
    }),
  ],
  [AUTOMATION_PROJECTS.api]: [
    definition({
      id: "stripe-webhook",
      name: "Replay failed Stripe events",
      prompt: { objective: "Read the failed webhook deliveries in this batch and replay the ones our handler can take now." },
      start: { harness: "codex", access: "ask", place: "here" },
      triggers: [{ kind: "webhook", secret: "STRIPE_FORWARD", coalesce: { windowS: 300 } }],
      result: "report",
    }),
    definition({
      id: "openapi-sync",
      name: "Sync the OpenAPI spec",
      prompt: { objective: "Regenerate openapi.yaml from the routes and commit it if it changed." },
      start: { harness: "codex", access: "edits", place: "here" },
      triggers: [{ kind: "manual" }],
      result: "act",
    }),
    definition({
      id: "token-rotation",
      name: "Remind about token rotation",
      prompt: { objective: "List API tokens older than 90 days and draft the rotation steps." },
      start: { access: "chat", place: "here" },
      triggers: [{ kind: "schedule", cron: "0 10 * * 5", timezone: "Asia/Tokyo" }],
      result: "report",
    }),
  ],
} satisfies Record<string, AutomationDefinition[]>

function slot(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16)}Z`
}

function run(project: string, automation: string, fields: Partial<AutomationRun> & Pick<AutomationRun, "cause" | "status" | "at">): AutomationRun {
  const occurrence = fields.occurrence ?? (fields.cause.kind === "schedule" ? slot(fields.cause.at) : fields.cause.kind === "commit" ? `commit-${fields.cause.head}` : `now-${Math.round(fields.at)}`)
  return { occurrence, automation, project, clientKey: automationClientKey(automation, occurrence), ...fields }
}

function seedRuns() {
  const mako = AUTOMATION_PROJECTS.mako
  const site = AUTOMATION_PROJECTS.site
  const api = AUTOMATION_PROJECTS.api
  const morning = (days: number) => {
    const at = new Date(NOW - days * DAY)
    at.setUTCHours(7, 0, 0, 0)
    return at.getTime()
  }
  const t = RUN_THREADS
  return {
    [`${mako}\u0000nightly-ci-triage`]: [
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: NOW - 22 * MINUTE }, status: "fired", at: NOW - 22 * MINUTE, startedAt: NOW - 21 * MINUTE, gate: { key: "11873,11871", context: { failures: 2, runs: [11873, 11871] } }, thread: { conversation: t.triageRunning.conversation, request: "r1", branch: "auto/nightly-ci-triage/2026-11-19" } }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(1) }, status: "completed", at: morning(1), startedAt: morning(1) + MINUTE, endedAt: morning(1) + 38 * MINUTE, gate: { key: "11840", context: { failures: 1, runs: [11840] } }, thread: { conversation: t.triageDone.conversation, request: "r2", branch: "auto/nightly-ci-triage/2026-11-18" }, result: { status: "done", summary: "One failure: test-inbox-ui timed out waiting for the rail after #1031 renamed a selector. Fixed the selector and opened a PR; the suite passes locally three times.", pullRequest: "https://github.com/Verbiflow/mako/pull/1042" } }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(2) }, status: "completed", at: morning(2), startedAt: morning(2) + MINUTE, endedAt: morning(2) + 64 * MINUTE, gate: { key: "11802,11799,11797" }, thread: { conversation: t.triageBlocked.conversation, request: "r3" }, result: { status: "blocked", summary: "Two of three failures are GitHub's: the macOS runners ran out of disk. The third needs a decision on whether Grok 4.3 stays in the matrix." } }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(3) }, status: "gate-skipped", at: morning(3), why: "The gate found no failed runs on main." }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(4) }, status: "gate-skipped", at: morning(4), why: "The gate found no failed runs on main." }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(5) }, status: "gate-skipped", at: morning(5), why: "The gate found no failed runs on main." }),
      run(mako, "nightly-ci-triage", { cause: { kind: "schedule", at: morning(6), catchUp: true }, status: "skipped", at: morning(6) + 3 * HOUR, why: "Its gate key 11702 already ran on Friday.", gate: { key: "11702" } }),
      run(mako, "nightly-ci-triage", { cause: { kind: "person" }, status: "failed-to-start", at: morning(7) + 5 * HOUR, why: "Claude Code had no room: the account's five-hour limit resets at 14:20." }),
    ],
    [`${mako}\u0000weekly-deps`]: [
      run(mako, "weekly-deps", { cause: { kind: "schedule", at: morning(3) - HOUR }, status: "failed", at: morning(3) - HOUR, startedAt: morning(3) - HOUR, endedAt: morning(3) + HOUR, why: "Stopped after 120 minutes, its timeout.", thread: { conversation: t.depsFailed.conversation, request: "r4", branch: "deps/2026-11-16" } }),
      run(mako, "weekly-deps", { cause: { kind: "schedule", at: morning(10) - HOUR }, status: "failed", at: morning(10) - HOUR, why: "npm ci failed: ERESOLVE could not resolve @types/react@19.3.", thread: { conversation: t.depsFailed.conversation, request: "r5" } }),
      run(mako, "weekly-deps", { cause: { kind: "schedule", at: morning(17) - HOUR }, status: "failed", at: morning(17) - HOUR, why: "The suites failed on two bumps; nothing passed to open.", thread: { conversation: t.depsFailed.conversation, request: "r6" } }),
    ],
    [`${mako}\u0000release-notes`]: [
      run(mako, "release-notes", { occurrence: "github-release-188234", cause: { kind: "event", source: "github", event: "release", id: "188234", summary: "Release v0.171.0 published in Verbiflow/mako", url: "https://github.com/Verbiflow/mako/releases/tag/v0.171.0" }, status: "completed", at: NOW - 5 * HOUR, startedAt: NOW - 5 * HOUR, endedAt: NOW - 4.7 * HOUR, runWhen: { verdict: "run", reason: "0.171.0 is a minor release.", model: "claude-haiku-4-5" }, thread: { conversation: t.releaseNotes.conversation, request: "r7" }, result: { status: "done", summary: "Notes for 0.171.0: 14 pull requests in four groups, the Overview panel first. Ready to paste." } }),
      run(mako, "release-notes", { occurrence: "github-release-188101", cause: { kind: "event", source: "github", event: "release", id: "188101", summary: "Release v0.170.2 published in Verbiflow/mako", url: "https://github.com/Verbiflow/mako/releases/tag/v0.170.2" }, status: "skipped", at: NOW - 2 * DAY, runWhen: { verdict: "skip", reason: "0.170.2 is a patch release.", model: "claude-haiku-4-5" }, why: "0.170.2 is a patch release." }),
    ],
    [`${mako}\u0000schema-doc`]: [
      run(mako, "schema-doc", { cause: { kind: "commit", head: "4be81c2a9f", subject: "Store a run's gate key" }, status: "completed", at: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, endedAt: NOW - 2.9 * HOUR, runWhen: { verdict: "run", reason: "It adds packages/sessions/src/migrations/0042_gate_key.sql." }, thread: { conversation: t.docsCheck.conversation, request: "r8" }, result: { status: "done", summary: "docs/schema.md was missing gate_key on automation_runs. Added it." } }),
      run(mako, "schema-doc", { cause: { kind: "commit", head: "91ad03e7b2", subject: "Rename the rail's Inbox row" }, status: "skipped", at: NOW - 6 * HOUR, runWhen: { verdict: "skip", reason: "No migration changed." }, why: "No migration changed." }),
      run(mako, "schema-doc", { cause: { kind: "commit", head: "77c1de0aa1", subject: "Polish the Overview panel" }, status: "skipped", at: NOW - 7 * HOUR, runWhen: { verdict: "skip", reason: "No migration changed." }, why: "No migration changed." }),
      run(mako, "schema-doc", { cause: { kind: "commit", head: "c0ffee1234", subject: "Queue a second commit" }, status: "queued", at: NOW - 2 * MINUTE }),
    ],
    [`${mako}\u0000flaky-tests`]: [],
    [`${site}\u0000broken-links`]: [
      run(site, "broken-links", { cause: { kind: "schedule", at: NOW - 18 * DAY }, status: "completed", at: NOW - 18 * DAY, thread: { conversation: t.docsCheck.conversation, request: "r9" }, result: { status: "done", summary: "Three links 404'd after the pricing move; fixed.", pullRequest: "https://github.com/Verbiflow/site/pull/88" } }),
    ],
    [`${site}\u0000sentry-triage`]: [
      run(site, "sentry-triage", { occurrence: "sentry-issue-5523", cause: { kind: "event", source: "sentry", event: "issue_created", id: "5523", summary: "New issue in verbiflow-web: TypeError: Cannot read properties of undefined (reading 'plan')", url: "https://verbiflow.sentry.io/issues/5523/" }, status: "completed", at: NOW - 26 * HOUR, endedAt: NOW - 25 * HOUR, thread: { conversation: t.sentry.conversation, request: "r10" }, result: { status: "needs-input", summary: "Caused by 9f1e2d0, which made plan optional. The fix is one line, but the checkout copy should say what happens without a plan: which words?" } }),
    ],
    [`${api}\u0000stripe-webhook`]: [
      run(api, "stripe-webhook", { occurrence: "webhook-batch-7781", cause: { kind: "event", source: "webhook", event: "delivery", id: "7781", summary: "Webhook STRIPE_FORWARD: invoice.payment_failed and 11 more", batch: 12 }, status: "completed", at: NOW - 9 * HOUR, endedAt: NOW - 8.8 * HOUR, thread: { conversation: t.docsCheck.conversation, request: "r11" }, result: { status: "done", summary: "Replayed 9 of 12; 3 are for deleted customers and were left." } }),
    ],
  }
}

function local(fields: Partial<AutomationLocal> & { enabled: boolean }): AutomationLocal {
  return { failures: 0, ...fields }
}

const LOCALS = {
  "nightly-ci-triage": local({ enabled: true, enabledAt: NOW - 30 * DAY }),
  "weekly-deps": local({ enabled: true, failures: 3, paused: { kind: "failures", reason: "Paused after 3 failed runs in a row: the last stopped after 120 minutes, its timeout.", at: NOW - 3 * DAY } }),
  "release-notes": local({ enabled: true, cloudRegistered: true }),
  "schema-doc": local({ enabled: true }),
  "flaky-tests": local({ enabled: false }),
  "check-failed-fix": local({ enabled: true }),
  "broken-links": local({ enabled: true, paused: { kind: "changed", reason: "Paused because .mako/automations.json changed after you turned it on (a pull brought a new prompt). Read it, then turn it on again.", at: NOW - 6 * HOUR } }),
  "sentry-triage": local({ enabled: true, cloudRegistered: true }),
  "slack-questions": local({ enabled: true, cloudRegistered: false, cloudIssue: "Slack isn’t connected to the account, so #support can’t be watched. Connect it in Settings › Integrations." }),
  "stripe-webhook": local({ enabled: true, cloudRegistered: true }),
  "openapi-sync": local({ enabled: false }),
  "token-rotation": local({ enabled: false }),
} satisfies Record<string, AutomationLocal>

function proposalsSeed(): Map<string, AutomationProposal[]> {
  const after = definition({
    ...TRIAGE,
    prompt: {
      objective: "Read last night's failed CI runs on main and on open release branches, find the cause of each, and fix the ones that are ours.",
      doneWhen: ["Every failure has a cause in the report", "Each fix has a passing test", "Flaky tests are named, not retried"],
      boundaries: ["No new dependencies"],
      output: "Each failure, its cause, and the pull request that fixes it",
    },
    triggers: [{ kind: "schedule", cron: "0 6 * * 1-5", timezone: "Europe/London" }, { kind: "github", event: "check_failed", repo: "Verbiflow/mako", runWhen: "The check is on main" }],
    start: { ...TRIAGE.start, model: "claude-sonnet-5", reasoning: "medium" },
    limits: { ...TRIAGE.limits, maxRunsPerDay: 4, tokenBudget: 1_000_000 },
  })
  const by = { conversation: RUN_THREADS.proposer.conversation, title: RUN_THREADS.proposer.title, harness: "claude" }
  const mako = AUTOMATION_PROJECTS.mako
  const created = definition({
    id: "pr-review-digest",
    name: "Morning PR review digest",
    prompt: { objective: "List open pull requests waiting on review for more than a day, with a two-line summary of each and who should look." },
    start: { harness: "claude", access: "chat", place: "here" },
    triggers: [{ kind: "schedule", cron: "30 8 * * 1-5", timezone: "Europe/London" }],
    result: "report",
  })
  const list: AutomationProposal[] = [
      { id: "p-triage-faster", project: mako, automation: "nightly-ci-triage", change: "update", before: json(TRIAGE), after: json(after), why: "The triage averaged 41 minutes on Opus; Sonnet did the last five in 12 with the same fixes. Release branches broke twice this month without anyone seeing.", by, ask: PROPOSAL_ASK, at: NOW - 35 * MINUTE, expiresAt: NOW - 35 * MINUTE + 3 * DAY, status: "pending" },
      { id: "p-pr-digest", project: mako, automation: "pr-review-digest", change: "create", after: json(created), why: "You asked each morning this week which PRs wait on review.", by: { conversation: RUN_THREADS.triageDone.conversation, title: "What's waiting on review?", harness: "claude" }, at: NOW - 3 * HOUR, expiresAt: NOW + 2 * DAY, status: "pending" },
      { id: "p-flaky-on", project: mako, automation: "flaky-tests", change: "enable", by, at: NOW - 2 * DAY, expiresAt: NOW + DAY, status: "declined", decidedAt: NOW - 2 * DAY + HOUR, told: true },
      { id: "p-deps-weekly", project: mako, automation: "weekly-deps", change: "update", before: json(DEFINITIONS[mako]![1]), after: json({ ...DEFINITIONS[mako]![1], limits: { overlap: "skip", timeoutMin: 240 } }), why: "The bumps need longer than two hours with the UI suites.", by, at: NOW - 5 * DAY, expiresAt: NOW - 2 * DAY, status: "expired" },
      { id: "p-schema-stale", project: mako, automation: "schema-doc", change: "update", before: json({ ...DEFINITIONS[mako]![3], result: "report" }), after: json({ ...DEFINITIONS[mako]![3], result: "pull-request" }), why: "Doc fixes should be reviewed.", by, at: NOW - 4 * DAY, expiresAt: NOW - DAY, status: "stale", decidedAt: NOW - 3 * DAY, note: "The automation changed after it was proposed (you edited its trigger), so approving it would undo that." },
      { id: "p-release-approved", project: mako, automation: "release-notes", change: "update", before: json({ ...DEFINITIONS[mako]![2], triggers: [{ kind: "manual" }] }), after: json(DEFINITIONS[mako]![2]), why: "Draft the notes the moment a release is published.", by, at: NOW - 9 * DAY, expiresAt: NOW - 6 * DAY, status: "approved", decidedAt: NOW - 9 * DAY + 20 * MINUTE, told: true },
  ]
  return new Map([[mako, list]])
}

function standingOf(definition: AutomationDefinition, local: AutomationLocal, active: AutomationRun | undefined): AutomationView["standing"] {
  if (!local.enabled) return "off"
  if (local.paused) return "paused"
  if (active?.status === "fired") return "running"
  const fires = definition.triggers.some((trigger) => triggerFiresHere(trigger) || (local.cloudRegistered && !cloudTriggerWaiting(trigger, true)))
  return fires ? "on" : "unsupported"
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  { key: "ci-triage", name: "Nightly CI triage", summary: "Each weekday morning, find why last night's CI failed and fix what's yours.", definition: { ...TRIAGE, id: "", name: "Nightly CI triage" } },
  { key: "deps", name: "Weekly dependency bumps", summary: "Every Monday, bump safe versions, run the suites and open one pull request.", definition: { id: "", name: "Weekly dependency bumps", prompt: { objective: "Bump patch and minor versions of the dependencies, run the suites, and open one pull request with what passes." }, triggers: [{ kind: "schedule", cron: "0 6 * * 1", timezone: "UTC" }], start: { access: "edits", place: "here", workspace: { branch: "deps/{date}" } }, result: "pull-request" } },
  { key: "release-notes", name: "Release notes", summary: "When a release is published, draft its notes from the merged pull requests.", definition: { id: "", name: "Release notes", prompt: { objective: "Draft release notes from the pull requests merged since the last release." }, triggers: [{ kind: "github", event: "release", repo: "owner/repo" }], result: "report" } },
  { key: "docs-drift", name: "Docs that drift", summary: "On each commit to main, check the docs still say what the code does.", definition: { id: "", name: "Docs that drift", prompt: { objective: "Check the docs this commit's files are described in still match, and fix them if not." }, triggers: [{ kind: "commit", branch: "main" }], result: "act" } },
  { key: "sentry", name: "Sentry issue investigation", summary: "When Sentry sees a new issue, find the commit behind it and prepare a fix.", definition: { id: "", name: "Sentry issue investigation", prompt: { objective: "Investigate the new Sentry issue, find the commit that caused it, and prepare a verified fix." }, triggers: [{ kind: "sentry", event: "issue_created" }], result: "pull-request" } },
]

export function mockAutomations(emit: (event: HostEvent) => void) {
  const definitions: Record<string, AutomationDefinition[]> = Object.fromEntries(Object.entries(DEFINITIONS).map(([project, list]) => [project, [...list]]))
  const locals = new Map<string, AutomationLocal>(Object.entries(LOCALS))
  // What the person approved, as the host keeps it: each one that's on, its definition as the file has it; the one paused
  // for a change, an earlier prompt, so its page shows what changed.
  for (const list of Object.values(DEFINITIONS))
    for (const each of list) {
      const held = locals.get(each.id)
      if (!held?.enabled) continue
      const approvedAs = held.paused?.kind === "changed" ? { ...each, prompt: { ...each.prompt, objective: "Check the docs' links once a week and list the broken ones." } } : each
      locals.set(each.id, { ...held, approved: automationFingerprint(approvedAs), approvedDefinition: json(approvedAs) })
    }
  const runs = seedRuns()
  const proposals = proposalsSeed()
  const hooks = new Map<string, { provider: AutomationHook["provider"]; url: string }>()
  const key = (project: string, id: string) => `${project}\u0000${id}`

  const view = (project: string, each: AutomationDefinition): AutomationView => {
    const held = runs[key(project, each.id)] ?? []
    const local = locals.get(each.id) ?? { enabled: false, failures: 0 }
    const active = held.find((entry) => entry.status === "fired" || entry.status === "queued")
    const issues = each.triggers.flatMap((trigger) => (trigger.kind === "unsupported" ? [trigger.why] : []))
    return { project, definition: each, local, standing: standingOf(each, local, active), ...(held[0] && { lastRun: held[0] }), ...(active && { activeRun: active }), fingerprint: automationFingerprint(each), issues }
  }
  const reading = (project: string): AutomationProjectReading => ({
    project,
    automations: (definitions[project] ?? []).map((each) => view(project, each)),
    proposals: [...(proposals.get(project) ?? [])].sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.at - a.at),
    file: project === AUTOMATION_PROJECTS.api ? { exists: true, legacy: true } : { exists: true },
  })
  const changed = (project: string) => {
    const next = reading(project)
    emit({ type: "automations-changed", reading: next })
    return next
  }
  const find = (proposal: string) => [...proposals.values()].flat().find((each) => each.id === proposal)
  const apply = (proposal: AutomationProposal) => {
    const list = definitions[proposal.project] ?? (definitions[proposal.project] = [])
    if (proposal.change === "delete") definitions[proposal.project] = list.filter((each) => each.id !== proposal.automation)
    else if (proposal.change === "enable") locals.set(proposal.automation, { failures: 0, ...locals.get(proposal.automation), enabled: true })
    else if (proposal.after) {
      const next = AutomationDefinitionSchema.parse(proposal.after)
      const at = list.findIndex((each) => each.id === proposal.automation)
      if (at === -1) list.push(next)
      else list[at] = next
      if (!locals.has(next.id)) locals.set(next.id, { enabled: false, failures: 0 })
    }
  }
  const decide = (id: string, approve: boolean): AutomationProposal => {
    const proposal = find(id)
    if (!proposal) throw new Error("No such proposal")
    if (proposal.status !== "pending") return proposal
    if (approve) apply(proposal)
    proposal.status = approve ? "approved" : "declined"
    proposal.decidedAt = Date.now()
    proposal.told = true
    changed(proposal.project)
    return proposal
  }
  const record = (entry: AutomationRun) => {
    const list = runs[key(entry.project, entry.automation)] ?? (runs[key(entry.project, entry.automation)] = [])
    const at = list.findIndex((each) => each.occurrence === entry.occurrence)
    if (at === -1) list.unshift(entry)
    else list[at] = entry
    emit({ type: "automation-run", run: entry })
  }

  return {
    /** The ask that carries the pending update to the Inbox, answered through `answerAgentAsk`. */
    proposalAsk: PROPOSAL_ASK,
    decideByAsk: (ask: string, allow: boolean) => {
      const proposal = [...proposals.values()].flat().find((each) => each.ask === ask)
      if (proposal) decide(proposal.id, allow)
    },
    bridge: {
      automations: async (project?: string): Promise<AutomationsReading> => ({ projects: Object.keys(definitions).filter((each) => !project || each === project).map(reading) }),
      automationRuns: async (project: string, id?: string, limit = 50): Promise<AutomationRun[]> =>
        (id ? (runs[key(project, id)] ?? []) : Object.entries(runs).filter(([each]) => each.startsWith(`${project}\u0000`)).flatMap(([, list]) => list)).slice(0, limit),
      saveAutomation: async (project: string, input: JsonValue, replaces?: string, approve?: string): Promise<AutomationProjectReading> => {
        const next = AutomationDefinitionSchema.parse(input)
        const before = locals.get(replaces ?? next.id)
        const prior = (definitions[project] ?? []).find((each) => each.id === (replaces ?? next.id))
        // As the host does: an edit to one the person approved as it stood approves the edit; any other only with `approve`.
        if (before?.enabled && (approve === automationFingerprint(next) || (prior && before.approved === automationFingerprint(prior))))
          locals.set(replaces ?? next.id, { ...before, approved: automationFingerprint(next), approvedDefinition: json(next), ...(before.paused?.kind === "changed" && { paused: undefined }) })
        const list = definitions[project] ?? (definitions[project] = [])
        const at = list.findIndex((each) => each.id === (replaces ?? next.id))
        if (at === -1) list.push(next)
        else list[at] = next
        if (replaces && replaces !== next.id) {
          locals.set(next.id, { enabled: false, failures: 0 })
          locals.delete(replaces)
        } else if (!locals.has(next.id)) locals.set(next.id, { enabled: false, failures: 0 })
        // A changed definition pauses one that was on, as the host does for an edit outside Mako; the person's own edit doesn't.
        return changed(project)
      },
      deleteAutomation: async (project: string, id: string): Promise<AutomationProjectReading> => {
        definitions[project] = (definitions[project] ?? []).filter((each) => each.id !== id)
        return changed(project)
      },
      setAutomationEnabled: async (project: string, id: string, enabled: boolean, approve?: string): Promise<AutomationProjectReading> => {
        const rest: AutomationLocal = { ...(locals.get(id) ?? { enabled: false, failures: 0 }) }
        const current = (definitions[project] ?? []).find((each) => each.id === id)
        if (enabled && current && rest.approvedDefinition !== undefined && rest.approved !== automationFingerprint(current) && approve !== automationFingerprint(current)) throw new Error(`${current.name} changed since you approved it. Review what changed, then turn it on.`)
        delete rest.paused
        locals.set(id, { ...rest, enabled, failures: enabled ? 0 : rest.failures, ...(enabled && { enabledAt: Date.now() }), ...(enabled && current && { approved: automationFingerprint(current), approvedDefinition: json(current) }) })
        return changed(project)
      },
      runAutomation: async (project: string, id: string, clientKey: string, approve?: string): Promise<AutomationRunNowResult> => {
        const current = (definitions[project] ?? []).find((each) => each.id === id)
        const kept = locals.get(id) ?? { enabled: false, failures: 0 }
        if (current && kept.approved !== automationFingerprint(current)) {
          if (approve !== automationFingerprint(current)) return { refused: `${current.name} changed since you approved it: review it, then run it.` }
          locals.set(id, { ...kept, approved: approve, approvedDefinition: json(current) })
        }
        const held = runs[key(project, id)] ?? []
        const repeat = held.find((each) => each.occurrence === clientKey)
        if (repeat) return { run: repeat }
        if (held.some((each) => each.status === "fired")) return { refused: "A run is still going, and this automation skips while one is." }
        const conversation = RUN_THREADS.byHand.conversation
        const started = run(project, id, { occurrence: clientKey, cause: { kind: "person" }, status: "fired", at: Date.now(), startedAt: Date.now(), thread: { conversation, request: `r-${clientKey}` } })
        record(started)
        changed(project)
        setTimeout(() => {
          record({ ...started, status: "completed", endedAt: Date.now(), result: { status: "done", summary: "Ran by hand from the mock: nothing to fix this time." } })
          changed(project)
        }, 4_000)
        return { run: started }
      },
      decideAutomationProposal: async (proposal: string, approve: boolean): Promise<AutomationProposal> => decide(proposal, approve),
      draftAutomation: async (conversationId: string): Promise<AutomationDraft> => ({
        project: AUTOMATION_PROJECTS.mako,
        definition: {
          id: "compare-triage-models",
          name: "Compare the triage's models",
          prompt: { objective: `Do again what this Thread (${conversationId.slice(0, 8)}) was asked: compare the triage's last five runs on Opus and Sonnet, and say which to keep.` },
          start: { harness: "claude", model: "claude-opus-5-5", access: "edits", place: "here" },
          triggers: [{ kind: "manual" }],
        },
      }),
      automationTemplates: async (): Promise<AutomationTemplate[]> => AUTOMATION_TEMPLATES,
      automationRunOf: async (conversation: string): Promise<AutomationRunOf | null> => {
        const found = Object.values(runs).flat().find((each) => each.thread?.conversation === conversation)
        if (!found) return null
        const name = [...Object.values(definitions)].flat().find((each) => each.id === found.automation)?.name ?? found.automation
        return { project: found.project, id: found.automation, occurrence: found.occurrence, name }
      },
      automationHook: async (name: string, provider: AutomationHook["provider"] = "webhook", rotate = false): Promise<AutomationHook> => {
        const held = hooks.get(name)
        const secret = () => `whsec_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`
        if (held && !rotate) return { name, provider: held.provider, url: held.url }
        const url = held?.url ?? `https://hooks.mako.dev/a/7f3c2e/${provider}/${name.toLowerCase().replaceAll("_", "-")}`
        hooks.set(name, { provider, url })
        return { name, provider, url, secret: secret() }
      },
    },
  }
}

/* ------------------------------------------------------------------ */
/* `?app=automations`: the run Threads and the proposer, live          */
/* ------------------------------------------------------------------ */

const CWD = AUTOMATION_PROJECTS.mako

function snapshot(entry: { conversation: string; title: string; harness: string }, index: number, prompt: string, answer: string, asks?: NonNullable<LiveSnapshot["control"]>["asks"], ago = (index + 1) * HOUR): LiveSnapshot {
  const createdAt = NOW - ago
  const request: LiveRequest = { id: `${entry.conversation.slice(0, 24)}000000000001`.slice(0, 36), createdAt, text: prompt, attachments: [], status: "completed", tuning: { model: "claude-opus-5-5", options: { effort: "high" } }, mode: "full" }
  return {
    session: { id: entry.conversation, harness: entry.harness, nativeId: `auto-native-${index}`, cwd: CWD, title: entry.title, connection: "connected", status: "ready", modes: [{ id: "default", name: "Ask", access: "ask" }], currentMode: "default", configOptions: [] },
    revision: 1,
    createdAt,
    threadPath: `/mock/automation-${index}.jsonl`,
    threadId: `${entry.conversation.slice(0, 30)}aaaaaa`.slice(0, 36),
    sessionId: `${entry.conversation.slice(0, 30)}bbbbbb`.slice(0, 36),
    base: null,
    permissions: [],
    requests: [request],
    blocks: [
      { type: "user", text: prompt, requestId: request.id },
      { type: "text", text: answer },
    ],
    control: { activeBindingId: entry.conversation, bindings: [], merges: [], transfers: [], actions: [], ...(asks && { asks }) },
  }
}

export function automationSnapshots(): LiveSnapshot[] {
  const t = RUN_THREADS
  return [
    snapshot(t.triageRunning, 0, TRIAGE.prompt.objective, "Reading run 11873: `test-inbox-ui` timed out at the rail check…"),
    snapshot(t.triageDone, 1, TRIAGE.prompt.objective, "One failure: test-inbox-ui timed out after #1031 renamed a selector. Fixed in #1042."),
    snapshot(t.triageBlocked, 2, TRIAGE.prompt.objective, "Two failures are the runners' disk; the third needs your call on Grok 4.3."),
    snapshot(t.depsFailed, 3, "Bump patch and minor versions of our npm dependencies.", "npm ci failed: ERESOLVE could not resolve @types/react@19.3."),
    snapshot(t.releaseNotes, 4, "Write release notes for v0.171.0.", "Notes for 0.171.0, in four groups."),
    snapshot(t.docsCheck, 5, "Check docs/schema.md after 4be81c2.", "Added gate_key to automation_runs in the doc."),
    snapshot(t.sentry, 6, "Investigate Sentry issue 5523.", "Caused by 9f1e2d0. Which words should checkout say without a plan?"),
    snapshot(t.byHand, 8, "Run the automation now.", "Nothing to fix this time."),
    snapshot(t.proposer, 7, "The nightly triage takes too long. Can it be faster without missing failures?", "Sonnet matched Opus on the last five runs in a third of the time. I proposed the change; it's waiting for you in Automations.", [
      { id: PROPOSAL_ASK, at: NOW - 35 * MINUTE, want: { kind: "automation-proposal", proposal: "p-triage-faster", change: "update", id: "nightly-ci-triage", name: "Nightly CI triage", cwd: CWD } },
    ], 40 * MINUTE),
  ]
}

export function automationSummaries(): LiveSummary[] {
  return automationSnapshots().map(({ session, revision, createdAt, threadPath, threadId, sessionId, requests, control }) => ({ session, revision, createdAt, threadPath, threadId, sessionId, threadTitle: session.title, promptedAt: personPromptedAt(requests, control?.actions) }))
}

export function automationRefs(): ThreadRef[] {
  return automationSnapshots().map((each, index) => ({
    harness: each.session.harness,
    nativeId: `auto-native-${index}`,
    path: each.threadPath!,
    cwd: CWD,
    title: each.session.title,
    updatedAt: new Date(each.createdAt + 10 * MINUTE).toISOString(),
    startedAt: new Date(each.createdAt).toISOString(),
    threadId: each.threadId!,
    sessionId: each.sessionId!,
    bytes: 4_000,
  }))
}
