import { execFile } from "node:child_process"
import { hostname } from "node:os"
import { promisify } from "node:util"
import type { ClientSessionOverSockets } from "@mako/protocol"
import { cloudUrl, runtimeBuild } from "../base/build-identity.js"
import { CloudAccounts, cloudLegacyFiles, cloudSignInName, type CloudThreadMaking } from "./cloud-account.js"
import type { AccountEvent } from "@mako/protocol/account-events"
import type { SessionListings } from "@mako/protocol/thread-listing"
import type { WaitingInput, WaitingMessage } from "@mako/protocol/waiting"
import type { SessionPublishing } from "./machine-runtime.js"
import type { MoveAnswer, MoveCheckpoint, MoveHandOverRequest, MoveHandOverState, ReturnDeparture, ReturnState } from "@mako/protocol/moves"
import type { RecordsLink } from "@mako/sessions/record-sync"
import type { CloudRepository } from "../contracts/cloud-threads.js"
import type { CloudKeptSignIn, CloudShareOutcome, CloudSharedChain, CloudSignIn, CloudSignInChain, CloudSignInHarness, CloudSignInListing, CloudSignInsState } from "../contracts/cloud-sign-ins.js"
import type { DiagnosticEvents } from "../contracts/telemetry.js"
import type { HostEnvironment } from "../base/host-environment.js"
import { hostLog } from "../base/host-log.js"
import type { DomainSecrets } from "../base/host-secrets.js"
import type { HostEvent } from "../contracts/host-events-boot.js"
import type { MethodTable } from "../base/methods.js"
import { type GatewayHostOptions, type HostMethods, serveHostThroughGateway } from "../transport/index.js"
import { presentMachine, type MachineCapability } from "../base/machine.js"
import { onMac, systemName, systemVersion } from "../base/platform.js"

/** The Mako account this host is signed in to, for the services that act as it. */
export interface CloudAccount {
  /** A connection token while this Mac is signed in to Mako. */
  token(): Promise<string | undefined>
  /** The cloud's address this Mac reaches, such as `https://api.example.com`; undefined in a build without one. */
  gateway(): URL | undefined
  /** The signed-in Mako account's ID, or undefined while signed out. */
  id(): Promise<string | undefined>
  /**
   * Calls through the cloud as this Mac, to a Thread, another device's runtime or the account, for
   * `gatewayHostCalls`; throws in a build without a cloud. Signing out closes it.
   */
  session(): ClientSessionOverSockets
  /** This Mac's device in the account, which its calls act for; undefined while signed out. */
  deviceId(): Promise<string | undefined>
  /** Why this Mac can't use the cloud now: signed out, or an account without it; undefined when it can. */
  cloudBlocked?(): Promise<"signed-out" | "no-cloud" | undefined>
  /**
   * A cloud Thread in the account, its machine working in a clone of `repository`; the same Thread when made again
   * under its ID. `prepare`: made ahead of its first message, as its person writes it; `ready` once its machine is.
   * `harness`: the one its first message is for, whose start its machine runs ahead as it boots.
   */
  createThread(threadId: string, repository: CloudRepository, options?: CloudThreadMaking): Promise<{ ready: boolean; ended?: true }>
  /** Project bases for these repositories, made in the background ahead of their first cloud Thread. */
  askBases(repositories: CloudRepository[]): Promise<void>
  /** A move's checkpoint, sent to the cloud Thread once (`CloudAccounts.sendCheckpoint`). */
  sendCheckpoint(threadId: string, checkpoint: MoveCheckpoint, file: string): Promise<{ sent: boolean }>
  /**
   * A move this Mac released, handed to the cloud to carry through once it sent what only it has: the cloud arrives
   * it, claims it (or refuses it), and starts it (`CloudAccounts.handOverMove`).
   */
  handOverMove(threadId: string, move: string, request: MoveHandOverRequest): Promise<MoveHandOverState>
  /** The cloud's promise never to take a move, or its claim if that came first. */
  refuseMove(threadId: string, move: string, reason: string): Promise<MoveAnswer>
  /** What the cloud answered a move; undefined while it hasn't, after holding the ask open up to `waitMs`. */
  moveAnswer(threadId: string, move: string, waitMs?: number): Promise<MoveAnswer | undefined>
  /** Where a cloud Thread's session records are kept, as this Mac's device reaches them. */
  threadRecords(threadId: string): Promise<RecordsLink>
  /** Where a device's session records are kept in the account (`CloudAccounts.deviceRecords`): this Mac's own, or another's to read. */
  deviceRecords(deviceId: string): Promise<RecordsLink>
  /** A checkpoint kept beside a cloud Thread's records, read whole into `file`. */
  readCheckpoint(threadId: string, sha256: string, file: string): Promise<void>
  /** A cloud Thread's return to this Mac, step by step (`CloudAccounts.beginReturn` and the rest). */
  beginReturn(threadId: string, move: string): Promise<ReturnState>
  releaseReturn(threadId: string, move: string, departure: ReturnDeparture): Promise<ReturnState>
  cancelReturn(threadId: string, move: string, reason: string): Promise<ReturnState>
  giveBackReturn(threadId: string, move: string, reason: string): Promise<ReturnState>
  finishReturn(threadId: string, move: string): Promise<ReturnState>
  returnState(threadId: string, move: string): Promise<ReturnState | undefined>
  /** The account's Sessions as every device lists them (`GET /v1/sessions`), and the account stream's number then. */
  sessionListings?(): Promise<SessionListings>
  /** Tells the account's list what changed of this host's Sessions (`SessionPublisher`); called on a tick. */
  reportSessions?(): void
  /**
   * A message for a Session whose owner is off, kept by the account until its owner takes it (`waiting.ts`), under its
   * request ID: sent again, it's the same message. The Session's messages waiting, as they stand after it.
   */
  waitMessage?(session: string, id: string, input: WaitingInput): Promise<WaitingMessage[]>
  /** A waiting message's words changed, only while they're still `expectedText` and it's still waiting. */
  editWaiting?(session: string, id: string, expectedText: string, text: string): Promise<WaitingMessage[]>
  /** A waiting message taken back before its owner took it. */
  unwaitMessage?(session: string, id: string): Promise<WaitingMessage[]>
  /** Its owner took it: it's a request of the Session now, under the same ID. */
  tookWaiting?(session: string, id: string): Promise<void>
  /** The account's devices, by ID and name, and which is this one. */
  devices?(): Promise<{ devices: Array<{ id: string; name: string }>; current: string }>
  /**
   * Hears each change to the account's list of Sessions, in the stream's order, as it comes, and `account-changed` when
   * this Mac signs in, out or to another account, after which the list is another's; returns how to stop.
   */
  onThreadListings?(listener: (heard: ThreadListHeard | "account-changed") => void): () => void
  /** After the machine slept or the host was paused: the sign-in may have lapsed meanwhile. */
  wake(): void
  stop(): void
}

