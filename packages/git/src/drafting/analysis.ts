import { createHash } from "node:crypto"
import { z } from "zod"
import type { Evidence } from "./evidence.js"
import type { ModelSession } from "./model.js"
import { finalInstructions, inspectionInstructions, SUMMARY_INSTRUCTIONS } from "./prompts.js"

/** A piece of one or more patches, read once however often it repeats. */
interface Unit {
  id: string
  data: Buffer
  encodedBytes: number
  sources: Array<{ file: number; start: number; end: number }>
}

interface Node {
  id: string
  summary: string
  children: string[]
  sourceUnits: number
}

interface Prepared {
  evidence: Evidence
  chunkBytes: number
  units: Unit[]
  batches: Unit[][]
}

interface Analysis {
  /** What the final request reads: the evidence itself when it fits one request, else the top summaries. */
  context: string
  nodes: Node[]
  rootIds: string[]
}

const CONCURRENCY = 8
const FAN_IN = 12
const strict = new TextDecoder("utf-8", { fatal: true })

function digest(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex")
}

function valid(data: Buffer): boolean {
  try {
    strict.decode(data)
    return true
  } catch {
    return false
  }
}

function payload(data: Buffer): string {
  return valid(data) ? data.toString("utf8") : JSON.stringify({ encoding: "base64", bytes: data.toString("base64") })
}

function unitHeader(unit: Unit): string {
  return `\nSOURCE ${unit.id} · ${unit.data.length} bytes · ${unit.sources.length} occurrences; inspect this ID for all file references\n`
}

/** Splits each patch into pieces a quarter of a request, cut between characters, and packs them into requests. */
export function organize(evidence: Evidence, chunkBytes: number): Prepared {
  const piece = Math.floor(chunkBytes / 4)
  const units = new Map<string, Unit>()
  evidence.patches.forEach((patch, file) => {
    for (let start = 0; start < patch.length;) {
      let end = Math.min(patch.length, start + piece)
      while (end > start && end < patch.length && (patch[end]! & 0xc0) === 0x80) end -= 1
      if (end === start) end = Math.min(patch.length, start + piece)
      const data = patch.subarray(start, end)
      const id = digest(data)
      const known = units.get(id)
      if (known) known.sources.push({ file, start, end })
      else units.set(id, { id, data, encodedBytes: valid(data) ? data.length : payload(data).length, sources: [{ file, start, end }] })
      start = end
    }
  })
  const budget = Math.floor(chunkBytes * 3 / 4)
  const batches: Unit[][] = []
  let batch: Unit[] = []
  let size = 0
  for (const unit of units.values()) {
    const bytes = Buffer.byteLength(unitHeader(unit)) + unit.encodedBytes + 1
    if (bytes > budget) throw new Error("A piece of evidence exceeds the request budget.")
    if (batch.length > 0 && size + bytes > budget) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(unit)
    size += bytes
  }
  if (batch.length > 0) batches.push(batch)
  return { evidence, chunkBytes, units: [...units.values()], batches }
}

function batchInput(prepared: Prepared, batch: Unit[]): string {
  let input = ""
  for (const unit of batch) input += `${unitHeader(unit)}${payload(unit.data)}\n`
  if (Buffer.byteLength(input) > prepared.chunkBytes) throw new Error("A request exceeded its budget.")
  return input
}

/** Summaries by what produced them, kept across drafts so a retry or a second draft reuses them. */
const summaries = new Map<string, Node>()
const SUMMARY_LIMIT = 4_096

function remember(node: Node): void {
  summaries.delete(node.id)
  summaries.set(node.id, node)
  if (summaries.size > SUMMARY_LIMIT) summaries.delete(summaries.keys().next().value!)
}

