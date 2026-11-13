import { runSuite } from "./lib/run-suite.mjs"
import { appendFile } from "node:fs/promises"

/**
 * The npm test scripts no other job runs, whole or in part, on a Mac, where the tests' Electron runs: every suite in
 * turn however the last went, so one run shows all that fail, each once, with no second try. The job's three
 * shards take one suite in three. A script that needs a person's sign-in, a window or a real harness isn't here:
 * `test:shared-runtime` reads the Devin CLI, `test:opencode-native-forms` runs a real OpenCode, and
 * `test:simulators-ui` draws with Chrome, none of which works on this runner.
 *
 * Left out though they pass: `test:acp-registry`, `test:cursor-fork`, `test:model-connections-live`,
 * `test:native-authoring-live` and `test:native-routing-cursor` skip their real part without a sign-in or a local
 * model, so a pass here would prove less than it reads. `test:full-access-never-asks`, `test:full-access-questions`,
 * `test:grok-modes-live` and `test:native-routing-live` skip theirs here, with no harness CLIs on this runner.
 * `test:control-api-e2e` and `test:cloud-archive-ui` each failed one run in four.
 *
 * This runner's screen is 1024×768 and it asks for reduced motion; a UI test sizes its window and turns motion on
 * itself (`lib/test-window.mjs`), or its window is cut to the screen and its marks stand still. Not here yet, each
 * for a reason of its own: `test:orch-ui` reads the Agents panel's groups from the rows drawn, and the runner's
 * panel leaves its last group undrawn; `test:live-refresh`'s page fails as Vite bundles its dependencies again
 * while it loads; `test:terminal-live-ui` timed out waiting for both terminals' output in one run of six.
 *
 *   node scripts/ci-suites.mjs <shard> <shards>     what CI runs, shards counted from 1
 */
const SUITES = [
  "test:acp-background-work", "test:action-recovery", "test:approval-answer-ui", "test:appshot-shortcut",
  "test:attachment-sweep", "test:authoring-ui", "test:automations", "test:background-work", "test:background-work-ui",
  "test:checkout-heads", "test:child-input", "test:client", "test:cloud-account", "test:codex-archived-resume",
  "test:codex-background-work", "test:codex-protocol", "test:commit-generation", "test:control-cli",
  "test:control-driver-install", "test:control-media-sources", "test:control-packages", "test:control-preview",
  "test:control-recording-continuous", "test:cursor-child", "test:desktop-answers", "test:desktop-crashes",
  "test:dev-updates", "test:execution-ownership", "test:file-previews", "test:fin-pips-ui", "test:git",
  "test:placed-fin-ui",
  "test:git-remote", "test:host", "test:host-shutdown", "test:host-signals", "test:host-single", "test:lazy",
  "test:listed-repositories", "test:live-actions", "test:live-approvals", "test:live-context-children",
  "test:local-signing", "test:mcp", "test:message-queue", "test:mobile-behavior", "test:model-connections-ui",
  "test:moves", "test:native-authoring", "test:node-host-secrets", "test:opencode-agents", "test:opencode-api",
  "test:owner-check", "test:plugins", "test:proposed-plans", "test:provider-launch-options", "test:provider-ui",
  "test:host-load-memory", "test:queued-steering", "test:zod-patch", "test:rail-list", "test:roster-delta", "test:recovery-admission", "test:scripted-model", "test:secrets-keychain", "test:side-rail-ui", "test:lazy-pieces-ui", "test:fin-transitions-ui",
  "test:simulators-remote", "test:skills", "test:telemetry", "test:terminal", "test:terminal-ui",
  "test:run-suite", "test:test-scratch", "test:thread-environment-launch", "test:thread-lifecycle", "test:thread-worktrees", "test:transfer-scheduling",
  "test:tree-watcher", "test:update-local", "test:usage-worker", "test:web-delivery", "test:window-boot",
  "test:follow-ui", "test:phone-scroll-ui",
  "test:account-devices-ui", "test:account-threads-ui", "test:animations-ui", "test:appshot-ui", "test:carried-files-ui",
  "test:cloud-turn-on-ui", "test:crew-card-ui", "test:fin-counts-ui", "test:fin-decision-ui", "test:fin-view-keeps-ui",
  "test:fins-fresh-on-return-ui", "test:inbox-ui", "test:moves-ui", "test:opening-send-ui", "test:sync-status-ui",
  "test:thread-app", "test:tool-rows-ui",
  "test:composer-edges-ui",
  "test:agent-ask-ui",
  "test:ci-downloads",
  "test:internal-review-ui",
]
/** Past this a suite has hung: the slowest here takes about 4 minutes on a Mac at load 15. */
const SUITE_MS = 20 * 60_000
/** So has one that says nothing for this long, which needn't wait out the rest. */
const QUIET_MS = 5 * 60_000

const [shard, shards] = process.argv.slice(2).map(Number)
if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 1 || shard > shards) {
  console.error("Use: node scripts/ci-suites.mjs <shard> <shards>")
  process.exit(2)
}

const run = (suite) => runSuite("npm", ["run", "-s", suite], { limitMs: SUITE_MS, quietMs: QUIET_MS })

const results = []
for (const suite of SUITES.filter((_, index) => index % shards === shard - 1)) {
  console.log(`::group::${suite}`)
  const began = Date.now()
  const code = await run(suite)
  console.log("::endgroup::")
  const seconds = Math.round((Date.now() - began) / 1000)
  console.log(`${code === 0 ? "passed" : "FAILED"}: ${suite} in ${seconds} s`)
  results.push({ suite, code, seconds })
}

const failed = results.filter(({ code }) => code !== 0)
const lines = [
  `### suites, shard ${shard} of ${shards}: ${failed.length ? `${failed.length} failed` : "passed"}`,
  "",
  "| suite | exit | seconds |",
  "|---|---|---|",
  ...results.map(({ suite, code, seconds }) => `| ${suite} | ${code ?? "none"} | ${seconds} |`),
]
console.log(lines.join("\n"))
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
process.exit(failed.length ? 1 : 0)
