import { z } from "zod"

/**
 * What a tool call did to the machine, as its harness reported it: the
 * files it created, changed, deleted, renamed or read, the commands it ran
 * and the processes it left running.
 *
 * Every harness's decoder derives these from the call it already decodes
 * (its identity in `tool-identity.ts`, its arguments and its result), the
 * same way live and saved, so a Claude `Edit`, a Codex `apply_patch`, a
 * Cursor edit and an OpenCode `write` all say "modified src/a.ts with this
 * patch". They are what a harness *said*: attribution joins them with what
 * the file system observed before it puts a change on a Thread, and never
 * treats a report alone as proof that bytes changed.
 *
 * Paths are absolute. A path a harness gave relative is resolved against the
 * folder the call ran in; one that can't be resolved is left out rather than
 * guessed.
 */

/** The most text one effect carries in a field; a longer one is left out, never cut. */
export const MAX_EFFECT_TEXT = 2_000_000
/** A unified diff of one file, as `diff -u` writes it, without the `---`/`+++` header. */
const Patch = z.string().max(MAX_EFFECT_TEXT)
const AbsolutePath = z.string().min(1).startsWith("/")
/**
 * One replacement an edit made, as the tool stated it: `old` became `new`,
 * once, or at every occurrence with `all`. Exact against the file's content
 * rather than its lines: applied in order to the content before the call, the
 * edits give the content after it.
 */
const Edit = z.object({ old: z.string().max(MAX_EFFECT_TEXT), new: z.string().max(MAX_EFFECT_TEXT), all: z.literal(true).optional() })
/**
 * The harness saw this file change on disk while the call ran (Claude's
 * `bashEditDiff`) rather than the tool stating it made the change: another
 * process's write in that stretch is listed the same way.
 */
const Seen = z.literal(true).optional()

export const ToolEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    path: AbsolutePath,
    /** The whole content the tool wrote, when it said; a large one is left out. */
    content: z.string().max(2_000_000).optional(),
    seen: Seen,
  }),
  z.object({
    kind: z.literal("modify"),
    path: AbsolutePath,
    /** The change, when the tool stated it with line numbers: a patch it applied, or the hunks it reported. */
    patch: Patch.optional(),
    /** The change, when the tool stated it as text it replaced and no line numbers: an edit's old and new strings. */
    edits: z.array(Edit).max(256).optional(),
    seen: Seen,
  }),
  z.object({
    kind: z.literal("write"),
    path: AbsolutePath,
    /** A whole-file write whose tool doesn't say whether the file existed: create or modify, decided against the disk. */
    content: z.string().max(2_000_000).optional(),
  }),
  z.object({ kind: z.literal("delete"), path: AbsolutePath, seen: Seen }),
  z.object({ kind: z.literal("rename"), from: AbsolutePath, to: AbsolutePath }),
  z.object({ kind: z.literal("read"), path: AbsolutePath }),
  z.object({
    kind: z.literal("command"),
    command: z.string().max(64_000),
    /** The folder it ran in. */
    cwd: AbsolutePath.optional(),
    exitCode: z.number().int().optional(),
    /** Paths the command line names, resolved against `cwd`: evidence, not a claim that it wrote them. */
    named: z.array(AbsolutePath).max(256).optional(),
    /** Started in the background; its end arrives later as background work. */
    background: z.boolean().optional(),
  }),
])
export type ToolEffect = z.infer<typeof ToolEffectSchema>

/** The effects of one tool call, with what identifies the call. */
export interface ToolEffects {
  /** The call's id in its harness, the same live and saved. */
  callId: string
  /** When the call started and ended, in epoch milliseconds, where the source says. */
  startedAt?: number
  endedAt?: number
  /** Whether the call finished, failed or was refused; a refused call changed nothing. */
  status: "completed" | "failed" | "refused" | "running"
  effects: ToolEffect[]
}