/** A change to the account's list of Sessions, as its stream said it. */
export type ThreadListHeard = { seq: number; event: Extract<AccountEvent, { type: "sessions-listed" | "sessions-unlisted" | "messages-waiting" }> }

/** The account's store of shared sign-ins in Mako Cloud, through this Mac's device sign-in. */
export interface HarnessSignInStore {
  /** Why nothing can be sent now, or undefined when it can. */
  blocked(): Promise<CloudSignInsState["blocked"]>
  list(): Promise<{ signIns: CloudSignInListing[]; kept: CloudKeptSignIn[] }>
  put(signIn: CloudSignIn): Promise<void>
  remove(harness: CloudSignInHarness): Promise<void>
  share(harness: CloudSignInHarness, chain: CloudSignInChain): Promise<CloudShareOutcome>
  pull(harness: CloudSignInHarness): Promise<CloudSharedChain | null>
  refresh(harness: CloudSignInHarness): Promise<CloudSharedChain | null>
  disconnect(harness: CloudSignInHarness): Promise<void>
}

/** Keeps the account's store holding this Mac's harness sign-ins, once the person has said to share them. */
export interface HarnessSignInSharing {
  start(): void
  stop(): void
  check(): Promise<CloudSignInsState>
  state(): Promise<CloudSignInsState>
  share(sharing: boolean): Promise<CloudSignInsState>
  /** The machine woke: take what the cloud refreshed meanwhile, before anything runs on the old. */
  wake(): void
}

/**
 * The Mako account, against the cloud `cloudUrl` names; a build without one says so and offers nothing.
 * A fixture desk signs in only to a cloud on this Mac, and is given secrets kept in memory, so its profile isn't written.
 */
