import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { MethodTable } from "../base/methods.js"
import type { CloudAccount } from "../contracts/cloud-account.js"
import type { CloudSignInRow, CloudSignInsState } from "../contracts/cloud-sign-ins.js"
import type { CloudRepository } from "../contracts/cloud-threads.js"
import { TURN_ON_STEPS, type BaseStanding, type CloudTurnOn, type TurnOnAgent, type TurnOnProject, type TurnOnStep, type TurnOnStepId, type TurnOnStepOf } from "../contracts/cloud-turn-on.js"
import type { SyncStatus } from "../contracts/sync-status.js"

/**
 * Turning Mako Cloud on, read whole from what owns each step (`contracts/cloud-turn-on.ts`). Everything the steps wait
 * on starts by itself the moment this Mac hears the account has the cloud, at once and side by side: the agents'
 * sign-ins go up (`CloudSignInSync`), the recent projects' bases are asked for (`CloudConversations.offerProjects`),
 * and the last 30 days start syncing (`SessionUploads`). This only follows them, and keeps when each was first seen
 * done, per account, in `turn-on.json` beside the cloud conversations.
 */

const CLOUD = "cloud"
/** While a base is being made or waits, its standing is read again this often; once every one is settled, this. */
const STANDING_BUSY_MS = 4_000
const STANDING_SETTLED_MS = 5 * 60_000

/** What a step's state is read from. */
export type TurnOnReading = {
  account: CloudAccount
  signIns: CloudSignInsState | undefined
  sync: SyncStatus
  /** The projects offered for bases, with how each base stands; undefined until offered. */
  projects: TurnOnProject[] | undefined
  /** When the first cloud Thread was made, if one was. */
  firstThread: number | undefined
  /** A machine made ahead for the first project's first Thread. */
  machine: "warming" | "ready" | undefined
}

/** When each step was first seen done, for one account; what makes `at`, `since`, `readyAt` and `onAt`. */
const KeptSchema = z.object({
  since: z.number(),
  done: z.record(z.string(), z.number()),
  readyAt: z.number().optional(),
  onAt: z.number().optional(),
})
type Kept = z.infer<typeof KeptSchema>
const FileSchema = z.object({ version: z.literal(1), accounts: z.record(z.string(), KeptSchema) })

/** Once seen done, these stay done: what follows is the Sync section's, the base's own life, the person's own Threads. */
const STAYS_DONE: readonly TurnOnStepId[] = ["projects", "history", "thread"]

/** The steps as they stand now, before what was kept is laid over them. */
function stepsOf(reading: TurnOnReading): TurnOnStep[] {
  const { state } = reading.account
  const later = (id: TurnOnStepId): TurnOnStep => laterStep(id)
  if (state.status === "unavailable") return TURN_ON_STEPS.map(later)
  if (state.status !== "signed-in") {
    const account: TurnOnStepOf<"account"> = { id: "account", state: "yours", fix: "sign-in" }
    if (state.status === "signing-in") account.signingIn = true
    return [account, ...TURN_ON_STEPS.slice(1).map(later)]
  }
  const account: TurnOnStepOf<"account"> = { id: "account", state: "done", connection: state.connection }
  if (state.connection === "offline") {
    account.state = "stuck"
    account.problem = "Mako Cloud can't be reached from this Mac just now. It tries again by itself."
    account.fix = "check-plan"
  }
  if (!state.account.entitlements.includes(CLOUD)) return [account, { id: "plan", state: "yours", fix: "check-plan" }, ...TURN_ON_STEPS.slice(2).map(later)]
  return [account, { id: "plan", state: "done" }, agentsStep(reading.signIns), projectsStep(reading.projects), historyStep(reading.sync), threadStep(reading)]
}

