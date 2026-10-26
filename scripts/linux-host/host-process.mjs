import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"

const run = promisify(execFile)

/**
 * A `mako-host` the Linux kit starts as a machine's agent would: the program
 * from PATH, its data root and socket in its environment, as installed
 * (`MAKO_PROD`). Its output goes to `output`, a file beside its data.
 */
export async function startHost({ dataRoot, output, env = process.env }) {
  const { directory, socket } = runtimeLocation(dataRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await mkdir(dataRoot, { recursive: true })
  const log = await open(output, "a")
  const began = performance.now()
  const child = spawn("mako-host", [], {
    env: { ...env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: socket, MAKO_PROD: "1", MAKO_TELEMETRY: "off" },
    stdio: ["ignore", log.fd, log.fd],
  })
  // The child holds its own copy of the descriptor from here.
  await log.close()
  let exited
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve(exited = { code, signal, ms: performance.now() - began })))
  let probe
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !exited; await delay(25)) {
    probe = await probeRuntime(socket, { timeoutMs: 2_000 }).catch(() => undefined)
    if (probe?.state === "ready") break
  }
  if (probe?.state !== "ready") {
    child.kill("SIGKILL")
    // Its own last words, so a failure inside an image build (whose files go with it) says why: what it
    // printed, else its log, where a crash at start is written.
    const tail = async (file) => (await readFile(file, "utf8").catch(() => "")).trimEnd().split("\n").slice(-40).join("\n")
    const hostLog = join(dataRoot, "logs", "host.log")
    const printed = await tail(output)
    const [file, said] = printed ? [output, printed] : [hostLog, await tail(hostLog)]
    throw new Error(`${exited ? `mako-host exited before it answered (${exited.code ?? exited.signal})` : "mako-host didn't answer /health within 30 s"}; ${said ? `${file} ends:\n${said}` : `${output} and ${hostLog} are empty`}`)
  }
  const client = randomUUID()
  return {
    pid: child.pid,
    socket,
    info: probe.info,
    healthMs: performance.now() - began,
    log: join(dataRoot, "logs", "host.log"),
    call: (channel, ...args) => invokeRuntime(socket, client, channel, args, 1, { timeoutMs: 600_000 }),
    /** SIGTERM, as a machine's agent stops it; resolves with how it exited. */
    async stop(timeoutMs = 15_000) {
      const asked = performance.now()
      if (!exited) child.kill("SIGTERM")
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
      const result = await exit
      clearTimeout(timer)
      return { ...result, stopMs: performance.now() - asked }
    },
  }
}

/**
 * Mako's shared daemons outlive a host by design: terminals survive its
 * restart, and the catalog reader serves the next host. Each leaves on its
 * own, the terminal daemon once its data root is gone, the reader once idle.
 */
export const SHARED_DAEMONS = ["mako-terminal-daemon", "mako-syncd"]

/**
 * Whether a process is one of them: by the title each sets, or, where an
 * x64 image runs emulated on an arm64 Mac and the emulator keeps the command
 * line in place of the title, by the program it runs.
 */
export function sharedDaemon(args) {
  return SHARED_DAEMONS.includes(args) || /\/(?:@mako\/sessions\/dist\/daemon-main|packages\/host\/dist\/terminals\/daemon)\.js(?: |$)/.test(args)
}

/** Every other process in this container: all but this one, its parent and its own children such as ps. */
export async function othersRunning() {
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,args="])
  return stdout.trim().split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([pid, ppid]) => ![process.pid, process.ppid].includes(Number(pid)) && Number(ppid) !== process.pid)
    .map(([pid, ppid, ...args]) => ({ pid: Number(pid), ppid: Number(ppid), args: args.join(" ") }))
}

/** Polls `read` until `done` says the value is final, or fails after `timeoutMs`. */
export async function until(read, done, label, timeoutMs = 60_000) {
  for (const deadline = Date.now() + timeoutMs; ; await delay(200)) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs / 1000} s: ${label}`)
  }
}
