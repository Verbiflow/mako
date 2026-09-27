import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { copyFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { probeRuntime } from "../dist-electron/runtime-connection.js"
import { runtimeLocation } from "../dist-electron/runtime-service.js"

// The standard installed check until successive hosts land: the packaged
// lifecycle for every harness against /Applications/Mako.app itself, each in
// its own verification profile, plus read-only readings of the live host.
// It never restarts, signals or writes to the live host or its profile.
// /Applications has no node_modules above it, so nothing from the checkout
// can stand in for a file the bundle lacks.
const HARNESSES = ["claude", "codex", "cursor", "grok", "devin", "opencode"]
const app = "/Applications/Mako.app"
const dataRoot = join(homedir(), "Library/Application Support/mako")
const outFlag = process.argv.find((arg) => arg.startsWith("--out="))
const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
for (const harness of requested) assert.ok(HARNESSES.includes(harness), `Unknown harness ${harness}; use ${HARNESSES.join(", ")}`)
const harnesses = requested.length ? requested : HARNESSES
const build = readLocalAppMetadata(app).makoBuild.id
const out = resolve(outFlag?.slice("--out=".length) ?? `docs/audits/${new Date().toISOString().slice(0, 10)}/installed-${build}`)
await mkdir(out, { recursive: true })
const env = { ...process.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: "/tmp" }

function lines(command, args) {
  try { return execFileSync(command, args, { encoding: "utf8" }).trim().split("\n").filter(Boolean) } catch { return [] }
}

/** Every bundle file the process has open, and whether each is still the installed one. */
async function bundleFiles(pid) {
  const files = []
  let inode
  for (const line of lines("lsof", ["-p", String(pid), "-Fin"])) {
    if (line.startsWith("i")) inode = Number(line.slice(1))
    else if (line.startsWith("n") && line.slice(1).startsWith(`${app}/`) && inode !== undefined) {
      const path = line.slice(1)
      const current = await stat(path).then((file) => file.ino === inode, () => false)
      if (!files.some((file) => file.path === path)) files.push({ path: path.slice(app.length + 1), current })
    }
  }
  return files
}

async function reading(pid) {
  const [row] = lines("ps", ["-o", "lstart=,time=,rss=", "-p", String(pid)])
  if (!row) return { pid, running: false }
  const [cpu, rss] = row.slice(24).trim().split(/\s+/)
  const files = await bundleFiles(pid)
  const executable = lines("lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"]).find((line) => line.startsWith("n/"))?.slice(1)
  const bundle = executable?.match(/^(.*?\.app)\//)?.[1] ?? executable
  return {
    pid,
    running: true,
    startedAt: new Date(row.slice(0, 24)).toISOString(),
    cpuTime: cpu,
    rssKiB: Number(rss),
    threads: Math.max(0, lines("ps", ["-M", "-p", String(pid)]).length - 1),
    bundle,
    installedBuild: bundle === app && files.every((file) => file.current),
    replacedFiles: files.filter((file) => !file.current).map((file) => file.path),
  }
}

async function readings() {
  const probe = await probeRuntime(runtimeLocation(dataRoot).socket).catch((error) => ({ state: "error", error: String(error) }))
  const host = probe.state === "ready" ? probe.info : undefined
  const children = host ? lines("ps", ["-axo", "pid=,ppid=,command="]).map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .filter(([, , ppid]) => Number(ppid) === host.pid) : []
  const child = (pattern) => children.find(([, , , command]) => pattern.test(command))?.[1]
  const terminal = lines("lsof", ["-t", "--", join(dataRoot, "terminal", "daemon.sock")])[0]
  const daemons = {}
  for (const [name, pid] of [["catalog", child(/^mako-syncd\b/)], ["kiri", child(/kiri-engine/)], ["terminal", terminal]])
    daemons[name] = pid ? await reading(Number(pid)) : { running: false }
  return {
    at: new Date().toISOString(),
    host: host ? { instanceId: host.instanceId, version: host.version, ...await reading(host.pid) } : { state: probe.state },
    daemons,
  }
}

function run(name, args, limitMs) {
  return new Promise((resolveRun, reject) => {
    const started = Date.now()
    void open(join(out, `check-${name}.log`), "w").then((log) => {
      const child = spawn(process.execPath, [join("scripts", "test-packaged-lifecycle.mjs"), app, ...args], { env, stdio: ["ignore", log.fd, log.fd] })
      const limit = setTimeout(() => child.kill("SIGTERM"), limitMs)
      child.once("error", reject)
      child.once("exit", (code, signal) => {
        clearTimeout(limit)
        void log.close().then(() => resolveRun({ name, code, signal, seconds: Math.round((Date.now() - started) / 1000) }))
      })
    }, reject)
  })
}

async function report(check) {
  const log = await readFile(join(out, `check-${check.name}.log`), "utf8")
  const path = [...log.matchAll(/Verification report: (\S+result\.json)/g)].at(-1)?.[1]
  if (path) await copyFile(path, join(out, `check-${check.name}.json`)).catch(() => {})
  return { ...check, passed: check.code === 0, report: path ? `check-${check.name}.json` : undefined }
}

const before = await readings()
console.log(`Installed build ${build}; live host ${before.host.pid ?? before.host.state}. Writing to ${out}`)
const checks = []
for (const harness of harnesses) {
  checks.push(await report(await run(harness, [harness, "--stop", "--search"], 900_000)))
  console.log(`${harness}: ${checks.at(-1).passed ? "pass" : "FAIL"} (${checks.at(-1).seconds} s)`)
}
checks.push(await report(await run("terminal", ["claude", "--renderer-only", "--terminal"], 600_000)))
console.log(`terminal: ${checks.at(-1).passed ? "pass" : "FAIL"} (${checks.at(-1).seconds} s)`)
const after = await readings()
const undisturbed = before.host.instanceId !== undefined && before.host.instanceId === after.host.instanceId
const receipt = {
  app,
  build,
  checks,
  liveHost: { undisturbed, before, after },
  passed: checks.every((check) => check.passed) && undisturbed,
}
await writeFile(join(out, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`)
for (const [name, daemon] of Object.entries(after.daemons))
  if (daemon.running && !daemon.installedBuild) console.log(`Note: the live ${name} daemon (pid ${daemon.pid}, since ${daemon.startedAt}) is not the installed build; it runs from ${daemon.bundle}${daemon.replacedFiles.length ? ` with replaced ${daemon.replacedFiles.join(", ")}` : ""}`)
console.log(`${receipt.passed ? "PASS" : "FAIL"}: receipt ${join(out, "receipt.json")}`)
process.exitCode = receipt.passed ? 0 : 1
