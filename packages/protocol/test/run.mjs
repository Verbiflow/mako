import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { runGatewayConformance } from "../dist/conformance.js"
import { createFakeGateway } from "../dist/fake-gateway.js"
import {
  GatewayFrameSchema,
  OperationSchema,
  PROTOCOL_VERSION,
  ReplySchema,
  RuntimeFrameSchema,
  mayRetry,
  negotiate,
  nextStep,
  problem,
} from "../dist/index.js"

const operation = {
  v: PROTOCOL_VERSION,
  id: "6f1c2a8e-4b1d-4c3a-9f0e-2d7b5a9c1e34",
  op: "thread.send",
  threadId: "th-1",
  input: { text: "hi" },
  correlationId: "c-1",
  actor: { kind: "client", client: "web", deviceId: "browser-1" },
  attempt: 1,
}

describe("versions", () => {
  test("both sides settle on the newest version they share", () => {
    assert.equal(negotiate({ min: 1, max: 3 }, { min: 2, max: 5 }), 3)
    assert.equal(negotiate({ min: 1, max: 1 }, { min: 1, max: 1 }), 1)
  })
  test("ranges that don't overlap have no version", () => {
    assert.equal(negotiate({ min: 1, max: 2 }, { min: 3, max: 4 }), null)
  })
})

describe("cursor", () => {
  test("the next number applies, a repeat is dropped, and a jump asks to resume", () => {
    assert.deepEqual(nextStep(4, { seq: 5 }), { kind: "apply" })
    assert.deepEqual(nextStep(4, { seq: 4 }), { kind: "duplicate" })
    assert.deepEqual(nextStep(4, { seq: 2 }), { kind: "duplicate" })
    assert.deepEqual(nextStep(4, { seq: 7 }), { kind: "gap", after: 4 })
  })
})

describe("retries", () => {
  const unavailable = (outcome) =>
    problem("owner-unavailable", "gone", "c-1", outcome)
  test("anything but a passing outage is final", () => {
    for (const replay of ["read", "replay", "never"])
      assert.equal(
        mayRetry(replay, problem("conflict", "no", "c-1", "not-applied")),
        false
      )
  })
  test("reads and settled operations retry through an outage, whatever happened", () => {
    for (const replay of ["read", "replay"])
      assert.equal(mayRetry(replay, unavailable("unknown")), true)
  })
  test("an operation only the person can judge retries only if it never ran", () => {
    assert.equal(mayRetry("never", unavailable("not-applied")), true)
    assert.equal(mayRetry("never", unavailable("unknown")), false)
  })
})

describe("schemas", () => {
  test("an operation takes no fields it doesn't define", () => {
    assert.equal(OperationSchema.safeParse(operation).success, true)
    assert.equal(
      OperationSchema.safeParse({ ...operation, extra: 1 }).success,
      false
    )
  })
  test("operation names are lowercase words joined by dots", () => {
    for (const op of ["Thread.send", "thread..send", "thread_send", ".send"])
      assert.equal(
        OperationSchema.safeParse({ ...operation, op }).success,
        false,
        op
      )
  })
  test("a problem names a known type and whether it ran", () => {
    const reply = {
      v: PROTOCOL_VERSION,
      id: operation.id,
      ok: false,
      problem: problem("fenced", "moved", "c-1", "not-applied", {
        generation: 3,
      }),
    }
    assert.equal(ReplySchema.safeParse(reply).success, true)
    assert.equal(
      ReplySchema.safeParse({
        ...reply,
        problem: { ...reply.problem, type: "urn:mako:problem:nope" },
      }).success,
      false
    )
    assert.equal(
      ReplySchema.safeParse({
        ...reply,
        problem: { ...reply.problem, outcome: undefined },
      }).success,
      false
    )
  })
  test("frames reject unknown types and wrong directions", () => {
    assert.equal(
      RuntimeFrameSchema.safeParse({ type: "heartbeat" }).success,
      true
    )
    assert.equal(
      RuntimeFrameSchema.safeParse({
        type: "ack",
        threadId: "th-1",
        generation: 1,
        localSeq: 1,
        seq: 1,
      }).success,
      false
    )
    assert.equal(
      GatewayFrameSchema.safeParse({ type: "heartbeat" }).success,
      false
    )
  })
})

describe("the fake gateway passes the conformance suite", () => {
  runGatewayConformance(async () => createFakeGateway(), test)
})
