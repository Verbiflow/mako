#!/usr/bin/env node
import { fork } from "node:child_process"
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { createControlDirectory } from "./private-socket.js"
import {
  CloudControlConfigSchema,
  CloudParentMessageSchema,
} from "./cloud-control-config.js"

async function main() {
  const { values } = parseArgs({
    options: { config: { type: "string" }, help: { type: "boolean" } },
  })
  if (values.help) {
    process.stdout.write(
      "mako-control session start --config /absolute/job.json\nLinux job-scoped Local Control session supervisor. See docs/local-control-runtime.md.\n"
    )
    return
  }
  if (process.platform !== "linux")
    throw new Error(
      "Standalone cloud control requires Linux; desktop Mac control uses Mako's permission-owning host"
    )
  if (!values.config)
    throw new Error("Supply --config with a trusted job configuration")
  const source = await readFile(values.config, "utf8")
  if (source.length > 16_384)
    throw new Error("Cloud configuration exceeds 16 KiB")
  const config = CloudControlConfigSchema.parse(JSON.parse(source))
  // Never reuse another job's output or recursively delete a caller's directory.
  await mkdir(config.output, { mode: 0o700 })
  const runtime = await createControlDirectory("mako-cloud-")
  let stopping = false
  let finished = false
  let ready = false
  let reason = "worker-exit"
  let deadline: NodeJS.Timeout | undefined
  const child = fork(
    fileURLToPath(new URL("./cloud-control-worker.js", import.meta.url)),
    [],
    {
      detached: true,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      // No provider/cloud credentials or desktop/session environment is inherited.
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        HOME: runtime,
        TMPDIR: runtime,
        MAKO_CONTROL_ARTIFACTS: config.output,
      },
    }
  )
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error
      }
    }
  }
  const stop = (why: string) => {
    if (stopping) return
    stopping = true
    reason = why
    if (child.connected) child.send({ kind: "stop", reason }, () => {})
    deadline = setTimeout(killGroup, config.shutdownMs + 2000)
  }
  process.once("SIGTERM", () => stop("SIGTERM"))
  process.once("SIGINT", () => stop("SIGINT"))
  process.stdout.once("error", () => stop("stdout-closed"))
  child.stdout!.resume()
  child.stderr!.on("data", () => {}) // Worker writes bounded diagnostics to its private result directory.
  child.on("message", (raw) => {
    const message = CloudParentMessageSchema.safeParse(raw)
    if (!message.success) return
    if (message.data.kind === "ready") ready = true
    else {
      finished = message.data.clean
      if (!stopping) reason = message.data.reason
    }
  })
  const timeout = setTimeout(() => stop("deadline"), config.timeoutMs)
  const startup = setTimeout(
    () => stop("startup-timeout"),
    config.startupMs + 1000
  )
  child.on("message", (raw) => {
    if (CloudParentMessageSchema.safeParse(raw).data?.kind === "ready")
      clearTimeout(startup)
  })
  child.send({ kind: "start", config, runtime }, () => {})
  const result = await new Promise<{
    code: number | null
    signal: string | null
  }>((resolve) => {
    child.once("error", () => resolve({ code: 1, signal: null }))
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timeout)
  clearTimeout(startup)
  clearTimeout(deadline)
  process.stdin.pause()
  // The worker is the leader of this job's process group. Also reap grandchildren
  // after an abrupt worker crash, including encoder and browser subprocesses.
  killGroup()
  await rm(runtime, { recursive: true, force: true })
  const receipt = {
    version: 1,
    ready,
    reason,
    clean: finished,
    workerExit: result,
    runtimeRemoved: true,
  }
  const path = join(config.output, "launcher.json")
  await writeFile(`${path}.tmp`, JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  })
  await rename(`${path}.tmp`, path)
  process.exitCode =
    !finished || result.code !== 0
      ? 1
      : reason === "deadline"
        ? 124
        : reason === "SIGTERM"
          ? 143
          : reason === "SIGINT"
            ? 130
            : 0
}
void main().catch((error) => {
  process.stderr.write(
    `Local Control: ${error instanceof Error ? error.message : "startup failed"}\n`
  )
  process.exitCode = 1
})
