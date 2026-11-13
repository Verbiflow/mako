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

/** The packages `src/` reaches: its `@mako/*` imports, then each package's own `@mako/*` dependencies, the host aside. */
export function reachedPackages() {
  const sources = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) sources.push(path)
    }
  }
  walk("src")
  const reached = new Set()
  for (const path of sources) for (const [, name] of readFileSync(path, "utf8").matchAll(/(?:from|import\()\s*["']@mako\/([\w-]+)/g)) reached.add(name)
  const folders = new Map(readdirSync("packages").filter((name) => existsSync(join("packages", name, "package.json"))).map((name) => [JSON.parse(readFileSync(join("packages", name, "package.json"), "utf8")).name, name]))
  for (const name of reached) {
    const folder = folders.get(`@mako/${name}`)
    if (!folder || name === "host") continue
    const manifest = JSON.parse(readFileSync(join("packages", folder, "package.json"), "utf8"))
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) if (dependency.startsWith("@mako/")) reached.add(dependency.slice("@mako/".length))
  }
  reached.delete("host")
  return [...reached].sort()
}

if (process.argv[2] === "--check-ui-scope") {
  const missing = reachedPackages().filter((name) => !UI_PACKAGES.includes(name))
  if (missing.length) {
    console.error(`src/ reaches ${missing.map((name) => `@mako/${name}`).join(", ")}, which UI_PACKAGES in scripts/ci-changes.mjs leaves out: a change there wouldn't run the UI suites on a pull request. Add ${missing.length === 1 ? "it" : "them"}.`)
    process.exit(1)
  }
  console.log(`UI scope: src/ reaches ${reachedPackages().map((name) => `@mako/${name}`).join(", ")}, all in UI_PACKAGES`)
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const paths = readFileSync(0, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
  const lines = Object.entries(affected(paths)).map(([job, runs]) => `${job}=${runs}`)
  console.log(`${paths.length} changed paths\n${lines.join("\n")}`)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
}
