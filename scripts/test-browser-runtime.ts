import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { BrowserToolsRuntime } from "../electron/browser-tools-runtime.js"
import {
  INLINE_IMAGE_COUNT,
  outlineOf,
  ControlProgramRuntime,
  type ControlProgramOutput,
} from "@mako/control/program"

const imageValue = z.object({ data: z.string(), mimeType: z.string() })
const textOf = (block: ControlProgramOutput | undefined) =>
  z.object({ type: z.literal("text"), text: z.string() }).parse(block).text

const artifacts = await mkdtemp(join(tmpdir(), "mako-control-artifacts-"))
process.env.MAKO_CONTROL_ARTIFACTS = artifacts
const calls: string[] = []
const first = new BrowserToolsRuntime(async (command) => {
  calls.push(command.action)
  return []
})
const second = new BrowserToolsRuntime(async () => [])
try {
  await first.run(
    "state.value='first'; return state.value",
    new AbortController().signal
  )
  const separate = await second.run(
    "return state.value ?? 'empty'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(separate), /empty/)
  const abort = new AbortController()
  const busy = first.run("while(true) {}", abort.signal)
  const failed = assert.rejects(busy, /cancelled/i)
  const queuedAbort = new AbortController()
  const queued = first.run("await browser.status()", queuedAbort.signal)
  const queuedFailed = assert.rejects(queued)
  queuedAbort.abort()
  setTimeout(() => abort.abort(), 100)
  await Promise.all([failed, queuedFailed])
  assert.deepEqual(calls, [])
  const reset = await first.run(
    "return state.value ?? 'reset'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(reset), /reset/)
  const next = await first.run(
    "await browser.status(); return 'next'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(next), /next/)
  assert.deepEqual(calls, ["status"])
  // A program's own error keeps the worker and its state: a refused action
  // once cost the next program its target as well as the step.
  await first.run("state.kept = 'yes'; return 1", new AbortController().signal)
  await assert.rejects(
    first.run("throw new Error('my own fault')", new AbortController().signal),
    /my own fault/
  )
  const kept = await first.run(
    "return state.kept ?? 'lost'",
    new AbortController().signal
  )
  assert.match(JSON.stringify(kept), /yes/)
  const late = new BrowserToolsRuntime(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return []
  })
  try {
    await assert.rejects(
      late.run(
        "browser.status(); return 'too early'",
        new AbortController().signal
      ),
      /unawaited/
    )
    const clean = await late.run(
      "return state.value ?? 'clean'",
      new AbortController().signal
    )
    assert.match(JSON.stringify(clean), /clean/)
    await late.run(
      "setTimeout(() => { try { browser.status() } catch {} }, 50); return 'done'",
      new AbortController().signal
    )
    const isolated = await late.run(
      "await new Promise(resolve => setTimeout(resolve, 100)); return 'isolated'",
      new AbortController().signal
    )
    assert.deepEqual(isolated, [{ type: "text", text: '"isolated"' }])
  } finally {
    await late.close()
  }

  const sharedCalls: unknown[] = []
  const shared = new ControlProgramRuntime({
    namespace: "computer",
    actions: ["observe", "click", "capture"],
    artifacts: join(artifacts, "computer"),
    call: async (command) => {
      sharedCalls.push(command)
      return command.action === "observe"
        ? { token: "snapshot:1" }
        : command.action === "capture"
          ? {
              data: Buffer.from("pixels").toString("base64"),
              mimeType: "image/png",
            }
          : { clicked: command.token }
    },
    image: (value) => {
      const image = imageValue.parse(value)
      return [{ type: "image", data: image.data, mimeType: image.mimeType }]
    },
    fault: (detail) => new Error(detail.message),
  })
  try {
    const output = await shared.run(
      "const seen = await computer.observe({pid: 42}); return computer.click({token: seen.token})",
      new AbortController().signal
    )
    assert.deepEqual(sharedCalls, [
      { action: "observe", pid: 42 },
      { action: "click", token: "snapshot:1" },
    ])
    assert.deepEqual(output, [
      { type: "text", text: '{"clicked":"snapshot:1"}' },
    ])

    // Output past the inline budget is written whole, in order, with a
    // receipt; console.log and the return value are treated alike.
    const spilled = await shared.run(
      "console.log('small'); console.log({rows: Array.from({length: 20000}, (_, i) => ({i, text: 'row ' + i}))}); return {done: true}",
      new AbortController().signal
    )
    assert.equal(spilled.length, 3)
    assert.deepEqual(spilled[0], { type: "text", text: '"small"' })
    const receipt = z
      .object({
        artifact: z.literal(true),
        path: z.string(),
        bytes: z.number(),
        sha256: z.string(),
        outline: z.object({
          type: z.string(),
          keys: z.array(
            z.object({ name: z.string(), type: z.string(), bytes: z.number() })
          ),
        }),
      })
      .parse(JSON.parse(textOf(spilled[1])))
    assert.equal(receipt.artifact, true)
    assert.ok(receipt.bytes > 200_000)
    assert.deepEqual(receipt.outline.keys, [
      { name: "rows", type: "array", bytes: receipt.bytes - 9 },
    ])
    const stored = z
      .object({ rows: z.array(z.json()) })
      .parse(JSON.parse(await readFile(receipt.path, "utf8")))
    assert.equal(stored.rows.length, 20_000)
    assert.deepEqual(spilled[2], { type: "text", text: '{"done":true}' })

    // Images past the inline count are written as files and described.
    const images = await shared.run(
      `for (let i = 0; i < ${INLINE_IMAGE_COUNT + 2}; i++) emitImage(await computer.capture({}))`,
      new AbortController().signal
    )
    assert.equal(
      images.filter((block) => block.type === "image").length,
      INLINE_IMAGE_COUNT
    )
    const imageReceipts = images
      .filter((block) => block.type === "text")
      .map((block) =>
        z
          .object({ kind: z.string(), path: z.string(), mimeType: z.string() })
          .parse(JSON.parse(textOf(block)))
      )
    assert.equal(imageReceipts.length, 2)
    assert.equal(imageReceipts[0]?.kind, "image")
    assert.equal(imageReceipts[0]?.mimeType, "image/png")
    assert.equal((await readFile(imageReceipts[0]!.path)).toString(), "pixels")

    // A return value with an undefined member, or one JSON cannot carry, is
    // a result or a named error, never an "invalid message" that loses the run.
    const sparse = await shared.run(
      "return {delivery: undefined, ok: true}",
      new AbortController().signal
    )
    assert.deepEqual(sparse, [{ type: "text", text: '{"ok":true}' }])
    await assert.rejects(
      shared.run("return {n: 1n}", new AbortController().signal),
      /not JSON/
    )
    const afterFault = await shared.run(
      "return 'still running'",
      new AbortController().signal
    )
    assert.deepEqual(afterFault, [{ type: "text", text: '"still running"' }])

    // Programs save what they choose to keep.
    const saved = await shared.run(
      "const file = artifacts.save('../evil/tree', {a: 1}); return file",
      new AbortController().signal
    )
    const file = z
      .object({ path: z.string(), bytes: z.number() })
      .parse(JSON.parse(textOf(saved[0])))
    assert.ok(file.path.startsWith(join(artifacts, "computer")))
    assert.match(file.path, /tree-[0-9a-f]{8}\.json$/)
    assert.equal(file.bytes, 7)
  } finally {
    await shared.close()
  }

  const outline = outlineOf({
    title: "x".repeat(400),
    nodes: [{ ref: "a" }, { ref: "b" }, { ref: "c" }, { ref: "d" }],
    count: 4,
  })
  assert.equal(outline.type, "object")
  assert.deepEqual(
    outline.keys?.map((key) => [key.name, key.type]),
    [
      ["title", "string"],
      ["nodes", "array"],
      ["count", "number"],
    ]
  )
  const nodes = outlineOf([
    { ref: "a" },
    { ref: "b" },
    { ref: "c" },
    { ref: "d" },
  ])
  assert.equal(nodes.length, 4)
  assert.equal(nodes.sample?.length, 3)
  assert.equal(outlineOf("y".repeat(1000)).head?.length, 240)
  console.log(
    "Control scripts: shared typed adapter, isolated persistent state, CPU-bound cancellation, canceled queued work never dispatches, recovery after worker reset, state kept through a program's own error, ordered artifact receipts instead of truncation, image spill past the inline count, and bounded artifact names"
  )
} finally {
  await first.close()
  await second.close()
  await rm(artifacts, { recursive: true, force: true })
}
