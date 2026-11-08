import { hostCommand } from "../base/host-command.js"
import { constants } from "node:fs"
import { physicalFiles } from "../base/physical-files.js"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { z } from "zod"
import { createHash } from "node:crypto"
import {
  BuildIdentitySchema,
  CHANGE_TITLES,
  type BuildIdentity,
  type BuildPhase,
  type LocalBuildState,
  type MissingDependencies,
  type RevisionChanges,
  type UncommittedChanges,
  type UnsurePerformance,
  type UpdateBuildFrom,
  type UpdateSource,
} from "../contracts/app-lifecycle.js"
import { describeRow, parseVerdicts } from "../contracts/performance-verdict.js"
import { busyReasons, describeMachine, readMachine, type MachineReading } from "../base/machine-load.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { environmentForExecutable, resolveExecutable } from "../base/executable.js"
import { unregisterBundle as unregisterPreparedBundle } from "./local-update-installer.js"
import { changesSince, readUncommitted, readUpdateSource, type Writers } from "./local-update-source.js"
import { checkScripts, performanceEnvironment, UPDATE_CHECKS, updateEnvironment, updaterInherited, writeChanged } from "./local-update-checks.js"
import { describeFailure, failureMessage, StepError, type FailureContext } from "./local-update-failures.js"
import { githubApi } from "../git/index.js"
import { githubRepository, readCi, type CiReading } from "./local-update-ci.js"
import { checkoutUpstream, seedDependencies } from "./upstream-copy.js"
import { runProcessGroup } from "./process-group.js"
import { DependencyInstallError, installDependencies, missingDependencies, uninstalledPackages } from "./local-update-dependencies.js"
import type { Git } from "@mako/git"

const execute = hostCommand

/** Host-side bundle cleanup uses the stop scope; the standalone installer supplies its own runner. */
export function unregisterBundle(app: string): Promise<void> {
  return unregisterPreparedBundle(app, (command, args) => hostCommand(command, args, { timeout: 30_000 }))
}
const localPackage = z.object({
  makoDistribution: z.literal("local"),
  makoLocalSigningIdentity: z.string().regex(/^[A-Fa-f0-9]{40}$/),
  makoBuild: BuildIdentitySchema,
})
const sourcePackage = z.object({
  name: z.literal("mako"),
  scripts: z.object({
    "package:mac:local": z.string(),
    "test:performance": z.string(),
    build: z.string(),
  }),
})
const excluded = new Set([
  "node_modules",
  "ignore",
  "release",
  "dist",
  "dist-electron",
  "dist-browser-extension",
])

export async function verifyLocalCandidate(app: string, identity: string) {
  const metadata = localPackage.parse(
    JSON.parse(
      await readFile(
        join(app, "Contents/Resources/app.asar/package.json"),
        "utf8"
      )
    )
  )
  if (
    metadata.makoLocalSigningIdentity.toUpperCase() !== identity.toUpperCase()
  )
    throw new Error(
      "The update was signed with a different identity. Nothing was installed."
    )
  await execute(
    "codesign",
    [
      "--verify",
      "--deep",
      "--strict",
      "--test-requirement",
      `=identifier "dev.mako.app" and certificate leaf = H"${identity}"`,
      app,
    ],
    { timeout: 60_000, maxBuffer: 1024 * 1024 }
  )
  return metadata.makoBuild
}

/**
 * A packaged Mako.app measures about 0.8 GB; electron-builder writes it once
 * into the build's output.
 */
export const PACKAGED_APP_BYTES = 1e9
/**
 * Left free after a build. The build's compile output, test profiles and
 * swap need room too, and macOS itself misbehaves with less than a few GB.
 */
export const DISK_MARGIN_BYTES = 5e9

