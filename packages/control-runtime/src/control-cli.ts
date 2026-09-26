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
import { controlCommandHelp, controlCommands } from "./control-cli-help.js"
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
/** The service saves explicit images as artifacts; ordinary values stay lossless. */
function execBlocks(value: z.infer<ReturnType<typeof z.json>>) {
  return z
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
      json: { type: "boolean" },
      topic: { type: "string" },
      tool: { type: "string" },
      domain: { type: "string" },
      method: { type: "string" },
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
      format: { type: "string" },
      overwrite: { type: "boolean" },
      role: { type: "string" },
      name: { type: "string" },
      directory: { type: "string" },
      fps: { type: "string" },
      "max-side": { type: "string" },
      wait: { type: "boolean" },
    },
  })
  if (values.help || positionals.length === 0 || positionals[0] === "help") {
    process.stdout.write(
      controlCommandHelp(
        positionals[0] === "help" ? positionals.slice(1) : positionals,
        values.json
      )
    )
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
  const allowed = controlCommands.get(commandKey)?.flags
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
    if (key !== "session-file" && key !== "json" && !allowed.includes(key))
      throw new ControlFault(
        "invalid-request",
        `--${key} is not an option for ${commandKey}. Run mako-control ${commandKey} --help.`,
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
          "Local Mac sessions are attached by Mako at task launch. session start creates an isolated Linux job.",
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
        if (controlFaultData(error)) throw error
        throw new ControlFault(
          controller.signal.aborted ? "cancelled" : "startup-failed",
          controller.signal.aborted
            ? "Session startup cancelled; shutdown was requested. Inspect this job's launcher.json cleanup report before starting another job."
            : "Session startup did not complete; shutdown was requested. Inspect this job's output and launcher.json cleanup report before starting another job.",
          "unknown"
        )
      }
    }
    const sessionFile =
      values["session-file"] ?? process.env.MAKO_CONTROL_SESSION_FILE
    if (!sessionFile)
      throw new ControlFault(
        "invalid-request",
        "No task session is attached. Launch through Mako, use --session-file for an existing session, or session start for an isolated Linux job.",
        "not-dispatched"
      )
    const descriptor = await readControlSession(resolve(sessionFile))
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
      case "api":
        for (const key of ["topic", "tool", "domain", "method"] as const)
          if (values[key] !== undefined) payload[key] = values[key]
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
          if (values.format) options.format = values.format
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
    if (!reply.ok) {
      let shown = false
      if (command === "exec" && reply.output?.length) {
        // Completed steps' output, in the success shape; the fault still decides the exit code.
        try {
          await output(execBlocks(reply.output))
          shown = true
        } catch {
          // An unreadable result must not replace the program's own fault.
        }
      }
      throw new ControlFault(
        reply.fault.code,
        shown ? `${reply.fault.message} Output emitted before the failure is on stdout.` : reply.fault.message,
        reply.fault.outcome
      )
    }
    // The engine has already completed this command. Failure to consume or
    // publish its result must never be presented as a pre-dispatch input error.
    try {
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
      if (command === "exec") value = execBlocks(value)
      const failedRecording =
        command === "record" &&
        ["failed", "interrupted"].includes(
          RecordingReceiptSchema.parse(value).status
        )
      await output(value)
      if (failedRecording) process.exitCode = 5
    } catch (error) {
      if (controlFaultData(error)) throw error
      const io = z.object({ code: z.string().max(80) }).safeParse(error)
      throw new ControlFault(
        "result-unavailable",
        `The command completed, but its result could not be validated or saved${io.success ? ` (${io.data.code})` : ""}. Do not replay it; inspect the same session and target.`,
        "unknown"
      )
    }
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
