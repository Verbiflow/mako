import { spawn } from "node:child_process"
import { appendFile } from "node:fs/promises"

/**
 * The npm test scripts no other job runs, whole or in part, on a Mac, where the tests' Electron runs: every suite in
 * turn however the last went, so one run shows all that fail, each once, with no second try. The job's three
 * shards take one suite in three. A script that needs a person's sign-in, a window or a real harness isn't here:
 * `test:shared-runtime` reads the Devin CLI, `test:opencode-native-forms` runs a real OpenCode, and
 * `test:simulators-ui` draws with Chrome, none of which works on this runner.
 *
 *   node scripts/ci-suites.mjs <shard> <shards>     what CI runs, shards counted from 1
 */
const SUITES = [
  "test:acp-background-work", "test:action-recovery", "test:attachment-sweep", "test:automations",
  "test:background-work", "test:checkout-heads", "test:client", "test:cloud-account", "test:codex-archived-resume",
  "test:codex-background-work", "test:codex-protocol", "test:control-cli", "test:control-driver-install",
  "test:control-media-sources", "test:control-packages", "test:control-preview", "test:control-recording-continuous",
  "test:desktop-answers", "test:desktop-crashes", "test:dev-updates", "test:execution-ownership",
  "test:file-previews", "test:git", "test:git-remote", "test:host", "test:host-shutdown", "test:host-signals",
  "test:host-single", "test:lazy", "test:limit-notice-ui", "test:listed-repositories", "test:mcp", "test:message-queue",
  "test:mobile-behavior", "test:moves", "test:native-authoring", "test:opencode-agents", "test:opencode-api",
  "test:owner-check", "test:plugins", "test:proposed-plans", "test:provider-launch-options", "test:queued-steering",
  "test:rail-list", "test:scripted-model", "test:simulators-remote", "test:skills", "test:telemetry", "test:terminal",
  "test:thread-environment-launch", "test:thread-lifecycle", "test:thread-worktrees", "test:transfer-scheduling",
  "test:tree-watcher", "test:update-local", "test:usage-worker", "test:window-boot",
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
