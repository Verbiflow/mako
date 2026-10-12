import { withHostClient, hostHistoryPaging } from "../base/host-client.js"
import { hostCallSchema, hostChannels, isHostChannel, type HostArguments, type HostCallInput, type HostChannel } from "../contracts/host-call-inputs.js"
import type { MethodTable } from "../base/methods.js"
import type { HostWork } from "../base/event-loop.js"
import { FixtureDeskRefusedError, fixtureDeskRefusal } from "../contracts/fixture-desk-policy.js"
import { CLIENT_CALL_ON_SOCKET, isClientCall } from "../contracts/client-calls.js"
import { EncodedAnswer, decodeRuntimeValue, encodeRuntimeValue, type EncodedValue } from "../contracts/runtime-value.js"
import { HostCallLifetime } from "./call-lifetime.js"
import { ControlPreviewSchema, type ControlPreview } from "@mako/control-runtime/contracts"

/** Whether another host answered a call, and its answer as that host encoded it. */
export type RoutedCall = { handled: false } | { handled: true; value: EncodedValue }

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
  /** Loads the domain that declares a method no domain has declared yet. */
  declaring(channel: HostChannel): Promise<void>
  /** Each call is work by its channel while it runs, so a call that holds the event loop is named. */
  work: HostWork
}

/** The host's method table: each domain declares its methods here, and the socket calls them. */
export class HostMethods implements MethodTable {
  /** Each call's value, encoded once for whichever transport carries it. */
  private readonly calls = new Map<HostChannel, (args: unknown[]) => Promise<EncodedValue>>()
  private preview: ((args: unknown[]) => Promise<ControlPreview | null>) | undefined
  private readonly lifetime = new HostCallLifetime()
  private readonly options: HostMethodsOptions

  constructor(options: HostMethodsOptions) {
    this.options = options
  }

  handle<Channel extends HostChannel, Result>(channel: Channel, listener: (...args: HostArguments<Channel>) => Result): void {
    if (isClientCall(channel)) throw new Error(`${channel} is a client call; each client answers it itself`)
    if (this.calls.has(channel)) throw new Error(`${channel} is declared twice`)
    // Built at the call's first use rather than when the host starts.
    let schema: HostCallInput<Channel> | undefined
    // Each answer is delivered inside the call's work, so the event-loop monitor names a slow encode with its call.
    const call = <Answer>(args: unknown[], local: (value: Awaited<Result>) => Answer, encoded: (value: EncodedValue) => Answer) => this.lifetime.run(async () => {
      const done = this.options.work.begin(channel)
      try {
        this.refuseOutsideFixture(channel)
        // SAFETY: the schema is selected by this exact Channel and parses every argument; TypeScript loses that key/output correlation when indexing the heterogeneous table.
        const parsed = (schema ??= hostCallSchema(channel)).parse(args) as HostArguments<Channel>
        // A refused call is returned to the renderer. Recording it as a crash
        // filled the local store with expected validation errors and hid the
        // failures that actually killed a process.
        this.options.breadcrumb(channel)
        // An answer already encoded, the owner's or another call's, had its history paged by whoever encoded it.
        const owner = await this.options.route(channel, parsed)
        if (owner.handled) return encoded(owner.value)
        const value = await listener(...parsed)
        if (value instanceof EncodedAnswer) return encoded(value.value)
        return local(hostHistoryPaging() ? this.options.presentHistory(value) : value)
      } finally {
        done()
      }
    })
    this.calls.set(channel, (args) => call(args, encodeRuntimeValue, (value) => value))
    if (channel === "mako:control-preview") {
      const preview = ControlPreviewSchema.nullable()
      this.preview = (args) => call(args, (value) => preview.parse(value), (value) => preview.parse(decodeRuntimeValue(value)))
    }
  }

  /** Every value is encoded here, once: the socket and the gateway carry the same text to the caller. */
  async invoke(channel: string, args: unknown[], client = "web", history = hostHistoryPaging(), correlationId?: string): Promise<EncodedValue> {
    if (isClientCall(channel)) throw new Error(CLIENT_CALL_ON_SOCKET)
    this.refuseOutsideFixture(channel)
    if (channel === "mako:control-preview") throw new Error("Preview delivery requires a matching binary-capable client. Update the Mako client and host.")
    if (!isHostChannel(channel)) throw new Error("Unknown Mako host method")
    const call = await this.declared(channel)
    return withHostClient(client, () => call(args), history, correlationId)
  }

  /** The same validated handler and client authority, without serializing pixels. */
  async invokePreview(args: unknown[], client = "web"): Promise<ControlPreview | null> {
    this.refuseOutsideFixture("mako:control-preview")
    if (!this.preview) await this.options.declaring("mako:control-preview")
    const call = this.preview
    if (!call) throw new Error("Preview delivery is unavailable")
    return withHostClient(client, () => call(args), false)
  }

  /** A method's handler, once the domain declaring it has loaded. */
  private async declared(channel: HostChannel): Promise<(args: unknown[]) => Promise<EncodedValue>> {
    const ready = this.calls.get(channel)
    if (ready) return ready
    await this.options.declaring(channel)
    const call = this.calls.get(channel)
    if (!call) throw new Error(`No domain declared ${channel} once it loaded`)
    return call
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
