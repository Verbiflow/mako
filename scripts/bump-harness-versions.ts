import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { compareVersions } from "@mako/host/contracts/runtime-version"
import type { HarnessUpdateCommand } from "@mako/host/contracts/harness-updates"
import type { HarnessVersions } from "@mako/host/contracts/harness-versions"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { unpublished } from "./lib/pinned-builds.ts"
import {
  emptyReasons, missingConcepts, moveHow, movePin, moveVocabulary, newTools, pairJudgements, renderJudgements, staleRecords, unexplainedFailures, unplacedRecords, type Judgement,
} from "./lib/bump-records.ts"
import { PairFinding } from "./lib/native-kinds.ts"
import { currentPairVersions } from "./native-decoding.ts"

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
 *   npx tsx scripts/bump-harness-versions.ts --published     fails when a pinned tested build is no longer published
 *                                                            and its feed names nothing to move to
 *   npx tsx scripts/bump-harness-versions.ts codex --write   move one harness, install it through
 *                                                            Mako's install plan, rerun its drift
 *                                                            tools and tests (CI, on a fresh runner)
 *   npx tsx scripts/bump-harness-versions.ts codex --verify  install tested through Mako's plan and
 *                                                            run the sealed flows (the macOS leg)
 *   npx tsx scripts/bump-harness-versions.ts codex --install install tested through Mako's plan only
 *   npx tsx scripts/bump-harness-versions.ts devin --keep    pin tested's archives (`HarnessVersions.kept`) while
 *                                                            the vendor's feed still names it
 *
 * `--write` finishes the bump: it moves every record a version check holds to
 * `tested` once its own recording of the new build backs it (the vocabulary's
 * tools and concepts, the declaration's `how`, the bundled package's pins and
 * lockfile, a kept build's archives), regenerates what is generated from them
 * (`docs/adding-a-harness.md`, `docs/harness-concepts.md`, the descriptors),
 * and runs the checks a pull request runs on them. What the new build does
 * that Mako has no place for (a tool, a native kind, a record kind, a
 * difference no kept pair explains, a patch that no longer applies) it can't
 * place itself: each is said in the summary with where it goes and, where the
 * bump can tell, how.
 *
 * `--summary <file>` writes what each step did, for the pull request's body;
 * `--outcome <file>` writes `{ harness, version, state, judgements }`, where
 * `state` is `finished` (every check passed: the pull request is green),
 * `judgement` (the release does something a person must place) or `broken`
 * (a step failed with nothing to place: a vendor's feed or install, say).
 * `--own-model` records a harness whose pairs run on its own model too, with
 * the key from the environment only (`CURSOR_API_KEY`, a CI secret) and at
 * most `--budget-tokens <n>` tokens (default 1,500,000: re-recording Cursor's 18 pairs took 1.23M, cache reads included).
 * Pushing, committing and opening the pull request are the workflow's
 * (`.github/workflows/harness-versions.yml`), never this script's.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    published: { type: "boolean", default: false },
    write: { type: "boolean", default: false },
    verify: { type: "boolean", default: false },
    install: { type: "boolean", default: false },
    keep: { type: "boolean", default: false },
    summary: { type: "string" },
    outcome: { type: "string" },
    "own-model": { type: "boolean", default: false },
    "budget-tokens": { type: "string", default: "1500000" },
  },
})

const REPO = join(import.meta.dirname, "..")
const FEED_TIMEOUT_MS = 10_000

interface Declared {
  provider: string
  versions: HarnessVersions
  file: string
  /** Where Mako installs it from, which says whether its tested build is still published. */
  install: readonly HarnessUpdateCommand[]
}

interface Reading extends Declared {
  /** What the feed is compared with: the bundled package's version, or tested. */
  current: string
  newest?: string
  /** When npm published `newest`, for a bundled runtime that declares its release date. */
  released?: string
  /** Why the pinned tested build is no longer published (`unpublished`): a bump moves off it even to the same release line. */
  withdrawn?: string
  error?: string
  bump: boolean
}

