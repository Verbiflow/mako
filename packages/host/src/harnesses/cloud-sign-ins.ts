import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { childProcessEnv } from "../base/child-environment.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import {
  CloudSignInHarnessSchema,
  CloudSignInSchema,
  type CloudKeptSignIn,
  type CloudShareOutcome,
  type CloudSharedChain,
  type CloudSignIn,
  type CloudSignInChain,
  type CloudSignInHarness,
  type CloudSignInInstall,
  type CloudSignInListing,
  type CloudSignInRow,
  type CloudSignInsState,
} from "../contracts/cloud-sign-ins.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { HarnessAccounts } from "./accounts.js"
import { credentialFingerprint } from "./accounts-common.js"
import { chainFingerprint, type CloudSignInCapability, type CloudSignInMirror, type CloudSignInPlace } from "./cloud-sign-in.js"
import type { ProviderRegistry } from "./registry.js"

/** How often this Mac reads every harness's sign-in; a harness refreshes in place, and Mako Cloud follows within this. */
const CHECK_MS = 60_000
/** A sign-in this close to lapsing is refreshed by its harness, as running it would, before it's sent. */
const RENEW_BEFORE_MS = 10 * 60_000
/** A harness asked to refresh isn't asked again sooner: a refresh it refused stays refused. */
const RENEW_GAP_MS = 5 * 60_000
/** While nothing checks on a timer, a state older than this is read again when asked for. */
const FRESH_MS = 30_000
/**
 * After a wake the network may not be back: checks follow at these waits until the cloud answers, closely at first,
 * since a harness may want to refresh as soon as it can reach its provider. A check with no network fails at once.
 */
const WAKE_RETRY_MS = [500, 500, 1_000, 1_000, 1_000, 2_000, 2_000, 4_000, 4_000, 8_000, 16_000, 32_000, 32_000]
/**
 * After a wake, each shared harness's own refresh lock is held until a check reached the cloud and wrote its pair,
 * or this long: past it the cloud is unreachable and the harness may need to refresh by itself.
 */
const WAKE_HOLD_MS = 15_000
/** How long a wake waits for a harness that's refreshing right now to let go of its lock. */
const WAKE_HOLD_WAIT_MS = 2_000
/** The longest a harness's launch waits for the check after a wake, so it starts on the cloud's newest pair. */
const LAUNCH_WAIT_MS = 5_000
/** A harness whose store refused a write is tried again this often, not every check. */
const UNWRITABLE_RETRY_MS = 10 * 60_000
/** While this Mac is behind the cloud and couldn't write its pair, it checks again this soon, up to `HURRY_TRIES` times. */
const HURRY_MS = 5_000
const HURRY_TRIES = 12

/**
 * Writes each sign-in a cloud machine is given where its harness reads it,
 * through that harness's own adapter. One that fails leaves the others.
 */
export async function installCloudSignIns(
  capabilities: ProviderRegistry<ProviderAccountCapability>,
  signIns: readonly CloudSignIn[],
  place: CloudSignInPlace,
): Promise<CloudSignInInstall[]> {
  const at = () => new Date().toISOString()
  const given = new Set(signIns.map((signIn) => signIn.harness))
  const installed = signIns.map(async (signIn): Promise<CloudSignInInstall> => {
    const adapter = capabilities.get(signIn.harness)?.cloudSignIn
    if (!adapter) return { harness: signIn.harness, status: "failed", at: at(), reason: "This host has no such harness" }
    try {
      await adapter.install(signIn.payload, place)
      return { harness: signIn.harness, status: "installed", at: at(), expiresAt: signIn.expiresAt }
    } catch (error) {
      return { harness: signIn.harness, status: "failed", at: at(), reason: problemOf(error) }
    }
  })
  // The set is the account's whole: a harness missing from it is signed out here too, not left to lapse.
  const removed = capabilities.list().flatMap((capability) => {
    const harness = CloudSignInHarnessSchema.safeParse(capability.provider)
    if (!harness.success || given.has(harness.data) || !capability.cloudSignIn) return []
    const adapter = capability.cloudSignIn
    return [
      adapter.remove(place).then(
        (had): CloudSignInInstall | undefined => (had ? { harness: harness.data, status: "removed", at: at() } : undefined),
        (cause: unknown): CloudSignInInstall => ({ harness: harness.data, status: "failed", at: at(), reason: problemOf(cause) }),
      ),
    ]
  })
  return [...(await Promise.all(installed)), ...(await Promise.all(removed)).filter((install) => install !== undefined)]
}