export type DiskReader = (path: string) => Promise<{ bavail: number; bsize: number }>

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`

/**
 * Refuse a build the disk can't hold, before anything is copied or built.
 * `copied` is what the build duplicates first (the private checkout); the
 * packaged app and the margin are added to it. The disk once filled to the
 * last byte from builds nobody removed, so this is checked on every build.
 */
export async function ensureBuildSpace(
  folder: string,
  copied: number,
  read: DiskReader = statfs
): Promise<{ needed: number; free: number }> {
  const disk = await read(folder)
  const free = disk.bavail * disk.bsize
  const needed = copied + PACKAGED_APP_BYTES + DISK_MARGIN_BYTES
  if (free < needed)
    throw new Error(
      `Not enough free disk space to build Mako: it needs about ${gigabytes(needed)} free on the disk holding ${folder} (${copied ? `${gigabytes(copied)} for its copy of the checkout, ` : ""}${gigabytes(PACKAGED_APP_BYTES)} for the packaged app and ${gigabytes(DISK_MARGIN_BYTES)} left over), and ${gigabytes(free)} is free. Nothing was copied or built. Free some space, then build again.`
    )
  return { needed, free }
}

/**
 * What a fresh private checkout of `source` takes: everything the sync
 * copies, `node_modules` included, as if none of it were there yet.
 */
export async function buildCopyBytes(source: string): Promise<number> {
  const files = await physicalFiles()
  let total = 0
  const visit = async (dir: string, top: boolean): Promise<void> => {
    const entries = await files.readdir(dir, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async (entry) => {
      const skipped = top && entry.name !== "node_modules" && (excluded.has(entry.name) || entry.name.startsWith("."))
      if (skipped) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return visit(path, false)
      if (!entry.isFile()) return
      const size = (await files.lstat(path).catch(() => null))?.size ?? 0
      total += size
    }))
  }
  await visit(source, true)
  return total
}

const revisionChanges = z.object({
  from: z.string().nullable(),
  count: z.number().int().nonnegative(),
  titles: z.array(z.string()).max(CHANGE_TITLES),
})
/** What a build brought, kept beside it so the build it becomes can say so once it runs. */
const BUILD_CHANGES = "build-changes.json"
const buildChanges = z.object({ build: z.string(), changes: revisionChanges })

/** A reading younger than this answers a check without fetching again; Check again and Build always fetch. */
const FETCH_EVERY_MS = 60_000

export interface LocalUpdateOptions {
  /**
   * Pass `MAKO_BUILD_SOURCE` to the build's checks. Updaters released before
   * it was added never passed it; `test:settings-build --as-installed-updater`
   * turns it off to rehearse them.
   */
  buildSource?: boolean
  statfs?: DiskReader
  /** How long npm install in the checkout may run; `DEPENDENCY_INSTALL_TIMEOUT_MS` unless a test shortens it. */
  installTimeoutMs?: number
  /** Packages the checked build into `output` and verifies what it made; the real packager and codesign unless a test stands in. */
  candidate?: CandidateMaker
  /** Reads the Mac while an update waits for it to quiet down; `readMachine` unless a test simulates one. */
  machine?: () => Promise<MachineReading>
  /** How often a waiting update reads the Mac; `QUIET_EVERY_MS` unless a test shortens it. */
  quietEveryMs?: number
  /** Who changed each uncommitted file, from the change journal; nobody is named without it. */
  writers?: Writers
  /** What CI says of a commit; GitHub unless a test or a rehearsal stands in. */
  ciPassed?: (commit: string) => Promise<CiReading>
}

export interface CandidateMaker {
  package(checkout: string, output: string, env: NodeJS.ProcessEnv): Promise<void>
  verify(app: string): Promise<BuildIdentity>
}

/**
 * The private build copy. Spotlight leaves a folder named `.noindex` alone:
 * a build rewrites the copy's 50,000 dependency files whenever the lockfile
 * moves, and indexing them kept `mds_stores` at a full core through the
 * performance check that followed.
 */
const CHECKOUT = "checkout.noindex"
/** Where builds before `CHECKOUT` kept the copy; moved once, so the next build stays incremental. */
const LEGACY_CHECKOUT = "checkout"
/** The file a build's performance check appends its verdicts to, in the build's own folder. */
const VERDICTS = "performance-verdict.jsonl"
/** How long one build step may run. */
const BUILD_STEP_MS = 20 * 60_000
/**
 * How long the performance check may run: on a busy Mac each of its two
 * comparisons waits up to 3 minutes for quiet and measures for 5 more.
 */
const PERFORMANCE_CHECK_MS = 40 * 60_000
/** How often an update the Mac was too busy to measure reads it again, and how many quiet readings in a row measure again. */
export const QUIET_EVERY_MS = 60_000
export const QUIET_READINGS = 3

export class LocalUpdates {
  private source: string | null = null
  private state: LocalBuildState = { kind: "idle" }
  private candidate: string | null = null
  private preparedRoot: string | null = null
  private job: Promise<void> | null = null
  private stamp: string | null = null
  private lastReady: LocalBuildState | null = null
  /** How the last build ran its checks, for measuring its performance again. */
  private checks: { npm: string; env: NodeJS.ProcessEnv; folder: string; script: string } | null = null
  /** How long each step of the build under way has taken so far. */
  private steps: Partial<Record<BuildPhase, number>> = {}
  /** What the build under way is making, for saying whose code a failure is. */
  private failureContext: FailureContext = { from: undefined, revision: undefined, upstream: undefined, uncommitted: 0, otherSource: null }
  /** The next reading of the Mac, while an update waits for it to quiet down. */
  private quietTimer: NodeJS.Timeout | null = null
  /** An install or restart is pending; the update stays as it is until it's done or cancelled. */
  private held = false
  /** The source against its upstream, as last read, and the reading under way. */
  private reading: UpdateSource | null = null
  private pendingRead: Promise<UpdateSource> | null = null
  private fetchedAt = 0
  /** What the running build brought, when Settings built and installed it. */
  private installed: RevisionChanges | null = null
  private readonly git: Git
  private readonly root: string
  private readonly identity: string
  private readonly changed: () => void
  private readonly running: BuildIdentity | null
  private readonly options: LocalUpdateOptions
  constructor(git: Git, root: string, identity: string, changed: () => void, running: BuildIdentity | null = null, options: LocalUpdateOptions = {}) {
    this.git = git
    this.root = root
    this.identity = identity
    this.changed = changed
    this.running = running
    this.options = options
  }

  async load(): Promise<void> {
    await this.pruneBuilds()
    try {
      this.source = z
        .string()
        .parse(
          JSON.parse(await readFile(join(this.root, "source.json"), "utf8"))
        )
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        this.state = {
          kind: "error",
          message:
            "The saved source selection could not be read. Choose the checkout again.",
        }
    }
    const kept = await readFile(join(this.root, BUILD_CHANGES), "utf8").then((text) => buildChanges.parse(JSON.parse(text))).catch(() => null)
    if (kept && kept.build === this.running?.id) this.installed = kept.changes
    const receiptPath = join(this.root, "install-result.json")
    const receipt = await readFile(receiptPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    // Other installers (the CLI, a manual copy) never write this receipt. One
    // older than the running build therefore describes an earlier installation.
    const superseded = receipt !== null && this.running !== null &&
      (await stat(receiptPath)).mtimeMs < Date.parse(this.running.builtAt)
    if (receipt && !superseded) {
      const result = z
        .object({ ok: z.boolean(), message: z.string().optional() })
        .parse(JSON.parse(receipt))
      if (!result.ok || result.message)
        this.state = {
          kind: "error",
          message:
            result.message ??
            "The previous update could not be installed. Your previous app was retained.",
        }
    }
  }

  snapshot() {
    return { source: this.source, local: this.state, checkout: this.reading, reading: this.pendingRead !== null, installed: this.installed }
  }

  /**
   * Read the source against its upstream. `fetch` asks the remote first,
   * unless a fetch answered within the last minute and `force` isn't set.
   * Readings asked for while one runs share it; `force` waits it out and
   * reads afresh.
   */
  async check({ fetch, force = false }: { fetch: boolean; force?: boolean }): Promise<UpdateSource | null> {
    const source = this.source
    if (!source) return null
    while (this.pendingRead) {
      if (!force) return this.pendingRead
      await this.pendingRead.catch(() => undefined)
    }
    const fetching = fetch && (force || Date.now() - this.fetchedAt >= FETCH_EVERY_MS)
    const installed = this.running ? { revision: this.running.revision, dirty: this.running.dirty } : null
    const read = readUpdateSource(this.git, source, { fetch: fetching, installed, ...this.options.writers && { writers: this.options.writers } })
      .then((reading) => {
        if (fetching) this.fetchedAt = Date.now()
        if (this.source === source) this.reading = reading
        return reading
      })
      .finally(() => {
        this.pendingRead = null
        this.changed()
      })
    this.pendingRead = read
    this.changed()
    return read
  }

  /**
   * Remove the build directories earlier hosts left under `updates/`.
   *
   * A finished build keeps its `output/` — some 850 MB of packaged app —
   * until this host builds again, so it can be installed. Installing copies
   * it into `/Applications` first (`prepareLocalInstall`), and the prepared
   * state lives only in this process, so once a host has restarted every
   * `build-*` here is dead weight: four of them held 3.4 GB. The current
   * host's own job is never on disk yet when this runs, and a directory
   * that is not one of ours, or is a symlink, stays.
   */
  private async pruneBuilds(): Promise<string[]> {
    const removed: string[] = []
    const names: string[] = await readdir(this.root).catch(() => [])
    const files = await physicalFiles()
    for (const name of names) {
      if (!/^build-[A-Za-z0-9]+$/.test(name)) continue
      const path = join(this.root, name)
      if (path === this.preparedRoot) continue
      const info = await lstat(path).catch(() => null)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue
      try {
        await unregisterBundle(join(path, "output/mac-arm64/Mako.app"))
        await files.rm(path, { recursive: true, force: true })
        removed.push(path)
      } catch {
        // A directory another process still holds is tried again next start.
      }
    }
    return removed
  }
  get building(): boolean {
    return this.job !== null
  }
  get ready(): boolean {
    return this.state.kind === "ready" && this.candidate !== null
  }

  async select(path: string): Promise<void> {
    if (this.job)
      throw new Error("Wait for the current build before changing its source.")
    const source = await realpath(path)
    sourcePackage.parse(
      JSON.parse(await readFile(join(source, "package.json"), "utf8"))
    )
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await writeFile(join(this.root, "source.json"), JSON.stringify(source), {
      mode: 0o600,
    })
    this.source = source
    this.stopWaiting()
    this.candidate = null
    this.stamp = null
    this.lastReady = null
    this.reading = null
    this.fetchedAt = 0
    this.state = { kind: "idle" }
    this.changed()
    void this.check({ fetch: true }).catch(() => undefined)
  }

  /** Build the update from `from`, or from what the reading recommends. */
  start(from?: UpdateBuildFrom): void {
    if (this.job) return
    if (!this.source)
      throw new Error("Choose a trusted Mako source checkout first.")
    const source = this.source
    this.stopWaiting()
    const startedAt = new Date().toISOString()
    this.state = { kind: "building", phase: "copying", startedAt, phaseAt: startedAt, ...from && { from } }
    this.candidate = null
    this.failureContext = { from, revision: undefined, upstream: undefined, uncommitted: 0, otherSource: null }
    this.job = this.build(source, from)
      .catch((error) => {
        const phase = this.state.kind === "building" ? this.state.phase : "verifying"
        const failure = describeFailure(error instanceof Error ? error : new Error(String(error)), this.failureContext, phase)
        hostWarn("updates", "build failed", { step: failure.step, blame: failure.blame, from: this.failureContext.from, revision: this.failureContext.revision?.slice(0, 12), what: failure.what, ms: Date.now() - Date.parse(startedAt) })
        // npm install by hand is the person's to run only in their own checkout, never in Mako's copy.
        const install = error instanceof StepError && error.cause instanceof DependencyInstallError ? error.cause : error instanceof DependencyInstallError ? error : null
        this.state = {
          kind: "error",
          message: failureMessage(failure),
          failure: { ...failure, ...failure.details && { details: failure.details.slice(-2000) } },
          ...install && this.failureContext.from !== "upstream" && { command: install.command },
        }
      })
      .finally(() => {
        this.job = null
        this.changed()
      })
    this.changed()
  }

  async prepared(): Promise<{ app: string; identity: string }> {
    if (!this.ready || !this.candidate)
      throw new Error("Build and verify an update before installing it.")
    const build = await verifyLocalCandidate(this.candidate, this.identity)
    if (this.state.kind !== "ready" || build.id !== this.state.build.id)
      throw new Error(
        "The prepared update changed. Build it again before installing."
      )
    return { app: this.candidate, identity: this.identity }
  }

  /**
   * Measure a built update's performance again, after a Mac too busy to
   * measure it: nothing is rebuilt, and on a pass it's ready as any other.
   * Mako starts this itself once the Mac is quiet; Retry starts it at once.
   */
  measureAgain(): void {
    if (this.job) return
    const waiting = this.state.kind === "ready" && this.state.performance ? this.state : null
    if (!waiting || !this.checks || !this.preparedRoot) throw new Error("No update is waiting to have its performance measured again.")
    this.stopWaiting()
    const { npm, env, folder, script } = this.checks
    const revision = waiting.build.revision ?? undefined
    this.state = { kind: "building", phase: "checking", remeasuring: true, ...revision && { revision }, ...waiting.from && { from: waiting.from } }
    this.job = checkPerformance(npm, folder, script, env, this.preparedRoot, revision)
      .then((performance) => {
        this.state = { kind: "ready", build: waiting.build, changes: waiting.changes, ...waiting.from && { from: waiting.from }, ...performance && { performance }, ...waiting.took && { took: waiting.took } }
        this.lastReady = performance ? null : this.state
        if (performance) this.waitForQuiet()
      })
      .catch((error) => {
        const failure = describeFailure(error instanceof Error ? error : new Error(String(error)), this.failureContext, "checking")
        this.state = { kind: "error", message: failureMessage(failure), failure }
      })
      .finally(() => {
        this.job = null
        this.changed()
      })
    this.changed()
  }

  /** Once the Mac reads quiet `QUIET_READINGS` times running, measure the waiting update again. */
  private waitForQuiet(): void {
    this.stopWaiting()
    const read = this.options.machine ?? (() => readMachine())
    let quiet = 0
    const look = () => {
      const timer = setTimeout(() => void read().then((reading) => {
        if (this.quietTimer !== timer) return
        if (this.job || this.state.kind !== "ready" || !this.state.performance) return this.stopWaiting()
        quiet = this.held || busyReasons(reading).length ? 0 : quiet + 1
        if (quiet < QUIET_READINGS) return look()
        hostLog("updates", "the Mac is quiet; measuring the update's performance again", { machine: describeMachine(reading) })
        this.quietTimer = null
        this.measureAgain()
      }, () => {
        if (this.quietTimer === timer) look()
      }), this.options.quietEveryMs ?? QUIET_EVERY_MS)
      timer.unref()
      this.quietTimer = timer
    }
    look()
  }

  hold(held: boolean): void {
    this.held = held
  }

  private stopWaiting(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer)
    this.quietTimer = null
  }

  /** The packager and codesign this build's checkout carries. */
  private packager(node: string): CandidateMaker {
    return {
      package: (checkout, output, env) => runBuild(node, ["scripts/package-mac.mjs", "--local", "--dir", `--output=${output}`], checkout, env),
      verify: (app) => verifyLocalCandidate(app, this.identity),
    }
  }

  private phase(phase: BuildPhase, dependencies?: MissingDependencies): void {
    const now = new Date().toISOString()
    const building = this.state.kind === "building" ? this.state : null
    if (building?.phaseAt) this.steps[building.phase] = (this.steps[building.phase] ?? 0) + Date.parse(now) - Date.parse(building.phaseAt)
    this.state = { kind: "building", phase, phaseAt: now, ...building?.revision && { revision: building.revision }, ...building?.from && { from: building.from }, ...building?.startedAt && { startedAt: building.startedAt }, ...dependencies && { dependencies } }
    this.changed()
  }

  private async build(source: string, requested: UpdateBuildFrom | undefined): Promise<void> {
    this.steps = {}
    const began = Date.now()
    const node = resolveExecutable("node")
    const npm = resolveExecutable("npm")
    if (!node || !npm)
      throw new StepError("copying", "Node.js and npm are required to build Mako.", { blame: "machine", next: "Install Node.js, then build again." })
    // What's available decides what's built: fetch, then build what the
    // person chose, or what the reading recommends, and never rebuild what
    // is already installed.
    const reading = await this.check({ fetch: true, force: true })
    if (!reading || reading.kind === "unreadable")
      throw new StepError("copying", reading?.reason ?? "The source checkout couldn't be read.", { blame: "checkout", next: "Choose a Git checkout of Mako in Settings › Updates." })
    const { plan, upstream } = reading
    const from = requested ?? plan.recommended
    if (!from || (from === "upstream" ? plan.upstream?.installed : plan.checkout.installed)) {
      this.state = { kind: "idle" }
      return
    }
    if (from === "upstream" && !upstream)
      throw new StepError("copying", `${source} has no remote with a default branch to build from.`, { blame: "checkout", next: "Build the checkout as it is instead." })
    const commit = from === "upstream" ? upstream!.commit : reading.head
    this.failureContext = { from, revision: commit, upstream: upstream?.name, uncommitted: from === "checkout" ? reading.uncommitted.count : 0, otherSource: from === "upstream" ? (plan.checkout.installed ? null : "checkout") : plan.upstream && !plan.upstream.installed ? "upstream" : null }
    this.state = { ...this.state.kind === "building" ? this.state : { kind: "building", phase: "copying" }, from, revision: commit }
    this.changed()
    hostLog("updates", "build started", { from, revision: commit.slice(0, 12), upstream: upstream?.name, behind: reading.behind, uncommitted: reading.uncommitted.count })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await ensureBuildSpace(this.root, await buildCopyBytes(source), this.options.statfs).catch((error: Error) => {
      throw new StepError("copying", error.message, { blame: "machine", next: "Free some disk space, then build again." })
    })
    const inherited = updaterInherited(process.env)
    await moveLegacyCheckout(this.root)
    // Upstream: its commit, clean, in Mako's own clone. Checkout: the
    // working tree as it is, synced into the private copy, its uncommitted
    // files read as the copy is taken so the build carries them by name.
    const prepared = from === "upstream"
      ? await (async () => {
          const folder = await checkoutUpstream(this.git, source, this.root, commit)
          if (await seedDependencies(source, folder)) await checkDependencyLinks(folder)
          return { folder, revision: commit, uncommitted: { count: 0, files: [] }, fingerprint: `upstream ${commit} ${await dependencySignature(folder)}` }
        })()
      : await (async () => {
          const folder = join(this.root, CHECKOUT)
          const [revision, uncommitted, fingerprint] = await Promise.all([
            this.git.text({ cwd: source, args: ["rev-parse", "HEAD"], timeoutMs: 10_000 }),
            readUncommitted(this.git, source, undefined, this.options.writers),
            syncBuildCheckout(source, folder),
          ])
          return { folder, revision, uncommitted, fingerprint }
        })()
    const { folder: checkout, revision, uncommitted } = prepared
    // What the copy's package-lock.json lists beyond its node_modules goes
    // in there, never into the person's checkout.
    const missing = await uninstalledPackages(checkout)
    if (missing.length) {
      this.phase("installing", missingDependencies(missing))
      const env = environmentForExecutable(node, inherited)
      await installDependencies(this.git, from === "upstream" ? checkout : source, missing, {
        run: (args, signal) => runBuild(npm, args, checkout, env, signal),
        timeoutMs: this.options.installTimeoutMs,
      }).catch((error: Error) => {
        const machine = /didn't finish within|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network/i.test(error.message)
        throw new StepError("installing", error.message, {
          blame: machine ? "machine" : "checkout",
          next: machine ? "This is the network or the Mac, not the code. Build again when it's back."
            : from === "upstream" ? `Mako installs into its own copy, never your checkout. Build again; if it fails the same way, ${upstream?.name ?? "the upstream"}'s package-lock.json is the problem.`
            : "Mako installs into its own copy, never your checkout.",
          cause: error,
        })
      })
    }
    const job = await mkdtemp(join(this.root, "build-"))
    const output = join(job, "output")
    try {
      const dirty = uncommitted.count > 0
      const stamp = `${prepared.fingerprint}:${revision}:${dirty ? 1 : 0}:${this.identity}`
      // Identical inputs produce an identical candidate: when the prepared
      // output from a successful build is still on disk there is nothing to
      // redo — retrying an install or a mistaken second build is instant.
      if (
        this.lastReady &&
        this.stamp === stamp &&
        this.candidate &&
        (await lstat(this.candidate).catch(() => null))
      ) {
        this.state = this.lastReady
        this.changed()
        return
      }
      const changed = await this.changedSinceInstalled(source, revision, uncommitted)
      const env = environmentForExecutable(node, updateEnvironment(inherited, {
        identity: this.identity,
        revision,
        uncommitted,
        ...this.options.buildSource !== false && { source },
        ...changed && { changed: await writeChanged(job, changed) },
      }))
      const scripts = await checkScripts(checkout)
      const vouched = from === "upstream" && scripts.machine && (await this.ciPassed(source, upstream!.name, revision))
      const performance = await runUpdateChecks({ npm, checkout, env, folder: job, revision, performance: scripts.performance, vouched, phase: (phase) => this.phase(phase) })
      this.phase("packaging")
      const maker = this.options.candidate ?? this.packager(node)
      await maker.package(checkout, output, env).catch((error: Error) => {
        throw new StepError("packaging", error.message, { cause: error })
      })
      this.phase("verifying")
      const candidate = join(output, "mac-arm64/Mako.app")
      const build = await maker.verify(candidate)
      if (this.preparedRoot) {
        await unregisterBundle(
          join(this.preparedRoot, "output/mac-arm64/Mako.app")
        )
        await (await physicalFiles()).rm(this.preparedRoot, { recursive: true, force: true })
      }
      this.preparedRoot = job
      this.candidate = candidate
      // Counted to the revision the build stamped, whatever moved in the checkout meanwhile.
      const changes = this.running?.revision && build.revision ? await changesSince(this.git, source, this.running.revision, build.revision) : null
      if (changes) await writeFile(join(this.root, BUILD_CHANGES), JSON.stringify({ build: build.id, changes } satisfies z.infer<typeof buildChanges>), { mode: 0o600 })
      if (this.state.kind === "building" && this.state.phaseAt) this.steps.verifying = (this.steps.verifying ?? 0) + Date.now() - Date.parse(this.state.phaseAt)
      const took = { ms: Date.now() - began, steps: { ...this.steps } }
      hostLog("updates", "build ready", { from, revision: revision.slice(0, 12), ms: took.ms, ...Object.fromEntries(Object.entries(took.steps).map(([step, ms]) => [`${step}Ms`, ms])), unsure: performance ? performance.rows.length : undefined })
      this.state = { kind: "ready", build, changes, from, took, ...performance && { performance } }
      this.stamp = stamp
      this.checks = { npm, env, folder: checkout, script: scripts.performance }
      // A build the Mac was too busy to measure isn't one to hand back unmeasured on the next Build.
      this.lastReady = performance ? null : this.state
      if (performance) this.waitForQuiet()
    } finally {
      if (this.preparedRoot !== job) {
        await unregisterBundle(join(output, "mac-arm64/Mako.app"))
        await (await physicalFiles()).rm(job, { recursive: true, force: true })
      }
    }
  }

  /**
   * The files the build differs in from the installed app: the commits
   * between them and, for a checkout build, its uncommitted files. Null
   * when the installed revision isn't known here, so every benchmark runs.
   */
  private async changedSinceInstalled(source: string, revision: string, uncommitted: UncommittedChanges): Promise<string[] | null> {
    const installed = this.running?.revision
    if (!installed || this.running?.dirty || uncommitted.count > uncommitted.files.length) return null
    const known = (await this.git.run({ cwd: source, args: ["cat-file", "-e", `${installed}^{commit}`], codes: [1, 128], read: true })).code === 0
    if (!known) return null
    const diff = await this.git.text({ cwd: source, args: ["diff", "--name-only", "--no-renames", installed, revision, "--"], read: true, timeoutMs: 30_000 })
    return [...new Set([...diff.split("\n").filter(Boolean), ...uncommitted.files.flatMap((file) => file.from ? [file.path, file.from] : [file.path])])]
  }

  /** Whether CI passed `commit` on `upstream`, `origin/main`; it's said in the log either way, as it decides what runs. */
  private async ciPassed(source: string, upstream: string, commit: string): Promise<boolean> {
    const slash = upstream.indexOf("/")
    const url = await this.git.text({ cwd: source, args: ["remote", "get-url", upstream.slice(0, slash)], read: true, timeoutMs: 10_000 }).catch(() => "")
    const repository = githubRepository(url)
    const reading = this.options.ciPassed
      ? await this.options.ciPassed(commit)
      : repository ? await readCi((path) => githubApi(source, path), repository, upstream.slice(slash + 1), commit) : { passed: false as const, why: "its upstream isn't on GitHub" }
    hostLog("updates", reading.passed ? "CI passed this commit; only this Mac's checks run" : "every check runs", { revision: commit.slice(0, 12), ...reading.passed ? { run: reading.run } : { why: reading.why } })
    return reading.passed
  }
}