function declarations(): Declared[] {
  const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
  return host.updateSources.list().flatMap((source) => {
    if (!source.versions) return []
    const file = join(REPO, "packages/host/src/harnesses", source.provider, "versions.ts")
    if (!existsSync(file)) throw new Error(`${source.provider} declares its versions outside ${file}, where the bump can't move them`)
    return [{ provider: source.provider, versions: source.versions, file, install: source.install }]
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

const NpmTimes = z.object({ time: z.record(z.string(), z.string()) })

const KeptManifest = z.object({ version: z.string(), platforms: z.record(z.string(), z.object({ url: z.string(), sha256: z.string() })) })
const KeptBuild = z.object({ harness: z.string() }).loose()
const KeptBuilds = z.object({ builds: z.array(KeptBuild) })
const KEPT_FILE = join(REPO, "vendor/harness-builds/sources.json")

/**
 * Pins the archives of `version` a harness keeps (`HarnessVersions.kept`)
 * by the sha256 its feed's manifest gives them, while that version is the
 * vendor's current one: CI keeps those bytes, so its image never needs the
 * vendor to still serve them (`scripts/lib/harness-builds.mjs`).
 */
async function keepBuilds(provider: string, versions: HarnessVersions, version: string, steps: Step[]): Promise<void> {
  const kept = versions.kept
  if (!kept) return
  if (!("manifest" in versions.feed)) throw new Error(`${provider} keeps builds but its feed is no manifest`)
  const feed = versions.feed.manifest
  const response = await fetch(feed, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${feed} answered ${response.status}`)
  const manifest = KeptManifest.parse(await response.json())
  if (manifest.version !== version) throw new Error(`${feed} names ${manifest.version}, not ${version}: its archives can't be pinned`)
  const named = (text: string) => text.replaceAll("{version}", version)
  const builds = kept.targets.map((target) => {
    const platform = manifest.platforms[target]
    if (!platform) throw new Error(`${feed} has no ${target} build`)
    return {
      harness: provider, version, target, archive: platform.url.slice(platform.url.lastIndexOf("/") + 1), url: platform.url, sha256: platform.sha256,
      unpack: named(kept.unpack),
      links: Object.fromEntries(Object.entries(kept.links).map(([path, to]) => [named(path), named(to)])),
      ...kept.files && { files: Object.fromEntries(Object.entries(kept.files).map(([path, content]) => [named(path), content])) },
    }
  })
  const others = existsSync(KEPT_FILE) ? KeptBuilds.parse(JSON.parse(readFileSync(KEPT_FILE, "utf8"))).builds.filter((build) => build.harness !== provider) : []
  writeFileSync(KEPT_FILE, `${JSON.stringify({ builds: [...others, ...builds] }, null, 2)}\n`)
  steps.push({ name: `${provider} ${version}'s archives pinned`, ok: true, detail: kept.targets.join(", ") })
}

/** When npm published `version` of the feed's package. */
async function published(feed: HarnessVersions["feed"], version: string): Promise<string> {
  if (!("npm" in feed)) throw new Error(`${feed.manifest} dates no release`)
  const url = `https://registry.npmjs.org/${feed.npm.replace("/", "%2F")}`
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FEED_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const at = NpmTimes.parse(await response.json()).time[version]
  if (!at) throw new Error(`${url} dates no ${version}`)
  return at
}

async function readings(only: string[]): Promise<Reading[]> {
  const declared = declarations().filter((entry) => !only.length || only.includes(entry.provider))
  return Promise.all(declared.map(async (entry): Promise<Reading> => {
    const current = entry.versions.bundled?.version ?? entry.versions.tested
    try {
      const newest = await newestRelease(entry.versions.feed)
      // A bundled runtime is Mako's own package; a pinned one is fetched from its vendor, which can withdraw it.
      const withdrawn = entry.versions.bundled ? undefined : await unpublished(entry.install, entry.versions.tested)
      const bump = compareVersions(newest, current) > 0 || (withdrawn !== undefined && newest !== current)
      const released = bump && entry.versions.bundled?.released !== undefined ? await published(entry.versions.feed, newest) : undefined
      return { ...entry, current, newest, bump, ...released && { released }, ...withdrawn && { withdrawn } }
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
    : reading.withdrawn && !bump
      ? `tested ${versions.tested} is no longer published (${reading.withdrawn}), and ${feedName(versions.feed)} names nothing else to move to`
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
  /** Why a step that passed did nothing for a harness (its flows need a program this runner lacks): never a pass. */
  skipped?: string
}

function run(name: string, command: string, args: string[], steps: Step[], env: NodeJS.ProcessEnv = process.env): boolean {
  console.log(`\n$ ${[command, ...args].join(" ")}`)
  const result = spawnSync(command, args, { cwd: REPO, env, stdio: ["ignore", "inherit", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  process.stderr.write(result.stderr ?? "")
  const ok = result.status === 0
  if (!ok && result.error) steps.push({ name, ok, detail: result.error.message })
  if (!ok && result.error) return ok
  const step: Step = { name, ok }
  if (!ok) step.detail = failureOf(result.stderr ?? "") || `exited with ${result.status ?? result.signal}`
  else {
    const skipped = skippedOf(result.stderr ?? "")
    if (skipped) step.skipped = skipped
  }
  steps.push(step)
  return ok
}

/**
 * What a failed step says went wrong, for its row: every line that names a failure (an assertion's or error's
 * message, a `✗` line), each once and in order, never the stack under it; the last line only when none names one.
 */
export function failureOf(stderr: string): string {
  const lines = stderr.split("\n").map((line) => line.trim()).filter(Boolean)
  const named = lines.filter((line) => /^(?:\w*Error\b.*?:|AssertionError|✗ )/.test(line) && !/^\s*at /.test(line))
  const said = [...new Set(named.map((line) => line.replace(/^AssertionError \[ERR_ASSERTION\]: /, "").replace(/^Error: /, "")))]
  return (said.length ? said.slice(0, 4).join(" · ") : (lines.at(-1) ?? "")).slice(0, 600)
}

/** What a step that passed skipped whole (`harness-decode-pairs.ts` says so on stderr: `<harness>: skipped; <why>`). */
export function skippedOf(stderr: string): string | undefined {
  const said = stderr.split("\n").map((line) => line.trim().match(/^[\w-]+: skipped; (.+)$/)?.[1]).filter((why) => why !== undefined)
  return said.length ? [...new Set(said)].join(" · ").slice(0, 600) : undefined
}

/** A step's result as its row or line says it. */
function outcome(step: Step): string {
  if (!step.ok) return `**failed**${step.detail ? `: ${step.detail}` : ""}`
  return step.skipped ? `**skipped**: ${step.skipped}` : "passed"
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
  // Where the bundled build stands among the builds of a program it imports: the day npm published it.
  if (reading.versions.bundled?.released !== undefined && reading.released)
    replace(/(bundled: \{[^}]*released: )"[^"]+"/, `$1"${reading.released}"`, "bundled release date")
  writeFileSync(reading.file, text)
  // What `how` says the records were checked on moves with them; the records themselves move once recorded (`moveVocabulary`).
  moveHow(reading.file, reading.versions.tested, tested, reading.versions.bundled && reading.newest ? { from: reading.versions.bundled.version, to: reading.newest } : undefined)
}

const PackageJson = z.object({ version: z.string(), claudeCodeVersion: z.string().optional(), scripts: z.record(z.string(), z.string()).optional() })
const Dependencies = z.record(z.string(), z.string()).optional()
const WorkspacePackage = z.object({ workspaces: z.array(z.string()).optional(), dependencies: Dependencies, devDependencies: Dependencies, optionalDependencies: Dependencies })

/** The root and every package of its workspace, as folders under it. */
function workspaceFolders(): string[] {
  const root = WorkspacePackage.parse(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")))
  return [".", ...(root.workspaces ?? []).flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern]
    const parent = pattern.slice(0, -2)
    return readdirSync(join(REPO, parent)).map((folder) => `${parent}/${folder}`)
  })]
}

/**
 * Every package of the workspace that names `name` at one exact version. Each moves with the bump: one left on the old
 * version keeps that build nested in its own node_modules, so the code it holds (the host runs every harness) would run
 * the old build while the declaration names the new one. A range (`^0.3.283`) is left to npm, which resolves it to the
 * hoisted build when that satisfies it.
 */
function exactPins(name: string): string[] {
  return workspaceFolders().filter((folder) => {
    const file = join(REPO, folder, "package.json")
    if (!existsSync(file)) return false
    const manifest = WorkspacePackage.parse(JSON.parse(readFileSync(file, "utf8")))
    const spec = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name] ?? manifest.optionalDependencies?.[name]
    return spec !== undefined && /^\d/.test(spec)
  })
}

/** The build of `name` code in `folder` loads: its own nested copy, else the hoisted one. */
function resolvedVersion(folder: string, name: string): string | undefined {
  for (const base of [join(REPO, folder), REPO]) {
    const file = join(base, "node_modules", name, "package.json")
    if (existsSync(file)) return PackageJson.parse(JSON.parse(readFileSync(file, "utf8"))).version
  }
  return undefined
}

const RootScripts = z.object({ scripts: z.record(z.string(), z.string()).optional() })

/**
 * Moves a bundled package in every package that pins it, and checks they all load the one build. Each pin is moved
 * in its file's text and npm installs from there: `npm install <name>@<version>` rewrote each package.json whole.
 * A patch the root's `postinstall` applies to that package (`scripts/patch-cursor-sdk.mjs` for `@cursor/sdk`) then
 * runs alone with `--check`: it either applies to the new build or reports which anchor it lost, and that report goes
 * into the pull request word for word, since only a person can port a patch to changed code.
 */
function moveBundled(name: string, version: string, steps: Step[], judgements: Judgement[]): void {
  const pins = exactPins(name)
  for (const folder of pins) movePin(join(REPO, folder, "package.json"), name, version)
  run(`npm install (${name} ${version})`, "npm", ["install", "--no-audit", "--no-fund"], steps)
  const stem = name.replace(/^@/, "").split("/")[0]!
  const postinstall = RootScripts.parse(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))).scripts?.postinstall ?? ""
  for (const script of [...postinstall.matchAll(/node (scripts\/patch-[\w.-]+\.mjs)/g)].map((match) => match[1]!).filter((file) => file.includes(stem))) {
    console.log(`\n$ node ${script} --check`)
    const result = spawnSync("node", [script, "--check"], { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
    const said = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim()
    process.stdout.write(`${said}\n`)
    const ok = result.status === 0
    steps.push({ name: `${script} applies to ${name} ${version}`, ok, ...!ok && { detail: said.split("\n").filter(Boolean).at(-1)?.slice(0, 600) ?? `exited with ${result.status}` } })
    if (!ok) judgements.push({
      what: `\`${script}\` doesn't apply to ${name} ${version}; its report:\n\n\`\`\`\n${said.slice(0, 6000)}\n\`\`\`\n`,
      where: script,
      proposal: `port the patch named above to ${version}'s code, or delete it if ${version} no longer needs it; until then every job that installs fails at postinstall`,
    })
  }
  const step: Step = { name: `every package loads ${name} ${version}`, ok: pins.every((folder) => resolvedVersion(folder, name) === version) }
  if (!step.ok) step.detail = pins.map((folder) => `${folder === "." ? "the root" : folder} loads ${resolvedVersion(folder, name) ?? "nothing"}`).join(", ")
  steps.push(step)
}

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

/** Records the new build: its protocol types, its tools, its self-report and its session flows. */
function record(provider: string, steps: Step[], pairsReport: string): void {
  const scripts = PackageJson.parse(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"))).scripts ?? {}
  // A harness whose protocol types are generated from its CLI regenerates them.
  if (scripts[`generate:${provider}-inputs`]) run(`generate:${provider}-inputs`, "npm", ["run", `generate:${provider}-inputs`], steps)
  run("harness:native-tools", "npm", ["run", "harness:native-tools", "--", provider], steps)
  run("harness:self-report", "npm", ["run", "harness:self-report", "--", provider], steps)
  // A harness whose pairs run on its own model is recorded only when asked, with the key from the environment alone
  // and its spend bounded; otherwise it's skipped, saying so.
  const ownModel = options["own-model"] ? ["--env-key-only", "--budget-tokens", options["budget-tokens"]] : ["--sealed"]
  run(options["own-model"] ? "session flows (the scripted model, or the harness's own within its budget)" : "session flows against the scripted model", "npm",
    ["run", "harness:decode-pairs", "--", provider, "--write", ...ownModel, "--report", pairsReport], steps)
}

/** What is generated from the declarations and records, written again from them. */
function regenerate(steps: Step[]): void {
  // The checks read @mako/sessions from its build, as the host does: built before the records moved, it names the old versions.
  run("@mako/sessions built with the moved records", "npm", ["run", "-s", "build", "--workspace", "@mako/sessions"], steps)
  // docs/adding-a-harness.md names each harness's tested version, generated from the declarations.
  run("harness:checklist", "npm", ["run", "harness:checklist"], steps)
  // docs/harness-concepts.md names each harness's self-report and recorded tools, generated from them.
  run("harness:concepts", "npm", ["run", "harness:concepts"], steps)
  run("harness:descriptors", "npm", ["run", "harness:descriptors"], steps)
}

/** The checks a pull request runs on what the bump changes. */
function checks(steps: Step[], recordsReport: string): void {
  run("version records agree with tested", "npx", ["tsx", "scripts/test-harness-definitions.ts"], steps)
  run("vocabulary declares every recorded tool", "npx", ["tsx", "scripts/test-native-tools.ts"], steps)
  run("concepts match the installed build", "npx", ["tsx", "scripts/test-harness-concepts.ts"], steps)
  run("record tables place every kind the build saves", "npx", ["tsx", "--tsconfig", "tsconfig.app.json", "scripts/test-harness-records.ts", "--report", recordsReport], steps)
  run("decoders and pairs", "npm", ["run", "test:decoders"], steps)
}

/**
 * What the new build does that Mako has no place for, from every recording and check of this run, and every record
 * still naming the old build with why. Pairs on the harness's own model that weren't recorded say what records them.
 */
async function judge(provider: string, tested: string, pairsReport: string, recordsReport: string, steps: readonly Step[]): Promise<Judgement[]> {
  const findings = existsSync(pairsReport)
    ? readFileSync(pairsReport, "utf8").split("\n").filter(Boolean).map((line) => PairFinding.parse(JSON.parse(line)))
    : []
  const unexplained = new Set(findings.flatMap((finding) => finding.kind === "unexplained" ? [`scripts/fixtures/native-decoding/${finding.harness}/pairs/${finding.scenario}/pair.json`] : []))
  const judgements = [
    ...newTools(provider),
    ...missingConcepts(provider, tested),
    ...unplacedRecords(recordsReport),
    ...pairJudgements(findings),
    // A pair left with an empty reason that no finding above already names: a run before this one's.
    ...emptyReasons(provider).filter((judgement) => !unexplained.has(judgement.where)),
    ...staleRecords(provider, tested),
  ]
  const pairs = await currentPairVersions(provider)
  if (pairs.some((version) => version !== tested)) {
    const skipped = steps.find((step) => step.name.startsWith("session flows"))?.skipped
    judgements.push({
      what: `${provider}'s session flows weren't recorded on ${tested}: its pairs name ${pairs.join(" and ")}${skipped ? ` (${skipped})` : ""}`,
      where: `scripts/fixtures/native-decoding/${provider}/pairs`,
      proposal: skipped?.includes("own model")
        ? "set the repository secret the harness's model takes (CURSOR_API_KEY) and run the workflow again: the bump then records them on its own model within OWN_MODEL_BUDGET_TOKENS"
        : `record them where the recorder can run: \`npm run harness:decode-pairs -- ${provider} --write\``,
    })
  }
  return judgements
}

type State = "finished" | "judgement" | "broken"

function summary(reading: Reading, steps: Step[], judgements: readonly Judgement[], state: State): string {
  const said = {
    finished: "Finished by the bot: every record names the new build, the generated files are written again from them, and every check passed. Nothing in this release needs a person; it can merge.",
    judgement: "The bot finished everything it could; what's left is below, each with where it goes.",
    broken: "A step failed with nothing to place: see the failed rows below.",
  }[state]
  const own = options["own-model"]
    ? "Session flows ran against a scripted model, and a harness whose flows need its own model ran on it with the key from the repository's secret, within the run's budget."
    : "The drift tools and session flows ran against a scripted model, so no account or usage was involved."
  const lines = [
    `Moves ${reading.provider}'s tested version from ${reading.versions.tested} to the vendor's newest release, ${reading.newest} (${feedName(reading.versions.feed)}).`,
    ...reading.withdrawn ? ["", `${reading.versions.tested} is no longer published (${reading.withdrawn}), so every install of it fails until this lands.`] : [],
    "",
    `**${said}**`,
    "",
    ...judgements.length ? [renderJudgements(judgements), ""] : [],
    `Opened by the daily harness bump (\`scripts/bump-harness-versions.ts\`). ${own} A red bump stays out of Mako's Update until it's placed or fixed, and people who update outside Mako already run it, because a newer version always runs.`,
    "",
    "| Step | Result |",
    "| --- | --- |",
    ...steps.map((step) => `| ${step.name} | ${outcome(step).replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
  ]
  return `${lines.join("\n")}\n`
}

/* -------------------------------------------------------------------- run */

const only = positionals
const today = new Date().toISOString().slice(0, 10)

if (options.keep) {
  if (only.length !== 1) throw new Error("--keep takes one harness: name it")
  const [declared] = declarations().filter((entry) => entry.provider === only[0])
  if (!declared) throw new Error(`${only[0]} declares no versions`)
  const steps: Step[] = []
  await keepBuilds(declared.provider, declared.versions, declared.versions.tested, steps)
  for (const step of steps) console.log(`ok     ${step.name} · ${step.detail ?? ""}`)
} else if (options.write || options.verify || options.install) {
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
    const judgements: Judgement[] = []
    let tested = reading.newest
    if (reading.versions.bundled) {
      // A bundled runtime moves with Mako's lockfile; its tested version is the build the package ships.
      moveBundled(reading.versions.bundled.package, reading.newest, steps, judgements)
      const shipped = PackageJson.parse(JSON.parse(readFileSync(join(REPO, "node_modules", reading.versions.bundled.package, "package.json"), "utf8")))
      tested = shipped.claudeCodeVersion ?? shipped.version
    }
    moveDeclaration(reading, tested, today)
    steps.push({ name: `declaration moved to ${tested}`, ok: true })
    await keepBuilds(provider, reading.versions, tested, steps)
    // The package Mako speaks it with is published with each release, and moves with it.
    if (reading.versions.client) moveBundled(reading.versions.client.package, tested, steps, judgements)
    // The declaration this process loaded is the old one: install through a fresh process that reads the new one.
    run(`install ${provider} ${tested}`, "npx", ["tsx", "scripts/bump-harness-versions.ts", provider, "--install"], steps)
    const scratch = await mkdtemp(join(tmpdir(), "mako-bump-report-"))
    try {
      const pairsReport = join(scratch, "pairs.jsonl")
      const recordsReport = join(scratch, "records.json")
      record(provider, steps, pairsReport)
      // The vocabulary's records move only as far as this run's recordings of the new build back them.
      const previous = reading.versions.tested
      const bundled = reading.versions.bundled ? { from: reading.versions.bundled.version, to: reading.newest } : undefined
      const moved = moveVocabulary(provider, previous, tested, today, bundled)
      steps.push({ name: `vocabulary records moved to ${tested}`, ok: moved.tools && moved.concepts, ...!(moved.tools && moved.concepts) && { detail: `${moved.tools ? "" : "tools not moved: no native-tools recording of it; "}${moved.concepts ? "" : "concepts not moved: no self-report of it"}` } })
      regenerate(steps)
      checks(steps, recordsReport)
      judgements.push(...await judge(provider, tested, pairsReport, recordsReport, steps))
      // A failed check nothing above traces to a cause is still said, in its own words.
      judgements.push(...unexplainedFailures(steps, judgements))
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    const state: State = steps.every((step) => step.ok) && !judgements.length ? "finished" : judgements.length ? "judgement" : "broken"
    if (options.summary) writeFileSync(options.summary, summary({ ...reading, newest: reading.newest }, steps, judgements, state))
    // The pins it moved, for `assemble-harness-bumps.ts` to move again on the day's one tree rather than merge package.json.
    const pins = [
      ...reading.versions.bundled ? [{ package: reading.versions.bundled.package, version: reading.newest }] : [],
      ...reading.versions.client ? [{ package: reading.versions.client.package, version: tested }] : [],
    ]
    if (options.outcome) writeFileSync(options.outcome, `${JSON.stringify({ harness: provider, version: reading.newest, tested, state, pins, judgements }, null, 2)}\n`)
    if (judgements.length) console.error(`\n${renderJudgements(judgements)}\n`)
  } else {
    await installTested(provider, steps)
    if (options.verify) run("session flows against the scripted model", "npm", ["run", "harness:decode-pairs", "--", provider, "--sealed"], steps)
    if (options.summary) writeFileSync(options.summary, steps.map((step) => `- ${step.name}: ${outcome(step).replaceAll("**", "")}`).join("\n") + "\n")
  }
  for (const step of steps) {
    const said = step.detail ?? step.skipped
    console.log(`${!step.ok ? "FAILED" : step.skipped ? "SKIP  " : "ok    "} ${step.name}${said ? ` · ${said}` : ""}`)
  }
  process.exitCode = steps.every((step) => step.ok) ? 0 : 1
} else {
  const found = await readings(only)
  if (options.json) {
    console.log(JSON.stringify(found.map(({ provider, current, newest, withdrawn, error, bump, versions }) =>
      ({ provider, tested: versions.tested, oldest: versions.oldest ?? null, bundled: versions.bundled ?? null, current, newest: newest ?? null, withdrawn: withdrawn ?? null, error: error ?? null, bump }))))
  } else if (options.published) {
    // A withdrawn build a bump can't move off: every install of it fails, and nothing will open a pull request.
    const stuck = found.filter((reading) => reading.withdrawn && !reading.bump)
    for (const reading of found) if (reading.withdrawn) console.log(describe(reading))
    if (stuck.length) process.exitCode = 1
    else console.log("Every pinned tested build is still published, or a bump moves off it.")
  } else {
    if (!options["dry-run"]) console.log("Reading only; pass a harness with --write to move it.\n")
    for (const reading of found) console.log(describe(reading))
    const due = found.filter((reading) => reading.bump)
    console.log(due.length
      ? `\n${due.length} would bump: ${due.map((reading) => `${reading.provider} ${reading.current} → ${reading.newest}`).join(", ")}`
      : "\nEvery harness is at its vendor's newest release.")
  }
}