/** A failure in words that can be logged and shown: a parse error quotes what it couldn't parse, which may be a token. */
function problemOf(cause: unknown): string {
  if (cause instanceof SyntaxError) return "The harness's sign-in isn't in a shape Mako reads"
  return cause instanceof Error ? cause.message : String(cause)
}

/** Where this Mac's sign-ins go: the account's store in Mako Cloud, through this Mac's device sign-in. */
export interface CloudSignInStore {
  /** Why nothing can be sent now, or undefined when it can. */
  blocked(): Promise<CloudSignInsState["blocked"]>
  /** What devices shared, and the sign-ins the cloud keeps and refreshes. */
  list(): Promise<{ signIns: CloudSignInListing[]; kept: CloudKeptSignIn[] }>
  put(signIn: CloudSignIn): Promise<void>
  remove(harness: CloudSignInHarness): Promise<void>
  /** Hands the cloud this Mac's whole sign-in, for it to refresh for both: it takes it, has it, or has a newer one. */
  share(harness: CloudSignInHarness, chain: CloudSignInChain): Promise<CloudShareOutcome>
  /** The whole pair of a sign-in this Mac shares, as the cloud last refreshed it; null when it holds none for this Mac. */
  pull(harness: CloudSignInHarness): Promise<CloudSharedChain | null>
  disconnect(harness: CloudSignInHarness): Promise<void>
}

/**
 * The person's choice, and for each sign-in this Mac shares the refresh token both sides last had, by fingerprint:
 * what tells a sign-in signed out here apart from one a stale refresh cleared while this Mac was behind.
 */
const ChoiceSchema = z.union([
  z.object({ version: z.literal(2), sharing: z.boolean().optional(), inStep: z.record(z.string(), z.object({ token: z.string(), at: z.string() })).default({}) }),
  // Version 1 shared access only; a choice of "off" then was a choice about that, so it isn't carried over.
  z.object({ version: z.literal(1), sharing: z.boolean() }).transform(({ sharing }) => ({ version: 2 as const, sharing: sharing ? true : undefined, inStep: {} })),
])
type InStep = { token: string; at: string }

type Sent = { fingerprint: string; at: string }

/**
 * Keeps Mako Cloud holding the sign-in each harness on this Mac runs under. Sharing is on unless the person turns it
 * off, and does anything only for an account with the cloud. Every minute, and on wake, it reads each harness's store
 * (no prompt, no network):
 *
 * - A sign-in that rotates (Claude Code, Codex, Grok) is one sign-in for this Mac and the cloud, which refreshes it
 *   for both. This Mac's seeds it; each refresh the cloud makes is written into the harness's own store before the
 *   harness would refresh by itself; a refresh the harness made anyway is sent up. Every harness reads its store
 *   again before it refreshes and runs on a newer pair it finds, as for another of its own processes.
 * - Any other sign-in (a key) is sent as it is, and a harness whose sign-in is about to lapse is asked to refresh it.
 *
 * A harness signed out here is signed out there. Values go between the store and the cloud and nowhere else:
 * Settings and the log see names, times, fingerprints and problems.
 */
export class CloudSignInSync {
  readonly #accounts: HarnessAccounts
  readonly #capabilities: ProviderRegistry<ProviderAccountCapability>
  readonly #store: CloudSignInStore
  readonly #choicePath: string
  readonly #onChange: (state: CloudSignInsState) => void
  #sharing: boolean | undefined
  #inStep: Record<string, InStep> = {}
  #state: CloudSignInsState = { sharing: true, harnesses: [] }
  readonly #sent = new Map<CloudSignInHarness, Sent>()
  readonly #renewedAt = new Map<CloudSignInHarness, number>()
  #timer: NodeJS.Timeout | undefined
  #checking: Promise<CloudSignInsState> | undefined
  #next: Promise<CloudSignInsState> | undefined
  #loaded: Promise<void>
  /** Whether the last check reached the cloud. */
  #reached = false
  /** The checks after a wake, until one reaches the cloud. */
  #waking: Promise<void> | undefined
  /** Harnesses whose store this run has written back whole: the proof the cloud may move their sign-in. */
  readonly #writable = new Set<CloudSignInHarness>()
  /** Harnesses whose store refused a write, with why and when, so the refusal is shown and retried sparingly. */
  readonly #unwritable = new Map<CloudSignInHarness, { problem: string; at: number }>()
  /** This check found this Mac behind the cloud with a pair it couldn't write: its harness has no live sign-in. */
  #behind = false
  #hurried = 0
  readonly #wakeRetryMs: readonly number[]
  readonly #wakeHoldMs: number
  /** Harnesses whose refresh lock a wake holds now: a write to them doesn't take it again. */
  readonly #held = new Set<CloudSignInHarness>()
  /** Pairs taken from the cloud, counted for what a wake reports. */
  #taken = 0

