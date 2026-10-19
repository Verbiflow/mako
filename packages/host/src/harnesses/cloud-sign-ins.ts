import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { childProcessEnv } from "../base/child-environment.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import type { AccountLogin } from "../contracts/accounts.js"
import {
  CloudSignInHarnessSchema,
  CloudSignInSchema,
  type CloudKeptSignIn,
  type CloudSignIn,
  type CloudSignInChain,
  type CloudSignInHarness,
  type CloudSignInInstall,
  type CloudSignInListing,
  type CloudSignInRow,
  type CloudSignInsState,
} from "../contracts/cloud-sign-ins.js"
import type { HandOn } from "./account-login.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { HarnessAccounts } from "./accounts.js"
import { credentialFingerprint } from "./accounts-common.js"
import type { CloudSignInPlace } from "./cloud-sign-in.js"
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
  /** What devices shared, and the sign-ins the cloud keeps by itself. */
  list(): Promise<{ signIns: CloudSignInListing[]; kept: CloudKeptSignIn[] }>
  put(signIn: CloudSignIn): Promise<void>
  remove(harness: CloudSignInHarness): Promise<void>
  /** Hands the cloud a whole sign-in made for it, to keep and refresh by itself. */
  connect(harness: CloudSignInHarness, chain: CloudSignInChain): Promise<CloudKeptSignIn>
  disconnect(harness: CloudSignInHarness): Promise<void>
}

/** Runs a harness's own sign-in into a profile made for it, handing the profile on once it's proven. */
export type CloudLogin = (harness: CloudSignInHarness, handOn: HandOn) => Promise<AccountLogin>

const ChoiceSchema = z.object({ version: z.literal(1), sharing: z.boolean() })

type Sent = { fingerprint: string; at: string }

/**
 * Keeps Mako Cloud holding the sign-in each harness on this Mac runs under,
 * once the person has said to share them. Every minute it reads each
 * harness's store (no prompt, no network), has a harness whose sign-in is
 * about to lapse refresh it the way running it would, and sends what changed.
 * A harness signed out here is removed there. Values go from the store to
 * the cloud and nowhere else: Settings sees names, times and problems.
 */
export class CloudSignInSync {
  readonly #accounts: HarnessAccounts
  readonly #capabilities: ProviderRegistry<ProviderAccountCapability>
  readonly #store: CloudSignInStore
  readonly #login: CloudLogin
  readonly #choicePath: string
  readonly #onChange: (state: CloudSignInsState) => void
  #sharing = false
  #state: CloudSignInsState = { sharing: false, harnesses: [] }
  readonly #sent = new Map<CloudSignInHarness, Sent>()
  readonly #renewedAt = new Map<CloudSignInHarness, number>()
  #timer: NodeJS.Timeout | undefined
  #checking: Promise<CloudSignInsState> | undefined
  #next: Promise<CloudSignInsState> | undefined
  #loaded: Promise<void>

