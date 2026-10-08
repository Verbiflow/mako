import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs"
import { z } from "zod"
import { objectValue, stringValue, type JsonObject } from "../../codex-app-json.js"

/** An `exec_command` call or a code cell (`exec`), and the output Codex gave the model, as its rollout keeps them. */
export type RolloutCall = {
  call: JsonObject
  output: JsonObject
}

const CALL_ID = /"call_id":"([^"\\]+)"/
/** Calls still waiting for their output; a turn's running commands, never more than a few. */
const MAX_PENDING = 256
const Record = z.object({ type: z.literal("response_item"), payload: z.record(z.string(), z.json()) })
const Call = z.object({ type: z.enum(["function_call", "custom_tool_call"]), call_id: z.string() })
const Output = z.object({ type: z.enum(["function_call_output", "custom_tool_call_output"]), call_id: z.string() })

/**
 * The commands a thread's rollout keeps, read forward from where the last
 * read stopped. Codex 0.159.3 sends no item for a command its sandbox
 * refused (a write outside the workspace, or any command when Mako itself
 * runs inside a macOS sandbox), though the rollout keeps the call and its
 * output. It sends none for a code cell either, only for the calls the cell
 * made, so a cell's own failure reaches Mako only here. The decoder draws
 * what the wire never named (`CodexDecoder.rolloutCalls`). The file only
 * grows, so each read costs what was appended, and only command and cell
 * records are parsed.
 */
export class CodexRolloutCalls {
  private readonly path: string
  private offset: number
  private file: number | undefined
  private readonly pending = new Map<string, JsonObject>()

  /** What the rollout already holds is the thread's history, not this process's turns. */
  constructor(path: string) {
    this.path = path
    try {
      const { size, ino } = statSync(path)
      this.offset = size
      this.file = ino
    } catch {
      this.offset = 0
    }
  }

  /** Each `exec_command` call and code cell whose output was appended since the last read. */
  read(): RolloutCall[] {
    const settled: RolloutCall[] = []
    let fd: number | undefined
    try {
      fd = openSync(this.path, "r")
      const { size, ino } = fstatSync(fd)
      if (this.file !== undefined && (ino !== this.file || size < this.offset)) {
        this.offset = 0
        this.pending.clear()
      }
      this.file = ino
      if (size <= this.offset) return settled
      const bytes = Buffer.allocUnsafe(size - this.offset)
      const read = readSync(fd, bytes, 0, bytes.length, this.offset)
      const end = bytes.subarray(0, read).lastIndexOf(0x0a)
      if (end < 0) return settled
      this.offset += end + 1
      for (const line of bytes.toString("utf8", 0, end).split("\n")) this.line(line, settled)
    } catch {
      return settled
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    return settled
  }

  private line(line: string, settled: RolloutCall[]): void {
    if (!line.includes(`"type":"response_item"`)) return
    const command = line.includes(`"type":"function_call"`) && line.includes(`"name":"exec_command"`)
    const cell = line.includes(`"type":"custom_tool_call"`) && line.includes(`"name":"exec"`)
    if (command || cell) {
      const payload = parsed(line)
      const id = Call.safeParse(payload).data?.call_id
      if (!payload || id === undefined) return
      if (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!)
      this.pending.set(id, payload)
      return
    }
    if (!line.includes(`"type":"function_call_output"`) && !line.includes(`"type":"custom_tool_call_output"`)) return
    const id = CALL_ID.exec(line)?.[1]
    const call = id === undefined ? undefined : this.pending.get(id)
    if (id === undefined || !call) return
    const payload = parsed(line)
    if (!payload || Output.safeParse(payload).data?.call_id !== id) return
    this.pending.delete(id)
    settled.push({ call, output: payload })
  }
}

function parsed(line: string): JsonObject | undefined {
  try {
    return Record.safeParse(JSON.parse(line)).data?.payload
  } catch {
    return undefined
  }
}

/**
 * Whether the rollout is due a read before this notification of `thread`:
 * a model response starting, or the turn ending. Codex finishes every tool
 * call of a round before it asks the model again, so a command the rollout
 * kept that the wire hasn't named by then is one Codex never sent.
 */
export function codexRolloutDue(method: string, params: JsonObject, thread: string | null): boolean {
  if (stringValue(params["threadId"]) !== thread) return false
  if (method === "turn/completed") return true
  const item = method === "item/started" ? stringValue(objectValue(params["item"])?.["type"]) : undefined
  return item === "reasoning" || item === "agentMessage"
}