async function summarize(session: ModelSession, chunkBytes: number, input: string, children: string[], sourceUnits: number): Promise<Node> {
  if (Buffer.byteLength(input) > chunkBytes) throw new Error("A summary request exceeded its budget.")
  const maxBytes = Math.min(Math.floor(chunkBytes / 8), 8_192)
  const maxChars = Math.floor(maxBytes / 4)
  const system = `${SUMMARY_INSTRUCTIONS}\nKeep the summary under ${maxChars} characters. Return {"summary":"..."}.`
  const id = digest(`mako-analysis-v1\n${session.options.model.identity}\n${system}\n${input}`)
  const known = summaries.get(id)
  if (known && known.sourceUnits === sourceUnits && known.children.join() === children.join()) {
    remember(known)
    return known
  }
  const schema = z.strictObject({ summary: z.string().min(1).max(maxChars) })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const summary = (await session.ask(attempt === 0 ? system : `${system}\nReturn a shorter valid JSON summary.`, input, schema))?.summary
    if (summary?.trim() && Buffer.byteLength(summary) <= maxBytes) {
      const node = { id, summary, children, sourceUnits }
      remember(node)
      return node
    }
  }
  throw new Error("The model returned an invalid summary twice. No draft was created.")
}

/** Runs `work` on each item, `CONCURRENCY` at a time, keeping their order. After a failure no item starts. */
async function pooled<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let next = 0
  let failed = false
  const lane = async () => {
    while (!failed && next < items.length) {
      const index = next++
      try {
        results[index] = await work(items[index]!)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, lane))
  return results
}

function summaryText(nodes: readonly Node[]): string {
  return nodes.map((node) => `SUMMARY ${node.id} · ${node.sourceUnits} source units\n${node.summary}\n\n`).join("")
}

/**
 * Evidence that fits one request goes as is. More is summarized a request at
 * a time, and the summaries again in groups, until what is left fits.
 */
export async function analyze(prepared: Prepared, session: ModelSession): Promise<Analysis> {
  if (prepared.batches.length === 1) return { context: batchInput(prepared, prepared.batches[0]!), nodes: [], rootIds: prepared.units.map((unit) => unit.id) }
  let roots = await pooled(prepared.batches, (batch) => summarize(session, prepared.chunkBytes, batchInput(prepared, batch), batch.map((unit) => unit.id), batch.length))
  const nodes = [...roots]
  while (roots.length > FAN_IN || Buffer.byteLength(summaryText(roots)) > prepared.chunkBytes / 2) {
    const groups: Node[][] = []
    let group: Node[] = []
    let bytes = 0
    for (const node of roots) {
      const size = Buffer.byteLength(node.summary) + node.id.length + 100
      if (group.length > 0 && (group.length >= FAN_IN || bytes + size > prepared.chunkBytes * 3 / 4)) {
        groups.push(group)
        group = []
        bytes = 0
      }
      group.push(node)
      bytes += size
    }
    if (group.length > 0) groups.push(group)
    if (groups.length >= roots.length) throw new Error("Summaries didn't get shorter. No draft was created.")
    roots = await pooled(groups, (members) => summarize(session, prepared.chunkBytes, summaryText(members), members.map((node) => node.id), members.reduce((sum, node) => sum + node.sourceUnits, 0)))
    nodes.push(...roots)
  }
  if (roots.reduce((sum, node) => sum + node.sourceUnits, 0) !== prepared.units.length) throw new Error("Summaries lost part of the evidence. No draft was created.")
  return { context: summaryText(roots), nodes, rootIds: roots.map((node) => node.id) }
}

/** What a deep draft may ask to read: a source, a summary, where a source occurs, or the file list. */
function inspectionSchema(pageLimit: number) {
  const page = { offset: z.int().min(0), limit: z.int().min(1).max(pageLimit) }
  return z.union([
    z.strictObject({ kind: z.enum(["source", "node", "references"]), id: z.string(), ...page }),
    z.strictObject({ kind: z.literal("inventory"), ...page }),
  ])
}
type Inspection = z.infer<ReturnType<typeof inspectionSchema>>

interface Page {
  id: string
  offset: number
  total_bytes: number
  next_offset: number | null
  encoding: "utf8" | "base64"
  data: string
}

