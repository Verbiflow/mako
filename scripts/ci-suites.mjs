import { runSuite } from "./lib/run-suite.mjs"
import { appendFile } from "node:fs/promises"

/**
 * The npm test scripts that draw a window, on a Mac, where the tests' Electron runs: every suite in turn however the
 * last went, so one run shows all that fail, each once, with no second try. The ones that need no window run in the
 * pull request gate on Linux (`ci-gate.mjs`); these run on every push to main and on a pull request that touches what
 * they draw (`ci-changes.mjs`). The job's three
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
  "test:approval-answer-ui",
  "test:authoring-ui",
  "test:background-work-ui",
  "test:fin-pips-ui",
  "test:placed-fin-ui",
  "test:model-connections-ui",
  "test:provider-ui",
  "test:side-rail-ui",
  "test:lazy-pieces-ui",
  "test:fin-transitions-ui",
  "test:terminal-ui",
  "test:follow-ui",
  "test:phone-scroll-ui",
  "test:account-devices-ui",
  "test:account-threads-ui",
  "test:animations-ui",
  "test:appshot-ui",
  "test:carried-files-ui",
  "test:cloud-turn-on-ui",
  "test:crew-card-ui",
  "test:fin-counts-ui",
  "test:fin-decision-ui",
  "test:fin-view-keeps-ui",
  "test:fins-fresh-on-return-ui",
  "test:inbox-ui",
  "test:moves-ui",
  "test:opening-send-ui",
  "test:sync-status-ui",
  "test:tool-rows-ui",
  "test:composer-edges-ui",
  "test:agent-ask-ui",
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
