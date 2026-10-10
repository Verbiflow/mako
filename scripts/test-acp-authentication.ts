import assert from "node:assert/strict"
import { RequestError, type AuthMethod } from "@agentclientprotocol/sdk"
import { openAuthenticatedSession } from "@mako/host/harnesses/acp-authentication"

const methods: AuthMethod[] = [
  { id: "provider-browser", name: "Log in with browser" },
]
const controller = new AbortController()
const calls: string[] = []
let opens = 0
const flow = {
  methods,
  signal: controller.signal,
  open: async () => {
    calls.push("open")
    if (++opens === 1) throw RequestError.authRequired()
    return "session"
  },
  select: async () => {
    calls.push("consent")
    return methods[0]!.id
  },
  authenticate: async (id: string) => {
    calls.push(`authenticate:${id}`)
  },
}
assert.equal(await openAuthenticatedSession(flow), "session")
assert.deepEqual(calls, [
  "open",
  "consent",
  "authenticate:provider-browser",
  "open",
])
calls.length = 0
assert.equal(await openAuthenticatedSession(flow), "session")
assert.deepEqual(
  calls,
  ["open"],
  "An already authenticated provider must not launch another login"
)
const denied = RequestError.authRequired()
const unauthenticated = {
  ...flow,
  open: async () => {
    throw denied
  },
}
await assert.rejects(
  openAuthenticatedSession({ ...unauthenticated, select: async () => null }),
  /cancelled/
)
await assert.rejects(
  openAuthenticatedSession({
    ...unauthenticated,
    select: async () => "not-advertised",
  }),
  /no longer available/
)
await assert.rejects(
  openAuthenticatedSession({
    ...unauthenticated,
    methods: [{ id: "terminal-login", name: "Terminal", type: "terminal" }],
  }),
  /supported sign-in/
)
const refusal = new Error("Invalid model")
await assert.rejects(
  openAuthenticatedSession({
    ...flow,
    open: async () => {
      throw refusal
    },
  }),
  (error) => error === refusal
)
opens = 0
await assert.rejects(
  openAuthenticatedSession({
    ...unauthenticated,
    open: async () => {
      opens++
      throw denied
    },
  }),
  (error) => error === denied
)
assert.equal(
  opens,
  2,
  "Authentication-required responses cannot cause an endless retry loop"
)
const authenticationError = new Error("Provider denied sign-in")
await assert.rejects(openAuthenticatedSession({ ...unauthenticated, authenticate: async () => { throw authenticationError } }), (error) => error === authenticationError)
const selecting = new AbortController()
const selection = Promise.withResolvers<string | null>()
const choosing = openAuthenticatedSession({ ...unauthenticated, signal: selecting.signal, select: () => selection.promise })
await new Promise<void>((resolve) => setImmediate(resolve))
selecting.abort()
await assert.rejects(choosing, /cancelled/)
selection.resolve("provider-browser")
const stopped = new AbortController()
const gate = Promise.withResolvers<void>()
const waiting = openAuthenticatedSession({
  ...unauthenticated,
  signal: stopped.signal,
  authenticate: () => gate.promise,
})
await new Promise<void>((resolve) => setImmediate(resolve))
stopped.abort()
await assert.rejects(waiting, /cancelled/)
gate.resolve()
console.log(
  "ACP authentication: explicit consent, advertised agent methods, same-connection retry, no login on success, no arbitrary-error retries, refusal and cancellation verified"
)