function laterStep(id: TurnOnStepId): TurnOnStep {
  switch (id) {
    case "account":
      return { id, state: "later" }
    case "plan":
      return { id, state: "later" }
    case "agents":
      return { id, state: "later", sharing: true, agents: [] }
    case "projects":
      return { id, state: "later", projects: [] }
    case "history":
      return { id, state: "later", threads: 0, inCloud: 0, today: { threads: 0, inCloud: 0 }, paused: false, failures: 0, correlationIds: [] }
    case "thread":
      return { id, state: "later" }
  }
}

/** An agent signed in on this Mac, as it stands in the cloud; one not signed in here has nothing to send. */
function agentOf(row: CloudSignInRow): TurnOnAgent | undefined {
  if (row.status === "signed-out") return undefined
  if (row.status === "failed") return { harness: row.harness, state: "stuck", ...row.problem && { problem: row.problem } }
  if (row.rotates) {
    const kept = row.kept
    if (kept?.state === "needs-reconnect") return { harness: row.harness, state: "stuck", ...kept.problem && { problem: kept.problem.detail } }
    return { harness: row.harness, state: kept ? "in-cloud" : "sending" }
  }
  return { harness: row.harness, state: row.status === "sent" ? "in-cloud" : "sending" }
}

function agentsStep(signIns: CloudSignInsState | undefined): TurnOnStepOf<"agents"> {
  if (!signIns || signIns.blocked) return { id: "agents", state: "working", sharing: signIns?.sharing ?? true, agents: [] }
  if (!signIns.sharing) return { id: "agents", state: "done", sharing: false, agents: [] }
  // Not read yet: every harness is read once at the start.
  if (!signIns.checkedAt) return { id: "agents", state: "working", sharing: true, agents: [] }
  const agents = signIns.harnesses.map(agentOf).filter((agent) => agent !== undefined)
  const step: TurnOnStepOf<"agents"> = { id: "agents", state: "done", sharing: true, agents }
  if (agents.some((agent) => agent.state === "sending")) step.state = "working"
  else if (agents.some((agent) => agent.state === "stuck")) {
    step.state = "stuck"
    step.fix = "sign-in-agent"
  }
  return step
}

/** A base the cloud can't read (a private repository, or one gone): settled, since no try would help. */
export function noAccess(base: BaseStanding): boolean {
  return (base.state === "failed" || base.state === "waiting") && base.reason === "no-access"
}

function projectsStep(projects: TurnOnProject[] | undefined): TurnOnStepOf<"projects"> {
  if (!projects) return { id: "projects", state: "working", projects: [] }
  const step: TurnOnStepOf<"projects"> = { id: "projects", state: "done", projects }
  if (projects.some(({ base }) => (base.state === "making" || base.state === "waiting") && !noAccess(base))) step.state = "working"
  else {
    const failed = projects.find(({ base }) => base.state === "failed" && !noAccess(base))
    if (failed?.base.state === "failed") {
      step.state = "stuck"
      step.problem = failed.base.message
      step.fix = "retry-bases"
    }
  }
  return step
}

function historyStep(sync: SyncStatus): TurnOnStepOf<"history"> {
  const step: TurnOnStepOf<"history"> = { id: "history", state: "working", threads: 0, inCloud: 0, today: { threads: 0, inCloud: 0 }, paused: false, failures: 0, correlationIds: [] }
  if (!("tiers" in sync)) return step
  for (const tier of sync.tiers) {
    step.threads += tier.threads
    step.inCloud += tier.threadsInCloud
    if (tier.tier === "now" || tier.tier === "day") {
      step.today.threads += tier.threads
      step.today.inCloud += tier.threadsInCloud
    }
  }
  step.paused = sync.state === "paused"
  step.failures = sync.failures.length
  step.correlationIds = sync.failures.flatMap((failure) => (failure.correlationId ? [failure.correlationId] : []))
  if (sync.state === "synced") step.state = "done"
  else if (sync.state === "failing") {
    step.state = "stuck"
    step.problem = sync.failures[0]?.message ?? "Some Sessions didn't go up."
    step.fix = "copy-details"
  }
  return step
}