/** What `runUpdateChecks` runs in, and where it reports which step it's on. */
export interface UpdateCheckRun {
  npm: string
  checkout: string
  env: NodeJS.ProcessEnv
  /** The build's own folder: the performance verdicts go there. */
  folder: string
  revision: string | undefined
  /** The checkout's performance script (`checkScripts`). */
  performance: string
  /** CI passed this very commit (`readCi`): only what this Mac alone can tell runs. */
  vouched?: boolean
  phase?: (phase: BuildPhase) => void
}

/**
 * Every check an update runs before it packages (`UPDATE_CHECKS`), in its
 * order: the compile alone, the checks together, the performance check
 * alone. The updater runs this, and so does CI (`ci-update-checks.ts`), in
 * the same environment, so a check that fails only the updater's way fails
 * at review. Answers the performance caveat when the Mac was too busy.
 */
export async function runUpdateChecks(run: UpdateCheckRun): Promise<UnsurePerformance | undefined> {
  const { npm, checkout, env } = run
  run.phase?.("compiling")
  await runStep("compiling", npm, UPDATE_CHECKS.compile, checkout, env)
  run.phase?.("checking")
  if (run.vouched) {
    await runBuild(npm, ["run", UPDATE_CHECKS.machine], checkout, env).catch((error: Error) => {
      throw new StepError("checking", error.message, { blame: "machine", next: "CI passed this commit on its own Mac, so look at what's different on this one first: its macOS, its Node or how busy it is.", script: UPDATE_CHECKS.machine, details: error.message, cause: error })
    })
    return undefined
  }
  const results = await Promise.allSettled(UPDATE_CHECKS.checks.map((script) => runStep("checking", npm, script, checkout, env)))
  const failed = results.find((result) => result.status === "rejected")
  if (failed) throw failed.reason
  // Alone, after the rest: a timing that shares the Mac with the update's own checks measures them too.
  return checkPerformance(npm, checkout, run.performance, env, run.folder, run.revision)
}

