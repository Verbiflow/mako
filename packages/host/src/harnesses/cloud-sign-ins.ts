import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { childProcessEnv } from "../base/child-environment.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import {
  CLOUD_SIGN_IN_HARNESSES,
  CloudSignInHarnessSchema,
  CloudSignInSchema,
  type CloudSignIn,
  type CloudSignInHarness,
  type CloudSignInInstall,
  type CloudSignInListing,
  type CloudSignInRow,
  type CloudSignInsState,
} from "../contracts/cloud-sign-ins.js"
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
        (error: unknown): CloudSignInInstall => ({ harness: harness.data, status: "failed", at: at(), reason: problemOf(error) }),
      ),
    ]
  })
  return [...(await Promise.all(installed)), ...(await Promise.all(removed)).filter((install) => install !== undefined)]
}

/** A failure in words that can be logged and shown: a parse error quotes what it couldn't parse, which may be a token. */
function problemOf(error: unknown): string {
  if (error instanceof SyntaxError) return "The harness's sign-in isn't in a shape Mako reads"
  return error instanceof Error ? error.message : String(error)
}

/** Where this Mac's sign-ins go: the account's store in Mako Cloud, through this Mac's device sign-in. */
export interface CloudSignInStore {
  /** Why nothing can be sent now, or undefined when it can. */
  blocked(): Promise<CloudSignInsState["blocked"]>
  list(): Promise<CloudSignInListing[]>
  put(signIn: CloudSignIn): Promise<void>
  remove(harness: CloudSignInHarness): Promise<void>
}

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
  readonly #choicePath: string
  readonly #onChange: (state: CloudSignInsState) => void
  #sharing = false
  #state: CloudSignInsState = { sharing: false, harnesses: [] }
  readonly #sent = new Map<CloudSignInHarness, Sent>()
  readonly #renewedAt = new Map<CloudSignInHarness, number>()
  #timer: NodeJS.Timeout | undefined
  #checking: Promise<CloudSignInsState> | undefined
  #again = false
  #loaded: Promise<void>

  constructor(options: {
    accounts: HarnessAccounts
    capabilities: ProviderRegistry<ProviderAccountCapability>
    store: CloudSignInStore
    /** Where the person's choice is kept. */
    dataRoot: string
    onChange: (state: CloudSignInsState) => void
  }) {
    this.#accounts = options.accounts
    this.#capabilities = options.capabilities
    this.#store = options.store
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

  async state(): Promise<CloudSignInsState> {
    await this.#loaded
    if (!this.#state.harnesses.length) return this.check()
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
        for (const listing of await this.#store.list()) if (listing.mine) await this.#store.remove(listing.harness)
      this.#sent.clear()
    }
    return this.check()
  }

  /** Reads every harness now and sends what changed; one check at a time, and a call during one runs another after it. */
  check(): Promise<CloudSignInsState> {
    if (this.#checking) {
      this.#again = true
      return this.#checking
    }
    this.#checking = this.#check().finally(() => {
      this.#checking = undefined
      if (this.#again) {
        this.#again = false
        void this.check()
      }
    })
    return this.#checking
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.check(), CHECK_MS)
    this.#timer.unref()
  }

  async #check(): Promise<CloudSignInsState> {
    await this.#loaded
    const blocked = this.#sharing ? await this.#store.blocked().catch(() => "signed-out" as const) : undefined
    const send = this.#sharing && !blocked
    // What this Mac sent before it last started, so a harness signed out meanwhile is removed there too.
    const mine = new Set<CloudSignInHarness>(send && !this.#sent.size ? (await this.#store.list().catch(() => [])).filter((listing) => listing.mine).map((listing) => listing.harness) : [])
    const harnesses = await Promise.all(
      CLOUD_SIGN_IN_HARNESSES.filter((harness) => this.#capabilities.get(harness)?.cloudSignIn).map((harness) =>
        this.#sync(harness, send, mine.has(harness)),
      ),
    )
    this.#state = { sharing: this.#sharing, ...(blocked ? { blocked } : {}), checkedAt: new Date().toISOString(), harnesses }
    this.#onChange(this.#state)
    return this.#state
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
