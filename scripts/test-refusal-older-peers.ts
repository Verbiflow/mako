import assert from "node:assert/strict"
import { PROVIDER_FAILURE_KINDS } from "@mako/host/contracts/provider-failure"
import { olderReadable } from "@mako/host/contracts/provider-failure-evidence"
import { z } from "zod"
import { exactFailures, requestsAfter, sessionAfter } from "@mako/host/contracts/live-conversations"
import type { RuntimeEvent } from "@mako/host/contracts/runtime-value"
import { gatewayCompactLine, gatewayEventLine } from "@mako/host/transport/gateway"

/**
 * A refused turn as another device reads it (`npm run test:live-prompt-delivery`): a build from before `model-refusal`
 * threw on a request of that kind (`acp-live.ts`'s `failureDetail` reads `.title` off `describeProviderFailure`, which
 * returns nothing for a kind it doesn't list), so what leaves this host through the gateway carries the kind every build
 * reads, with the exact one beside it, and a reader of this build takes the exact one back. This host's own windows,
 * its own build, read it as it is.
 */
const olderKinds: readonly string[] = PROVIDER_FAILURE_KINDS.filter((kind) => kind !== "model-refusal")
const refusal = { kind: "model-refusal", source: "native-error" } as const
const request = { id: "r1", text: "Do the thing", status: "failed", createdAt: 1, failure: "model-refusal", failureEvidence: refusal, error: "The model declined the request" }
const batch = { id: "c1", revision: 3, updates: [], requestChanges: [request], sessionChanges: { failureEvidence: refusal } }
// A batch's event as the host encodes it once for every reader: its windows read this text as it is.
const encoded: RuntimeEvent = {
  type: "live-batch",
  conversation: "c1",
  payload: JSON.stringify({ type: "live-batch", batch }),
  compact: JSON.stringify({ type: "live-batch", batch: { ...batch, form: 2 } }),
}

// What leaves through the gateway: no kind an older build doesn't list, as a whole line, a compact one and an answer.
const line = gatewayEventLine("event", encoded)
assert.ok(line.fit === "whole")
const compact = gatewayCompactLine(encoded)
assert.ok(compact !== undefined)
const answer = olderReadable(JSON.stringify({ revision: 3, requests: [request], session: { status: "ready", failureEvidence: refusal } }))
for (const [what, text] of [["the whole line", line.text], ["the compact line", compact], ["a call's answer", answer]] as const) {
  const kinds = [...text.matchAll(/"failure":"([^"]+)"/g)].map((match) => match[1]!)
  assert.ok(kinds.length > 0, what)
  assert.ok(kinds.every((kind) => olderKinds.includes(kind)), `${what} names only kinds an older build lists: ${kinds.join(", ")}`)
  const evidenceKinds = [...text.matchAll(/"failureEvidence":\{"kind":"([^"]+)"/g)].map((match) => match[1]!)
  assert.ok(evidenceKinds.length > 0 && evidenceKinds.every((kind) => olderKinds.includes(kind)), `${what}'s evidence leads with a kind an older build lists`)
  assert.ok(text.includes('"exactFailure":"model-refusal"'), `${what} keeps the exact kind beside it`)
}

// A reader of this build takes the exact kind back, from a whole list, a change and a session alike.
// What a reader takes from the wire, as the host's own types: only the fields this test reads are checked.
type HeardRequest = NonNullable<Parameters<typeof requestsAfter>[0]>[number]
const HeardRequests = z.array(z.custom<HeardRequest>(() => true))
const Sent = z.object({ requests: HeardRequests, session: z.custom<Parameters<typeof sessionAfter>[0]>(() => true) })
const sent = Sent.parse(JSON.parse(answer))
const heard = requestsAfter(undefined, { requests: sent.requests })!
assert.equal(heard[0]!.failure, "model-refusal")
assert.deepEqual(heard[0]!.failureEvidence, refusal)
const Changed = z.object({ batch: z.object({ requestChanges: HeardRequests, sessionChanges: z.custom<Partial<Parameters<typeof sessionAfter>[0]>>(() => true) }) })
const changed = Changed.parse(JSON.parse(compact)).batch
assert.equal(requestsAfter([], { requestChanges: changed.requestChanges })![0]!.failure, "model-refusal")
assert.deepEqual(sessionAfter(sent.session, { sessionChanges: changed.sessionChanges }).failureEvidence, refusal)
assert.deepEqual(sessionAfter(sent.session, { session: sent.session }).failureEvidence, refusal)

// Nothing else changes: text without the kind is the same string, and a request without it the same object.
const plain = JSON.stringify({ requests: [{ ...request, failure: "network", failureEvidence: { kind: "network", source: "host" } }] })
assert.equal(olderReadable(plain), plain)
const ordinary = { ...request, failure: "network" as const, failureEvidence: undefined }
assert.equal(exactFailures(ordinary), ordinary)
// Prose that mentions the kind is left as written.
const prose = JSON.stringify({ text: 'the "model-refusal" kind' })
assert.equal(olderReadable(prose), prose)

console.log("older peers: a refused turn leaves through the gateway as unknown with the exact kind beside it, which this build reads back; windows and other values unchanged")