  constructor(options: {
    accounts: HarnessAccounts
    capabilities: ProviderRegistry<ProviderAccountCapability>
    store: CloudSignInStore
    login: CloudLogin
    /** Where the person's choice is kept. */
    dataRoot: string
    onChange: (state: CloudSignInsState) => void
  }) {
    this.#accounts = options.accounts
    this.#capabilities = options.capabilities
    this.#store = options.store
    this.#login = options.login
    this.#choicePath = join(options.dataRoot, "cloud", "sign-ins.json")
    this.#onChange = options.onChange
    this.#loaded = readFile(this.#choicePath, "utf8").then(
      (text) => {
        this.#sharing = ChoiceSchema.parse(JSON.parse(text)).sharing
      },
      () => undefined,
    )
  }

  start(): void {
    void this.#loaded.then(() => {
      if (!this.#sharing) return
      void this.check()
      this.#schedule()
    })
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /**
   * The last check, or a new one when there's none or it's stale. Without sharing nothing checks on a timer, yet the
   * cloud refreshes what it keeps on its own schedule; Settings asks again each minute it's open, and is read anew.
   */
  async state(): Promise<CloudSignInsState> {
    await this.#loaded
    const checkedAt = this.#state.checkedAt ? Date.parse(this.#state.checkedAt) : 0
    if (!this.#state.harnesses.length || (!this.#timer && Date.now() - checkedAt > FRESH_MS)) return this.check()
    return this.#state
  }

  /** The person's choice. Turning it off removes from Mako Cloud every sign-in this Mac sent. */
  async share(sharing: boolean): Promise<CloudSignInsState> {
    await this.#loaded
    this.#sharing = sharing
    await mkdir(dirname(this.#choicePath), { recursive: true, mode: 0o700 })
    await writeFile(`${this.#choicePath}.tmp`, JSON.stringify({ version: 1, sharing }), { mode: 0o600 })
    await rename(`${this.#choicePath}.tmp`, this.#choicePath)
    hostLog("cloud", sharing ? "sharing sign-ins with Mako Cloud" : "no longer sharing sign-ins")
    if (sharing) this.#schedule()
    else {
      this.stop()
      if ((await this.#store.blocked()) === undefined)
        for (const listing of (await this.#store.list()).signIns) if (listing.mine) await this.#store.remove(listing.harness)
      this.#sent.clear()
    }
    return this.check()
  }

  /**
   * Signs `harness` in once more, for Mako Cloud alone: its own login, in a profile this Mac never lists, handed
   * whole to the cloud and removed. From then the cloud refreshes it and machines run with it, whether or not
   * this Mac is awake or shares its own; this Mac's login stays as it was.
   */
  async connect(harness: CloudSignInHarness): Promise<AccountLogin> {
    const capability = this.#capabilities.get(harness)
    const chain = capability?.cloudSignIn?.chain?.bind(capability.cloudSignIn)
    if (!capability || !chain) throw new Error(`Mako Cloud can't keep ${capability?.label ?? harness}'s sign-in by itself. Share this Mac's instead.`)
    const blocked = await this.#store.blocked()
    if (blocked === "signed-out") throw new Error("Sign in to Mako first.")
    if (blocked === "no-cloud") throw new Error("Your account can't run Threads in Mako's cloud yet.")
    return this.#login(harness, async (env) => {
      const whole = await chain(env)
      if (!whole) throw new Error(`${capability.label} finished, but no sign-in was saved. Connect again.`)
      const kept = await this.#store.connect(harness, whole)
      hostLog("cloud", "Mako Cloud keeps a sign-in of its own", { harness, state: kept.state, lapses: kept.expiresAt ?? "never" })
      this.#keeps(harness, kept)
      void this.check()
      return whole.label ? { email: whole.label } : {}
    })
  }

  /** Mako Cloud forgets the sign-in it kept; machines go back to what this Mac shares, if it does. */
  async disconnect(harness: CloudSignInHarness): Promise<CloudSignInsState> {
    await this.#store.disconnect(harness)
    hostLog("cloud", "Mako Cloud no longer keeps a sign-in of its own", { harness })
    this.#keeps(harness, undefined)
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

  /** Shows what the cloud now keeps for `harness` at once; the next check reads every row again. */
  #keeps(harness: CloudSignInHarness, kept: CloudKeptSignIn | undefined): void {
    this.#state = {
      ...this.#state,
      harnesses: this.#state.harnesses.map((row) => {
        if (row.harness !== harness) return row
        const shown: CloudSignInRow = { ...row }
        if (kept) shown.kept = kept
        else delete shown.kept
        return shown
      }),
    }
    this.#onChange(this.#state)
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.check(), CHECK_MS)
    this.#timer.unref()
  }

  async #check(): Promise<CloudSignInsState> {
    await this.#loaded
    const blocked = await this.#store.blocked().catch(() => "signed-out" as const)
    const send = this.#sharing && !blocked
    const listed = blocked ? undefined : await this.#listed()
    // What this Mac sent before it last started, so a harness signed out meanwhile is removed there too.
    const mine = new Set<CloudSignInHarness>(send && !this.#sent.size ? (listed?.signIns ?? []).filter((listing) => listing.mine).map((listing) => listing.harness) : [])
    const kept = new Map((listed?.kept ?? []).map((signIn) => [signIn.harness, signIn]))
    const harnesses = await Promise.all(
      this.#capabilities.list().flatMap((capability) => {
        const harness = CloudSignInHarnessSchema.safeParse(capability.provider)
        if (!harness.success || !capability.cloudSignIn) return []
        const connectable = capability.cloudSignIn.chain !== undefined
        const ownSignIn = kept.get(harness.data)
        return [
          this.#sync(harness.data, send, mine.has(harness.data)).then((row) => {
            const shown: CloudSignInRow = { ...row }
            if (connectable) shown.connectable = true
            if (ownSignIn) shown.kept = ownSignIn
            return shown
          }),
        ]
      }),
    )
    const state: CloudSignInsState = { sharing: this.#sharing, checkedAt: new Date().toISOString(), harnesses }
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
