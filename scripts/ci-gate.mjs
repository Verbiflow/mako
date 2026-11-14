import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import { runSuite } from "./lib/run-suite.mjs"

/**
 * The pull request gate's tests on Linux, in shards of about equal time: each shard runs its share however the last
 * went, so one run names every failure, each once, with no second try. A step's seconds are its median over CI's
 * runs of 2026-11-12, which sizes the shards; a step added without one counts as `DEFAULT_SECONDS` until it's
 * measured (`--plan` prints the shards). What a step checks is said where it's listed.
 *
 *   node scripts/ci-gate.mjs <shard> <shards>     what CI runs, shards counted from 1
 *   node scripts/ci-gate.mjs --plan <shards>      each shard's steps and estimated seconds
 *   --mac, before either, takes `MAC_STEPS` instead
 */

/** [seconds, command] */
export const STEPS = [
  // The protocol's conformance suite, every host call over the socket and the gateway, the host as a cloud machine's runtime and the way back from the cloud.
  [8, "node scripts/generate-host-inputs.mjs --check"],
  [21, "npm run test:protocol"],
  [1, "npx tsx scripts/test-host-liveness.ts"],
  [19, "npx tsx scripts/test-host-lifecycle.ts"],
  [0, "npm run test:loop-profile"],
  [34, "npm run test:machine-runtime"],
  [6, "npx tsx scripts/test-cloud-sign-ins.ts"],
  [1, "npx tsx scripts/test-published-files.ts"],
  [17, "npm run test:harness-conformance"],
  [20, "npm run test:device-join"],
  [56, "npm run test:cloud-conversations"],
  [1, "npx tsx scripts/test-owned-files.ts"],
  [13, "npx tsx scripts/test-cloud-returns.ts"],
  [1, "npm run test:keep-awake"],
  // The renderer's and the live state's own suites, in Node without a window, and the web client's build.
  [4, "npm run build -w @mako/web-client"],
  [8, "npm run test:transcript"],
  [3, "npm run test:transcript-events"],
  [12, "npm run test:stage"],
  [0, "npm run test:fin-words"],
  [2, "npm run test:setup"],
  [1, "npm run test:fin-row-time"],
  [0, "npm run test:steer-notices"],
  [1, "npm run test:fin-decisions"],
  [1, "npm run test:live-controls"],
  [2, "npm run test:prompt-delivery"],
  [4, "npm run test:live-prompt-delivery"],
  [2, "npm run test:control-cadence"],
  [1, "npm run test:live-form"],
  [22, "npm run test:send-race"],
  [12, "npm run test:durable-outbox"],
  [15, "npm run test:tuning"],
  [1, "npm run test:model-connections"],
  [27, "npm run test:accounts"],
  [30, "npm run test:notifications"],
  [42, "npm run test:update-source"],
  [60, "npm run test:attribution"],
  [24, "npm run test:attribution-holds"],
  [26, "npm run test:workspace-snapshots"],
  [2, "npx tsx scripts/test-package-links.ts"],
  [0, "npx tsx scripts/test-file-events-service.ts"],
  [1, "npm run test:simulator-setup"],
  [2, "npm run test:simulators-remote"],
  [23, "npm run test:simulator-host"],
  // Orchestration with every harness a scripted model: starts, switches, held notices, limits, digests, hand-offs.
  [17, "npm run test:start-interleavings"],
  [52, "npm run test:switch-interleavings"],
  [4, "npm run test:followed-stop-crash"],
  [19, "npm run test:held-notice-crash"],
  [64, "npm run test:limit-replay"],
  [55, "MAKO_TEST_HARNESSES=claude,codex npm run test:held-digest"],
  [55, "MAKO_TEST_HARNESSES=cursor,grok npm run test:held-digest"],
  [55, "MAKO_TEST_HARNESSES=opencode,devin npm run test:held-digest"],
  [62, "MAKO_TEST_HARNESSES=claude,codex npm run test:fin-fallback"],
  [62, "MAKO_TEST_HARNESSES=cursor,grok npm run test:fin-fallback"],
  [62, "MAKO_TEST_HARNESSES=opencode,devin npm run test:fin-fallback"],
  [59, "npm run test:handoff"],
  [31, "npm run test:orch-comms"],
  // Every harness's definitions, decoders, recorded pairs and spend readers, and the native-store layer's own suite.
  [2, "npx tsx --tsconfig tsconfig.app.json scripts/test-harness-definitions.ts"],
  [4, "npx tsx scripts/test-harness-concepts.ts"],
  [17, "npm run test:provider-startup"],
  [4, "npx tsx scripts/test-opencode-resume.ts"],
  [17, "npx tsx scripts/test-fork-watches.ts"],
  [1, "npx tsx --tsconfig tsconfig.app.json scripts/test-devin-fork.ts"],
  [2, "npm run test:native-routing"],
  [1, "npm run test:native-calls"],
  [2, "npm run test:primer"],
  [3, "npm run eval:orch-tools -- --dry-run"],
  [87, "npm run test:decoders"],
  [16, "npm run test:usage"],
  [144, "npm test -w @mako/sessions"],
  // Fins held by the tree's budget, woken, resumed, moved, and what each reads as.
  [127, "CASES=statesAndEntries,rosterAndLists,uploadsFollowParents,startsAndWakes,explicitReports,refusals,launchesBeforeTheirEdge,stopHoldsUntilCancelled,linkTellsUnreadableFromGone,followedStopStuck,harnessLadders,stopAllUnqueues,unreadableQueuedStarts,settingsFollowTheBinding,startedFinsOldQueueRow,stoppedApexHolds,listsReadNoJournal,finsMoveInTheNewestSession,aSessionNeedsYou,followsShellRuns,relinkedRuns,messagesReachLinkedRuns,finRules npm run test:background-agents"],
  [127, "CASES=storeKeeps,readOnlyStoreVersion,finLimit,afterOrder,slotsGoAtOnce,followedStopHoldsUntilExit,followedStopUnknownIdentity,followedStopStaleIdentity,queueProjection,edgeWriteMovesTheLine,accessFits,finReadingsLoadNothing,finsAtWorkByBinding,activityTellsNoOne,progressGoesWhereItsRead,anySessionAsks,finModels,limitedHarnesses,apexStops,staleEndsStayOut,waitingFins,ownSessionIsNoChild npm run test:background-agents"],
  [32, "npm run test:build-slots"],
  [0, "npm run test:agents-migrate"],
  [9, "npm run test:thread-split"],
  [74, "npm run test:agents-wake"],
  [3, "npm run test:fins-reach-released-apex"],
  [68, "npm run test:fin-pull-waits"],
  [12, "npm run test:fin-resume"],
  [31, "npm run test:git-helper"],
  [32, "npm run test:fin-reopen"],
  [4, "npm run test:roster-refresh"],
  [33, "npm run test:resume-holds"],
  [36, "npm run test:fin-states"],
  // What comes back: a crash, a recovery or a Fin moved, with its queue kept through SIGKILL.
  [40, "MAKO_TEST_HARNESSES=claude npm run test:fin-move"],
  [40, "MAKO_TEST_HARNESSES=codex npm run test:fin-move"],
  [40, "MAKO_TEST_HARNESSES=cursor npm run test:fin-move"],
  [40, "MAKO_TEST_HARNESSES=grok npm run test:fin-move"],
  [40, "MAKO_TEST_HARNESSES=opencode npm run test:fin-move"],
  [40, "MAKO_TEST_HARNESSES=devin npm run test:fin-move"],
  [20, "npm run test:request-holds"],
  [67, "MAKO_TEST_HARNESSES=claude,codex npm run test:wake-queue"],
  [67, "MAKO_TEST_HARNESSES=cursor,grok npm run test:wake-queue"],
  [67, "MAKO_TEST_HARNESSES=opencode,devin npm run test:wake-queue"],
  // A harness a step, its kill points in two halves: each host after a kill waits out its own timers once.
  [75, "MAKO_TEST_HARNESSES=claude tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=claude tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [75, "MAKO_TEST_HARNESSES=codex tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=codex tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [75, "MAKO_TEST_HARNESSES=cursor tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=cursor tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [75, "MAKO_TEST_HARNESSES=grok tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=grok tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [75, "MAKO_TEST_HARNESSES=opencode tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=opencode tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [75, "MAKO_TEST_HARNESSES=devin tsx scripts/test-orch-crash.ts launched brief admitted queued send report notice"],
  [75, "MAKO_TEST_HARNESSES=devin tsx scripts/test-orch-crash.ts released lone wake woken held freed"],
  [78, "npm run test:orch-recovery"],
  // Each message queued, steered or interrupting as its sender chose, answered, routed, and going again by itself.
  [112, "npm run test:orch-answer"],
  [41, "MAKO_TEST_HARNESSES=claude,codex npm run test:delivery-retry"],
  [41, "MAKO_TEST_HARNESSES=cursor,grok npm run test:delivery-retry"],
  [41, "MAKO_TEST_HARNESSES=opencode,devin npm run test:delivery-retry"],
  [109, "npm run test:orch-front-door"],
  [72, "npm run test:person-rules"],
  [73, "CASES=siblingRefusalNamesRelay,notificationDoesNotReportCompletion,notificationsAcrossApexes,oldQueuedKeepsNewerInstructions,aRowCountsItsTurn npm run test:orch-deliver"],
  [90, "CASES=idleTakesATurn,queueByDefault,steerAcrossHarnesses,refusedSteerQueues,cursorHoldsASteer,interruptGoesFirst,forwardTakesTheChoice npm run test:orch-deliver"],
  [6, "npm run test:steer-landing"],
  [2, "npm run test:thread-stays-live"],
  [14, "npm run test:agents-doors"],
  [3, "npm run bench:person-ask"],
  [32, "npm run test:agents-cli"],
  [7, "npm run test:thread-move-tool"],
  [12, "npm run test:thread-act-tool"],
  [32, "npm run test:orch-update"],
  [94, "npm run test:fins-placed"],
  // The npm suites that need no window, which ran on the macOS shards before (`ci-suites.mjs` keeps the rest).
  [37, "npm run -s test:acp-background-work"],
  [1, "npm run -s test:action-recovery"],
  [2, "npm run -s test:appshot-shortcut"],
  [6, "npm run -s test:attachment-sweep"],
  [1, "npm run -s test:automations"],
  [4, "npm run -s test:background-work"],
  [7, "npm run -s test:checkout-heads"],
  [2, "npm run -s test:child-input"],
  [7, "npm run -s test:ci-downloads"],
  [43, "npm run -s test:client"],
  [32, "npm run -s test:cloud-account"],
  [17, "npm run -s test:codex-archived-resume"],
  [25, "npm run -s test:codex-background-work"],
  [2, "npm run -s test:codex-protocol"],
  [9, "npm run -s test:commit-generation"],
  [53, "npm run -s test:control-cli"],
  [0, "npm run -s test:control-driver-install"],
  [0, "npm run -s test:control-media-sources"],
  [28, "npm run -s test:control-packages"],
  [17, "npm run -s test:control-preview"],
  [71, "npm run -s test:control-recording-continuous"],
  [33, "npm run -s test:cursor-child"],
  [12, "npm run -s test:desktop-answers"],
  [1, "npm run -s test:dev-updates"],
  [6, "npm run -s test:file-previews"],
  [19, "npm run -s test:git"],
  [8, "npm run -s test:git-remote"],
  [1, "npm run -s test:host-load-memory"],
  [7, "npm run -s test:host-shutdown"],
  [28, "npm run -s test:host-signals"],
  [5, "npm run -s test:host-single"],
  [1, "npm run -s test:lazy"],
  [5, "npm run -s test:listed-repositories"],
  [52, "npm run -s test:live-actions"],
  [26, "npm run -s test:live-approvals"],
  [1, "npm run -s test:live-context-children"],
  [1, "npm run -s test:local-signing"],
  [16, "npm run -s test:message-queue"],
  [1, "npm run -s test:mobile-behavior"],
  [178, "npm run -s test:moves"],
  [9, "npm run -s test:node-host-secrets"],
  [3, "npm run -s test:opencode-agents"],
  [2, "npm run -s test:opencode-api"],
  [4, "npm run -s test:owner-check"],
  [1, "npm run -s test:plugins"],
  [6, "npm run -s test:proposed-plans"],
  [7, "npm run -s test:provider-launch-options"],
  [4, "npm run -s test:queued-steering"],
  [2, "npm run -s test:rail-list"],
  [66, "npm run -s test:roster-delta"],
  [10, "npm run -s test:run-suite"],
  [1, "npm run -s test:scripted-model"],
  [6, "npm run -s test:secrets-keychain"],
  [5, "npm run -s test:simulators-remote"],
  [6, "npm run -s test:skills"],
  [4, "npm run -s test:telemetry"],
  [20, "npm run -s test:terminal"],
  [3, "npm run -s test:test-scratch"],
  [42, "npm run -s test:thread-app"],
  [9, "npm run -s test:thread-environment-launch"],
  [6, "npm run -s test:thread-lifecycle"],
  [6, "npm run -s test:transfer-scheduling"],
  [177, "npm run -s test:tree-watcher"],
  [2, "npm run -s test:update-local"],
  [14, "npm run -s test:usage-worker"],
  [3, "npm run -s test:web-delivery"],
  [2, "npm run -s test:window-boot"],
  [1, "npm run -s test:zod-patch"],
  // The host's tests under Node and Electron's Helper (`test-host.ts`), a runtime a step, but the Keychain's on the Mac.
  [86, "MAKO_TEST_HOST_EXCEPT=scripts/test-keychain-safe-storage.ts tsx scripts/test-host.ts --runtime node"],
  [86, "MAKO_TEST_HOST_EXCEPT=scripts/test-keychain-safe-storage.ts tsx scripts/test-host.ts --runtime electron"],
  // Taken apart here, their Mac-only parts (`MAC_PARTS`) on the Mac.
  [207, "npm run -s test:execution-ownership"],
  [201, "npm run -s test:thread-worktrees"],
  [61, "npm run -s test:mcp"],
]

/**
 * The steps that pass only on macOS, each for the reason beside it, run by `--mac` on Mac runners: on every push to
 * main, and on a pull request that touches the host or its tests (`ci-changes.mjs`'s `macHost`), with the parts of
 * Linux steps `MAC_PARTS` names: a suite taken apart runs on Linux but for the parts only a Mac passes.
 */
export const MAC_STEPS = [
  // The host's own secret storage test reads the macOS Keychain; Linux's secret store answers otherwise. The rest of
  // `test-host.ts`'s scripts run in the Linux gate.
  [20, "MAKO_TEST_HOST_SCRIPTS=scripts/test-keychain-safe-storage.ts tsx scripts/test-host.ts"],
  // A native crash leaves a minidump only where Crashpad writes one, on the Mac.
  [8, "npm run -s test:desktop-crashes"],
  // It runs Claude's darwin-arm64 binary.
  [11, "npm run -s test:native-authoring"],
]

/**
 * Parts of the Linux steps that pass only on macOS, which `--mac` runs instead, each for its reason:
 * `test-recovery-probe-scope.ts` reads a resume as unavailable, as it is on a Mac, where Linux reads it resumable;
 * `test-thread-worktrees.ts` holds the npm install to the Mac's lockfile platform packages; `test-mcp.ts` drives the
 * embedded computer-use host, which is macOS-only.
 */
const MAC_PARTS = [
  /scripts\/test-recovery-probe-scope\.ts\b/,
  /scripts\/test-thread-worktrees\.ts\b/,
  /scripts\/test-mcp\.ts\b/,
  // Reads the Mac's document windows ("2 document windows").
  /scripts\/test-computer-tools\.ts\b/,
  // Holds Git's executable to the first on PATH, resolved once, as `@mako/git` resolves it only on a Mac: elsewhere it
  // runs `git` by PATH at each spawn, so its older-Git case can't stand in a Git there (#636's test).
  /scripts\/test-worktree-writes\.ts\b/,
  // Starts the host as the packaged Mac app does, through Electron.app's own binary.
  /scripts\/test-host-exit-hold\.mjs\b/,
]

/** A step not yet measured. */
const DEFAULT_SECONDS = 30
/**
 * Past this a part has hung, and is named, its processes listed and ended: well inside the job's 20 minutes, so a hang
 * is a failure that says which part, never a job GitHub cancels with no log. The longest part runs 104 s.
 * Main's run 43581631623 had gate (20) at 15 minutes a part: one hung, the job timed out at 20, and nothing said which.
 */
const STEP_MS = Number(process.env.CI_GATE_PART_MS ?? 4 * 60_000)
/** So has one that says nothing for this long. */
const QUIET_MS = 3 * 60_000
/** A shard past this starts no new part, so its last part's limit still ends it before the job's 20 minutes. */
const SHARD_MS = 12 * 60_000

/** What a step needs on the runner beyond the job's own setup, by its npm script, installed once in a shard that picks it. */
const NEEDS = {
  "test:mcp": "ffmpeg",
  "test:control-cli": "ffmpeg",
  "test:control-packages": "ffmpeg",
  "test:control-recording-continuous": "ffmpeg",
}
/**
 * Parts of a script `NEEDS` names that don't need it themselves, so a shard that picks only them installs nothing:
 * test:mcp's parts on the Mac read MCP configurations and computer use, and record nothing (ffmpeg took 31 s there).
 */
const NEEDS_NOTHING = [/scripts\/test-mcp\.ts\b/, /scripts\/test-computer-tools\.ts\b/]
const INSTALL = {
  // Recording reads ffmpeg and ffprobe on PATH; the runner's image has neither.
  ffmpeg: process.platform === "darwin" ? "command -v ffmpeg >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install ffmpeg" : "command -v ffmpeg >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq --no-install-recommends ffmpeg)",
}

/**
 * The parts that measure the event loop, which run with nothing beside them in their shard: each holds a loop to
 * bounds it measures in the same run (a slice against the whole done at once), and a second lane on a 2-vCPU runner
 * puts its own work into one side of that comparison. test-attribution-holds once read 130 ms against its 117 ms, where
 * it reads 11 to 30 ms alone (#635).
 */
const ALONE = [
  /scripts\/test-(app-overview-reads|attribution-holds|event-loop|git-helper|host-probes|idle-app-marks|probe-child-edges|resume-holds|trace-history-holds)\.ts\b/,
  /scripts\/test-terminal-backpressure\.mjs\b/,
]

/** Evidence a failed step leaves, by its npm script, run after it: its own exit stays the result. */
const ON_FAILURE = {
  "test:resume-holds": "MAKO_RESUME_DIAGNOSTICS=1 node --import tsx scripts/diagnose-resume-holds.mjs",
}

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts
/** What builds rather than tests: run once a shard, before the first part that needs it. */
const BUILD = /^(npm (run (-s )?build[\w:-]*|run -s build --workspace \S+|--prefix \S+ run -s build)|tsgo )/
/** What the job built before the gate began. */
const BUILT = new Set(["npm run build:control-runtime", "npm run -s build:control-runtime"])

/**
 * A step as the parts it runs: an `npm run test:…` chain (`a && b && c`) taken apart, nested chains too, so one long
 * chain spreads over shards and fails part by part. Each part keeps the builds before it (`builds`), its script
 * (for `NEEDS` and `ON_FAILURE`) and the step's environment prefix; a bundle (`esbuild …`) stays with the run after
 * it. A build is every later part's, not the next one's alone: a part may land in another shard, or on the Mac, than
 * the one after the build (test-host-exit-hold went to the Mac without the `build:electron` before it). A chain's
 * seconds are shared equally among its parts until they're measured.
 */
export function parts([seconds, command]) {
  const workspace = /^npm test -w (@mako\/[\w-]+)$/.exec(command)
  if (workspace) return workspaceParts(seconds, command, workspace[1])
  const match = /^((?:\w+=\S+ )*)npm run (?:-s )?(test:[\w:-]+)$/.exec(command)
  const body = match && scripts[match[2]]
  if (!body || !body.includes(" && ")) return [{ seconds, command, builds: [], script: match?.[2] ?? command }]
  const [env, script] = [match[1], match[2]]
  const units = []
  let builds = [], bundle = ""
  for (const part of body.split(" && ")) {
    if (BUILD.test(part)) builds.push(part)
    else if (part.startsWith("esbuild ")) bundle = `${part} && `
    else {
      const nested = /^npm run (?:-s )?(test:[\w:-]+)$/.exec(part)
      const found = nested ? parts([0, `${env}npm run ${nested[1]}`]) : [{ command: `${scoped(env, part)}${bundle}${part}`, builds: [], script }]
      for (const unit of found) unit.builds = [...builds, ...unit.builds.filter((each) => !builds.includes(each))]
      units.push(...found)
      bundle = ""
    }
  }
  return units.map((unit) => ({ ...unit, seconds: Math.max(1, Math.round((seconds || DEFAULT_SECONDS) / units.length)) }))
}

/** What a test reads when it honours a variable a step sets: `MAKO_TEST_HARNESSES` and `CASES` split one test. */
const READS = { MAKO_TEST_HARNESSES: "TESTED_HARNESSES", CASES: "runCases" }

/**
 * A step's environment as `part` takes it: a splitting variable only for a test that reads it, so a part that runs in
 * full anyway runs once, not in each of the step's splits.
 */
function scoped(env, part) {
  const file = /\bscripts\/[\w./-]+\.(?:ts|mjs|tsx)\b/.exec(part)?.[0]
  const text = file && existsSync(file) ? readFileSync(file, "utf8") : undefined
  return env.split(" ").filter((each) => {
    const name = each.split("=")[0]
    return !(name in READS) || text?.includes(READS[name])
  }).join(" ")
}

/** A workspace's `npm test` chain taken apart the same way, each part run from the workspace's folder. */
function workspaceParts(seconds, command, name) {
  const folder = `packages/${name.slice("@mako/".length)}`
  const body = JSON.parse(readFileSync(new URL(`../${folder}/package.json`, import.meta.url), "utf8")).scripts?.test
  if (!body?.includes(" && ")) return [{ seconds, command, builds: [], script: command }]
  const units = []
  let builds = []
  for (const part of body.split(" && ")) {
    if (BUILD.test(part)) builds.push(`cd ${folder} && ${part}`)
    else {
      units.push({ command: `cd ${folder} && ${part}`, builds: [...builds], script: command })
    }
  }
  return units.map((unit) => ({ ...unit, seconds: Math.max(1, Math.round((seconds || DEFAULT_SECONDS) / units.length)) }))
}

/** Every step's parts, each part once: a part two chains share runs in the first. */
/**
 * Parts run as several, each with an environment its test reads (`CASES`, `MAKO_TEST_HARNESSES`), so one long test
 * spreads over shards: test-watch-backend's four cases took 6, 14, 58 and 29 s, one part of 108 to 138 s.
 */
const SPLITS = {
  "tsx scripts/test-watch-backend.ts": ["CASES=silentCanary", "CASES=degradedFseventsd", "CASES=sharedChildAndCrash,lateCanary"],
}

/** `unit` as the parts `SPLITS` makes of it; a test that doesn't read the variable runs once, as it is. */
function split(unit) {
  const ways = SPLITS[unit.command]
  if (!ways) return [unit]
  return ways.map((env) => ({ ...unit, command: `${scoped(`${env} `, unit.command)}${unit.command}`, seconds: Math.round(unit.seconds / ways.length) }))
}

export function units(steps, mac = false) {
  const seen = new Set()
  const own = (unit) => MAC_PARTS.some((rule) => rule.test(unit.command)) === mac
  const linux = STEPS.flatMap((step) => parts(step)).flatMap(split)
  return (mac ? [...MAC_STEPS.flatMap((step) => parts(step)), ...linux.filter(own)] : linux.filter(own)).filter((unit) => !seen.has(unit.command) && seen.add(unit.command))
    .map((unit) => (MEASURED[unit.command] === undefined ? unit : { ...unit, seconds: MEASURED[unit.command] }))
}

/**
 * Each part's seconds as CI last measured it (`scripts/ci-gate-times.json`), which sizes the shards in place of a
 * chain's median shared among its parts. `--learn` reads a run's logs on stdin and prints the file anew.
 */
const MEASURED = JSON.parse(readFileSync(new URL("./ci-gate-times.json", import.meta.url), "utf8"))

/**
 * `steps` in `count` shards, longest first onto the shard with the least so far, each shard in the steps' own order;
 * `start` is what each shard holds already.
 */
export function shards(steps, count, start = []) {
  // A step is a part here: `[seconds, …]` first.
  const load = Array.from({ length: count }, (_, at) => ({ seconds: start[at] ?? 0, picked: [] }))
  const order = steps.map((step, index) => ({ step, index })).sort((a, b) => (b.step.seconds || DEFAULT_SECONDS) - (a.step.seconds || DEFAULT_SECONDS) || a.index - b.index)
  for (const { step, index } of order) {
    const lightest = load.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    lightest.seconds += step.seconds || DEFAULT_SECONDS
    lightest.picked.push(index)
  }
  return load.map((shard) => ({ seconds: shard.seconds, steps: shard.picked.sort((a, b) => a - b).map((index) => steps[index]) }))
}

const mac = process.argv[2] === "--mac"
const args = process.argv.slice(mac ? 3 : 2)
if (args[0] === "--learn") {
  const learned = { ...MEASURED }
  for (const [, command, seconds] of readFileSync(0, "utf8").matchAll(/(?:passed|FAILED): (.+) in (\d+) s$/gm)) learned[command] = Number(seconds)
  console.log(JSON.stringify(Object.fromEntries(Object.entries(learned).sort(([a], [b]) => a.localeCompare(b))), null, 2))
  process.exit(0)
}
const listed = mac ? MAC_STEPS : STEPS
/**
 * Each shard runs `LANES` of its parts at once: most of them wait on timers and child processes rather than the CPU,
 * so two at a time on a 2-vCPU runner take about half as long. A part's output is printed whole when it ends.
 */
const LANES = Number(process.env.CI_GATE_LANES ?? 2)
const isAlone = ({ command }) => ALONE.some((rule) => rule.test(command))
/**
 * A shard's `ALONE` parts run first, one after another, before either lane starts, and the plan charges their time to
 * every lane of their shard: placed among the lanes, test-resume-holds waited 61 s for its neighbour to finish and then
 * held that lane idle for its own 30 s, and its shard took 3 minutes where the plan said 83 s (run 43576192196).
 * The first lane of each shard lists them, ahead of its own parts.
 */
function lanesOf(count) {
  const all = units(listed, mac)
  const solo = shards(all.filter(isAlone), count)
  const lanes = shards(all.filter((unit) => !isAlone(unit)), count * LANES, solo.flatMap(({ seconds }) => Array(LANES).fill(seconds)))
  return lanes.map((lane, at) => (at % LANES === 0 ? { ...lane, steps: [...solo[at / LANES].steps, ...lane.steps] } : lane))
}
if (args[0] === "--plan") {
  const count = Number(args[1])
  const lanes = lanesOf(count)
  for (let index = 0; index < count; index += 1) {
    const own = lanes.slice(index * LANES, (index + 1) * LANES)
    console.log(`shard ${index + 1}: ${Math.max(...own.map((lane) => lane.seconds))} s, ${own.reduce((sum, lane) => sum + lane.steps.length, 0)} steps`)
    own.forEach((lane, at) => console.log(`  lane ${at + 1}, ${lane.seconds} s\n    ${lane.steps.map((step) => `${step.seconds} ${step.command}`).join("\n    ")}`))
  }
  process.exit(0)
}
const [shard, count] = args.map(Number)
if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
  console.error("Use: node scripts/ci-gate.mjs [--mac] <shard> <shards>, or [--mac] --plan <shards>")
  process.exit(2)
}

/** What a part needs installed first (`NEEDS`), unless `NEEDS_NOTHING` says it needs nothing. */
const needOf = ({ script, command }) => (NEEDS[script] && !NEEDS_NOTHING.some((rule) => rule.test(command)) ? NEEDS[script] : undefined)
// A part that needs an install goes last in its lane, so the lane's other parts run while it installs.
const planned = lanesOf(count).slice((shard - 1) * LANES, shard * LANES).map((lane) => lane.steps)
const first = planned.flat().filter(isAlone)
const lanes = planned.map((steps) => steps.filter((step) => !isAlone(step)).toSorted((a, b) => Number(Boolean(needOf(a))) - Number(Boolean(needOf(b)))))
const picked = [...first, ...lanes.flat()]
/**
 * Each install starts at once, beside the parts, and only a part that needs it waits for it: awaited first, apt's
 * ffmpeg (17 to 45 s) held every test of the 20 shards that picked a recording part, and decided pr-gate's time
 * (run 43564312836: 8 of the 9 slowest shards installed it; shard 31's 145 s held 45 s of it).
 */
const installing = new Map([...new Set(picked.map(needOf).filter(Boolean))].map((need) => [need, (async () => {
  let output = ""
  const began = Date.now()
  const code = await runSuite("bash", ["-c", INSTALL[need]], { limitMs: 5 * 60_000, quietMs: 5 * 60_000, write: (text) => { output += text } })
  console.log(`::group::install ${need}\n${output}::endgroup::\n${code === 0 ? "installed" : "INSTALL FAILED"}: ${need} in ${Math.round((Date.now() - began) / 1000)} s`)
  return code
})()]))

// Parts run their scripts' tools as npm would, from the repository's own bin.
process.env.PATH = `${new URL("../node_modules/.bin", import.meta.url).pathname}:${process.env.PATH}`
/** Each build once a shard, shared by its lanes; a failed one is tried again by the next part that needs it. */
const building = new Map([...BUILT].map((build) => [build, Promise.resolve(0)]))
function build(command) {
  if (!building.has(command)) {
    building.set(command, (async () => {
      let output = ""
      const code = await runSuite("bash", ["-c", command], { limitMs: STEP_MS, quietMs: QUIET_MS, write: (text) => { output += text } })
      console.log(`::group::build: ${command}\n${output}::endgroup::\n${code === 0 ? "built" : "BUILD FAILED"}: ${command}`)
      if (code !== 0) building.delete(command)
      return code
    })())
  }
  return building.get(command)
}

/** Lanes share the shard; a part `ALONE` names waits until no other part runs, and none starts while it does. */
let running = 0
let alone = false
const turns = []
async function enter(solo) {
  while (alone || (solo && running > 0)) await new Promise((next) => turns.push(next))
  running += 1
  alone = solo
}
function leave() {
  running -= 1
  alone = false
  for (const next of turns.splice(0)) next()
}

const results = []
const began = Date.now()
/** What runs now, said as it starts, every minute while it runs, and into the evidence folder, which a cancelled job uploads too. */
const now = new Map()
const evidence = process.env.MAKO_TEST_EVIDENCE
if (evidence) mkdirSync(evidence, { recursive: true })
function progress(line) {
  const stamped = `[gate ${Math.round((Date.now() - began) / 1000)} s] ${line}`
  console.log(stamped)
  if (evidence) appendFileSync(join(evidence, `gate-${mac ? "mac-" : ""}${shard}-progress.log`), `${stamped}\n`)
}
const heartbeat = setInterval(() => {
  if (now.size) progress(`running: ${[...now].map(([command, at]) => `${command} (${Math.round((Date.now() - at) / 1000)} s)`).join("; ")}`)
}, 60_000)
heartbeat.unref()
async function lane(steps) {
  for (const step of steps) {
    const { command, builds, script } = step
    if (Date.now() - began > SHARD_MS) {
      progress(`not started, the shard is past ${SHARD_MS / 60_000} minutes: ${command}`)
      results.push({ command, code: null, seconds: 0 })
      continue
    }
    // A part's seconds are its builds' and its own, not a wait for the shard to itself (`ALONE`), which counted once made
    // test-git-helper read 116 s where it takes 37: `--learn` reads them, and the plan would size shards by the wait.
    let busy = 0
    let at = Date.now()
    let code = 0
    for (const each of builds) if ((code = await build(each)) !== 0) break
    let output = ""
    const write = (text) => { output += text }
    busy += Date.now() - at
    // What it waits for an install isn't its own time either.
    const need = needOf(step)
    const installWait = Date.now()
    if (code === 0 && need && (code = await installing.get(need)) !== 0) write(`${need} didn't install; see "install ${need}" above\n`)
    const installed = Math.round((Date.now() - installWait) / 1000)
    const waiting = Date.now()
    await enter(ALONE.some((rule) => rule.test(command)))
    const waited = Math.round((Date.now() - waiting) / 1000)
    at = Date.now()
    now.set(command, at)
    progress(`started: ${command}`)
    try {
      if (code === 0) code = await runSuite("bash", ["-c", command], { limitMs: STEP_MS, quietMs: QUIET_MS, write })
    } finally {
      now.delete(command)
      leave()
    }
    const diagnose = code !== 0 ? ON_FAILURE[script] : undefined
    if (diagnose) await runSuite("bash", ["-c", diagnose], { limitMs: 3 * 60_000, quietMs: 3 * 60_000, write })
    if (code === null) progress(`HUNG: ${command}; its processes are listed in its output below`)
    const seconds = Math.round((busy + Date.now() - at) / 1000)
    console.log(`::group::${command}\n${output}::endgroup::\n${code === 0 ? "passed" : "FAILED"}: ${command} in ${seconds} s${installed ? `\n(it waited ${installed} s for ${need} to install)` : ""}${waited ? `\n(it waited ${waited} s for its shard to itself)` : ""}`)
    results.push({ command, code, seconds })
  }
}
// The measuring parts first, alone, then the lanes side by side.
await lane(first)
await Promise.all(lanes.map(lane))
clearInterval(heartbeat)

const failed = results.filter(({ code }) => code !== 0)
const lines = [
  `### ${mac ? "mac " : ""}gate, shard ${shard} of ${count}: ${failed.length ? `${failed.length} failed` : "passed"}`,
  "",
  "| step | exit | seconds |",
  "|---|---|---|",
  ...results.map(({ command, code, seconds }) => `| \`${command}\` | ${code ?? "none"} | ${seconds} |`),
]
console.log(lines.join("\n"))
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
process.exit(failed.length ? 1 : 0)
