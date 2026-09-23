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

let build: Promise<string> | undefined
/** Exact engine code identity; independent of task arguments or credentials. */
export function controlSessionBuild(): Promise<string> {
  return (build ??= (async () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const runtimeRoot = new URL("./", import.meta.url)
    const packageRoot = new URL("./", import.meta.resolve("@mako/control"))
    const collect = async (directory: URL): Promise<URL[]> => {
      const groups = await Promise.all(
        (await readdir(directory, { withFileTypes: true })).map((entry) =>
          entry.isDirectory()
            ? collect(new URL(`${entry.name}/`, directory))
            : Promise.resolve(
                entry.name.endsWith(`.${extension}`)
                  ? [new URL(entry.name, directory)]
                  : []
              )
        )
      )
      return groups.flat()
    }
    const [runtimeFiles, coreFiles] = await Promise.all([
      collect(runtimeRoot),
      // The pure package always executes its built worker, even under tsx.
      (async () => {
        const entries = await readdir(packageRoot, {recursive:true})
        return entries.filter(name => name.endsWith(".js")).map(name => new URL(name, packageRoot))
      })(),
    ])
    const files = [...runtimeFiles, ...coreFiles]
    const modules = files.map(file => ({
      file,
      name: file.href.startsWith(packageRoot.href)
        ? `control/${file.href.slice(packageRoot.href.length)}`
        : `runtime/${file.href.slice(new URL("./", import.meta.url).href.length)}`,
    })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    const contents = await Promise.all(modules.map(({ file }) => readFile(file)))
    const hash = createHash("sha256")
    for (const [index, bytes] of contents.entries()) {
      hash.update(modules[index].name).update("\0").update(String(bytes.length)).update("\0").update(bytes)
    }
    return hash.digest("hex")
  })())
}