function threadStep(reading: TurnOnReading): TurnOnStepOf<"thread"> {
  if (reading.firstThread !== undefined) return { id: "thread", state: "done" }
  const first = startable(reading.projects)
  if (!first) return { id: "thread", state: "yours" }
  const step: TurnOnStepOf<"thread"> = { id: "thread", state: "yours", folder: first.folder, repository: first.repository, fix: "start-thread" }
  if (reading.machine) step.machine = reading.machine
  return step
}

/** The most recent project a cloud Thread can start in: one the cloud can read. */
function startable(projects: TurnOnProject[] | undefined): TurnOnProject | undefined {
  return projects?.find((project) => !noAccess(project.base))
}

/** A Thread can run in the cloud: signed in, the cloud on the account, and the agents' sign-ins there, or none to send. */
function readyOf(steps: TurnOnStep[]): boolean {
  const byId = (id: TurnOnStepId) => steps.find((step) => step.id === id)
  const agents = byId("agents")
  if (byId("account")?.state !== "done" || byId("plan")?.state !== "done" || agents?.id !== "agents") return false
  if (agents.state === "done") return true
  return agents.state === "stuck" && agents.agents.some((agent) => agent.state === "in-cloud")
}

/**
 * The line as it stands: each step from `reading`, with when it was first seen done laid over it from `kept` (and
 * kept done, for the steps that stay so), and the phase. Returns what to keep next, unchanged when nothing new is done.
 */
/** The line as read, and what to keep of it. */
export type TurnOnRead = { turnOn: CloudTurnOn; kept: Kept | undefined }

export function turnOnOf(reading: TurnOnReading, kept: Kept | undefined, now: number): TurnOnRead {
  const { state } = reading.account
  const fresh = stepsOf(reading)
  if (state.status === "unavailable") return { turnOn: { phase: "unavailable", steps: fresh }, kept }
  if (state.status !== "signed-in") return { turnOn: { phase: "signed-out", steps: fresh }, kept }
  if (!state.account.entitlements.includes(CLOUD)) return { turnOn: { phase: "no-cloud", steps: fresh }, kept }
  let next: Kept = kept ? { ...kept, done: { ...kept.done } } : { since: now, done: {} }
  const steps = fresh.map((step): TurnOnStep => {
    const at = next.done[step.id]
    if (step.state === "done") {
      if (at === undefined) next.done[step.id] = now
      return { ...step, at: next.done[step.id] }
    }
    if (at !== undefined && STAYS_DONE.includes(step.id)) {
      const settled: TurnOnStep = { ...step, state: "done", at }
      delete settled.fix
      delete settled.problem
      return settled
    }
    return step
  })
  if (next.readyAt === undefined && readyOf(steps)) next.readyAt = now
  if (next.onAt === undefined && steps.every((step) => step.state === "done")) next.onAt = now
  if (kept && JSON.stringify(kept) === JSON.stringify(next)) next = kept
  const turnOn: CloudTurnOn = { phase: next.onAt !== undefined ? "on" : next.readyAt !== undefined || readyOf(steps) ? "ready" : "turning-on", since: next.since, steps }
  if (next.readyAt !== undefined) turnOn.readyAt = next.readyAt
  if (next.onAt !== undefined) turnOn.onAt = next.onAt
  return { turnOn, kept: next }
}

/** What turning the cloud on reads of the host. */
export type TurnOnSources = {
  account(): Promise<CloudAccount | undefined>
  signIns(): Promise<CloudSignInsState | undefined>
  sync(): Promise<SyncStatus>
  /** The recent projects offered for bases for this account, the newest first; undefined until offered. */
  projects(accountId: string): Promise<Array<{ folder: string; repository: CloudRepository }> | undefined>
  /** How the cloud stands these bases; null from a cloud that doesn't say. */
  standings(repositories: CloudRepository[]): Promise<Array<{ repository: CloudRepository; standing: BaseStanding }> | null>
  /** Asks the cloud again for these bases. */
  askBases(repositories: CloudRepository[]): Promise<void>
  /** Asks the cloud again what the account has. */
  checkPlan(): Promise<void>
  firstThread(): number | undefined
  machine(repository: CloudRepository): "warming" | "ready" | undefined
  now(): number
}