function inspectPage(prepared: Prepared, analysis: Analysis, request: Inspection): Page {
  let id: string
  let bytes: Buffer
  if (request.kind === "inventory") {
    id = "inventory"
    bytes = Buffer.from(JSON.stringify(prepared.evidence.files))
  } else if (request.kind === "node") {
    const node = analysis.nodes.find((entry) => entry.id === request.id)
    if (!node) throw new Error("The model asked for an analysis node that doesn't exist.")
    id = node.id
    bytes = Buffer.from(JSON.stringify(node))
  } else {
    const unit = prepared.units.find((entry) => entry.id === request.id)
    if (!unit) throw new Error("The model asked for a source that doesn't exist.")
    id = unit.id
    bytes = request.kind === "source" ? unit.data : Buffer.from(JSON.stringify(unit.sources.map((source) => ({ path: prepared.evidence.files[source.file]!.path, start: source.start, end: source.end }))))
  }
  const { offset, limit } = request
  if (!Number.isInteger(offset) || !Number.isInteger(limit) || limit <= 0 || limit > 128_000 || offset < 0 || offset > bytes.length) throw new Error("The model asked for an invalid evidence page.")
  let end = Math.min(offset + limit, bytes.length)
  const text = valid(bytes)
  if (text) {
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new Error("The model asked for a page that splits a character.")
    while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
  }
  if (end === offset && offset < bytes.length) throw new Error("The model asked for a page too small for the next character.")
  const chunk = bytes.subarray(offset, end)
  const utf8 = valid(chunk)
  return { id, offset, total_bytes: bytes.length, next_offset: end < bytes.length ? end : null, encoding: utf8 ? "utf8" : "base64", data: utf8 ? chunk.toString("utf8") : chunk.toString("base64") }
}


/** Deep drafts may read the original evidence this many times before they finish. */
const INSPECTION_ROUNDS = 6

/**
 * The final request: the task, the analysis, and in a deep draft what the
 * model chose to read of the original evidence, until it returns `output`.
 */
export async function synthesize<T>(prepared: Prepared, analysis: Analysis, session: ModelSession, instructions: string, task: string, output: z.ZodType<T>): Promise<T> {
  const pageLimit = Math.floor(prepared.chunkBytes / 16)
  const finish = z.strictObject({ action: z.literal("finish"), result: output, requests: z.array(z.string()).max(0), notes: z.string() })
  const inspect = z.strictObject({ action: z.enum(["finish", "inspect"]), result: output.nullable(), requests: z.array(inspectionSchema(pageLimit)).max(4), notes: z.string() })
  const limit = session.deep ? INSPECTION_ROUNDS : 0
  const inspection = inspectionInstructions(instructions, Math.min(pageLimit, 1_000))
  let pages: Page[] = []
  let notes = ""
  for (let round = 0; round <= limit; round += 1) {
    const available = session.remaining()
    if (available <= 0) throw new Error("No model request remains for the final step; completed summaries are kept for a retry. No draft was created.")
    const mayInspect = round < limit && available > 1
    const system = mayInspect
      ? `${inspection}\nAt most ${Math.min(limit - round, available - 1)} inspection rounds remain. Finish as soon as the evidence is sufficient; a final response is mandatory.`
      : finalInstructions(instructions)
    const input = `TASK\n${task}\nSELECTION ${prepared.evidence.files.length} files, ${prepared.evidence.inputBytes} bytes\nWARNINGS ${JSON.stringify(prepared.evidence.warnings)}\nROOT IDS ${JSON.stringify(analysis.rootIds)}\nANALYSIS\n${analysis.context}\nNOTES\n${notes}\nINSPECTION PAGES\n${JSON.stringify(pages)}`
    if (Buffer.byteLength(input) + Buffer.byteLength(system) > prepared.chunkBytes * 2) throw new Error("The final request can't fit its budget. No draft was created.")
    const answer = mayInspect ? await session.ask(system, input, inspect) : await session.ask(system, input, finish)
    if (!answer) throw new Error("The model's reply wasn't the JSON asked for. No draft was created.")
    if (answer.action === "finish") {
      if (answer.requests.length > 0) throw new Error("The model finished with inspections still pending. No draft was created.")
      if (answer.result === null) throw new Error("The model finished without the required result. No draft was created.")
      return answer.result
    }
    if (!mayInspect) throw new Error("The model didn't return the required final answer. No draft was created; completed summaries are kept for a retry.")
    if (answer.result !== null || answer.requests.length === 0 || Buffer.byteLength(answer.notes) > pageLimit)
      throw new Error("The model asked to read more than its budget allows. No draft was created.")
    pages = answer.requests.map((request) => inspectPage(prepared, analysis, request))
    notes = answer.notes
  }
  throw new Error("The model didn't produce a final answer. No draft was created.")
}
