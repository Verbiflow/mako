import { appendFileSync, readFileSync } from "node:fs"

/**
 * Which of CI's heavy jobs a pull request's files can affect, as `<job>=true|false` lines for `$GITHUB_OUTPUT`: the
 * changed paths on stdin, one a line. The pull request gate (lint, typecheck and `ci-gate.mjs`'s shards) runs on every
 * pull request whatever it changes; these jobs run on every push to main, and on a pull request only when it touches
 * what they measure. CI's own files and the lockfile run them all, and so does a list that couldn't be read (an empty
 * stdin): a job is skipped only when the change provably can't reach it.
 *
 *   gh api repos/<repo>/pulls/<n>/files --paginate --jq '.[].filename' | node scripts/ci-changes.mjs
 */
export const JOBS = {
  // The window's suites on a Mac: whatever the renderer, the desk, the web app or the host's wire to them draws.
  ui: [/^src\//, /^electron\//, /^packages\/(web-client|client|protocol)\//, /^packages\/host\/src\/(contracts|transport)\//, /^scripts\/test-[\w-]*-ui[\w-]*\./, /^scripts\/ci-suites\.mjs$/, /^scripts\/ci-ui-serve\.mjs$/, /^vite\.test\.config\.ts$/, /^scripts\/lib\/test-/, /^index\.html$/, /^vite\./, /^tailwind/],
  // The gate's steps that pass only on a Mac (`ci-gate.mjs`'s `MAC_STEPS`): the host, its packages and their tests.
  macHost: [/^packages\//, /^electron\//, /^scripts\/(test-|lib\/|diagnose-|check-)/, /^scripts\/ci-gate\.mjs$/],
  // The local updater's checks: the application domain, the update scripts and anything the packaged build reads.
  updates: [/^packages\/host\/src\/application\//, /^scripts\/[\w-]*update[\w-]*\./, /^scripts\/ci-update-checks\.ts$/, /^electron\//, /^electron-builder/, /^build\//],
  // Decode and live-path timings measured against the base: the decoders, readers, live host and the window's reduction.
  performance: [/^packages\/sessions\//, /^packages\/host\/src\/(conversations|harnesses|threads)\//, /^src\/(state|lib)\//, /^scripts\/perf[\w-]*\./, /^scripts\/test-perf[\w-]*\./, /^scripts\/test-performance-budgets\.ts$/],
  // The host's loop under many Fins.
  hostLoad: [/^packages\/host\//, /^packages\/sessions\//, /^scripts\/bench-host-load/, /^scripts\/test-host-load/],
  // Sync latency across devices through the protocol's gateway.
  syncBench: [/^packages\/(protocol|client|sessions)\//, /^packages\/host\/src\/(transport|conversations|threads)\//, /^scripts\/bench-sync/, /^scripts\/test-sync-bench/],
  // A steer landing mid-turn on the real Claude Code and Codex.
  steer: [/^packages\/host\/src\/(harnesses|conversations)\//, /^scripts\/probe-steer/],
  // Codex's own sandbox at the tested build.
  codexSandbox: [/^packages\/host\/src\/harnesses\/codex\//, /^scripts\/check-codex-sandbox/, /^\.github\/actions\/codex-sandbox\//],
  // The Files view's index and its benchmark.
  fileSearch: [/^packages\/host\/src\/workspaces\//, /^scripts\/[\w-]*file-(index|kinds|search)/],
}

/** What runs every job: CI itself, and what every job installs. */
const EVERYTHING = [/^\.github\//, /^package(-lock)?\.json$/, /^scripts\/ci-(changes|gate)\.mjs$/, /^scripts\/lib\/run-suite\.mjs$/]

export function affected(paths) {
  const all = paths.length === 0 || paths.some((path) => EVERYTHING.some((rule) => rule.test(path)))
  return Object.fromEntries(Object.entries(JOBS).map(([job, rules]) => [job, all || paths.some((path) => rules.some((rule) => rule.test(path)))]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  const lines = Object.entries(affected(paths)).map(([job, runs]) => `${job}=${runs}`)
  console.log(`${paths.length} changed paths\n${lines.join("\n")}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
}