const UNAVAILABLE: CloudAccount = { cloud: null, state: { status: "unavailable", message: "This Mako doesn't reach Mako Cloud." } }

/** Follows turning the cloud on, keeps when each step was done, and tells the windows as the line changes. */
export class CloudTurnOnFollower {
  readonly #sources: TurnOnSources
  readonly #file: string
  readonly #emit: (turnOn: CloudTurnOn) => void
  #stored: z.infer<typeof FileSchema> | undefined
  #last: CloudTurnOn | undefined
  #lastText: string | undefined
  #standings: { key: string; at: number; read: Array<{ repository: CloudRepository; standing: BaseStanding }> | null } | undefined
  #reading: Promise<CloudTurnOn> | undefined
  /** The repositories offered, by folder, branch included, as last read. */
  #offered = new Map<string, CloudRepository>()
  #writing: Promise<void> = Promise.resolve()
  readonly #loaded: Promise<void>

  constructor(options: { sources: TurnOnSources; file: string; emit: (turnOn: CloudTurnOn) => void }) {
    this.#sources = options.sources
    this.#file = options.file
    this.#emit = options.emit
    this.#loaded = this.#load()
  }

  /** The line now, read once however many ask at once. */
  read(): Promise<CloudTurnOn> {
    this.#reading ??= this.#read().finally(() => (this.#reading = undefined))
    return this.#reading
  }

