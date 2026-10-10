import type { AuthMethod } from "@agentclientprotocol/sdk"
import { heavy } from "./heavy-packages.js"

interface AuthenticationFlow<Value> {
  open(): Promise<Value>
  authenticate(methodId: string): Promise<void>
  select(methods: AuthMethod[]): Promise<string | null>
  methods: AuthMethod[]
  signal: AbortSignal
}

export async function openAuthenticatedSession<Value>(
  flow: AuthenticationFlow<Value>
): Promise<Value> {
  flow.signal.throwIfAborted()
  try {
    const session = await untilStopped(flow.open(), flow.signal)
    flow.signal.throwIfAborted()
    return session
  } catch (error) {
    const { RequestError } = await heavy.acpSdk.load("ACP sign-in")
    if (
      !(error instanceof RequestError) ||
      error.code !== RequestError.authRequired().code
    )
      throw error
    flow.signal.throwIfAborted()
    const methods = flow.methods.filter((method) => !("type" in method))
    if (!methods.length)
      throw new Error(
        "This provider requires authentication, but did not advertise a supported sign-in method.",
        { cause: error }
      )
    const selected = await untilStopped(flow.select(methods), flow.signal)
    if (!selected)
      throw new Error("Provider sign-in was cancelled.", { cause: error })
    if (!methods.some((method) => method.id === selected))
      throw new Error(
        "The selected provider sign-in method is no longer available.",
        { cause: error }
      )
    flow.signal.throwIfAborted()
    await untilStopped(flow.authenticate(selected), flow.signal)
    flow.signal.throwIfAborted()
    const session = await untilStopped(flow.open(), flow.signal)
    flow.signal.throwIfAborted()
    return session
  }
}

function untilStopped<Value>(
  work: Promise<Value>,
  signal: AbortSignal
): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Provider startup was cancelled."))
    signal.addEventListener("abort", abort, { once: true })
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}