export function declareCloudAccountMethods(methods: MethodTable & Pick<HostMethods, "invoke">, {
  environment,
  secrets,
  machine,
  emit,
  fixture,
  signedIn,
  request,
  harnessSignIns,
  sessions,
}: {
  environment: Pick<HostEnvironment, "dataRoot" | "version" | "build">
  secrets: DomainSecrets
  machine: MachineCapability
  emit: (event: HostEvent) => void
  fixture: boolean
  signedIn?: () => void
  request?: (call: DiagnosticEvents["cloud.request"]) => void
  /** Shares this Mac's harness sign-ins with the account's cloud machines; a fixture desk shares none. */
  harnessSignIns?: (options: { dataRoot: string; store: HarnessSignInStore; onChange: (signIns: CloudSignInsState) => void }) => HarnessSignInSharing
  /** What tells the account's list of this Mac's Sessions over its runtime's link (`SessionPublisher`). */
  sessions?: SessionPublishing
}): CloudAccount {
  let status: string | undefined
  /** What the sign-ins depend on in the account: who it is and whether it has the cloud. */
  let standing: string | undefined
  let described: Promise<{ name: string; platform: string; appVersion: string }> | undefined
  const { dataRoot } = environment
  secrets.adoptLegacy(cloudLegacyFiles(dataRoot))
  // The sign-ins reach the account through `cloud`, made next, and read nothing until they start below it.
  const sync = harnessSignIns?.({
    dataRoot,
    store: {
      blocked: () => cloud.signInsBlocked(),
      list: () => cloud.signIns(),
      put: (signIn) => cloud.saveSignIn(signIn),
      remove: (harness) => cloud.removeSignIn(harness),
      share: (harness, chain) => cloud.shareSignIn(harness, chain),
      pull: (harness) => cloud.pullSignIn(harness),
      refresh: (harness) => cloud.refreshSignIn(harness),
      disconnect: (harness) => cloud.disconnectSignIn(harness),
    },
    onChange: (signIns) => emit({ type: "cloud-sign-ins", signIns }),
  })
  const threadListeners = new Set<(heard: ThreadListHeard | "account-changed") => void>()
  const cloud = new CloudAccounts({
    url: cloudUrl(environment),
    secrets: secrets.secrets,
    secretName: cloudSignInName(dataRoot),
    // A host with no screen (a server, or one started for a check) has no browser to open: the sign-in page waits in
    // the account's state, which says where it is, for whoever opens it.
    openExternal: async (url) => {
      if (machine.kind === "absent") return hostLog("cloud", "no browser here; the sign-in page waits in the account's state", { reason: machine.reason })
      await presentMachine(machine).openUrl(url)
    },
    device: () => (described ??= describeThisMac(environment.version)),
    fixture,
    onChange: (account) => {
      if (status === "signing-in" && account.state.status === "signed-in") signedIn?.()
      status = account.state.status
      emit({ type: "cloud-account", account })
      // A grant, a revoke, a sign-in or a sign-out changes what the sign-ins may do; read them again then,
      // or Settings keeps saying "no cloud" after the grant until something else asks.
      const next = account.state.status === "signed-in" ? `${account.state.account.id}:${account.state.account.entitlements.join(",")}` : account.state.status
      if (standing !== undefined && next !== standing) {
        void sync?.check()
        for (const listener of threadListeners) listener("account-changed")
      }
      standing = next
    },
    log: (message, fields) => hostLog("cloud", message, fields),
    // Every window hears of the account's devices, so one that joined is said wherever this Mac is looked at. A change
    // to the account's Threads goes to what lists them, which tells windows of the conversations it changes.
    onAccountEvent: (heard) => {
      const { event } = heard
      if (event.type === "sessions-listed" || event.type === "sessions-unlisted" || event.type === "messages-waiting") {
        for (const listener of threadListeners) listener({ seq: heard.seq, event })
        return
      }
      hostLog("cloud", "account event", { seq: heard.seq, type: event.type, mine: heard.mine })
      emit({ type: "cloud-account-event", seq: heard.seq, at: heard.at, event, mine: heard.mine })
    },
    onRequest: request,
    sessions,
    // With the cloud entitlement, this Mac answers its account's other devices and the cloud through the same
    // dispatcher as its own windows: the same schemas, the same refusals, the same logs.
    runtime: {
      serve: (link, { runtimeId, credential, threads, watch }) => {
        const options: GatewayHostOptions = {
          runtimeId,
          build: runtimeBuild(environment),
          credential,
          threads,
          invoke: (channel, args, client, history, correlationId) => methods.invoke(channel, args, client, history, correlationId),
        }
        if (watch) options.watch = watch
        return serveHostThroughGateway(link, options)
      },
    },
  })

  methods.handle("mako:cloud-account", () => cloud.ready())
  methods.handle("mako:cloud-sign-in", () => cloud.signIn())
  methods.handle("mako:cloud-sign-in-cancel", () => cloud.cancelSignIn())
  methods.handle("mako:cloud-devices", () => cloud.devices())
  methods.handle("mako:cloud-device-remove", (id: string) => cloud.removeDevice(id))
  methods.handle("mako:cloud-browser-sessions", () => cloud.browserSessions())
  methods.handle("mako:cloud-browser-session-end", (id: string) => cloud.endBrowserSession(id))
  methods.handle("mako:cloud-browser-sessions-end", () => cloud.endBrowserSessions())
  methods.handle("mako:cloud-sign-out", () => cloud.signOut())

  sync?.start()
  const unsharable = () => Promise.reject(new Error("This Mac can't share sign-ins with Mako Cloud."))
  methods.handle("mako:cloud-sign-ins", () => sync?.state() ?? unsharable())
  methods.handle("mako:cloud-sign-ins-share", (sharing: boolean) => sync?.share(sharing) ?? unsharable())
  return {
    token: () => cloud.optionalConnectionToken(),
    gateway: () => cloud.gateway(),
    id: async () => {
      const { state } = await cloud.ready()
      return state.status === "signed-in" ? state.account.id : undefined
    },
    session: () => cloud.session(),
    deviceId: () => cloud.deviceId(),
    cloudBlocked: () => cloud.signInsBlocked(),
    createThread: (threadId, repository, options) => cloud.createThread(threadId, repository, options),
    askBases: (repositories) => cloud.askBases(repositories),
    sendCheckpoint: (threadId, checkpoint, file) => cloud.sendCheckpoint(threadId, checkpoint, file),
    handOverMove: (threadId, move, request) => cloud.handOverMove(threadId, move, request),
    refuseMove: (threadId, move, reason) => cloud.refuseMove(threadId, move, reason),
    moveAnswer: (threadId, move, waitMs) => cloud.moveAnswer(threadId, move, waitMs),
    threadRecords: (threadId) => cloud.threadRecords(threadId),
    deviceRecords: (deviceId) => cloud.deviceRecords(deviceId),
    readCheckpoint: (threadId, sha256, file) => cloud.readCheckpoint(threadId, sha256, file),
    beginReturn: (threadId, move) => cloud.beginReturn(threadId, move),
    releaseReturn: (threadId, move, departure) => cloud.releaseReturn(threadId, move, departure),
    cancelReturn: (threadId, move, reason) => cloud.cancelReturn(threadId, move, reason),
    giveBackReturn: (threadId, move, reason) => cloud.giveBackReturn(threadId, move, reason),
    finishReturn: (threadId, move) => cloud.finishReturn(threadId, move),
    returnState: (threadId, move) => cloud.returnState(threadId, move),
    sessionListings: () => cloud.sessionListings(),
    waitMessage: (session, id, input) => cloud.waitMessage(session, id, input),
    editWaiting: (session, id, expectedText, text) => cloud.editWaiting(session, id, expectedText, text),
    unwaitMessage: (session, id) => cloud.unwaitMessage(session, id),
    tookWaiting: (session, id) => cloud.tookWaiting(session, id),
    reportSessions: () => cloud.reportSessions(),
    devices: () => cloud.devices(),
    onThreadListings: (listener) => {
      threadListeners.add(listener)
      return () => threadListeners.delete(listener)
    },
    wake: () => {
      cloud.wake()
      sync?.wake()
    },
    stop: () => {
      sync?.stop()
      cloud.close()
    },
  }
}

/** The name people gave this Mac in System Settings, as the account's device list shows it. */
async function describeThisMac(appVersion: string) {
  const fallback = hostname().replace(/\.local$/, "")
  const name =
    onMac()
      ? await promisify(execFile)("/usr/sbin/scutil", ["--get", "ComputerName"], { timeout: 2_000 }).then(
          ({ stdout }) => stdout.trim() || fallback,
          () => fallback
        )
      : fallback
  return { name, platform: `${systemName()} ${systemVersion()}`.trim(), appVersion }
}
