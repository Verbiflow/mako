#!/usr/bin/env node
import { createReadStream } from "node:fs"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { link, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { imageSize } from "image-size"
import { z } from "zod"
import {
  ControlFault,
  controlFaultData,
  controlInputMessage,
  ControlTargetSchema,
  ControlOperationSchema,
  ControlObserveRequestSchema,
  RecordingOptionsSchema,
  RecordingReceiptSchema,
} from "@mako/control/control"
import { isMainModule } from "./main-module.js"
import {
  readControlSession,
  requestControlSession,
} from "./control-session-client.js"
import {
  SessionOperationSchema,
  SessionDescriptorSchema,
  type SessionOperation,
} from "./control-session-protocol.js"
import { CloudControlConfigSchema } from "./cloud-control-config.js"
import { BrowserCommandSchema } from "./contracts/browser-control.js"

const help = `mako-control — composable commands over one persistent Local Control session

Connect to the sessionFile returned by Mako's mako_control_status, or on Linux:
  mako-control session start --config job.json
  mako-control session stop --session-file /private/session.json

Discovery and exact targets:
  mako-control browsers --session-file session.json
  mako-control connect --browser ID --session-file session.json
  mako-control tabs --browser ID --session-file session.json
  mako-control open --browser ID --url https://example.com --session-file session.json > target.json
  mako-control claim --browser ID --tab ID --session-file session.json > target.json
  mako-control apps --session-file session.json
  mako-control windows --pid 42 --session-file session.json

Read, act and record:
  mako-control observe --target-file target.json --session-file session.json
  mako-control shot --target-file target.json --role button --name Save --output 'Save button.png' --session-file session.json
  mako-control act --target-file target.json --input operation.json --session-file session.json
  mako-control record start --target-file target.json --directory ./recordings --session-file session.json > recording.json
  mako-control record stop --input recording.json --wait --session-file session.json
  mako-control exec --source-file workflow.js --session-file session.json
  mako-control diagnostics --session-file session.json
  mako-control help --session-file session.json

--input, --target-file and --source-file accept - for stdin (one per command).
Every command writes one JSON result to stdout. Errors are JSON on stderr.
shot requires --output; --overwrite explicitly replaces an existing file.
record stop --wait returns after finalization; inspect status and video.
exec waits for completion; state survives separate invocations. No MCP cells.
act accepts a closed operation, e.g. {"kind":"set-text","ref":"...","text":"Hello"}.
Exit zero reports dispatch/results, not proof the UI reached the intended state.
Use handle.expect(...) in exec to verify. Unknown outcomes must never be replayed.
Exit codes: 2 invalid request, 3 unavailable/stale session or target, 4 unknown
outcome, 5 rejected/failed artifact, 130 cancelled. A command exit leaves its
session alive; session stop ends it and finalizes owned recordings.
`
const object = z.record(z.string(), z.json())
async function input(path: string) {
  const stream = path === "-" ? process.stdin : createReadStream(resolve(path))
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 512 * 1024)
      throw new ControlFault(
        "input-limit",
        "Input exceeds 512 KiB.",
        "not-dispatched"
      )
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}
async function output(value: z.infer<ReturnType<typeof z.json>>) {
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(value) + "\n", (error) => {
      if (error)
        reject(
          new ControlFault(
            "output-closed",
            "The result pipe closed; the request may have completed. Do not replay it.",
            "unknown"
          )
        )
      else resolve()
    })
  )
}

async function writeImage(
  output: string,
  image: z.infer<ReturnType<typeof z.json>>,
  overwrite: boolean
) {
  const parsed = z
    .object({ data: z.string(), mimeType: z.enum(["image/png", "image/jpeg"]) })
    .catchall(z.json())
    .parse(image)
  const bytes = Buffer.from(parsed.data, "base64")
  const dimensions = imageSize(bytes)
  const path = resolve(output)
  const temporary = join(dirname(path), `.mako-shot-${randomUUID()}`)
  const file = await open(temporary, "wx", 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
    await file.close()
    if (overwrite) await rename(temporary, path)
    else await link(temporary, path)
  } finally {
    await file.close().catch(() => {})
    await rm(temporary, { force: true })
  }
  const { data, ...metadata } = parsed
  void data
  return {
    ...metadata,
    path,
    bytes: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }
}