/**
 * The performance script (`UPDATE_CHECKS.performance`), alone, its
 * verdicts read from the file it's handed (`PERFORMANCE_VERDICT_VARIABLE`):
 * a slower row fails the build by name, and rows the Mac was too busy to
 * settle come back as the update's caveat. A checkout from before verdicts
 * writes none; its exit code says it all.
 */
export async function checkPerformance(npm: string, checkout: string, script: string, env: NodeJS.ProcessEnv, folder: string, revision: string | undefined): Promise<UnsurePerformance | undefined> {
  const file = join(folder, VERDICTS)
  await (await physicalFiles()).rm(file, { force: true })
  const started = Date.now()
  let failure: Error | undefined
  try {
    await runBuild(npm, ["run", script], checkout, { ...env, ...performanceEnvironment(file) }, undefined, PERFORMANCE_CHECK_MS)
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }
  const verdicts = parseVerdicts(await readFile(file, "utf8").catch(() => ""))
  const rows = verdicts.flatMap((verdict) => verdict.rows)
  const slower = rows.filter((row) => row.outcome === "slower").map(describeRow)
  const unsure = rows.filter((row) => row.outcome === "unsure").map(describeRow)
  const busy = [...new Set(verdicts.flatMap((verdict) => verdict.busy))]
  const machine = verdicts.find((verdict) => verdict.busy.length)?.machine ?? verdicts.at(-1)?.machine ?? ""
  hostLog("updates", "performance check", {
    revision: revision?.slice(0, 12),
    outcome: failure ? "failed" : unsure.length ? "unsure" : "passed",
    measured: rows.length,
    slower: slower.join("; ") || undefined,
    unsure: unsure.join("; ") || undefined,
    machine: machine || undefined,
    ms: Date.now() - started,
  })
  if (failure) {
    if (slower.length)
      throw new StepError("checking", `The performance check found ${slower.length === 1 ? "a timing" : `${slower.length} timings`} clearly slower than the code before it, measured beside it on this Mac: ${slower.join("; ")}.`, {
        blame: "code",
        next: "That's the code, not the Mac: a Mac too busy to tell reads as unsure, never slower. Build again once a fix lands.",
        details: failure.message,
        script,
      })
    throw new StepError("checking", failure.message, { script, cause: failure })
  }
  return unsure.length ? { rows: unsure, machine, busy, measuredAt: new Date().toISOString() } : undefined
}


