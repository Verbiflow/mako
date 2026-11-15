import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Which of CI's heavy jobs a pull request's files can affect, as `<job>=true|false` lines for `$GITHUB_OUTPUT`: the
 * changed paths on stdin, one a line. The pull request gate (lint, typecheck and `ci-gate.mjs`'s shards) runs on every
 * pull request whatever it changes; these jobs run on every push to main, and on a pull request only when it touches
 * what they measure. CI's own files and the lockfile run them all, and so does a list that couldn't be read (an empty
 * stdin): a job is skipped only when the change provably can't reach it.
 *
 *   gh api repos/<repo>/pulls/<n>/files --paginate --jq '.[].filename' | node scripts/ci-changes.mjs
 */
/**
 * The packages the window's code reaches: what `src/` imports and what those import in turn, with the web app and its
 * client. The host it reaches only through its contracts and transport, named in the `ui` rule. `--check-ui-scope`
 * recomputes the list from the imports (in `npm run lint:rules`), so a new import can't fall outside it unnoticed.
 */
export const UI_PACKAGES = ["client", "control", "control-runtime", "lazy", "protocol", "sessions", "web-client"]

export const JOBS = {
  // The window's suites on a Mac: whatever the renderer, the desk, the web app or the host's wire to them draws.
  ui: [/^src\//, /^electron\//, new RegExp(`^packages/(${UI_PACKAGES.join("|")})/`), /^public\//, /^mako-icons\//, /^tsconfig[\w.-]*\.json$/, /^packages\/host\/src\/(contracts|transport)\//, /^scripts\/test-[\w-]*-ui[\w-]*\./, /^scripts\/ci-suites\.mjs$/, /^scripts\/(ui-vite-server|ci-ui-warm)\.mjs$/, /^scripts\/lib\/ui-vite\.mjs$/, /^scripts\/lib\/test-/, /^index\.html$/, /^vite\./, /^tailwind/],
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

/**
 * The packages `src/` reaches, by their sources: every `@mako/*` its files import (each form TypeScript reads, a bare
 * `import "@mako/x"` and a type-only one included), then every one the sources of those import in turn; the host only
 * through its contracts, the one part of it the window reaches. TypeScript loads only here, since the job that reads
 * the paths checks out this file alone.
 */
export async function reachedPackages() {
  const { default: ts } = await import("typescript")
  const sourcesOf = (folder) => {
    if (!existsSync(folder)) return []
    return readdirSync(folder, { recursive: true }).map(String).filter((name) => /\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")).map((name) => join(folder, name))
  }
  const imported = (files) => files.flatMap((file) => ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles.map(({ fileName }) => /^@mako\/([\w-]+)/.exec(fileName)?.[1]).filter(Boolean))
  const folders = new Map(readdirSync("packages").filter((name) => existsSync(join("packages", name, "package.json"))).map((name) => [JSON.parse(readFileSync(join("packages", name, "package.json"), "utf8")).name.slice("@mako/".length), name]))
  const reached = new Set()
  const waiting = imported(sourcesOf("src"))
  while (waiting.length) {
    const name = waiting.pop()
    if (reached.has(name) || !folders.has(name)) continue
    reached.add(name)
    waiting.push(...imported(sourcesOf(join("packages", folders.get(name), "src", ...(name === "host" ? ["contracts"] : [])))))
  }
  reached.delete("host")
  return [...reached].sort()
}

if (process.argv[2] === "--check-ui-scope") {
  const reached = await reachedPackages()
  const missing = reached.filter((name) => !UI_PACKAGES.includes(name))
  if (missing.length) {
    console.error(`src/ reaches ${missing.map((name) => `@mako/${name}`).join(", ")}, which UI_PACKAGES in scripts/ci-changes.mjs leaves out: a change there wouldn't run the UI suites on a pull request. Add ${missing.length === 1 ? "it" : "them"}.`)
    process.exit(1)
  }
  console.log(`UI scope: src/ reaches ${reached.map((name) => `@mako/${name}`).join(", ")}, all in UI_PACKAGES`)
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  const lines = Object.entries(affected(paths)).map(([job, runs]) => `${job}=${runs}`)
  console.log(`${paths.length} changed paths\n${lines.join("\n")}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
}
