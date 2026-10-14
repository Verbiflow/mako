import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { compareVersions } from "@mako/host/contracts/runtime-version"
import type { HarnessVersions } from "@mako/host/contracts/harness-versions"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * The daily harness bump. Each harness declares its versions on its updates
 * source (`packages/host/src/harnesses/<harness>/versions.ts`), including the
 * feed its vendor publishes to; this reads every feed and, for a harness
 * whose newest release is newer than its tested version (or, for a runtime
 * Mako bundles, newer than the bundled package), moves the declaration and
 * reruns the drift tools that need no account, so the pull request's diff
 * shows what the release changed and its checks say whether Mako still
 * works on it. Nothing here spends model usage: the session flows run
 * against `scripts/scripted-model.ts`, and a harness whose flows need its
 * own model is skipped by `harness:decode-pairs --sealed`.
 *
 *   npx tsx scripts/bump-harness-versions.ts --dry-run       what would move; changes nothing
 *   npx tsx scripts/bump-harness-versions.ts --json          the same, as JSON (the workflow's matrix)
 *   npx tsx scripts/bump-harness-versions.ts codex --write   move one harness, install it through
 *                                                            Mako's install plan, rerun its drift
 *                                                            tools and tests (CI, on a fresh runner)
 *   npx tsx scripts/bump-harness-versions.ts codex --verify  install tested through Mako's plan and
 *                                                            run the sealed flows (the macOS leg)
 *   npx tsx scripts/bump-harness-versions.ts codex --install install tested through Mako's plan only
 *
 * `--summary <file>` writes what each step did, for the pull request's body.
 * Pushing, committing and opening the pull request are the workflow's
 * (`.github/workflows/harness-versions.yml`), never this script's.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    install: { type: "boolean", default: false },
    summary: { type: "string" },
  },
})

const REPO = join(import.meta.dirname, "..")
const FEED_TIMEOUT_MS = 10_000

interface Declared {
  provider: string
  versions: HarnessVersions
  file: string
}

interface Reading extends Declared {
  /** What the feed is compared with: the bundled package's version, or tested. */
  current: string
  newest?: string
  error?: string
  bump: boolean
}

function declarations(): Declared[] {
  const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
  return host.updateSources.list().flatMap((source) => {
    if (!source.versions) return []
    const file = join(REPO, "packages/host/src/harnesses", source.provider, "versions.ts")
    if (!existsSync(file)) throw new Error(`${source.provider} declares its versions outside ${file}, where the bump can't move them`)
    return [{ provider: source.provider, versions: source.versions, file }]
  })
}

const NpmLatest = z.object({ version: z.string() })
const Manifest = z.object({ version: z.string() })

async function newestRelease(feed: HarnessVersions["feed"]): Promise<string> {
  const url = "npm" in feed
    ? `https://registry.npmjs.org/${feed.npm.replace("/", "%2F")}/latest`
    : feed.manifest
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const body: unknown = await response.json()
  return ("npm" in feed ? NpmLatest : Manifest).parse(body).version
}

async function readings(only: string[]): Promise<Reading[]> {
  const declared = declarations().filter((entry) => !only.length || only.includes(entry.provider))
  return Promise.all(declared.map(async (entry): Promise<Reading> => {
    const current = entry.versions.bundled?.version ?? entry.versions.tested
    try {
      const newest = await newestRelease(entry.versions.feed)
      return { ...entry, current, newest, bump: compareVersions(newest, current) > 0 }
    } catch (error) {
      return { ...entry, current, error: error instanceof Error ? error.message : String(error), bump: false }
    }
  }))
}

function feedName(feed: HarnessVersions["feed"]): string {
  return "npm" in feed ? `npm ${feed.npm}` : feed.manifest
}

function describe(reading: Reading): string {
  const { provider, versions, newest, error, bump } = reading
  const declared = versions.bundled
    ? `tested ${versions.tested} (bundled ${versions.bundled.package} ${versions.bundled.version})`
    : `oldest ${versions.oldest ?? "none"} · tested ${versions.tested}`
  const verdict = error
    ? `couldn't read ${feedName(versions.feed)}: ${error}`
    : bump
      ? `would bump to ${newest} (${feedName(versions.feed)})`
      : `current: ${feedName(versions.feed)} says ${newest}`
  return `${provider.padEnd(9)} ${declared.padEnd(58)} ${verdict}`
}