/** The copy an earlier build kept as `checkout`, renamed `CHECKOUT` where nothing is there yet: its manifest and compile output carry over. */
async function moveLegacyCheckout(root: string): Promise<void> {
  const legacy = join(root, LEGACY_CHECKOUT)
  const info = await lstat(legacy).catch(() => null)
  if (!info?.isDirectory() || (await lstat(join(root, CHECKOUT)).catch(() => null))) return
  await rename(legacy, join(root, CHECKOUT))
}

const buildCaches = new Set([".git", ".next", ".eve", ".output", ".vercel", ".cache", ".turbo", ".DS_Store"])

const SYNC_MANIFEST = ".mako-sync.json"
const DEPENDENCIES_SENTINEL = join("node_modules", ".package-lock.json")

interface BuildSyncManifest {
  /** Signatures of npm's dependency sentinel and the project lockfile. */
  deps: string | null
  /** Last synced source entries: relative path → signature. */
  entries: Record<string, string>
}

const syncManifestSchema = z.object({
  deps: z.string().nullable(),
  entries: z.record(z.string(), z.string()),
})

const buildSourceFilter = (path: string) => {
  const name = basename(path)
  return (
    !name.startsWith(".env") &&
    !buildCaches.has(name) &&
    !name.endsWith(".tsbuildinfo")
  )
}

