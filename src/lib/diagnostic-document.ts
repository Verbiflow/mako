import { z } from "zod"
import type { DiagnosticFormat } from "../../electron/contracts/file-preview"

const number = z.number().finite()
const frame = z.object({
  functionName: z.string().default(""),
  url: z.string().default(""),
  lineNumber: number.default(-1),
})
const har = z.object({
  log: z.object({
    entries: z
      .array(
        z.object({
          startedDateTime: z.string(),
          time: number.nonnegative(),
          request: z.object({ method: z.string(), url: z.string() }),
          response: z.object({
            status: number.int().nonnegative(),
            _transferSize: number.optional(),
            content: z.object({ size: number }),
          }),
        })
      )
      .max(100_000),
  }),
})
const cpu = z
  .object({
    startTime: number,
    endTime: number,
    nodes: z
      .array(z.object({ id: number.int(), callFrame: frame }))
      .max(100_000),
    samples: z.array(number.int()).max(1_000_000),
    timeDeltas: z.array(number.nonnegative()).max(1_000_000),
  })
  .refine(
    (profile) => profile.endTime >= profile.startTime,
    "CPU end time precedes start time"
  )
interface SamplingNode {
  callFrame: z.infer<typeof frame>
  selfSize: number
  children: SamplingNode[]
}
// Bound schema depth before parsing, rather than recurse through arbitrary
// allocation trees on the rendering thread or exhaust the worker's stack.
let samplingNode: z.ZodType<SamplingNode> = z.object({
  callFrame: frame,
  selfSize: number.nonnegative(),
  children: z.array(z.never()).max(0),
})
for (let depth = 0; depth < 128; depth++)
  samplingNode = z.object({
    callFrame: frame,
    selfSize: number.nonnegative(),
    children: z.array(samplingNode).max(1_000_000),
  })
const allocations = z.object({ head: samplingNode })
const heap = z
  .object({
    snapshot: z.object({
      node_count: number.int().nonnegative(),
      edge_count: number.int().nonnegative(),
      meta: z.object({ node_fields: z.array(z.string()).min(1).max(32) }),
    }),
    nodes: z.array(number).max(8_000_000),
    strings: z.array(z.string()).max(1_000_000),
  })
  .superRefine((snapshot, context) => {
    const fields = snapshot.snapshot.meta.node_fields
    const size = fields.indexOf("self_size")
    if (size < 0) return
    for (
      let index = size;
      index < snapshot.nodes.length;
      index += fields.length
    ) {
      if (snapshot.nodes[index] < 0) {
        context.addIssue({
          code: "custom",
          message: "Heap shallow sizes must be nonnegative",
        })
        return
      }
    }
  })
const completeEvent = z.object({
  ph: z.literal("X"),
  name: z.string().default(""),
  cat: z.string().default(""),
  ts: number,
  dur: number.nonnegative(),
})
const otherEvent = z.object({ ph: z.string().refine((phase) => phase !== "X") })
const trace = z.object({
  traceEvents: z.array(z.union([completeEvent, otherEvent])).max(1_000_000),
})

export type DiagnosticDocument =
  | { format: "har"; data: z.infer<typeof har> }
  | { format: "cpu-profile"; data: z.infer<typeof cpu> }
  | { format: "heap-profile"; data: z.infer<typeof allocations> }
  | { format: "heap-snapshot"; data: z.infer<typeof heap> }
  | { format: "trace"; data: z.infer<typeof trace> }

/** The file I/O boundary owns JSON and schema validation. */
export function readDiagnosticDocument(
  format: DiagnosticFormat,
  contents: string
): DiagnosticDocument {
  const value: unknown = JSON.parse(contents)
  switch (format) {
    case "har":
      return { format, data: har.parse(value) }
    case "cpu-profile":
      return { format, data: cpu.parse(value) }
    case "heap-profile":
      return { format, data: allocations.parse(value) }
    case "heap-snapshot":
      return { format, data: heap.parse(value) }
    case "trace":
      return { format, data: trace.parse(value) }
  }
}
