import { inlineDocument } from "../src/lib/inline-document.ts"
import assert from "node:assert/strict"
import { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } from "@zip.js/zip.js"
import { mock } from "node:test"
import { checkOfficeArchive, readOfficeInput, OFFICE_BYTE_LIMIT } from "../src/lib/office-input.ts"
import { filePreviewFormat } from "../electron/contracts/file-preview.ts"
import { scheduleFileInspection, fileInspectionStats } from "../src/lib/file-inspections.ts"
import { LiveUpdateSchema, reduceLiveUpdates } from "../electron/contracts/live-content.ts"
import { ThreadEntrySchema } from "../packages/sessions/src/thread-schema.ts"

const zip = async (size: number) => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level: 0 })
  await writer.add("word/document.xml", new Uint8ArrayReader(new Uint8Array(size)))
  return writer.close()
}
const signal = new AbortController().signal
await checkOfficeArchive(await zip(64), signal)
await assert.rejects(checkOfficeArchive(await zip(8 * 1024 * 1024 + 1), signal), /too complex/)
await assert.rejects(checkOfficeArchive(new Uint8Array([1, 2, 3]), signal))
for (const [extension, format] of [["docx", "word"], ["xlsx", "workbook"], ["pptx", "presentation"]])
  assert.equal(filePreviewFormat(`native.${extension}`), format)
let cancelled = false
const fetch = mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
  start(controller) { controller.enqueue(new Uint8Array(OFFICE_BYTE_LIMIT + 1)) },
  cancel() { cancelled = true },
})))
try {
  await assert.rejects(readOfficeInput("http://fixture/file", signal), /16 MB/)
  assert.ok(cancelled, "oversized streams without Content-Length are cancelled")
} finally { fetch.mock.restore() }
const jobs = [0, 1, 2].map(() => scheduleFileInspection(() => () => {}, () => assert.fail("queue rejected")))
await Promise.resolve()
assert.equal(fileInspectionStats().running, 2)
assert.equal(fileInspectionStats().queued, 1)
jobs[0]()
assert.equal(fileInspectionStats().queued, 0)
jobs.forEach(release => release())
assert.equal(fileInspectionStats().running, 0)
const marker = { kind: "event", id: "native-1", source: { harness: "future", record: "native-1" }, label: "Context compacted" } as const
const update = LiveUpdateSchema.parse(marker)
assert.deepEqual(update.kind === "event" && update.source, marker.source)
const entry = ThreadEntrySchema.parse(marker)
assert.deepEqual(entry.kind === "event" && entry.source, marker.source)
const reduced = reduceLiveUpdates([], [marker, marker])
assert.equal(reduced.length, 1)
assert.deepEqual(reduced[0]?.type === "event" && reduced[0].source, marker.source)
console.log("PASS: lazy Office formats, bounded streamed input and ZIP metadata, shared job cleanup and native marker source retention")

assert.equal(inlineDocument({ name: "generated.md", mimeType: "text/markdown", data: Buffer.from("# Native résumé").toString("base64") }).contents, "# Native résumé")
assert.equal(inlineDocument({ name: "large.md", mimeType: "text/markdown", data: Buffer.from("x".repeat(100_000)).toString("base64") }).truncated, true)
assert.throws(() => inlineDocument({ name: "invalid.md", mimeType: "text/markdown", data: Buffer.from([255]).toString("base64") }))

// Hidden tabs suspend paint callbacks, not evidence of a stuck parser. The
// visible-time render watchdog pauses; cancellation removes its listener/timer.
{
  const { visiblePreviewDeadline } = await import("../src/lib/preview-deadline.ts")
  mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const page = Object.assign(new EventTarget(), { hidden: false })
  let expirations = 0
  try {
    const cancel = visiblePreviewDeadline(20_000, () => expirations++, page)
    mock.timers.tick(5000)
    page.hidden = true
    page.dispatchEvent(new Event("visibilitychange"))
    mock.timers.tick(60_000)
    assert.equal(expirations, 0)
    page.hidden = false
    page.dispatchEvent(new Event("visibilitychange"))
    mock.timers.tick(14_999)
    assert.equal(expirations, 0)
    mock.timers.tick(1)
    assert.equal(expirations, 1)
    cancel()
    const close = visiblePreviewDeadline(1000, () => expirations++, page)
    close()
    page.dispatchEvent(new Event("visibilitychange"))
    mock.timers.tick(10_000)
    assert.equal(expirations, 1)
  } finally { mock.timers.reset() }
}
console.log("PASS: Office rendering watchdog excludes hidden-tab paint suspension and cancels on close")