/* ------------------------------------------------------------------ write */

interface Step {
  name: string
  ok: boolean
  detail?: string
}

function run(name: string, command: string, args: string[], steps: Step[], env: NodeJS.ProcessEnv = process.env): boolean {
  console.log(`\n$ ${[command, ...args].join(" ")}`)
  const result = spawnSync(command, args, { cwd: REPO, env, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  process.stderr.write(result.stderr ?? "")
  const ok = result.status === 0
  const step: Step = { name, ok }
  if (!ok) step.detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" ").slice(-400) || `exited with ${result.status ?? result.signal}`
  steps.push(step)
  return ok
}

/** Moves one declaration: tested, and the bundled package's version for a bundled runtime. */
function moveDeclaration(reading: Reading, tested: string, today: string): void {
  let text = readFileSync(reading.file, "utf8")
  const replace = (pattern: RegExp, value: string, what: string) => {
    if (!pattern.test(text)) throw new Error(`${reading.file} has no ${what} the bump can move`)
    text = text.replace(pattern, value)
  }
  replace(/tested: "[^"]+"/, `tested: "${tested}"`, "tested version")
  replace(/on: "\d{4}-\d{2}-\d{2}"/, `on: "${today}"`, "checked date")
  if (reading.versions.bundled && reading.newest)
    replace(/(bundled: \{ package: "[^"]+", version: )"[^"]+"/, `$1"${reading.newest}"`, "bundled version")
  writeFileSync(reading.file, text)
}

const PackageJson = z.object({ version: z.string(), claudeCodeVersion: z.string().optional(), scripts: z.record(z.string(), z.string()).optional() })

/**
 * Installs the harness's declared tested version through the same plan
 * Settings and a cloud machine use, into this runner's home, and checks the
 * binary reports it. A runtime Mako bundles needs no install.
 */
async function installTested(provider: string, steps: Step[]): Promise<void> {
  const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
  const source = host.updateSources.get(provider)
  if (!source?.versions || source.versions.bundled) return
  const scratch = await mkdtemp(join(tmpdir(), "mako-bump-"))
  try {
    const runtimes = new RuntimeUpdates({ sources: () => [source], processes: new DiscoveryProcesses(), path: join(scratch, "runtime-updates.json"), emit: () => {} })
    const reading = await runtimes.check(provider, { force: true })
    if (reading.binary) {
      const tested = reading.installed === source.versions.tested
      steps.push({ name: `${provider} installed`, ok: tested, detail: `${reading.installed ?? "no version"} at ${reading.binary}${tested ? "" : `, not the tested ${source.versions.tested}: run the bump on a runner without it`}` })
      return
    }
    const after = await runtimes.install(provider)
    const ok = after.result?.outcome === "installed" && after.versions?.standing === "tested"
    steps.push({ name: `install ${provider} through Mako's plan`, ok, detail: ok ? `${after.installed} at ${after.binary}` : after.result?.message ?? `installed ${after.installed ?? "nothing"}` })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

function driftTools(provider: string, steps: Step[]): void {
  const scripts = PackageJson.parse(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))).scripts ?? {}
  // A harness whose protocol types are generated from its CLI regenerates them.
  if (scripts[`generate:${provider}-inputs`]) run(`generate:${provider}-inputs`, "npm", ["run", `generate:${provider}-inputs`], steps)
  run("harness:native-tools", "npm", ["run", "harness:native-tools", "--", provider], steps)
  run("harness:self-report", "npm", ["run", "harness:self-report", "--", provider], steps)
  run("session flows against the scripted model", "npm", ["run", "harness:decode-pairs", "--", provider, "--write", "--sealed"], steps)
}

function checks(steps: Step[]): void {
  run("version records agree with tested", "npx", ["tsx", "scripts/test-harness-definitions.ts"], steps)
  run("decoders and pairs", "npm", ["run", "test:decoders"], steps)
}

function summary(reading: Reading, steps: Step[]): string {
  const lines = [
    `Moves ${reading.provider}'s tested version from ${reading.versions.tested} to the vendor's newest release, ${reading.newest} (${feedName(reading.versions.feed)}).`,
    "",
    "Opened by the daily harness bump (`scripts/bump-harness-versions.ts`). The drift tools and session flows ran against a scripted model, so no account or usage was involved. A green bump can merge; a red one stays out of Mako's Update until what broke is fixed, and people who update outside Mako already run it, because a newer version always runs.",
    "",
    "| Step | Result |",
    "| --- | --- |",
    ...steps.map((step) => `| ${step.name} | ${step.ok ? "passed" : `**failed**${step.detail ? `: ${step.detail.replaceAll("|", "\\|").replaceAll("\n", " ")}` : ""}`} |`),
  ]
  return `${lines.join("\n")}\n`
}

/* -------------------------------------------------------------------- run */

const only = positionals
const today = new Date().toISOString().slice(0, 10)

if (options.write || options.verify || options.install) {
  if (only.length !== 1) throw new Error("--write, --verify and --install take one harness: name it")
  const provider = only[0]!
  const steps: Step[] = []
  if (options.write) {
    const [reading] = await readings(only)
    if (!reading) throw new Error(`${provider} declares no versions`)
    if (!reading.bump || !reading.newest) {
      console.log(describe(reading))
      console.log("Nothing to bump.")
      process.exit(0)
    }
    let tested = reading.newest
    if (reading.versions.bundled) {
      // A bundled runtime moves with Mako's lockfile; its tested version is the build the package ships.
      run(`npm install ${reading.versions.bundled.package}@${reading.newest}`, "npm", ["install", "--save-exact", `${reading.versions.bundled.package}@${reading.newest}`], steps)
      const shipped = PackageJson.parse(JSON.parse(readFileSync(join(REPO, "node_modules", reading.versions.bundled.package, "package.json"), "utf8")))
      tested = shipped.claudeCodeVersion ?? shipped.version
    }
    moveDeclaration(reading, tested, today)
    steps.push({ name: `declaration moved to ${tested}`, ok: true })
    // The declaration this process loaded is the old one: install through a fresh process that reads the new one.
    run(`install ${provider} ${tested}`, "npx", ["tsx", "scripts/bump-harness-versions.ts", provider, "--install"], steps)
    driftTools(provider, steps)
    checks(steps)
    if (options.summary) writeFileSync(options.summary, summary({ ...reading, newest: reading.newest }, steps))
  } else {
    await installTested(provider, steps)
    if (options.verify) run("session flows against the scripted model", "npm", ["run", "harness:decode-pairs", "--", provider, "--sealed"], steps)
    if (options.summary) writeFileSync(options.summary, steps.map((step) => `- ${step.name}: ${step.ok ? "passed" : `failed${step.detail ? `: ${step.detail}` : ""}`}`).join("\n") + "\n")
  }
  for (const step of steps) console.log(`${step.ok ? "ok    " : "FAILED"} ${step.name}${step.detail ? ` · ${step.detail}` : ""}`)
  process.exitCode = steps.every((step) => step.ok) ? 0 : 1
} else {
  const found = await readings(only)
  if (options.json) {
    console.log(JSON.stringify(found.map(({ provider, current, newest, error, bump, versions }) =>
      ({ provider, tested: versions.tested, oldest: versions.oldest ?? null, bundled: versions.bundled ?? null, current, newest: newest ?? null, error: error ?? null, bump }))))
  } else {
    if (!options["dry-run"]) console.log("Reading only; pass a harness with --write to move it.\n")
    for (const reading of found) console.log(describe(reading))
    const due = found.filter((reading) => reading.bump)
    console.log(due.length
      ? `\n${due.length} would bump: ${due.map((reading) => `${reading.provider} ${reading.current} → ${reading.newest}`).join(", ")}`
      : "\nEvery harness is at its vendor's newest release.")
  }
}
