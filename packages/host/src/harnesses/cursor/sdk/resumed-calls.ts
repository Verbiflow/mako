import { z } from "zod"
import { cursorCallErrored } from "@mako/sessions/cursor-sdk-content"
import { resumeAccountText, type RepositoryChanges, type ResumedCall } from "../../../contracts/resume-account.js"

/**
 * Where the SDK's patched retry loop asks before each retry what to send
 * instead of its empty resume (`scripts/patch-cursor-sdk.mjs`).
 */
export const CURSOR_SDK_RESUME_HOOK = Symbol.for("mako:cursor-sdk-resume")

/** What the retry loop asks with: the attempt, the action it would send, and its run's request id. */
export interface ResumeQuestion {
  attempt: number
  action?: string
  requestId?: string
}

/** What the retry loop sends instead: the words, as a message of the turn's own mode. */
export interface ResumeAnswer {
  text: string
  plan: boolean
}

/** A `tool_call` message of the run's stream, as far as the account reads it. */
export const StreamedCallSchema = z.object({
  call_id: z.string(),
  name: z.string(),
  status: z.string(),
  args: z.unknown().optional(),
  result: z.unknown().optional(),
})
export type StreamedCall = z.infer<typeof StreamedCallSchema>

/** Arguments named by one field are told by it: a command, a path, a pattern. */
const NAMED_INPUT = ["command", "path", "file_path", "filePath", "pattern", "query", "url"] as const
const ArgsSchema = z.record(z.string(), z.json())
const ResultSchema = z.object({ status: z.string().optional(), value: z.json().optional(), error: z.json().optional() })
const DiffSchema = z.object({ diffString: z.string() })
const OutputSchema = z.object({ exitCode: z.number().nullable().optional(), stdout: z.string().optional(), stderr: z.string().optional() })
  .refine((output) => output.exitCode !== undefined || output.stdout !== undefined || output.stderr !== undefined)

function inputText(message: StreamedCall): string | undefined {
  if (message.args === undefined) return undefined
  const parsed = ArgsSchema.safeParse(message.args)
  if (!parsed.success) {
    const text = z.string().safeParse(message.args)
    return text.success ? text.data : undefined
  }
  const fields = Object.keys(parsed.data)
  for (const key of NAMED_INPUT) {
    const named = z.string().safeParse(parsed.data[key])
    if (named.success && fields.length === 1) return named.data
  }
  return JSON.stringify(parsed.data)
}

interface CallOutcome {
  failed: boolean
  text: string | undefined
}

/** A finished call's result in words: an edit's diff, a command's exit and output, else its value. */
function callResult(message: StreamedCall): CallOutcome {
  const parsed = ResultSchema.safeParse(message.result)
  const failed = cursorCallErrored(message.status, parsed.success ? parsed.data.status : undefined)
  const value = parsed.success ? parsed.data.value ?? parsed.data.error : undefined
  if (value === undefined || value === null) return { failed, text: undefined }
  const text = z.string().safeParse(value)
  if (text.success) return { failed, text: text.data }
  const diff = DiffSchema.safeParse(value)
  if (diff.success) return { failed, text: diff.data.diffString }
  const output = OutputSchema.safeParse(value)
  if (output.success) {
    const lines = [`exit code ${output.data.exitCode ?? "unknown"}`]
    if (output.data.stdout) lines.push(`stdout:\n${output.data.stdout}`)
    if (output.data.stderr) lines.push(`stderr:\n${output.data.stderr}`)
    return { failed, text: lines.join("\n") }
  }
  return { failed, text: JSON.stringify(value) }
}

/** A call of the run, by its id. */
export interface LoggedCall extends ResumedCall {
  id: string
}

/**
 * The calls one run's stream showed, in the order they started, with what
 * became of each, and which of them the agent was already told of. A call
 * told of is known once a checkpoint lands after the telling: that
 * checkpoint holds the words.
 */
export class RunCallLog {
  private readonly calls = new Map<string, LoggedCall>()
  private told: { ids: ReadonlySet<string>; root: string | undefined } | undefined
  private readonly confirmed = new Set<string>()

  record(message: StreamedCall): void {
    const known = this.calls.get(message.call_id)
    if (message.status === "running") {
      if (!known) this.calls.set(message.call_id, { id: message.call_id, tool: message.name, input: inputText(message), state: "started" })
      else if (message.args !== undefined) known.input = inputText(message)
      return
    }
    const call: LoggedCall = known ?? { id: message.call_id, tool: message.name, input: inputText(message), state: "started" }
    const result = callResult(message)
    call.state = result.failed ? "failed" : "finished"
    call.result = result.text
    if (message.args !== undefined) call.input = inputText(message)
    this.calls.set(message.call_id, call)
  }

  get size(): number {
    return this.calls.size
  }

  /**
   * The calls the agent goes on without seeing, in order: neither in the
   * checkpoint it resumes from (`root`; `known`, the ids whose results that
   * checkpoint holds) nor told of in words a checkpoint since holds.
   */
  unseen(root: string | undefined, known: ReadonlySet<string>): LoggedCall[] {
    if (this.told && this.told.root !== root) {
      for (const id of this.told.ids) this.confirmed.add(id)
      this.told = undefined
    }
    return [...this.calls.values()].filter((call) => !known.has(call.id) && !this.confirmed.has(call.id))
  }

  /** The agent is being told of `calls` on the checkpoint `root`. */
  telling(calls: readonly LoggedCall[], root: string | undefined): void {
    this.told = { ids: new Set(calls.map((call) => call.id)), root }
  }

  ids(): Set<string> {
    return new Set(this.calls.keys())
  }
}

/** The calls as the account names them, without the ids the log keeps them by. */
export function resumedCalls(calls: readonly LoggedCall[]): ResumedCall[] {
  return calls.map((call) => ({ tool: call.tool, input: call.input, state: call.state, ...call.result !== undefined && { result: call.result } }))
}

/**
 * The words a retry sends instead of resuming blind, or `undefined` when
 * every call of the run is in the checkpoint it resumes from. `since` is
 * when that checkpoint was saved, from which the checkout's changes count.
 */
export async function resumeWords(input: {
  calls: RunCallLog
  root: string | undefined
  since: number
  known: (ids: ReadonlySet<string>) => ReadonlySet<string>
  checkout: (since: number) => Promise<RepositoryChanges[]>
}): Promise<{ text: string; calls: number } | undefined> {
  if (!input.calls.size) return undefined
  const unseen = input.calls.unseen(input.root, input.known(input.calls.ids()))
  if (!unseen.length) return undefined
  const checkout = await input.checkout(input.since).catch((): RepositoryChanges[] => [])
  const text = resumeAccountText({ calls: resumedCalls(unseen), checkout, cause: "reconnected" })
  if (!text) return undefined
  input.calls.telling(unseen, input.root)
  return { text, calls: unseen.length }
}
