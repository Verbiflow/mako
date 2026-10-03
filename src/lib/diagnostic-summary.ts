import type { DiagnosticDocument } from "./diagnostic-document"

export const DIAGNOSTIC_BYTE_LIMIT = 32 * 1024 * 1024
const ITEM_LIMIT = 1_000_000
const ROW_LIMIT = 1000
const GROUP_LIMIT = 20_000
export interface DiagnosticSummary {
  title: string
  metrics: { label: string; value: number; unit: "count" | "ms" | "bytes" }[]
  columns: string[]
  rows: { cells: string[]; weight: number; offset?: number }[]
  notes: string[]
}
const label = (value: string): string => value.slice(0, 240)
const numeric = (value: number): number => value
const nonnegative = (value: number): number => Math.max(0, value)
const metric = (
  label: string,
  value: number,
  unit: "count" | "ms" | "bytes" = "count"
) => ({ label, value, unit })
function boundedRows(summary: DiagnosticSummary): DiagnosticSummary {
  if (summary.metrics.some((entry) => !Number.isFinite(entry.value)))
    throw new Error("Diagnostic totals overflow the supported numeric range")
  if (summary.rows.length > ROW_LIMIT)
    summary.notes.push(
      `Showing the first ${ROW_LIMIT.toLocaleString()} ranked rows; metrics cover the complete supported input.`
    )
  summary.rows = summary.rows.slice(0, ROW_LIMIT)
  return summary
}
function groups() {
  const values = new Map<string, { count: number; weight: number }>()
  return {
    add(name: string, weight: number) {
      if (!values.has(name) && values.size >= GROUP_LIMIT)
        throw new Error("This diagnostic exceeds the distinct-group limit")
      const existing = values.get(name) ?? { count: 0, weight: 0 }
      existing.count++
      existing.weight += weight
      values.set(name, existing)
    },
    rows(unit: string) {
      return [...values]
        .sort((a, b) => b[1].weight - a[1].weight)
        .map(([name, entry]) => ({
          cells: [
            name || "(anonymous)",
            entry.count.toLocaleString(),
            `${entry.weight.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`,
          ],
          weight: entry.weight,
        }))
    },
  }
}
/** Runs exclusively in the diagnostic worker, or directly in fixture tests. */
export function summarizeDiagnostic(
  document: DiagnosticDocument
): DiagnosticSummary {
  if (document.format === "har") {
    const entries = document.data.log.entries
    if (entries.length > 100_000)
      throw new Error("This HAR exceeds 100,000 requests")
    let bytes = 0,
      unknownSizes = 0,
      failures = 0,
      start = Infinity,
      end = -Infinity
    const rows = entries.map((value) => {
      const entry = value,
        request = entry.request,
        response = entry.response
      const duration = nonnegative(entry.time),
        status = numeric(response.status)
      const time = Date.parse(label(entry.startedDateTime))
      if (!Number.isFinite(time))
        throw new Error("A HAR request has an invalid start time")
      start = Math.min(start, time)
      end = Math.max(end, time + duration)
      const recordedSize = response._transferSize ?? response.content.size
      if (recordedSize < 0) unknownSizes++
      const size = nonnegative(recordedSize)
      bytes += size
      if (status === 0 || status >= 400) failures++
      // URLs can carry credentials/query payloads. The summary needs only path.
      let url: URL
      try {
        url = new URL(request.url)
      } catch {
        throw new Error("A HAR request has an invalid URL")
      }
      return {
        cells: [
          label(request.method),
          label(`${url.host}${url.pathname}`),
          String(status),
          `${duration.toFixed(2)} ms`,
          `${size.toLocaleString()} B`,
        ],
        weight: duration,
        offset: time,
      }
    })
    for (const row of rows) row.offset = (row.offset ?? start) - start
    return boundedRows({
      title: "Network archive",
      metrics: [
        metric("Requests", entries.length),
        metric("Failures", failures),
        metric("Elapsed", entries.length ? end - start : 0, "ms"),
        metric("Response bytes", bytes, "bytes"),
      ],
      columns: ["Method", "Request", "Status", "Duration", "Bytes"],
      rows: rows.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0)),
      notes: [
        `Response bytes use transfer size when recorded, otherwise decoded content size.${unknownSizes ? ` ${unknownSizes} request sizes are unknown and excluded from the total.` : ""} Headers, query strings and bodies are not shown.`,
      ],
    })
  }
  if (document.format === "cpu-profile") {
    const nodes = document.data.nodes,
      samples = document.data.samples,
      deltas = document.data.timeDeltas
    if (
      nodes.length > 100_000 ||
      samples.length > ITEM_LIMIT ||
      samples.length !== deltas.length
    )
      throw new Error(
        "CPU profile nodes or samples exceed the supported limits, or sample timings are incomplete"
      )
    const frames = new Map<number, string>()
    for (const value of nodes) {
      const node = value,
        frame = node.callFrame,
        id = numeric(node.id)
      if (frames.has(id)) throw new Error("CPU profile node IDs are duplicated")
      frames.set(
        id,
        `${label(frame.functionName) || "(anonymous)"} · ${label(frame.url).split(/[?#]/)[0]}:${nonnegative(frame.lineNumber) + 1}`
      )
    }
    const grouped = groups()
    let sampled = 0
    for (let i = 0; i < samples.length; i++) {
      const name = frames.get(numeric(samples[i]))
      if (name === undefined)
        throw new Error("A CPU sample references an unknown node")
      const ms = nonnegative(deltas[i]) / 1000
      sampled += ms
      grouped.add(name, ms)
    }
    return boundedRows({
      title: "CPU samples",
      metrics: [
        metric(
          "Duration",
          nonnegative(
            numeric(document.data.endTime) - numeric(document.data.startTime)
          ) / 1000,
          "ms"
        ),
        metric("Samples", samples.length),
        metric("Sampled time", sampled, "ms"),
      ],
      columns: ["Function", "Samples", "Self time"],
      rows: grouped.rows("ms"),
      notes: [
        "Self time is attributed to the sampled leaf. This view does not calculate inclusive stack time.",
      ],
    })
  }
  if (document.format === "heap-profile") {
    const pending = [document.data.head],
      grouped = groups()
    let count = 0,
      bytes = 0
    while (pending.length) {
      if (++count > ITEM_LIMIT)
        throw new Error("This allocation profile exceeds the node limit")
      const node = pending.pop()!,
        frame = node.callFrame,
        size = nonnegative(node.selfSize)
      bytes += size
      grouped.add(
        `${label(frame.functionName) || "(anonymous)"} · ${label(frame.url).split(/[?#]/)[0]}`,
        size
      )
      const children = node.children
      if (pending.length + children.length > ITEM_LIMIT)
        throw new Error("This allocation profile exceeds the node limit")
      for (const child of children) pending.push(child)
    }
    return boundedRows({
      title: "Sampled allocations",
      metrics: [
        metric("Stack nodes", count),
        metric("Sampled bytes", bytes, "bytes"),
      ],
      columns: ["Allocation site", "Stack nodes", "Self bytes"],
      rows: grouped.rows("B"),
      notes: [
        "Sampled allocation bytes are estimates, not current retained memory or evidence of a leak.",
      ],
    })
  }
  if (document.format === "heap-snapshot") {
    const snapshot = document.data.snapshot,
      fields = snapshot.meta.node_fields,
      nodes = document.data.nodes,
      strings = document.data.strings
    const width = fields.length,
      nameAt = fields.indexOf("name"),
      sizeAt = fields.indexOf("self_size"),
      typeAt = fields.indexOf("type")
    if (
      width === 0 ||
      nameAt < 0 ||
      sizeAt < 0 ||
      typeAt < 0 ||
      nodes.length % width !== 0
    )
      throw new Error("This heap snapshot schema is not supported")
    const count = nodes.length / width
    if (count > ITEM_LIMIT || count !== numeric(snapshot.node_count))
      throw new Error(
        "Heap node counts are inconsistent or exceed the inspection limit"
      )
    const grouped = groups()
    let bytes = 0
    for (let i = 0; i < nodes.length; i += width) {
      const nameIndex = numeric(nodes[i + nameAt])
      if (
        !Number.isInteger(nameIndex) ||
        nameIndex < 0 ||
        nameIndex >= strings.length
      )
        throw new Error("A heap node references an invalid string")
      const size = nonnegative(nodes[i + sizeAt])
      bytes += size
      grouped.add(label(strings[nameIndex]), size)
    }
    return boundedRows({
      title: "Heap objects",
      metrics: [
        metric("Objects", count),
        metric("Recorded edges", nonnegative(snapshot.edge_count)),
        metric("Shallow bytes", bytes, "bytes"),
      ],
      columns: ["Object name", "Objects", "Shallow bytes"],
      rows: grouped.rows("B"),
      notes: [
        "Shallow size only. Retainers, dominators, snapshot comparison and leak detection require a full memory profiler.",
      ],
    })
  }
  if (document.format !== "trace")
    throw new Error("Unsupported diagnostic format")
  const events = document.data.traceEvents
  if (events.length > ITEM_LIMIT)
    throw new Error("This trace exceeds the event limit")
  const grouped = groups()
  let complete = 0,
    ignored = 0,
    start = Infinity,
    end = -Infinity
  for (const value of events) {
    const event = value
    if (!("dur" in event)) {
      ignored++
      continue
    }
    const time = numeric(event.ts) / 1000,
      duration = nonnegative(event.dur) / 1000
    start = Math.min(start, time)
    end = Math.max(end, time + duration)
    complete++
    grouped.add(`${label(event.name)} · ${label(event.cat)}`, duration)
  }
  return boundedRows({
    title: "Trace durations",
    metrics: [
      metric("Events", events.length),
      metric("Complete events", complete),
      metric("Elapsed", complete ? end - start : 0, "ms"),
    ],
    columns: ["Event / category", "Occurrences", "Total duration"],
    rows: grouped.rows("ms"),
    notes: [
      `Summarises complete (X) events; ${ignored.toLocaleString()} metadata, counters, begin/end or async events are not analysed. Overlapping durations are not wall time.`,
    ],
  })
}
