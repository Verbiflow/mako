import { createContext, useContext } from "react"
import { z } from "zod"
import { AccountList } from "./account-list"
import { reportAttention } from "./attention"
import type { WebConversations } from "./conversations"
import { ARCHIVE_PLANS, Gateway, type WebAccount, type WebConnection } from "./gateway"
import { WebPush } from "./push"
import { RETURNED_EVENT, watchReturns, type Returned, type ReturnKind } from "./resume"

/** What the page that hosts the client gives it: where the gateway is, and this browser's sign-in. */
export interface WebClientOptions {
  /** The gateway's origin: the page's own. */
  origin: string
  /** The path the app is served under, ending in `/`: `/` for an app at the root of its own host. */
  base: string
  /** A connection token for this browser's sign-in; rejects with `SignedOutError` once it ended. */
  connect(): Promise<WebConnection>
  /** Ends this browser's sign-in, everywhere at once. */
  signOut(): Promise<void>
  /** Where a person signs in, coming back to `next`. */
  signInUrl(next: string): string
  /** The build serving the page, for Diagnostics. */
  build?: string
  /**
   * Called once, after the app's first screen has painted with the account's Threads and the screens it reads next (a
   * Thread, New) have arrived: the moment for the page's own work that can wait, such as installing its service worker.
   */
  painted?(): void
}

/** One signed-in browser: its gateway, the account's list it follows, its conversations and its notifications. */
export class WebClient {
  readonly options: WebClientOptions
  readonly gateway: Gateway
  readonly account: WebAccount
  readonly deviceId: string
  readonly list: AccountList
  #conversations: Promise<WebConversations> | undefined
  /** The conversations once read: what a return wakes, and what hiding lets go of. */
  #loaded: WebConversations | undefined
  readonly push: WebPush
  readonly #stops: Array<() => void> = []

  private constructor(options: WebClientOptions, gateway: Gateway, who: Who) {
    this.options = options
    this.gateway = gateway
    this.account = who.account
    this.deviceId = who.deviceId
    this.list = new AccountList(gateway, who.account.id)
    this.push = new WebPush(gateway)
  }

  /**
   * Signs in with the page's sign-in (`SignedOutError` without one), follows the list, and says when the person is here.
   * A browser that was signed in before paints at once, as who it was and from the list it last saw, while its sign-in
   * is checked; signed in as someone else since, it starts again as them.
   */
  static async start(options: WebClientOptions): Promise<WebClient> {
    const gateway = new Gateway({ origin: options.origin, connect: options.connect })
    const connecting = gateway.connection()
    const remembered = rememberedWho()
    const who = remembered ?? whoOf(await connecting)
    const client = new WebClient(options, gateway, who)
    void connecting.then(
      (connection) => {
        remember(whoOf(connection))
        if (connection.account.id !== who.account.id || connection.deviceId !== who.deviceId) location.reload()
      },
      // Signed out: the list finds it too, and the app goes to sign-in. Unreachable: the list follows again.
      () => undefined
    )
    client.list.start()
    client.#stops.push(reportAttention(gateway))
    client.#stops.push(
      watchReturns({
        // Whatever the list heard since it was last kept is kept as the page goes or is put away (a phone's app switcher
        // hides a page without ending it), for the next visit to paint; transcripts off screen are let go, so iOS is
        // less likely to end the page to free memory and bring it back black.
        hidden: () => {
          client.list.save()
          client.#loaded?.releaseHidden()
        },
        returned: (kind, away) => client.#returned(kind, away),
      })
    )
    void client.push.renew().catch((error) => console.warn("[mako] this browser's notifications weren't renewed", error))
    // An archive this browser left under way (the page closed mid-way) is settled, so its Thread isn't left fenced. Its
    // code is read only when there's a plan of one to read.
    if (Object.keys(localStorage).some((key) => key.startsWith(ARCHIVE_PLANS)))
      void import("./archive").then(({ settleArchives }) => settleArchives(gateway, who.deviceId)).catch((error) => console.warn("[mako] an archive left under way wasn't settled", error))
    return client
  }

  /**
   * The browser's conversations, each answered by its owner through the gateway and drawn by the renderer's live state:
   * read once a Thread is first opened, so the list paints without them. Installed as the renderer's bridge, which its
   * live state and transcript call as they call a Mac's host.
   */
  conversations(): Promise<WebConversations> {
    this.#conversations ??= import("./conversations").then(({ WebConversations }) => {
      const conversations = new WebConversations({ gateway: this.gateway, deviceId: this.deviceId, row: (conversation) => this.list.byConversation(conversation) })
      window.mako = conversations.bridge
      this.#loaded = conversations
      return conversations
    })
    return this.#conversations
  }

  /**
   * Back in front. Every socket is asked whether it's alive, and one that stays silent for three seconds (or was already
   * quiet past its heartbeat, as a frozen page's is) is ended and opened again, while the list's next follow starts
   * now rather than after its backoff. Away ten seconds or more, what's shown is stale: the list and the open
   * conversation are read again over HTTP at once, which answers even while a dead socket is being replaced.
   */
  #returned(kind: ReturnKind, away: number): void {
    this.gateway.wake()
    this.list.wake()
    this.#loaded?.wake()
    if (kind === "long") {
      void this.list.refresh().catch(() => undefined)
      this.#loaded?.resync()
    }
    window.dispatchEvent(new CustomEvent<Returned>(RETURNED_EVENT, { detail: { kind, away } }))
  }

  /** Ends this browser's sign-in everywhere, and forgets what it kept to paint the next visit. */
  async signOut(): Promise<void> {
    forgetWho()
    this.list.forget()
    this.stop()
    await this.options.signOut()
  }

  stop(): void {
    for (const stop of this.#stops.splice(0)) stop()
    this.list.stop()
    this.gateway.close()
  }
}

/** Who this browser was signed in as when it last connected: enough to paint before its sign-in is checked. */
type Who = { account: WebAccount; deviceId: string }
const WHO_KEY = "mako:web:who"

/** Who this browser was, as it kept it: read back only whole, since it paints before anything checks it. */
const WhoSchema = z.object({
  account: z.object({ id: z.string().min(1), name: z.string(), email: z.string(), image: z.string().nullable(), entitlements: z.array(z.string()) }),
  deviceId: z.string().min(1),
}) satisfies z.ZodType<Who>

function whoOf(connection: WebConnection): Who {
  return { account: connection.account, deviceId: connection.deviceId }
}

function rememberedWho(): Who | undefined {
  try {
    const text = localStorage.getItem(WHO_KEY)
    return text ? WhoSchema.safeParse(JSON.parse(text)).data : undefined
  } catch {
    return undefined
  }
}

function remember(who: Who): void {
  try {
    localStorage.setItem(WHO_KEY, JSON.stringify(who))
  } catch {
    // Not kept: the next visit waits for its sign-in to be checked before it paints.
  }
}

/** Forgets who this browser was, as it signs out. */
export function forgetWho(): void {
  localStorage.removeItem(WHO_KEY)
}

export const WebClientContext = createContext<WebClient | null>(null)

export function useWebClient(): WebClient {
  const client = useContext(WebClientContext)
  if (!client) throw new Error("The web client isn't started")
  return client
}