  /**
   * On the host's tick: read while the cloud is being turned on, so each step's time is its own and every window hears
   * it; once it's on, only the account is looked at, which is in memory.
   */
  async tick(): Promise<void> {
    await this.#loaded
    if (this.#last?.phase === "on") {
      const account = await this.#sources.account()
      const state = account?.state
      if (state?.status === "signed-in" && state.account.entitlements.includes(CLOUD) && this.#kept(state.account.id)?.onAt !== undefined) return
    }
    await this.read()
  }

  async checkPlan(): Promise<CloudTurnOn> {
    await this.#sources.checkPlan()
    return this.read()
  }

  /** "Try again" on the bases that failed: asked for again, and read again at once. */
  async retryBases(): Promise<CloudTurnOn> {
    const projects = this.#last?.steps.find((step) => step.id === "projects")
    const failed = projects?.id === "projects" ? projects.projects.filter(({ base }) => base.state === "failed") : []
    if (failed.length) {
      await this.#sources.askBases(failed.map(({ folder, repository }) => this.#offered.get(folder) ?? { url: repository }))
      this.#standings = undefined
    }
    return this.read()
  }

  async #read(): Promise<CloudTurnOn> {
    await this.#loaded
    const account = (await this.#sources.account()) ?? UNAVAILABLE
    const state = account.state
    const entitled = state.status === "signed-in" && state.account.entitlements.includes(CLOUD)
    const accountId = state.status === "signed-in" ? state.account.id : undefined
    const [signIns, sync, offered] = entitled && accountId
      ? await Promise.all([this.#sources.signIns().catch(() => undefined), this.#sources.sync(), this.#sources.projects(accountId)])
      : [undefined, { state: "off", reason: "signed-out" } as const, undefined]
    const projects = offered && (await this.#projects(offered))
    const firstFolder = startable(projects)?.folder
    const first = offered?.find((project) => project.folder === firstFolder)
    const reading: TurnOnReading = {
      account,
      signIns,
      sync,
      projects,
      firstThread: this.#sources.firstThread(),
      machine: first ? this.#sources.machine(first.repository) : undefined,
    }
    const kept = accountId ? this.#kept(accountId) : undefined
    const { turnOn, kept: next } = turnOnOf(reading, kept, this.#sources.now())
    if (accountId && next && next !== kept) await this.#keep(accountId, kept, next)
    const text = JSON.stringify(turnOn)
    this.#last = turnOn
    if (text !== this.#lastText) {
      this.#lastText = text
      this.#emit(turnOn)
    }
    return turnOn
  }

  /** Each offered project with its base's standing, read again only as often as it can change. */
  async #projects(offered: Array<{ folder: string; repository: CloudRepository }>): Promise<TurnOnProject[]> {
    this.#offered = new Map(offered.map(({ folder, repository }) => [folder, repository]))
    const key = JSON.stringify(offered.map(({ repository }) => repository))
    const now = this.#sources.now()
    const cached = this.#standings
    const settled = cached?.read?.every(({ standing }) => standing.state !== "making" && standing.state !== "waiting") ?? false
    if (!cached || cached.key !== key || now - cached.at >= (settled ? STANDING_SETTLED_MS : STANDING_BUSY_MS)) {
      const read = await this.#sources.standings(offered.map(({ repository }) => repository)).catch((error: Error) => {
        hostWarn("cloud-turn-on", "the bases' standing wasn't read", { error: error.message })
        return cached?.key === key ? cached.read : null
      })
      this.#standings = { key, at: now, read }
    }
    const read = this.#standings?.read
    return offered.map(({ folder, repository }) => ({
      folder,
      repository: repository.url,
      base: read?.find((entry) => entry.repository.url === repository.url && entry.repository.branch === repository.branch)?.standing ?? { state: "unknown" },
    }))
  }

  #kept(accountId: string): Kept | undefined {
    return this.#stored?.accounts[accountId]
  }

  /** What was kept, read once; a file this build can't read starts afresh rather than stopping the line. */
  async #load(): Promise<void> {
    const text = await readFile(this.#file, "utf8").catch(() => undefined)
    let json: unknown
    try {
      json = text === undefined ? undefined : JSON.parse(text)
    } catch {
      json = undefined
    }
    const parsed = json === undefined ? undefined : FileSchema.safeParse(json)
    this.#stored = parsed?.success ? parsed.data : { version: 1, accounts: {} }
  }

  async #keep(accountId: string, before: Kept | undefined, next: Kept): Promise<void> {
    this.#stored ??= { version: 1, accounts: {} }
    this.#stored.accounts[accountId] = next
    for (const step of TURN_ON_STEPS)
      if (next.done[step] !== undefined && before?.done[step] === undefined) hostLog("cloud-turn-on", "a step is done", { step, afterMs: next.done[step] - next.since })
    if (next.readyAt !== undefined && before?.readyAt === undefined) hostLog("cloud-turn-on", "the cloud is ready for a Thread", { afterMs: next.readyAt - next.since })
    if (next.onAt !== undefined && before?.onAt === undefined) hostLog("cloud-turn-on", "the cloud is on, every step done", { afterMs: next.onAt - next.since })
    if (!before) hostLog("cloud-turn-on", "turning the cloud on")
    const text = `${JSON.stringify(this.#stored)}\n`
    const file = this.#file
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(`${file}.tmp`, text, { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    }).catch((error: Error) => hostWarn("cloud-turn-on", "couldn't keep the steps' times", { error: error.message }))
    await this.#writing
  }
}

/** Where no person's Mac turns the cloud on (a cloud machine, the fixture desk), the line says so. */
const NOWHERE: CloudTurnOn = { phase: "unavailable", steps: TURN_ON_STEPS.map(laterStep) }

export function declareTurnOnMethods(methods: MethodTable, follower: CloudTurnOnFollower | undefined): void {
  methods.handle("mako:cloud-turn-on", () => follower?.read() ?? NOWHERE)
  methods.handle("mako:cloud-turn-on-check", () => follower?.checkPlan() ?? NOWHERE)
  methods.handle("mako:cloud-turn-on-retry-bases", () => follower?.retryBases() ?? NOWHERE)
}
