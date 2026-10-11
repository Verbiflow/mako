import type { HostArguments, HostChannel } from "../contracts/host-call-inputs.js"

/** Where a domain declares its methods: the host's method table, which the socket calls. */
export interface MethodTable {
  /** Every call validates its arguments against the generated contract before `listener` sees them. */
  handle<Channel extends HostChannel, Result>(channel: Channel, listener: (...args: HostArguments<Channel>) => Result): void
}
