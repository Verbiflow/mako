import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { z } from "zod"
import { ControlScopeSchema, ControlSelectorSchema } from "@mako/control/control/scope"
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
export const ControlJsInputSchema = z.object({
  code: z.string().min(1).max(100_000).describe("JavaScript with top-level await; normal bindings persist between calls."),
  timeout_ms: z.number().int().min(1).max(60_000).default(30_000).describe("Execution deadline in milliseconds, 1–60000. Timeout resets program bindings; never replay an uncertain action."),
  title: z.string().min(1).max(100).optional().describe("Short description of the operation for the user."),
}).strict()
export const CONTROL_HELP_TOPICS = [
  "discovery",
  "connection",
  "handles",
  "actions",
  "observations",
  "assertions",
  "recording",
  "page",
  "native",
  "output",
  "examples",
] as const
const jsonObject = z.record(z.string(), z.json())
const elementSelectorSchema = ControlSelectorSchema.extend({
  within: z.array(ControlScopeSchema).optional(),
}).strict()
/** The ref-free forms of dispatch operations; the locator supplies the ref. */
const locatorOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set-text"), text: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal("activate") }).strict(),
  z
    .object({
      kind: z.literal("press-key"),
      key: z.string().min(1).max(32),
      modifiers: z.array(z.string().min(1).max(32)).max(4).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("select-option"),
      value: z.string().max(4096).optional(),
      label: z.string().max(4096).optional(),
    })
    .strict()
    .refine(
      (operation) =>
        (operation.value === undefined) !== (operation.label === undefined),
      { message: "Pass exactly one of value or label" }
    ),
])
export const SessionOperationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("status") }).strict(),
  ControlJsInputSchema.extend({ method: z.literal("js") }),
  z.object({ method: z.literal("js-reset") }).strict(),
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
      selector: elementSelectorSchema.optional(),
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
  z
    .object({
      method: z.literal("act"),
      target: ControlTargetSchema,
      selector: elementSelectorSchema,
      operation: locatorOperationSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("expect"),
      target: ControlTargetSchema,
      expectation: jsonObject,
      options: z
        .object({
          timeoutMs: z.number().int().optional(),
          everyMs: z.number().int().optional(),
        })
        .strict()
        .default({}),
    })
    .strict(),
  z.object({ method: z.literal("close"), target: ControlTargetSchema }).strict(),
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
    /** Blocks a failed program emitted before its fault, images already saved. */
    output: z.array(z.json()).optional(),
    /** State-changing calls the failed program made, as programErrorText names them. */
    ran: z.array(z.string()).optional(),
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
