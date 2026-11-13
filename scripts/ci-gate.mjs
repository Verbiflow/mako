import { appendFile } from "node:fs/promises"
import { runSuite } from "./lib/run-suite.mjs"

/**
 * The pull request gate's tests on Linux, in shards of about equal time: each shard runs its share however the last
 * went, so one run names every failure, each once, with no second try. A step's seconds are its median over CI's
 * runs of 2026-11-12, which sizes the shards; a step added without one counts as `DEFAULT_SECONDS` until it's
 * measured (`--plan` prints the shards). What a step checks is said where it's listed.
 *
 *   node scripts/ci-gate.mjs <shard> <shards>     what CI runs, shards counted from 1
 *   node scripts/ci-gate.mjs --plan <shards>      each shard's steps and estimated seconds
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
  [326, "npm run test:notifications"],
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
  [165, "npm run test:held-digest"],
  [186, "npm run test:fin-fallback"],
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
  [254, "npm run test:background-agents"],
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
  [142, "npm run test:fin-move"],
  [20, "npm run test:request-holds"],
  [202, "npm run test:wake-queue"],
  [220, "npm run test:orch-crash"],
  [78, "npm run test:orch-recovery"],
  // Each message queued, steered or interrupting as its sender chose, answered, routed, and going again by itself.
  [112, "npm run test:orch-answer"],
  [122, "npm run test:delivery-retry"],
  [109, "npm run test:orch-front-door"],
  [72, "npm run test:person-rules"],
  [163, "npm run test:orch-deliver"],
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
  [8, "npm run -s test:desktop-crashes"],
  [1, "npm run -s test:dev-updates"],
  [207, "npm run -s test:execution-ownership"],
  [6, "npm run -s test:file-previews"],
  [19, "npm run -s test:git"],
  [8, "npm run -s test:git-remote"],
  [206, "npm run -s test:host"],
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
  [61, "npm run -s test:mcp"],
  [16, "npm run -s test:message-queue"],
  [1, "npm run -s test:mobile-behavior"],
  [178, "npm run -s test:moves"],
  [11, "npm run -s test:native-authoring"],
  [9, "npm run -s test:node-host-secrets"],
  [3, "npm run -s test:opencode-agents"],
  [2, "npm run -s test:opencode-api"],
  [4, "npm run -s test:owner-check"],
  [1, "npm run -s test:plugins"],
  [6, "npm run -s test:proposed-plans"],
  [7, "npm run -s test:provider-launch-options"],
  [4, "npm run -s test:queued-steering"],
  [2, "npm run -s test:rail-list"],
  [50, "npm run -s test:recovery-admission"],
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
  [201, "npm run -s test:thread-worktrees"],
  [6, "npm run -s test:transfer-scheduling"],
  [177, "npm run -s test:tree-watcher"],
  [2, "npm run -s test:update-local"],
  [14, "npm run -s test:usage-worker"],
  [3, "npm run -s test:web-delivery"],
  [2, "npm run -s test:window-boot"],
  [1, "npm run -s test:zod-patch"],
]

/** A step not yet measured. */
const DEFAULT_SECONDS = 30
/** Past this a step has hung. */
const STEP_MS = 15 * 60_000
/** So has one that says nothing for this long. */
const QUIET_MS = 5 * 60_000

/** Evidence a failed step leaves, run after it: its own exit stays the result. */
const ON_FAILURE = {
  "npm run test:resume-holds": "MAKO_RESUME_DIAGNOSTICS=1 node --import tsx scripts/diagnose-resume-holds.mjs",
}

/** `steps` in `count` shards, longest first onto the shard with the least so far, each shard in the steps' own order. */
export function shards(steps, count) {
  const load = Array.from({ length: count }, () => ({ seconds: 0, picked: [] }))
  const order = steps.map((step, index) => ({ step, index })).sort((a, b) => (b.step[0] || DEFAULT_SECONDS) - (a.step[0] || DEFAULT_SECONDS) || a.index - b.index)
  for (const { step, index } of order) {
    const lightest = load.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    lightest.seconds += step[0] || DEFAULT_SECONDS
    lightest.picked.push(index)
  }
  return load.map((shard) => ({ seconds: shard.seconds, steps: shard.picked.sort((a, b) => a - b).map((index) => steps[index]) }))
}

const args = process.argv.slice(2)
if (args[0] === "--plan") {
  const count = Number(args[1])
  shards(STEPS, count).forEach((shard, index) => console.log(`shard ${index + 1}: ${shard.seconds} s, ${shard.steps.length} steps\n  ${shard.steps.map((step) => step[1]).join("\n  ")}`))
  process.exit(0)
}
const [shard, count] = args.map(Number)
if (!Number.isInteger(shard) || !Number.isInteger(count) || shard < 1 || shard > count) {
  console.error("Use: node scripts/ci-gate.mjs <shard> <shards>, or --plan <shards>")
  process.exit(2)
}

const results = []
for (const [, command] of shards(STEPS, count)[shard - 1].steps) {
  console.log(`::group::${command}`)
  const began = Date.now()
  const code = await runSuite("bash", ["-c", command], { limitMs: STEP_MS, quietMs: QUIET_MS })
  const evidence = code !== 0 ? ON_FAILURE[command] : undefined
  if (evidence) await runSuite("bash", ["-c", evidence], { limitMs: 3 * 60_000, quietMs: 3 * 60_000 })
  console.log("::endgroup::")
  const seconds = Math.round((Date.now() - began) / 1000)
  console.log(`${code === 0 ? "passed" : "FAILED"}: ${command} in ${seconds} s`)
  results.push({ command, code, seconds })
}

const failed = results.filter(({ code }) => code !== 0)
const lines = [
  `### gate, shard ${shard} of ${count}: ${failed.length ? `${failed.length} failed` : "passed"}`,
  "",
  "| step | exit | seconds |",
  "|---|---|---|",
  ...results.map(({ command, code, seconds }) => `| \`${command}\` | ${code ?? "none"} | ${seconds} |`),
]
console.log(lines.join("\n"))
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
process.exit(failed.length ? 1 : 0)
