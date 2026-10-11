import { withHostClient, hostHistoryPaging } from "../base/host-client.js"
import { hostCallInput, hostChannels, isHostChannel, type HostArguments, type HostChannel } from "../contracts/host-call-inputs.js"
import type { MethodTable } from "../base/methods.js"
import { FixtureDeskRefusedError, fixtureDeskRefusal } from "../contracts/fixture-desk-policy.js"
import { CLIENT_CALL_ON_SOCKET, isClientCall } from "../contracts/client-calls.js"
import { HostCallLifetime } from "./call-lifetime.js"
import { ControlPreviewSchema, type ControlPreview } from "@mako/control-runtime/contracts"

/** Whether another host answered a call, and its answer. */
export type RoutedCall = { handled: false } | { handled: true; value: unknown }

/** Where each domain declares the methods it answers. */
export interface HostMethodsOptions {
  /**
   * A fixture desk refuses every call outside the fixture allowlist, from
   * every client, before its arguments are parsed.
   */
  fixtureDesk: boolean
  /** A call about a conversation another host owns is answered there. */
  route(channel: HostChannel, args: unknown[]): Promise<RoutedCall>
  /** A history-paging client gets each reply's history as pages. */
  presentHistory<Result>(value: Result): Result
  /** Notes each call by its channel alone, for the trail a crash report carries. */
  breadcrumb(note: string): void
}

/** The host's method table: each domain declares its methods here, and the socket calls them. */
export class HostMethods implements MethodTable {
  /** Each call's reply, encoded as the socket sends it. */
  private readonly calls = new Map<HostChannel, (args: unknown[]) => Promise<string>>()
  private preview: ((args: unknown[]) => Promise<ControlPreview | null>) | undefined
  private readonly lifetime = new HostCallLifetime()
  private readonly options: HostMethodsOptions

  constructor(options: HostMethodsOptions) {
    this.options = options
  }

  handle<Channel extends HostChannel, Result>(channel: Channel, listener: (...args: HostArguments<Channel>) => Result): void {
    if (isClientCall(channel)) throw new Error(`${channel} is a client call; each client answers it itself`)
    if (this.calls.has(channel)) throw new Error(`${channel} is declared twice`)
    const call = (args: unknown[]) => this.lifetime.run(async () => {
      this.refuseOutsideFixture(channel)
      // SAFETY: the schema is selected by this exact Channel and parses every argument; TypeScript loses that key/output correlation when indexing the heterogeneous table.
      const parsed = hostCallInput(channel).parse(args) as HostArguments<Channel>
      // A refused call is returned to the renderer. Recording it as a crash
      // filled the local store with expected validation errors and hid the
      // failures that actually killed a process.
      this.options.breadcrumb(channel)
      const routed = await this.options.route(channel, parsed)
      const value = routed.handled ? routed.value : await listener(...parsed)
      return hostHistoryPaging() ? this.options.presentHistory(value) : value
    })
    this.calls.set(channel, async (args) => JSON.stringify({ ok: true, value: await call(args) }))
    if (channel === "mako:control-preview") this.preview = async (args) => ControlPreviewSchema.nullable().parse(await call(args))
  }

  /** Every reply is encoded here: the socket carries JSON to every client. */
  async invoke(channel: string, args: unknown[], client = "web", history = hostHistoryPaging(), correlationId?: string): Promise<string> {
    if (isClientCall(channel)) throw new Error(CLIENT_CALL_ON_SOCKET)
    this.refuseOutsideFixture(channel)
    if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching binary-capable client. Update the Mako client and host.")
    const call = isHostChannel(channel) ? this.calls.get(channel) : undefined
    if (!call) throw new Error("Unknown Mako host method")
    return withHostClient(client, () => call(args), history, correlationId)
  }

  /** The same validated handler and client authority, without serializing pixels. */
  async invokePreview(args: unknown[], client = "web"): Promise<ControlPreview | null> {
    this.refuseOutsideFixture("mako:control-preview")
    const call = this.preview
    if (!call) throw new Error("Preview delivery is unavailable")
    return withHostClient(client, () => call(args), false)
  }

  /** The contract's host methods no domain has declared; a composed host has none. */
  undeclared(): HostChannel[] {
    return hostChannels.filter((channel) => !isClientCall(channel) && !this.calls.has(channel))
  }

  /** Refuse new calls, then wait for those already running, while their stores are still open. */
  close(): Promise<void> {
    return this.lifetime.close()
  }

  private refuseOutsideFixture(channel: string): void {
    const refusal = this.options.fixtureDesk ? fixtureDeskRefusal(channel, "socket") : undefined
    if (refusal) throw new FixtureDeskRefusedError(refusal)
  }
}