async function entrySignature(
  files: Awaited<ReturnType<typeof physicalFiles>>,
  path: string,
  entry: { isSymbolicLink(): boolean; isDirectory(): boolean }
): Promise<string> {
  if (entry.isSymbolicLink()) return `l:${await files.readlink(path)}`
  if (entry.isDirectory()) return "d"
  const info = await files.lstat(path)
  return `${info.size}:${info.mtimeMs}`
}

/**
 * The tracked source tree as relative path → signature, `node_modules`
 * excepted: it is managed whole through the dependency sentinel instead of
 * per-file diffs. Same admission rules as `copyBuildSource` — top-level
 * dotfiles except .npmrc/.prettier*, the excluded set, no top-level links,
 * and the per-name filter at every level below.
 */
async function scanBuildSource(
  files: Awaited<ReturnType<typeof physicalFiles>>,
  source: string
): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  const visit = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await files.readdir(dir, { withFileTypes: true })) {
      const name = entry.name
      const path = join(dir, name)
      const relative = rel ? `${rel}/${name}` : name
      if (!rel) {
        const config = name === ".npmrc" || name.startsWith(".prettier")
        if (
          (!config && name.startsWith(".")) ||
          excluded.has(name) ||
          !buildSourceFilter(path)
        )
          continue
        if (entry.isSymbolicLink())
          throw new Error("Build source entries must not be symbolic links.")
      } else if (!buildSourceFilter(path)) continue
      if (entry.isDirectory()) {
        entries.set(relative, "d")
        if (rel || name !== "node_modules") await visit(path, relative)
      } else {
        entries.set(relative, await entrySignature(files, path, entry))
      }
    }
  }
  await visit(source, "")
  return entries
}

