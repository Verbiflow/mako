import { inlineFileLinks } from "../src/lib/inline-file-links.ts"
import { parseProse } from "../src/lib/parsed-markdown.ts"
import { readDiagnosticInput } from "../src/lib/diagnostic-input.ts"
import { mock } from "node:test"
import { readDiagnosticDocument } from "../src/lib/diagnostic-document.ts"
import type { DiagnosticFormat } from "../electron/contracts/file-preview.ts"
import assert from "node:assert/strict"
import { filePreviewFormat } from "../electron/contracts/file-preview.ts"
import { classify } from "../src/lib/attachment-kind.ts"
import {
  summarizeDiagnostic,
  DIAGNOSTIC_BYTE_LIMIT,
} from "../src/lib/diagnostic-summary.ts"
const inspect = (
  format: DiagnosticFormat,
  input: import("zod").z.infer<ReturnType<typeof import("zod").z.json>>
) => summarizeDiagnostic(readDiagnosticDocument(format, JSON.stringify(input)))
const request = (
  status: number,
  time: number,
  size: number,
  start: string
) => ({
  startedDateTime: start,
  time,
  request: {
    method: "GET",
    url: "https://name:password@example.test/api?token=secret",
  },
  response: { status, content: { size } },
})
const har = inspect("har", {
  log: {
    entries: [
      request(200, 20, 1024, "2026-10-02T10:00:00Z"),
      request(500, 40, 2048, "2026-10-02T10:00:00.010Z"),
    ],
  },
})
assert.deepEqual(
  har.metrics.map((entry) => entry.value),
  [2, 1, 50, 3072]
)
assert.equal(JSON.stringify(har).includes("secret"), false)
assert.equal(JSON.stringify(har).includes("password"), false)
const cpu = inspect("cpu-profile", {
  startTime: 0,
  endTime: 3000,
  nodes: [
    {
      id: 1,
      callFrame: { functionName: "render", url: "app.ts", lineNumber: 0 },
    },
  ],
  samples: [1, 1],
  timeDeltas: [1000, 2000],
})
assert.deepEqual(
  cpu.metrics.map((entry) => entry.value),
  [3, 2, 3]
)
assert.equal(cpu.rows[0]?.weight, 3)
const frame = { functionName: "allocate", url: "app.ts" }
const heap = inspect("heap-profile", {
  head: {
    callFrame: frame,
    selfSize: 10,
    children: [{ callFrame: frame, selfSize: 20, children: [] }],
  },
})
assert.deepEqual(
  heap.metrics.map((entry) => entry.value),
  [2, 30]
)
const snapshot = inspect("heap-snapshot", {
  snapshot: {
    node_count: 2,
    edge_count: 0,
    meta: { node_fields: ["type", "name", "self_size"] },
  },
  nodes: [0, 0, 16, 0, 0, 24],
  strings: ["Object"],
})
assert.deepEqual(
  snapshot.metrics.map((entry) => entry.value),
  [2, 0, 40]
)
const trace = inspect("trace", {
  traceEvents: [
    { name: "render", cat: "main", ph: "X", ts: 1000, dur: 2000 },
    { ph: "B" },
  ],
})
assert.deepEqual(
  trace.metrics.map((entry) => entry.value),
  [2, 1, 2]
)
assert.match(trace.notes[0]!, /1.*not analysed/)
for (const format of [
  "har",
  "cpu-profile",
  "heap-profile",
  "heap-snapshot",
  "trace",
] as const)
  assert.throws(() => inspect(format, {}))
assert.throws(() =>
  inspect("cpu-profile", {
    startTime: 0,
    endTime: 1,
    nodes: [],
    samples: [1],
    timeDeltas: [],
  })
)
assert.throws(() =>
  inspect("heap-snapshot", {
    snapshot: {
      node_count: 2,
      edge_count: 0,
      meta: { node_fields: ["name", "self_size", "type"] },
    },
    nodes: [0, 16, 0],
    strings: ["Object"],
  })
)
assert.equal(filePreviewFormat("normal.json"), "text", "ordinary JSON uses the bounded source view, not diagnostic parsing")
assert.equal(filePreviewFormat("timing.trace.json"), "trace")
assert.equal(
  classify({ name: "heap.heapsnapshot", type: "application/json" }),
  "binary",
  "diagnostics never inline a large dump into prompts"
)
assert.equal(DIAGNOSTIC_BYTE_LIMIT, 32 * 1024 * 1024)
const started = performance.now()
const large = inspect("har", {
  log: {
    entries: Array.from({ length: 10_000 }, () =>
      request(200, 20, 1024, "2026-10-02T10:00:00Z")
    ),
  },
})
assert.equal(large.rows.length, 1000)
assert.equal(large.metrics[0]?.value, 10_000)
assert.ok(JSON.stringify(large).length < 250_000)
console.log(
  `PASS: five validated diagnostic formats, truthful totals, malformed rejection and bounded output; 10,000 HAR entries summarised in ${(performance.now() - started).toFixed(1)} ms`
)

assert.throws(() =>
  inspect("cpu-profile", {
    startTime: 2000,
    endTime: 1000,
    nodes: [],
    samples: [],
    timeDeltas: [],
  })
)
assert.throws(() =>
  inspect("heap-snapshot", {
    snapshot: {
      node_count: 1,
      edge_count: 0,
      meta: { node_fields: ["type", "name", "self_size"] },
    },
    nodes: [0, 0, -4096],
    strings: ["Object"],
  })
)

// Exercise the real streamed I/O ceiling, including files without a length header.
for (const knownLength of [false, true]) {
  let reads = 0,
    cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
    cancel() {
      cancelled = true
    },
  })
  mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(stream, {
        headers: knownLength
          ? { "content-length": String(DIAGNOSTIC_BYTE_LIMIT + 1) }
          : {},
      })
  )
  try {
    await assert.rejects(
      readDiagnosticInput("https://fixture.test/large"),
      /32 MB inspection limit/
    )
    assert.equal(cancelled, true, "over-limit fetch releases its stream")
    assert.ok(reads <= (knownLength ? 1 : 34), "no reads after the limit")
  } finally {
    mock.restoreAll()
  }
}
console.log(
  "PASS: oversized advertised and unadvertised streams are cancelled at the real I/O boundary"
)

const prose = parseProse(
  "Inspect **[report](/tmp/report.har)** now.\n\n- [image](/tmp/image.png)\n- **[trace](/tmp/main.trace.json)**\n\n- Loose [audio](/tmp/voice.wav)\n\n  Extra paragraph."
)
const cards: string[] = []
const visit = (element: import("hast").Element) => {
  if (element.tagName === "p" || element.tagName === "li")
    cards.push(...inlineFileLinks(element))
  for (const child of element.children)
    if (child.type === "element") visit(child)
}
for (const element of prose.children)
  if (element.type === "element") visit(element)
assert.deepEqual(
  cards,
  [
    "/tmp/report.har",
    "/tmp/image.png",
    "/tmp/main.trace.json",
    "/tmp/voice.wav",
  ],
  "sentences, strong text, tight/loose lists each discover exactly one card"
)

for (const [path, format] of [["photo.bmp", "image"], ["audio.aiff", "audio"], ["movie.avi", "video"], ["component.vue", "text"], ["view.svelte", "text"], ["records.jsonl", "text"], ["implementation.ts", "text"], ["design.yaml", "text"]] as const)
  assert.equal(filePreviewFormat(path), format, `library-backed format for ${path}`)
assert.equal(classify({name:"implementation.ts",type:"video/mp2t"}), "text", "source-code extension collision must not send code as video")