  constructor(options: {
    accounts: HarnessAccounts
    capabilities: ProviderRegistry<ProviderAccountCapability>
    store: CloudSignInStore
    /** Where the person's choice is kept. */
    dataRoot: string
    onChange: (state: CloudSignInsState) => void
    /** The waits between checks after a wake; shorter in tests. */
    wakeRetryMs?: readonly number[]
    /** The longest a wake holds the harnesses' refresh locks; shorter in tests. */
    wakeHoldMs?: number
  }) {
    this.#wakeRetryMs = options.wakeRetryMs ?? WAKE_RETRY_MS
    this.#wakeHoldMs = options.wakeHoldMs ?? WAKE_HOLD_MS
    this.#accounts = options.accounts
    this.#capabilities = options.capabilities
    this.#store = options.store
    this.#choicePath = join(options.dataRoot, "cloud", "sign-ins.json")
    this.#onChange = options.onChange
    this.#loaded = readFile(this.#choicePath, "utf8").then(
      (text) => {
        const choice = ChoiceSchema.parse(JSON.parse(text))
        this.#sharing = choice.sharing
        this.#inStep = choice.inStep
      },
      () => undefined,
    )
  }

  /** On unless the person turned it off. */
  get #shares(): boolean {
    return this.#sharing ?? true
  }

  start(): void {
    void this.#loaded.then(() => {
      if (!this.#shares) return
      void this.check()
      this.#schedule()
    })
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /**
   * The machine woke. While it slept the cloud may have refreshed a sign-in this Mac shares (for machines that ran),
   * or holds one that lapsed and refreshes it as this Mac reads (`returned` in the gateway). A harness whose token
   * lapsed meanwhile refreshes as soon as it can reach its provider, and on the pair this Mac still holds it would
   * present a token the cloud moved past. So this Mac first takes each shared harness's own refresh lock, as another
   * of its processes would, then checks now and closely after while the network comes back, writes the cloud's pair,
   * and lets go: a harness waiting on the lock reads the store again and runs on that pair.
   */
  wake(): void {
    const woke = performance.now()
    const taken = this.#taken
    const waking = (async () => {
      const release = await this.#holdRefreshes()
      try {
        await this.check()
        for (const wait of this.#wakeRetryMs) {
          if (this.#reached || !this.#shares) break
          await new Promise((resolve) => setTimeout(resolve, wait).unref())
          if (performance.now() - woke > this.#wakeHoldMs) release.now()
          await this.check()
        }
      } finally {
        release.now()
      }
      const fields = { ms: Math.round(performance.now() - woke), held: release.harnesses.join(",") || "none", took: this.#taken - taken }
      if (this.#reached) hostLog("cloud", "in step with Mako Cloud after waking", fields)
      else hostWarn("cloud", "Mako Cloud wasn't reached after waking; the minute's check goes on", fields)
    })()
    const settled = waking.catch(() => undefined).finally(() => {
      if (this.#waking === settled) this.#waking = undefined
    })
    this.#waking = settled
  }

  /**
   * Takes the refresh lock of every harness this Mac shares that refreshes under one, each held until `now()` or the
   * hold's limit. Resolves once each is held or found busy; the harnesses held are named for the log.
   */
  async #holdRefreshes(): Promise<{ harnesses: CloudSignInHarness[]; now(): void }> {
    await this.#loaded
    let letGo = () => {}
    const released = new Promise<void>((resolve) => {
      letGo = resolve
      // `wake` lets go between checks; this is only the bound should a check itself never end.
      setTimeout(resolve, this.#wakeHoldMs * 2).unref()
    })
    const harnesses: CloudSignInHarness[] = []
    if (this.#shares)
      await Promise.all(
        this.#capabilities.list().map(async (capability) => {
          const harness = CloudSignInHarnessSchema.safeParse(capability.provider)
          const hold = capability.cloudSignIn?.mirror?.hold?.bind(capability.cloudSignIn.mirror)
          if (!harness.success || !hold || !this.#inStep[harness.data]) return
          const env = (await this.#accounts.launch(harness.data, childProcessEnv(process.env), { trackCredential: false }).catch(() => undefined))?.env
          if (!env) return
          await new Promise<void>((held) => {
            const holding = async () => {
              try {
                await hold(env, async () => {
                  this.#held.add(harness.data)
                  harnesses.push(harness.data)
                  held()
                  await released
                  this.#held.delete(harness.data)
                }, WAKE_HOLD_WAIT_MS)
              } catch (error) {
                hostWarn("cloud", "a harness's refresh lock wasn't held after waking", { harness: harness.data, problem: problemOf(error) })
              } finally {
                held()
              }
            }
            void holding()
          })
        }),
      )
    return { harnesses, now: () => letGo() }
  }

  /**
   * Resolves once a harness may start on its sign-in: at once, or after a wake when the check has taken the cloud's
   * newest pair, waiting at most `LAUNCH_WAIT_MS`. A harness started on the pair before that would refresh it itself.
   */
  async inStep(): Promise<void> {
    const waking = this.#waking
    if (!waking) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([waking, new Promise((resolve) => { timer = setTimeout(resolve, LAUNCH_WAIT_MS) })])
    clearTimeout(timer)
  }

  /** The last check, or a new one when there's none or it's stale. */
  async state(): Promise<CloudSignInsState> {
    await this.#loaded
    const checkedAt = this.#state.checkedAt ? Date.parse(this.#state.checkedAt) : 0
    if (!this.#state.harnesses.length || (!this.#timer && Date.now() - checkedAt > FRESH_MS)) return this.check()
    return this.#state
  }

  /** The person's choice. Turning it off takes back from Mako Cloud every sign-in this Mac gave it. */
  async share(sharing: boolean): Promise<CloudSignInsState> {
    await this.#loaded
    this.#sharing = sharing
    await this.#save()
    hostLog("cloud", sharing ? "sharing sign-ins with Mako Cloud" : "no longer sharing sign-ins")
    if (sharing) this.#schedule()
    else {
      this.stop()
      if ((await this.#store.blocked()) === undefined) {
        const listed = await this.#store.list()
        for (const listing of listed.signIns) if (listing.mine) await this.#store.remove(listing.harness)
        for (const kept of listed.kept) if (kept.source === "shared" && kept.mine) await this.#store.disconnect(kept.harness)
      }
      this.#sent.clear()
      this.#inStep = {}
      await this.#save()
    }
    return this.check()
  }

  /**
   * Reads every harness now and sends what changed; one check at a time. A call during one gets the check after
   * it, which every call meanwhile shares, so what it's told was read after it asked.
   */
  check(): Promise<CloudSignInsState> {
    if (this.#checking)
      return (this.#next ??= this.#checking.then(
        () => undefined,
        () => undefined,
      ).then(() => {
        this.#next = undefined
        return this.check()
      }))
    this.#checking = this.#check().finally(() => {
      this.#checking = undefined
    })
    return this.#checking
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.check(), CHECK_MS)
    this.#timer.unref()
  }

  async #save(): Promise<void> {
    await mkdir(dirname(this.#choicePath), { recursive: true, mode: 0o700 })
    const choice: z.input<typeof ChoiceSchema> = { version: 2, inStep: this.#inStep }
    if (this.#sharing !== undefined) choice.sharing = this.#sharing
    await writeFile(`${this.#choicePath}.tmp`, JSON.stringify(choice), { mode: 0o600 })
    await rename(`${this.#choicePath}.tmp`, this.#choicePath)
  }

  async #check(): Promise<CloudSignInsState> {
    await this.#loaded
    const blocked = await this.#store.blocked().catch(() => "signed-out" as const)
    const send = this.#shares && !blocked
    const listed = blocked ? undefined : await this.#listed()
    this.#reached = blocked !== undefined || listed !== undefined
    // What this Mac sent before it last started, so a harness signed out meanwhile is removed there too.
    const mine = new Set<CloudSignInHarness>(send && !this.#sent.size ? (listed?.signIns ?? []).filter((listing) => listing.mine).map((listing) => listing.harness) : [])
    const kept = new Map((listed?.kept ?? []).map((signIn) => [signIn.harness, signIn]))
    const inStepBefore = JSON.stringify(this.#inStep)
    this.#behind = false
    const harnesses = await Promise.all(
      this.#capabilities.list().flatMap((capability) => {
        const harness = CloudSignInHarnessSchema.safeParse(capability.provider)
        const adapter = capability.cloudSignIn
        if (!harness.success || !adapter) return []
        const read = adapter.mirror && adapter.chain
          ? this.#mirror(harness.data, { chain: adapter.chain.bind(adapter), mirror: adapter.mirror }, send, kept.get(harness.data), mine.has(harness.data))
          : this.#sync(harness.data, send, mine.has(harness.data))
        return [read]
      }),
    )
    if (JSON.stringify(this.#inStep) !== inStepBefore)
      try {
        await this.#save()
      } catch (error) {
        hostWarn("cloud", "the sign-ins' state wasn't saved", { problem: problemOf(error) })
      }
    if (this.#behind && this.#hurried < HURRY_TRIES) {
      this.#hurried += 1
      setTimeout(() => void this.check(), HURRY_MS).unref()
    } else if (!this.#behind) this.#hurried = 0
    const state: CloudSignInsState = { sharing: this.#shares, checkedAt: new Date().toISOString(), harnesses }
    if (blocked) state.blocked = blocked
    this.#state = state
    this.#onChange(this.#state)
    return this.#state
  }

  /** What the cloud holds; a read that fails leaves the rows without it rather than failing them. */
  async #listed(): Promise<Awaited<ReturnType<CloudSignInStore["list"]>> | undefined> {
    try {
      return await this.#store.list()
    } catch (error) {
      hostWarn("cloud", "Mako Cloud's sign-ins weren't read", { problem: problemOf(error) })
      return undefined
    }
  }

  /**
   * One rotating sign-in, kept the same here and in the cloud. Which side moved is read from the fingerprint both
   * last had (`inStep`): the cloud refreshed (written here), the harness refreshed or signed in again here (sent
   * up; the cloud says if it's behind), a refresh the harness made on a token the cloud had moved past cleared it
   * here (written back), or the person signed out here (taken back from the cloud).
   */
  async #mirror(
    harness: CloudSignInHarness,
    adapter: { chain: NonNullable<CloudSignInCapability["chain"]>; mirror: CloudSignInMirror },
    send: boolean,
    kept: CloudKeptSignIn | undefined,
    sentBefore: boolean,
  ): Promise<CloudSignInRow> {
    try {
      const launch = await this.#accounts.launch(harness, childProcessEnv(process.env), { trackCredential: false })
      const env = launch.env
      // A read that fails (a locked keychain, a file mid-write) is a problem to show, never a sign-out to pass on.
      const local = await adapter.chain(env)
      const held = local ? adapter.mirror.token(local.payload) : null
      const here = held ? chainFingerprint(held) : null
      const label = local?.label ?? (await this.#email(harness, launch.account.name))
      const row = (shown: CloudKeptSignIn | undefined, status: CloudSignInRow["status"] = here ? "sent" : "signed-out"): CloudSignInRow => {
        const result: CloudSignInRow = { harness, status, label: shown?.label ?? label, expiresAt: shown?.expiresAt ?? null, rotates: true }
        if (shown) result.kept = shown
        const step = this.#inStep[harness]
        if (step && shown?.token === step.token) result.inStepAt = step.at
        return result
      }
      if (!send) return row(kept?.source === "shared" && kept.mine ? kept : undefined, here ? "waiting" : "signed-out")
      // What an earlier build sent of it, access alone, goes: the cloud now has the whole of it.
      if (sentBefore || this.#sent.has(harness)) {
        await this.#store.remove(harness)
        this.#sent.delete(harness)
      }
      const ours = kept?.source === "shared" && kept.mine ? kept : undefined
      // Before the cloud may move a sign-in, this Mac proves it can follow, once a run: it writes back what the store
      // holds. A store that refuses isn't shared, or is taken back from the cloud, and goes as access alone; its
      // harness keeps refreshing it, so the cloud never moves a pair this Mac can't write.
      const refused = this.#unwritable.get(harness)
      if (local && here && !this.#writable.has(harness) && !(kept?.source === "shared" && !kept.mine && kept.state !== "needs-reconnect")) {
        if (!refused || Date.now() - refused.at >= UNWRITABLE_RETRY_MS) {
          try {
            if (!(await adapter.mirror.write(env, local, here, this.#held.has(harness)))) return row(ours)
            this.#writable.add(harness)
            this.#unwritable.delete(harness)
          } catch (error) {
            const problem = problemOf(error)
            if (refused?.problem !== problem) hostWarn("cloud", "a harness's sign-in can't be written on this Mac, so Mako Cloud doesn't refresh it", { harness, problem })
            this.#unwritable.set(harness, { problem, at: Date.now() })
          }
        }
        const stillRefused = this.#unwritable.get(harness)
        if (stillRefused) {
          if (ours) {
            await this.#store.disconnect(harness)
            delete this.#inStep[harness]
          }
          const sent = await this.#sync(harness, send, sentBefore)
          return { ...sent, rotates: true, status: "failed", problem: `Mako can't update this sign-in on this Mac (${stillRefused.problem}), so Mako Cloud doesn't refresh it; it's sent as it is` }
        }
      }
      if (!ours) {
        // Another Mac's, still working: cloud Threads run on it, and this Mac's own stays this Mac's.
        if (kept?.source === "shared" && !kept.mine && kept.state !== "needs-reconnect") return row(kept, "waiting")
        if (!local || !here) return row(undefined)
        return row(await this.#send(harness, adapter, env, local, here))
      }
      const cloud = ours.token ?? null
      if (here && here === cloud) {
        this.#agree(harness, here)
        return row(ours)
      }
      const step = this.#inStep[harness]
      if (!here) {
        if (step?.token === cloud || ours.state === "needs-reconnect") {
          // In step, and gone here: the person signed out on this Mac, and the cloud's copy goes with it.
          if (step?.token === cloud) {
            await this.#store.disconnect(harness)
            delete this.#inStep[harness]
            hostLog("cloud", "signed out on this Mac; Mako Cloud no longer keeps the sign-in", { harness, token: cloud })
            return row(undefined)
          }
          return row(ours, "signed-out")
        }
        // Behind, and cleared: the harness refreshed on a token the cloud had moved past. The cloud's goes back.
        const restored = await this.#take(harness, adapter, env, null, "restored a sign-in a stale refresh had cleared")
        return restored ? row(restored, "sent") : row(ours, "signed-out")
      }
      // Unchanged here since both last agreed: the cloud refreshed, and this Mac takes its pair.
      if (step?.token === here) return row(await this.#take(harness, adapter, env, here, "took Mako Cloud's refresh") ?? ours)
      // Changed here: the harness refreshed or signed in again. The cloud takes it, or says it's behind.
      return row(await this.#send(harness, adapter, env, local!, here))
    } catch (error) {
      const problem = problemOf(error)
      hostWarn("cloud", "a sign-in wasn't kept in step with Mako Cloud", { harness, problem })
      // Behind the cloud and unwritten, the harness holds a pair the cloud moved past: try again in seconds.
      if (kept?.source === "shared" && kept.mine && this.#inStep[harness]?.token !== kept.token) this.#behind = true
      const failed: CloudSignInRow = { harness, status: "failed", label: null, expiresAt: kept?.expiresAt ?? null, problem, rotates: true }
      if (kept) failed.kept = kept
      return failed
    }
  }

  /** Sends this Mac's sign-in; one the cloud has moved past is replaced here by the cloud's. */
  async #send(
    harness: CloudSignInHarness,
    adapter: { mirror: CloudSignInMirror },
    env: NodeJS.ProcessEnv,
    local: CloudSignInChain,
    here: string,
  ): Promise<CloudKeptSignIn | undefined> {
    const shared = await this.#store.share(harness, local)
    hostLog("cloud", "shared a sign-in with Mako Cloud", { harness, outcome: shared.outcome, token: here, cloud: shared.signIn.token ?? null })
    if (shared.outcome !== "stale") {
      this.#agree(harness, shared.signIn.token ?? here)
      return shared.signIn
    }
    return (await this.#take(harness, adapter, env, here, "took Mako Cloud's newer sign-in")) ?? shared.signIn
  }

  /** Writes the cloud's pair into the harness's store, if the store still holds `expected`. */
  async #take(
    harness: CloudSignInHarness,
    adapter: { mirror: CloudSignInMirror },
    env: NodeJS.ProcessEnv,
    expected: string | null,
    why: string,
  ): Promise<CloudKeptSignIn | undefined> {
    const pulled = await this.#store.pull(harness)
    if (!pulled) return undefined
    const written = await adapter.mirror.write(env, { label: pulled.label, payload: pulled.payload }, expected, this.#held.has(harness))
    if (!written) {
      hostLog("cloud", "the harness's sign-in moved while Mako wrote it; read again next check", { harness, from: expected, to: pulled.token })
      return undefined
    }
    this.#taken += 1
    this.#agree(harness, pulled.token)
    const listed = (await this.#listed())?.kept.find((signIn) => signIn.harness === harness)
    // Why the cloud refreshed it, and since when it held it for this Mac: what tells a sleep's catch-up apart.
    hostLog("cloud", why, { harness, from: expected, to: pulled.token, because: listed?.refreshedBecause ?? null, waitedFrom: listed?.waitedFrom ?? null, held: this.#held.has(harness) })
    return listed
  }

  #agree(harness: CloudSignInHarness, token: string): void {
    if (this.#inStep[harness]?.token === token) return
    this.#inStep[harness] = { token, at: new Date().toISOString() }
  }

  async #sync(harness: CloudSignInHarness, send: boolean, sentBefore: boolean): Promise<CloudSignInRow> {
    const capability = this.#capabilities.get(harness)
    const adapter = capability?.cloudSignIn
    if (!capability || !adapter) return { harness, status: "failed", label: null, expiresAt: null, problem: "This harness can't share its sign-in" }
    try {
      const read = async () => {
        const launch = await this.#accounts.launch(harness, childProcessEnv(process.env), { trackCredential: false })
        return { name: launch.account.name, exported: await adapter.export(launch.env) }
      }
      // A read that fails (a locked keychain, a file mid-write) is a problem to show, never a sign-out to pass on.
      let { name, exported } = await read()
      const lapses = exported?.expiresAt ? Date.parse(exported.expiresAt) : Infinity
      if (send && lapses - Date.now() < RENEW_BEFORE_MS && Date.now() - (this.#renewedAt.get(harness) ?? 0) > RENEW_GAP_MS) {
        this.#renewedAt.set(harness, Date.now())
        hostLog("cloud", "asking a harness to refresh its sign-in before sharing it", { harness })
        await capability.accountUsage(name).catch(() => undefined)
        ;({ name, exported } = await read())
      }
      if (!exported) {
        if (send && (this.#sent.has(harness) || sentBefore)) {
          await this.#store.remove(harness)
          this.#sent.delete(harness)
        }
        return { harness, status: "signed-out", label: null, expiresAt: null }
      }
      const label = exported.label ?? (await this.#email(harness, name))
      const signIn = CloudSignInSchema.parse({ harness, ...exported, label })
      const row: CloudSignInRow = { harness, status: send ? "sent" : "waiting", label, expiresAt: signIn.expiresAt }
      if (!send) return row
      const fingerprint = credentialFingerprint([JSON.stringify(signIn)])
      let sent = this.#sent.get(harness)
      if (sent?.fingerprint !== fingerprint) {
        await this.#store.put(signIn)
        sent = { fingerprint, at: new Date().toISOString() }
        this.#sent.set(harness, sent)
        hostLog("cloud", "shared a sign-in", { harness, lapses: signIn.expiresAt ?? "never" })
      }
      return { ...row, sentAt: sent.at }
    } catch (error) {
      const problem = problemOf(error)
      hostWarn("cloud", "a sign-in wasn't shared", { harness, problem })
      return { harness, status: "failed", label: null, expiresAt: null, problem }
    }
  }

  async #email(harness: string, name: string): Promise<string | null> {
    return (await this.#accounts.principal(harness, name)) ?? null
  }
}
