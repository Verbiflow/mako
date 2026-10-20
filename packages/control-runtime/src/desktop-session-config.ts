import { z } from "zod"
import { SessionDescriptorSchema } from "./control-session-protocol.js"

export const DesktopSessionConfigSchema = z
  .object({
    taskId: z.string().min(1),
    /** The host's driver broker and this task's grant on it (`DriverBroker.grant`). */
    native: z
      .object({ broker: z.string().min(1), token: z.string().min(1) })
      .strict()
      .optional(),
    browser: z
      .object({ url: z.string(), token: z.string() })
      .strict()
      .optional(),
    artifacts: z.string().optional(),
    /** The JSONL file the worker appends one line to per request. */
    journal: z.string().optional(),
  })
  .strict()
export type DesktopSessionConfig = z.infer<typeof DesktopSessionConfigSchema>

/**
 * From the host to a worker. `bind` carries the listening socket as its
 * handle, and each `connection` one connection that reached the host first.
 */
export const DesktopSessionMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("bind"),
      config: DesktopSessionConfigSchema,
      descriptor: SessionDescriptorSchema,
      directory: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("connection") }).strict(),
  z.object({ kind: z.literal("stop") }).strict(),
])

/** From a worker to the host: loaded and waiting, then serving or not. */
export const DesktopWorkerReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loaded"), build: z.string() }).strict(),
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("failed") }).strict(),
])
export type DesktopWorkerReply = z.infer<typeof DesktopWorkerReplySchema>
