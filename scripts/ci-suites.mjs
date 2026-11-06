import { spawn } from "node:child_process"
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
 * model, so a pass here would prove less than it reads. `test:control-api-e2e` and `test:cloud-archive-ui` each failed
 * one run in four.
 *
 *   node scripts/ci-suites.mjs <shard> <shards>     what CI runs, shards counted from 1
 */
const SUITES = [
  "test:account-devices-ui", "test:account-threads-ui", "test:acp-background-work", "test:action-recovery",
  "test:animations-ui", "test:approval-answer-ui", "test:appshot-shortcut", "test:appshot-ui",
  "test:attachment-sweep", "test:authoring-ui", "test:automations", "test:background-work", "test:background-work-ui",
  "test:carried-files-ui", "test:checkout-heads", "test:client", "test:cloud-account", "test:cloud-turn-on-ui",
  "test:codex-archived-resume", "test:codex-background-work", "test:codex-protocol", "test:commit-generation",
  "test:control-cli", "test:control-driver-install", "test:control-media-sources", "test:control-packages",
  "test:control-preview", "test:control-recording-continuous", "test:crew-card-ui", "test:cursor-child",
  "test:desktop-answers", "test:desktop-crashes", "test:dev-updates", "test:execution-ownership",
  "test:file-previews", "test:fin-counts-ui", "test:fin-pips-ui", "test:fin-view-keeps-ui",
  "test:fins-fresh-on-return-ui", "test:full-access-never-asks", "test:full-access-questions", "test:git",
  "test:git-remote", "test:grok-modes-live", "test:host", "test:host-shutdown", "test:host-signals",
  "test:host-single", "test:inbox-ui", "test:lazy", "test:listed-repositories", "test:live-actions",
  "test:live-approvals", "test:live-context-children", "test:live-refresh", "test:local-signing", "test:mcp",
  "test:message-queue", "test:mobile-behavior", "test:model-connections-ui", "test:moves", "test:moves-ui",
  "test:native-authoring", "test:native-routing-live", "test:node-host-secrets", "test:opencode-agents",
  "test:opencode-api", "test:opening-send-ui", "test:orch-ui", "test:owner-check", "test:plugins",
  "test:proposed-plans", "test:provider-launch-options", "test:provider-ui", "test:queued-steering", "test:rail-list",
  "test:recovery-admission", "test:scripted-model", "test:secrets-keychain", "test:simulators-remote", "test:skills",
  "test:sync-status-ui", "test:telemetry", "test:terminal", "test:terminal-live-ui", "test:terminal-ui",
  "test:thread-app", "test:thread-environment-launch", "test:thread-lifecycle", "test:thread-worktrees",
  "test:tool-rows-ui", "test:transfer-scheduling", "test:tree-watcher", "test:update-local", "test:usage-worker",
  "test:web-delivery", "test:window-boot",
]
/** Past this a suite has hung: the slowest here takes about 4 minutes on a Mac at load 15. */
const SUITE_MS = 20 * 60_000

const [shard, shards] = process.argv.slice(2).map(Number)
if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 1 || shard > shards) {
  console.error("Use: node scripts/ci-suites.mjs <shard> <shards>")
  process.exit(2)
}

const run = (suite) => new Promise((resolve) => {
  const child = spawn("npm", ["run", "-s", suite], { stdio: ["ignore", "inherit", "inherit"], timeout: SUITE_MS })
  child.once("error", () => resolve(null))
  child.once("close", (code) => resolve(code))
})

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
