import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { z } from "zod"
import {
  ControlTargetSchema,
  RecordingOptionsSchema,
} from "@mako/control/control"

export const CONTROL_SESSION_PROTOCOL = 1
export const SessionDescriptorSchema = z
  .object({
    protocol: z.literal(CONTROL_SESSION_PROTOCOL),
    build: z.string().regex(/^[a-f0-9]{64}$/),
    session: z.string().uuid(),
    socket: z.string().min(1),
    pid: z.number().int().positive(),
  })
  .strict()
export type SessionDescriptor = z.infer<typeof SessionDescriptorSchema>
const jsonObject = z.record(z.string(), z.json())
export const SessionOperationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("status") }).strict(),
  z
    .object({ method: z.literal("help"), args: jsonObject.default({}) })
    .strict(),
  z.object({ method: z.literal("diagnostics") }).strict(),
  z.object({ method: z.literal("stop") }).strict(),
  z
    .object({
      method: z.literal("exec"),
      source: z.string().min(1).max(100_000),
    })
    .strict(),
  z.object({ method: z.literal("call"), command: jsonObject }).strict(),
  z
    .object({
      method: z.literal("shot"),
      target: ControlTargetSchema,
      selector: z
        .object({
          role: z.string(),
          name: z.string(),
          within: z
            .array(z.object({ role: z.string(), name: z.string() }).strict())
            .optional(),
        })
        .strict()
        .optional(),
      options: z
        .object({
          format: z.enum(["png", "jpeg"]).optional(),
          quality: z.number().int().min(0).max(100).optional(),
          maxSide: z.number().int().min(256).max(4096).optional(),
        })
        .strict()
        .default({}),
    })
    .strict(),
  z
    .object({
      method: z.literal("record"),
      target: ControlTargetSchema,
      operation: z.enum(["start", "stop", "status"]),
      id: z.string().optional(),
      options: RecordingOptionsSchema.optional(),
      wait: z.boolean().default(false),
    })
    .strict(),
])
export type SessionOperation = z.infer<typeof SessionOperationSchema>
export const SessionRequestSchema = z
  .object({
    protocol: z.literal(CONTROL_SESSION_PROTOCOL),
    build: z.string(),
    session: z.string(),
    requestId: z.string().uuid(),
    operation: SessionOperationSchema,
  })
  .strict()
export const SessionReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), requestId: z.string(), value: z.json() }),
  z.object({
    ok: z.literal(false),
    requestId: z.string(),
    fault: z.object({
      code: z.string(),
      message: z.string(),
      outcome: z.enum(["not-dispatched", "rejected", "unknown"]),
    }),
  }),
])

/** Kept equal to the transitive local engine graph by test-control-session-build. */
export const CONTROL_SESSION_MODULES = [
  "browser-capture",
  "browser-compatibility",
  "browser-connection",
  "browser-control-client",
  "browser-discovery",
  "browser-extension-protocol",
  "browser-extension-registration",
  "browser-installed",
  "browser-observation",
  "browser-page",
  "browser-preference",
  "browser-profile-name",
  "browser-protocol-help",
  "browser-recording",
  "browser-service",
  "browser-tools-runtime",
  "computer-driver-client",
  "computer-input-target",
  "computer-observation-client",
  "computer-paths",
  "contracts/appshots",
  "contracts/browser-control",
  "contracts/control-preview",
  "control-media",
  "control-recording",
  "control-session",
  "control-session-protocol",
  "control-session-server",
  "desk-browser-registration",
  "driver-schema",
  "executable",
  "native-capture",
  "native-recording",
  "process-registration",
] as const
let build: Promise<string> | undefined
/** Exact engine code identity; independent of task arguments or credentials. */
export function controlSessionBuild(): Promise<string> {
  return (build ??= (async () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const files = CONTROL_SESSION_MODULES.map(
      (file) => new URL(`./${file}.${extension}`, import.meta.url)
    )
    const packageRoot = new URL("../packages/control/dist/", import.meta.url)
    const collect = async (directory: URL): Promise<URL[]> => {
      const groups = await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map((entry) =>
          entry.isDirectory()
            ? collect(new URL(`${entry.name}/`, directory))
            : Promise.resolve(
                entry.name.endsWith(".js")
                  ? [new URL(entry.name, directory)]
                  : []
              )
        )
      )
      return groups.flat()
    }
    files.push(...(await collect(packageRoot)))
    files.sort((left, right) => left.href.localeCompare(right.href))
    const contents = await Promise.all(files.map((file) => readFile(file)))
    const hash = createHash("sha256")
    for (const [index, bytes] of contents.entries()) {
      // Contents and relative module identity, never installation paths.
      const file = files[index]
      hash.update(
        file.href.startsWith(packageRoot.href)
          ? `control/${file.href.slice(packageRoot.href.length)}`
          : file.href.slice(new URL("./", import.meta.url).href.length)
      )
      hash.update(bytes)
    }
    return hash.digest("hex")
  })())
}