/**
 * Sync the private build checkout instead of copying the whole tree.
 *
 * A manifest of the last synced signatures makes repeat updates copy only
 * what changed — the full clone of a checkout plus node_modules was the
 * slowest step of every local update. node_modules is replaced whole only
 * when npm's sentinel or the project lockfile moved; hand edits inside it
 * are deliberately not tracked. Generated output (dist, tsbuildinfo) is never
 * synced, so it survives in the checkout and the compile stays incremental.
 */
export async function syncBuildCheckout(
  source: string,
  checkout: string
): Promise<string> {
  const files = await physicalFiles()
  let manifest: BuildSyncManifest | null = await files
    .readFile(join(checkout, SYNC_MANIFEST), "utf8")
    .then((text) => syncManifestSchema.parse(JSON.parse(text)))
    .catch(() => null)
  if (!manifest) {
    await files.rm(checkout, { recursive: true, force: true })
    manifest = { deps: null, entries: {} }
  }
  await files.mkdir(checkout, { recursive: true })

  const locks = await Promise.all(
    [DEPENDENCIES_SENTINEL, "package-lock.json"].map((path) => files
      .lstat(join(source, path))
      .then((info) => `${info.size}:${info.mtimeMs}`)
      .catch(() => null))
  )
  const deps = locks[0] === null ? null : JSON.stringify(locks)
  const sourceModules = await files
    .lstat(join(source, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  const checkoutModules = await files
    .lstat(join(checkout, "node_modules"))
    .then((info) => info.isDirectory())
    .catch(() => false)
  let resyncedDependencies = false
  if (!sourceModules) {
    await files.rm(join(checkout, "node_modules"), {
      recursive: true,
      force: true,
    })
  } else if (deps === null || manifest.deps !== deps || !checkoutModules) {
    // No sentinel means there is nothing trustworthy to diff against; pay the
    // whole copy rather than guess at npm's tree.
    await files.rm(join(checkout, "node_modules"), {
      recursive: true,
      force: true,
    })
    await files.cp(join(source, "node_modules"), join(checkout, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: buildSourceFilter,
    })
    resyncedDependencies = true
  }

  const scanned = await scanBuildSource(files, source)
  const newLinks: string[] = []
  for (const [rel, signature] of scanned) {
    if (manifest.entries[rel] === signature) continue
    const from = join(source, rel)
    const to = join(checkout, rel)
    if (signature === "d") {
      await files.mkdir(to, { recursive: true })
      continue
    }
    const existing = await files.lstat(to).catch(() => null)
    const info = await files.lstat(from)
    if (
      existing &&
      (existing.isDirectory() ||
        existing.isSymbolicLink() !== info.isSymbolicLink())
    )
      await files.rm(to, { recursive: true, force: true })
    await files.mkdir(dirname(to), { recursive: true })
    await files.cp(from, to, {
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    })
    if (info.isSymbolicLink()) newLinks.push(to)
  }
  for (const rel of Object.keys(manifest.entries))
    if (!scanned.has(rel))
      await files.rm(join(checkout, rel), { recursive: true, force: true })

  const root = await files.realpath(checkout)
  // A link's resolution is fixed by its location and text, so only newly
  // synced links need checking; a wholesale dependency resync revalidates its
  // tree the way the original copy did.
  for (const link of newLinks) await checkLink(files, root, link)
  if (resyncedDependencies) await checkDependencyLinks(checkout)

  await writeFile(
    join(checkout, SYNC_MANIFEST),
    JSON.stringify({ deps: sourceModules ? deps : null, entries: Object.fromEntries(scanned) } satisfies BuildSyncManifest),
    { mode: 0o600 }
  )
  const fingerprint = createHash("sha256")
  for (const [path, signature] of [...scanned].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  ))
    fingerprint.update(`${path} ${signature}\n`)
  return fingerprint.update(`deps ${deps}`).digest("hex")
}

async function checkLink(files: Awaited<ReturnType<typeof physicalFiles>>, root: string, link: string): Promise<void> {
  const resolved = await files.realpath(link).catch(() => null)
  if (resolved && resolved !== root && !resolved.startsWith(`${root}/`))
    throw new StepError("copying", `The dependency link ${relative(root, link)} leaves the private build copy.`, { blame: "checkout", next: "Run npm install in the source checkout, then build again." })
}

/** Every link under `folder`'s node_modules resolves inside `folder`. */
export async function checkDependencyLinks(folder: string): Promise<void> {
  const files = await physicalFiles()
  const root = await files.realpath(folder)
  const pending = [join(root, "node_modules")]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await files.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) await checkLink(files, root, path)
      else if (entry.isDirectory()) pending.push(path)
    }
  }
}

