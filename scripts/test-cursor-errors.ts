import assert from "node:assert/strict"
import { AuthenticationError, NetworkError, RateLimitError } from "@cursor/sdk"
import { crashSummary, cursorSdkWireError } from "../electron/providers/cursor/sdk/errors.ts"
import { CursorSdkError } from "../electron/providers/cursor/sdk/client.ts"
import { SdkWireErrorSchema } from "../electron/providers/cursor/sdk/wire.ts"

const secret = "Bearer fixture-secret https://private.invalid/account"
const refused = Object.assign(new Error(secret), { code: "ECONNREFUSED", address: secret })
const timeout = Object.assign(new Error(secret), { code: "UND_ERR_CONNECT_TIMEOUT" })
const invalid = Object.assign(new Error(secret), { code: secret })
const cause = new TypeError("fetch failed", { cause: new AggregateError([refused, timeout, refused, invalid], secret) })
const network = new NetworkError("Network request failed", { cause, endpoint: secret, requestId: secret, isRetryable: true })
const wire = SdkWireErrorSchema.parse(cursorSdkWireError(network))
assert.deepEqual(wire.networkCauses, ["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"])
assert.equal(wire.kind, "network")
assert.ok(!JSON.stringify(wire).includes(secret), "diagnostics cannot retain raw cause, endpoint, headers or request identity")
const restored = new CursorSdkError(wire)
assert.deepEqual(restored.networkCauses, wire.networkCauses, "host retains the child evidence")
const cycle: Error & { cause?: unknown } = new Error("cycle")
cycle.cause = cycle
assert.deepEqual(cursorSdkWireError(new NetworkError("Network request failed", { cause: cycle })).networkCauses, [])
assert.equal(cursorSdkWireError(new AuthenticationError("Sign in", { code: "unauthenticated" })).kind, "authentication")
assert.equal(cursorSdkWireError(new RateLimitError("Limit", { code: "resource_exhausted" })).kind, "rate-limit")
assert.equal(SdkWireErrorSchema.safeParse({ ...wire, networkCauses: [secret] }).success, false)
assert.deepEqual(SdkWireErrorSchema.parse({ kind: "network", message: "Older child" }).networkCauses, undefined)
const crash = Object.assign(new TypeError(secret), { code: "ERR_FIXTURE" })
crash.stack = `TypeError: ${secret}\n${Array.from({ length: 12 }, (_, frame) => `    at step${frame} (file:///Users/someone/Mako.app/Contents/Resources/app.asar/node_modules/@cursor/sdk/dist/esm/357.js:1:${frame})`).join("\n")}`
const summary = crashSummary(crash)
assert.ok(!summary.includes(secret) && !summary.includes("/Users/someone"), `a crash report names no message or home path: ${summary}`)
assert.ok(summary.startsWith("TypeError ERR_FIXTURE | step0 (node_modules/@cursor/sdk/dist/esm/357.js:1:0)"), summary)
assert.equal(summary.split(" | ").length, 9, "a crash report keeps the class and eight frames")
assert.equal(crashSummary(secret), "a thrown string")
console.log("Cursor network evidence: bounded nested/aggregate causes, secret omission, typed classification and old-child compatibility passed")
console.log("Cursor crash summary: class, code and bounded frames without message or home path passed")
