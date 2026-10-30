import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { toast } from "sonner"
import { z } from "zod"
import type { LiveAction, LiveActionInput, LiveSnapshot } from "@/lib/types"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

/**
 * A steer is a send like any other (`steerTo`): kept in the outbox under the composer's request ID, which its action
 * takes, so a page that dies mid-steer neither puts the words back nor sends them twice; and a steer with no turn left
 * to steer goes as the next message under the same ID instead of coming back unexplained. The second half runs as a
 * reloaded page, in a process of its own, on the storage the first left.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/test-steer-outbox.ts
 */
const reloaded = process.argv[2] === "--reload"
const directory = reloaded ? process.argv[3]! : mkdtempSync(join(tmpdir(), "mako-steer-outbox-"))
const storage = join(directory, "storage.json")
const kept = (): Record<string, string> => {
  try {
    return z.record(z.string(), z.string()).parse(JSON.parse(readFileSync(storage, "utf8")))
  } catch {
    return {}
  }
}
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    get length() {
      return Object.keys(kept()).length
    },
    key: (index: number) => Object.keys(kept())[index] ?? null,
    getItem: (key: string) => kept()[key] ?? null,
    setItem: (key: string, value: string) => writeFileSync(storage, JSON.stringify({ ...kept(), [key]: value })),
    removeItem: (key: string) => {
      const { [key]: _gone, ...rest } = kept()
      writeFileSync(storage, JSON.stringify(rest))
    },
  },
})
Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true })
const { installMockBridge } = await import("../src/dev/mock-bridge")
const { getMako } = await import("../src/lib/bridge")
const { acpStore } = await import("../src/state/acp-state")
const { applyLiveSnapshot } = await import("../src/state/live-recovery")
const { restorePendingMessages, steerTo } = await import("../src/state/acp-queue")
const { pendingMessages } = await import("../src/state/message-outbox")
const { noteSending, openingText } = await import("../src/web-client/drafts")
const { outboxHolds } = await import("../src/web-client/outbox")
installMockBridge()
const errors = mock.method(toast, "error", () => "fixture")
const bridge = getMako()
// The host's paged read isn't offered here: snapshots come whole.
mock.method(bridge, "liveRead", async () => {
  throw new Error("Unknown Mako host method")
})

const conversation = auditId(900)
const turn = auditId(901)
const draftKey = `session:${conversation}`

let revision = 10
/** The conversation with its turn running, or idle; and the steer the host holds under `steered`, if any. */
function snapshot(running: boolean, steered?: { id: string; state: LiveAction["state"] }): LiveSnapshot {
  const base = auditSnapshot(1, "codex")
  base.session.id = conversation
  base.session.status = running ? "running" : "ready"
  base.revision = ++revision
  base.requests = [{ id: turn, text: "a long turn", attachments: [], status: running ? "dispatching" : "completed" }]
  if (steered)
    base.control = {
      activeBindingId: auditId(902),
      bindings: [],
      merges: [],
      transfers: [],
      actions: [{ input: { kind: "steer", id: steered.id, requestId: turn, text: "steer words", attachments: [] }, digest: "fixture", bindingId: auditId(902), createdAt: 1, state: steered.state }],
    }
  return base
}

/** What the host was asked under each ID: a steer (`liveAction`) or a message (`livePrompt`). */
const asked: Array<{ how: "steer" | "prompt"; id: string }> = []
mock.method(bridge, "livePrompt", async (_id: string, requestId: string) => {
  asked.push({ how: "prompt", id: requestId })
})

if (!reloaded) {
  try {
    // 1. A steer is held in the outbox under the composer's ID while it's on its way, and let go once it landed.
    applyLiveSnapshot(snapshot(true))
    const first = crypto.randomUUID()
    let heldWhileAsked = false
    const steering = mock.method(bridge, "liveAction", async (_id: string, input: LiveActionInput) => {
      heldWhileAsked = pendingMessages().some((command) => command.kind === "steer" && command.requestId === first)
      asked.push({ how: "steer", id: input.id })
      return { input, digest: "fixture", bindingId: auditId(902), createdAt: 1, state: { kind: "accepted" } } satisfies LiveAction
    })
    assert.equal(await steerTo(conversation, "steer words", [], first), true)
    assert.ok(heldWhileAsked, "the outbox holds the steer while the host is asked")
    assert.deepEqual(asked, [{ how: "steer", id: first }], "the steer's action takes the composer's ID")
    assert.equal(outboxHolds(first), false, "and lets it go once the turn took it")

    // 2. The turn ended between the tap and now: the words go as the next message, under the same ID, with nothing to explain.
    asked.length = 0
    applyLiveSnapshot(snapshot(false))
    const ended = crypto.randomUUID()
    assert.equal(await steerTo(conversation, "too late to steer", [], ended), true)
    assert.deepEqual(asked, [{ how: "prompt", id: ended }])

    // 3. The host refused the steer before the harness heard it (the turn was just ending): the same, under the same ID.
    asked.length = 0
    applyLiveSnapshot(snapshot(true))
    steering.mock.mockImplementation(async (_id: string, input: LiveActionInput) => {
      asked.push({ how: "steer", id: input.id })
      return { input, digest: "fixture", bindingId: auditId(902), createdAt: 1, state: { kind: "not-accepted", reason: "The turn ended" } } satisfies LiveAction
    })
    const refused = crypto.randomUUID()
    assert.equal(await steerTo(conversation, "refused steer", [], refused), true)
    assert.deepEqual(asked, [{ how: "steer", id: refused }, { how: "prompt", id: refused }])
    assert.equal(errors.mock.callCount(), 0, "nothing unexplained comes back, and nothing needs saying")

    // 4. The page dies while the steer is on its way: the outbox and the draft both still hold it.
    applyLiveSnapshot(snapshot(true))
    steering.mock.mockImplementation(() => new Promise<never>(() => {}))
    const dying = crypto.randomUUID()
    noteSending(draftKey, dying, "steer words")
    void steerTo(conversation, "steer words", [], dying)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(outboxHolds(dying), true)
    for (const landed of [true, false]) {
      const result = spawnSync(process.execPath, [createRequire(import.meta.url).resolve("tsx/cli"), "--tsconfig", "tsconfig.app.json", fileURLToPath(import.meta.url), "--reload", directory, dying, String(landed)], { encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr || result.stdout)
    }
    console.log("Steer outbox: a steer is kept under the composer's ID until it lands; one with no turn left goes as the next message under that ID; a page that dies mid-steer neither restores its words nor sends them twice")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
} else {
  // The reloaded page: the steer it left is in the outbox, so its words don't come back into the field.
  const id = process.argv[4]!
  const landed = process.argv[5] === "true"
  const before = kept()
  try {
    assert.equal(openingText(draftKey, outboxHolds), "", "a steer the outbox still holds doesn't put its words back")
    const reading = mock.method(bridge, "liveSnapshot", async () =>
      landed ? snapshot(true, { id, state: { kind: "accepted" } }) : snapshot(false)
    )
    mock.method(bridge, "liveAction", async () => assert.fail("a steer isn't asked twice"))
    acpStore.set({ activeKey: conversation })
    await restorePendingMessages()
    assert.ok(reading.mock.callCount() > 0)
    if (landed) {
      assert.deepEqual(asked, [], "a steer that landed is only let go")
      assert.equal(outboxHolds(id), false)
    } else assert.deepEqual(asked, [{ how: "prompt", id }], "one the host never heard, with no turn left, goes as the next message under its ID")
  } finally {
    // Each reload starts from what the dying page left.
    writeFileSync(storage, JSON.stringify(before))
  }
}