/** npm's record of what it installed in `folder`, as a signature: what a build's stamp carries for its dependencies. */
async function dependencySignature(folder: string): Promise<string> {
  const info = await lstat(join(folder, DEPENDENCIES_SENTINEL)).catch(() => null)
  return info ? `${info.size}:${info.mtimeMs}` : "none"
}

/** `npm run <script>` as a step of the build; a failure says which step and script, with what it printed. */
async function runStep(step: BuildPhase, npm: string, script: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await runBuild(npm, ["run", script], cwd, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new StepError(step, message, { script, details: message, cause: error })
  }
}

export async function copyBuildSource(
  source: string,
  checkout: string
): Promise<void> {
  const files = await physicalFiles()
  const filter = (path: string) => {
    const name = basename(path)
    return !name.startsWith(".env") && !buildCaches.has(name) && !name.endsWith(".tsbuildinfo")
  }
  const entries = await files.readdir(source, { withFileTypes: true })
  for (const entry of entries) {
    const config = entry.name === ".npmrc" || entry.name.startsWith(".prettier")
    if ((!config && entry.name.startsWith(".")) || excluded.has(entry.name))
      continue
    if (entry.isSymbolicLink())
      throw new Error("Build source entries must not be symbolic links.")
    await files.cp(join(source, entry.name), join(checkout, entry.name), {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter,
    })
  }
  await files.cp(join(source, "node_modules"), join(checkout, "node_modules"), {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
    filter,
  })
  const root = await files.realpath(checkout)
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of await files.readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        const resolved = await files.realpath(path)
        if (!resolved.startsWith(`${root}/`))
          throw new Error(
            `The dependency link ${relative(root, path)} leaves the private build copy. Reinstall dependencies in the source checkout before building.`
          )
      } else if (entry.isDirectory()) pending.push(path)
    }
  }
}

async function runBuild(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeoutMs = BUILD_STEP_MS
): Promise<void> {
  // Keep a bounded diagnostic tail. Discarding all output made a failed
  // Settings check report only "exited with 1", hiding the failing test.
  let stdout = ""
  let stderr = ""
  const { code, stopped } = await runProcessGroup(command, args, {
    cwd,
    env,
    stdio: "pipe",
    signal,
    timeoutMs,
    output: (stream, text) => {
      if (stream === "stdout") stdout = (stdout + text).slice(-8192)
      else stderr = (stderr + text).slice(-8192)
    },
  })
  if (signal?.aborted) throw signal.reason
  if (code === 0 && !stopped) return
  if (stopped === "timeout") throw new Error("The build step exceeded its time limit.")
  // The pipes can drain out of order: a stdout burst must not erase the
  // final stderr failure, even if the child wrote stderr last.
  const diagnostic = [stdout.slice(stderr ? -600 : -1200), stderr.slice(stdout ? -600 : -1200)]
    .map(text => stripVTControlCharacters(text).trim()).filter(Boolean).join("\n")
  throw new Error(`${basename(command)} ${args.join(" ")} exited with ${code ?? "a signal"}. ${diagnostic || "The step produced no diagnostic output."}`)
}
