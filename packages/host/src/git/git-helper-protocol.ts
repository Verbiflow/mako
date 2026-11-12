import { z } from "zod"

/** A chunk of a process's input or output: a `Buffer` on one side, whatever IPC's serialization makes of it on the other. */
const bytes = z.custom<Uint8Array>((value) => value instanceof Uint8Array, "bytes")

/** What the host asks its Git helper (`git-helper-main.ts`), each by the id of one `git` process. */
export const HelperAskSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("spawn"),
    id: z.number(),
    file: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    stdin: z.enum(["ignore", "pipe"]),
  }),
  z.object({ t: z.literal("stdin"), id: z.number(), chunk: bytes }),
  z.object({ t: z.literal("stdin-end"), id: z.number() }),
  /** Stop it as the host's runner stops its own: `signal` first, then the group killed and confirmed gone. */
  z.object({ t: z.literal("close"), id: z.number(), signal: z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]).optional() }),
])
export type HelperAsk = z.infer<typeof HelperAskSchema>

/** What an error starting a process says of the call that failed (`ENOENT` for a missing binary or folder), as `Git.run` reads it. */
export const ErrnoFieldsSchema = z.object({ code: z.string().optional(), errno: z.number().optional(), syscall: z.string().optional(), path: z.string().optional() })

/** What the helper says of each process, in the order it happened. */
export const HelperSaysSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("spawned"), id: z.number(), pid: z.number() }),
  z.object({ t: z.literal("out"), id: z.number(), chunk: bytes }),
  z.object({ t: z.literal("err"), id: z.number(), chunk: bytes }),
  ErrnoFieldsSchema.extend({ t: z.literal("error"), id: z.number(), message: z.string() }),
  /** It ended and its group is reaped: `code` and `signal` as Node's `close` says them. */
  z.object({ t: z.literal("close"), id: z.number(), code: z.number().nullable(), signal: z.string().nullable() }),
  /** A `close` the host asked for has finished; `error` when the group couldn't be confirmed gone. */
  z.object({ t: z.literal("closed"), id: z.number(), error: z.string().optional() }),
])
export type HelperSays = z.infer<typeof HelperSaysSchema>