export async function runControlCli(
  argv = process.argv.slice(2)
): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "session-file": { type: "string" },
      config: { type: "string" },
      browser: { type: "string" },
      tab: { type: "string" },
      pid: { type: "string" },
      url: { type: "string" },
      "target-file": { type: "string" },
      "source-file": { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      overwrite: { type: "boolean" },
      role: { type: "string" },
      name: { type: "string" },
      directory: { type: "string" },
      fps: { type: "string" },
      "max-side": { type: "string" },
      wait: { type: "boolean" },
    },
  })
  if (values.help || positionals.length === 0) {
    process.stdout.write(help)
    return
  }
  if (positionals.length > 2)
    throw new ControlFault(
      "invalid-request",
      "Unexpected positional arguments. See --help.",
      "not-dispatched"
    )
  const commandKey = ["session", "record"].includes(positionals[0])
    ? positionals.join(" ")
    : positionals[0]
  const flags = new Map<string, string[]>(
    Object.entries({
      "session start": ["config"],
      "session stop": [],
      status: [],
      help: ["input"],
      diagnostics: [],
      browsers: [],
      apps: [],
      windows: ["pid"],
      tabs: ["browser"],
      connect: ["browser"],
      open: ["browser", "url", "input"],
      claim: ["browser", "tab"],
      observe: ["target-file", "input"],
      act: ["target-file", "input"],
      shot: [
        "target-file",
        "input",
        "output",
        "overwrite",
        "role",
        "name",
        "max-side",
      ],
      "record start": [
        "target-file",
        "input",
        "directory",
        "fps",
        "max-side",
        "name",
      ],
      "record stop": ["target-file", "input", "wait"],
      "record status": ["target-file", "input"],
      exec: ["source-file"],
    })
  )
  const allowed = flags.get(commandKey)
  if (
    !allowed ||
    (!["session", "record"].includes(positionals[0]) &&
      positionals.length !== 1)
  )
    throw new ControlFault(
      "invalid-request",
      "Unknown command. See --help.",
      "not-dispatched"
    )
  for (const key of Object.keys(values))
    if (key !== "session-file" && !allowed.includes(key))
      throw new ControlFault(
        "invalid-request",
        `--${key} is not an option for ${commandKey}. See --help.`,
        "not-dispatched"
      )
  if (
    [values.input, values["source-file"], values["target-file"]].filter(
      (value) => value === "-"
    ).length > 1
  )
    throw new ControlFault(
      "invalid-request",
      "Only one input may consume stdin.",
      "not-dispatched"
    )
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  const brokenPipe = () => controller.abort()
  process.stdout.once("error", brokenPipe)
  try {
    const [command, subcommand] = positionals
    if (command === "session" && subcommand === "start") {
      if (process.platform !== "linux")
        throw new ControlFault(
          "unsupported",
          "Local Mac sessions are owned by Mako's host. Use sessionFile from mako_control_status. session start creates an isolated Linux job.",
          "not-dispatched"
        )
      if (!values.config)
        throw new ControlFault(
          "invalid-request",
          "session start requires --config.",
          "not-dispatched"
        )
      const configPath = resolve(values.config)
      const config = CloudControlConfigSchema.parse(
        JSON.parse(await input(configPath))
      )
      if (
        await stat(config.output).then(
          () => true,
          () => false
        )
      )
        throw new ControlFault(
          "invalid-request",
          "Use a new job output directory.",
          "not-dispatched"
        )
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("./cloud-control-main.js", import.meta.url)),
          "--config",
          configPath,
          "--session",
        ],
        { detached: true, stdio: "ignore" }
      )
      const spawned = new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve)
        child.once("error", reject)
      })
      await spawned
      child.unref()
      const file = join(config.output, "session.json")
      try {
        const deadline = Date.now() + config.startupMs + 5000
        for (;;) {
          controller.signal.throwIfAborted()
          const descriptor = await readFile(file, "utf8").then(
            (text) => SessionDescriptorSchema.parse(JSON.parse(text)),
            () => undefined
          )
          if (descriptor) {
            await output({ sessionFile: file, ...descriptor })
            return
          }
          if (Date.now() > deadline || child.exitCode !== null)
            throw new Error(
              "Session startup did not complete; inspect the job output directory."
            )
          await delay(50, undefined, { signal: controller.signal })
        }
      } catch (error) {
        child.kill("SIGTERM")
        throw error
      }
    }
    if (!values["session-file"])
      throw new ControlFault(
        "invalid-request",
        "Supply --session-file from the existing session; no new session was started.",
        "not-dispatched"
      )
    const descriptor = await readControlSession(resolve(values["session-file"]))
    const payload = values.input
      ? object.parse(JSON.parse(await input(values.input)))
      : {}
    const targetFile = values["target-file"]
      ? object.parse(JSON.parse(await input(values["target-file"])))
      : undefined
    const target = targetFile
      ? ControlTargetSchema.parse(targetFile.target ?? targetFile)
      : payload.target === undefined
        ? undefined
        : ControlTargetSchema.parse(payload.target)
    const requiredTarget = () => {
      if (!target)
        throw new ControlFault(
          "invalid-request",
          "Supply --target-file (or a recording receipt with target).",
          "not-dispatched"
        )
      return target
    }
    let operation: SessionOperation
    switch (command) {
      case "session":
        if (subcommand !== "stop") throw new Error("Use session start or stop")
        operation = { method: "stop" }
        break
      case "status":
        operation = { method: "status" }
        break
      case "help":
        operation = { method: "help", args: payload }
        break
      case "diagnostics":
        operation = { method: "diagnostics" }
        break
      case "browsers":
        operation = {
          method: "call",
          command: { action: "targets", kind: "browsers" },
        }
        break
      case "apps":
        operation = {
          method: "call",
          command: { action: "targets", kind: "apps" },
        }
        break
      case "windows":
        operation = {
          method: "call",
          command: {
            action: "targets",
            kind: "windows",
            pid: z.coerce.number().int().positive().parse(values.pid),
          },
        }
        break
      case "tabs":
        operation = {
          method: "call",
          command: {
            action: "targets",
            kind: "pages",
            browser: z.string().min(1).parse(values.browser),
          },
        }
        break
      case "connect":
        operation = {
          method: "call",
          command: {
            action: "connect",
            browser: z.string().min(1).parse(values.browser),
          },
        }
        break
      case "open":
        {
          if (values.url) payload.url = values.url
          const { action, ...args } = BrowserCommandSchema.parse({
            ...payload,
            action: "open",
            browser: z
              .string()
              .min(1)
              .parse(values.browser ?? payload.browser),
          })
          void action
          operation = {
            method: "call",
            command: {
              action: "page",
              name: "open",
              args,
            },
          }
        }
        break
      case "claim":
        operation = {
          method: "call",
          command: {
            action: "page",
            name: "select",
            args: {
              browser: z.string().min(1).parse(values.browser),
              tab: z.string().min(1).parse(values.tab),
            },
          },
        }
        break
      case "observe":
        operation = {
          method: "call",
          command: {
            action: "observe",
            ...ControlObserveRequestSchema.parse({
              ...payload,
              target: requiredTarget(),
            }),
          },
        }
        break
      case "act":
        operation = {
          method: "call",
          command: {
            action: "dispatch",
            target: requiredTarget(),
            operation: ControlOperationSchema.parse(payload),
          },
        }
        break
      case "shot":
        if (!values.output)
          throw new ControlFault(
            "invalid-request",
            "shot requires --output; image bytes never go to stdout.",
            "not-dispatched"
          )
        if (
          !values.overwrite &&
          (await stat(resolve(values.output)).then(
            () => true,
            () => false
          ))
        )
          throw new ControlFault(
            "output-exists",
            "Output exists. Choose another path or pass --overwrite.",
            "not-dispatched"
          )
        {
          const options = object.parse(payload.options ?? {})
          if (values["max-side"]) options.maxSide = Number(values["max-side"])
          const request = {
            ...payload,
            method: "shot",
            target: requiredTarget(),
            options,
          }
          if (values.role || values.name)
            payload.selector = {
              role: z.string().parse(values.role),
              name: z.string().parse(values.name),
            }
          operation = SessionOperationSchema.parse({
            ...request,
            ...payload,
            method: "shot",
            target: request.target,
            options,
          })
        }
        break
      case "record": {
        const request: z.input<typeof SessionOperationSchema> = {
          method: "record",
          target: requiredTarget(),
          operation: z.enum(["start", "stop", "status"]).parse(subcommand),
          wait: values.wait ?? false,
        }
        if (subcommand === "start") {
          const options = object.parse(payload.options ?? {})
          if (values.directory) options.directory = resolve(values.directory)
          if (values.fps) options.fps = Number(values.fps)
          if (values.name) options.name = values.name
          if (values["max-side"]) options.maxSide = Number(values["max-side"])
          request.options = RecordingOptionsSchema.parse(options)
        } else request.id = z.string().min(1).parse(payload.id)
        operation = SessionOperationSchema.parse(request)
        break
      }
      case "exec":
        if (!values["source-file"])
          throw new Error("exec requires --source-file")
        operation = {
          method: "exec",
          source: await input(values["source-file"]),
        }
        break
      default:
        throw new ControlFault(
          "invalid-request",
          `Unknown command ${command}. See --help.`,
          "not-dispatched"
        )
    }
    const reply = await requestControlSession(
      descriptor,
      SessionOperationSchema.parse(operation),
      controller.signal
    )
    if (!reply.ok)
      throw new ControlFault(
        reply.fault.code,
        reply.fault.message,
        reply.fault.outcome
      )
    let value = reply.value
    if (command === "open" || command === "claim") {
      const opened = object.parse(value)
      const target = ControlTargetSchema.parse({
        kind: "page",
        browser: opened.browser,
        tab: opened.tab,
        generation: opened.generation,
        lease: opened.lease,
      })
      const failed = z
        .object({ fault: z.object({ outcome: z.string() }) })
        .safeParse(opened.navigation)
      value = failed.success
        ? { target, navigation: z.json().parse(opened.navigation) }
        : target
      if (failed.success)
        process.exitCode = failed.data.fault.outcome === "unknown" ? 4 : 5
    }
    if (command === "shot")
      value = await writeImage(
        z.string().parse(values.output),
        value,
        values.overwrite ?? false
      )
    if (command === "exec") {
      // The service saves explicit images as artifacts; ordinary values stay lossless.
      value = z
        .array(z.record(z.string(), z.json()))
        .parse(value)
        .map((block) => {
          if (block.type === "image")
            throw new ControlFault(
              "invalid-image-reply",
              "Engine returned inline image data instead of a saved artifact. Do not replay the program.",
              "unknown"
            )
          const text = z.string().safeParse(block.text)
          if (block.type === "text" && text.success) {
            try {
              return {
                type: "result",
                value: z.json().parse(JSON.parse(text.data)),
              }
            } catch {
              return block
            }
          }
          return block
        })
    }
    await output(value)
    if (
      command === "record" &&
      ["failed", "interrupted"].includes(
        RecordingReceiptSchema.parse(value).status
      )
    )
      process.exitCode = 5
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
    process.stdout.removeListener("error", brokenPipe)
  }
}
if (isMainModule(import.meta.url))
  void runControlCli().catch((error) => {
    const detail = controlFaultData(error)
    const code = detail?.code ?? "invalid-request"
    const outcome = detail?.outcome ?? "not-dispatched"
    const message =
      error instanceof z.ZodError
        ? controlInputMessage(
            error,
            "CLI arguments",
            "See mako-control --help for command examples."
          )
        : error instanceof Error
          ? error.message
          : "Command failed"
    process.stderr.write(
      JSON.stringify({
        code,
        outcome,
        message,
      }) + "\n"
    )
    process.exitCode =
      code === "cancelled"
        ? 130
        : outcome === "unknown"
          ? 4
          : outcome === "rejected"
            ? 5
            : /session|unavailable|target|connect|observation|stale-/.test(code)
              ? 3
              : 2
  })
