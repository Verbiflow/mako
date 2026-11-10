import * as fs from "node:fs"
import { constants as osConstants } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { dirname, join, resolve, parse } from "node:path"
import { pathToFileURL } from "node:url"
import net from "node:net"

const SOURCE_SHA = "89384447ba8f900f6755fc76175876c83b427b52daea68d85b8ad3588696d95e"
const PREFIX = "FLICK_DIAGNOSTIC_STATUS "
const MAX_PACKET = 65536, MAX_MANIFEST = 4096, MAX_LINE = 4096, MAX_OUTPUT = 262144
const FILE = /^flick-diagnostic-[1-9]\d{0,9}-\d{1,16}-[a-z0-9]{1,16}\.json$/
const fail = message => { throw new Error(message) }
const check = (condition, message) => { if (!condition) fail(message) }
const absent = path => { try { fs.lstatSync(path); return false } catch (error) { if (error.code === "ENOENT") return true; throw error } }
const pause = ms => new Promise(done => setTimeout(done, ms))
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const message = error => String(error?.message ?? error).replace(/[^\x20-\x7e]/g, "?").slice(0, 160)

/** No links in any component; the leaf belongs to this uid. System-owned ancestors are allowed. */
function ownedPath(path, directory) {
  check(resolve(path) === path, "noncanonical path")
  let part = parse(path).root
  for (const name of path.slice(part.length).split("/").filter(Boolean)) {
    part = join(part, name)
    const stat = fs.lstatSync(part)
    check(!stat.isSymbolicLink(), "symlink path component")
    if (part !== path) check(stat.isDirectory(), "non-directory ancestor")
  }
  const stat = fs.lstatSync(path)
  check(stat.uid === process.getuid(), "path not owned by this uid")
  check(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1, "not an owned regular single-link file/directory")
  check(fs.realpathSync(path) === path, "resolved path differs")
  return stat
}

/** Read only a closed producer's one bounded regular file; refuse replacement/size changes. */
function readPacket(path) {
  const before = ownedPath(path, false)
  check(before.size > 0 && before.size <= MAX_PACKET, "packet size")
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const opened = fs.fstatSync(fd)
    check(opened.isFile() && opened.nlink === 1 && opened.uid === process.getuid(), "opened file ownership/type")
    check(opened.dev === before.dev && opened.ino === before.ino && opened.size === before.size, "packet replaced before open")
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); check(count > 0, "partial packet read"); offset += count }
    const after = fs.fstatSync(fd), pathAfter = ownedPath(path, false)
    check(after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && pathAfter.ino === opened.ino && pathAfter.dev === opened.dev, "packet changed during read")
    return bytes
  } finally { fs.closeSync(fd) }
}

function inventory(path, max = 64) {
  const directory = fs.opendirSync(path), names = []
  try { let entry; while ((entry = directory.readSync())) { check(names.length < max, "directory inventory over budget"); names.push(entry.name) } }
  finally { directory.closeSync() }
  return names
}

function outputReader() {
  const line = Buffer.alloc(MAX_LINE)
  let length = 0, long = false, total = 0, overflow = false, statusCount = 0, invalid = false, initial, final
  const accept = () => {
    if (!long && length >= PREFIX.length && line.subarray(0, PREFIX.length).toString() === PREFIX) {
      statusCount += 1
      try { check(statusCount <= 2, "too many status lines"); final = JSON.parse(line.subarray(PREFIX.length, length).toString("utf8")); if (statusCount === 1) initial = final } catch { invalid = true }
    } else if (long) invalid = true
    length = 0; long = false
  }
  return {
    feed(bytes) {
      total += bytes.length
      if (total > MAX_OUTPUT) { overflow = true; return }
      for (let offset = 0; offset < bytes.length;) {
        const end = bytes.indexOf(10, offset), stop = end === -1 ? bytes.length : end
        if (!long) { if (length + stop - offset > MAX_LINE) { long = true; length = 0 } else { bytes.copy(line, length, offset, stop); length += stop - offset } }
        if (end === -1) break
        accept(); offset = end + 1
      }
    },
    finish() { if (length || long) invalid = true; return { total, overflow, invalid, statusCount, initial, final } },
  }
}

function statusSchema(status) {
  check(status && ["completed", "diagnostic-unavailable"].includes(status.status), "missing/final status unavailable")
  check(FILE.test(status.file), "status filename/path")
  check(["not-run", "threw", "passed-instrumented-only"].includes(status.oracle), "status oracle")
  check(["throw-original", "abort-before-next-scope", "continue-original-test"].includes(status.disposition), "status disposition")
  check(Array.isArray(status.attempts) && status.attempts.length >= 2 && status.attempts.length <= 4, "attempt count")
  const names = status.attempts.map(each => each.name)
  check(["setup,write", "setup,cleanup,write", "setup,cleanup,readback,write"].includes(names.join(",")), "attempt order/names")
  for (const each of status.attempts) {
    check(["completed", "failed", "timed-out"].includes(each.status), "unsettled status")
    check(!each.lateSettlement || ["completed-after-timeout", "failed-after-timeout"].includes(each.lateSettlement), "late status")
  }
  if (status.status === "completed") check(status.attempts.length === 4 && status.attempts.every(each => each.status === "completed"), "completed status with incomplete attempts")
  return status
}

function validatePacket(bytes, status) {
  const packet = JSON.parse(bytes.toString("utf8"))
  check(packet.mode === "instrumented diagnostic; not normative performance acceptance" && packet.tracing === "removed-not-requested" && packet.screenshot === "removed-not-requested", "packet mode")
  const expected = { operationMs: 1000, captureMs: 15000, rendererBytes: 16384, fileBytes: 65536, files: 1, traceBytes: 0, screenshots: 0, statusBytes: 4096 }
  check(JSON.stringify(packet.budgets) === JSON.stringify(expected), "packet budgets/source schema")
  check(["completed", "diagnostic-unavailable"].includes(packet.status), "packet outcome")
  check(packet.oracle?.status === status.oracle, "packet/status oracle mismatch")
  const lateWriteAbort = status.attempts.at(-1).status !== "completed" && status.disposition === "abort-before-next-scope" && packet.disposition === "continue-original-test"
  check(packet.disposition === status.disposition || lateWriteAbort, "packet/status disposition mismatch")
  check(packet.status !== "completed" || packet.renderer?.status === "active" && packet.renderer?.cleanup === "completed", "completed packet collector unavailable")
  check(packet.primaryThrown === (packet.oracle.status === "threw"), "oracle/primary mismatch")
  check(Array.isArray(packet.attempts) && packet.attempts.length === status.attempts.length - 1, "pre-write packet attempts")
  for (let index = 0; index < packet.attempts.length; index += 1) check(packet.attempts[index].name === status.attempts[index].name && packet.attempts[index].status === status.attempts[index].status, "packet/status attempt mismatch")
  check(packet.attempts.every(each => each.name !== "write"), "packet cannot acknowledge its own write")
  check(packet.primaryThrown === (status.disposition === "throw-original"), "primary failure status")
  if (packet.oracle.tasks) check(Array.isArray(packet.oracle.tasks) && packet.oracle.tasks.length <= 64 && packet.oracle.tasks.every(Number.isFinite), "oracle tasks schema")
  return packet
}

/** A fresh POSIX group belongs only to this invocation. Never signal it again after observing it empty. */
async function childOnce(command, args, options, limits, abort, inspectGroup) {
  const reader = outputReader()
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let code = null, signal = null, spawnError, exited = false, timeout = false, cancelled = null, stderrBytes = 0, deadline, closeTimer
  let closed = false
  const close = new Promise(done => child.once("close", () => { closed = true; done() }))
  const exit = new Promise(done => {
    child.once("error", error => { spawnError = message(error); exited = true; done() })
    child.once("exit", (value, sig) => { code = value; signal = sig; exited = true; done() })
  })
  child.stdout.on("data", bytes => reader.feed(bytes))
  child.stderr.on("data", bytes => { stderrBytes += bytes.length })
  let onAbort
  const cancellation = new Promise(done => {
    onAbort = () => { cancelled = abort.reason === "SIGINT" ? "SIGINT" : "SIGTERM"; done() }
    if (abort?.aborted) onAbort(); else abort?.addEventListener("abort", onAbort, { once: true })
  })
  await Promise.race([exit, cancellation, new Promise(done => { deadline = setTimeout(() => { timeout = true; done() }, limits.runMs) })])
  clearTimeout(deadline)
  let cleanup = "unknown", groupEmpty = false
  const members = () => {
    if (!child.pid) return []
    if (inspectGroup) return inspectGroup(child.pid)
    const table = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 500, maxBuffer: 1048576 })
    return table.split("\n").filter(line => { const [, group, state] = line.trim().split(/\s+/); return Number(group) === child.pid && state && !state.startsWith("Z") })
  }
  const empty = () => { try { if (members().length === 0) { groupEmpty = true; return true } } catch { /* Unknown is never empty. */ } return false }
  const stop = sig => { if (child.pid && !groupEmpty) try { process.kill(-child.pid, sig) } catch (error) { if (error.code !== "ESRCH") cleanup = "unknown" } }
  const awaitEmpty = async ms => { const end = Date.now() + ms; do { if (empty()) return true; await pause(20) } while (Date.now() < end); return false }
  if (empty()) cleanup = "group-empty"
  else {
    stop("SIGTERM")
    if (await awaitEmpty(limits.termMs)) cleanup = "group-empty"
    else { stop("SIGKILL"); if (await awaitEmpty(limits.killMs)) cleanup = "group-empty" }
  }
  // Do not wait forever for close: a leaked inheritor can retain a pipe. An incomplete line fails validation.
  if (!exited) await Promise.race([exit, pause(limits.killMs)])
  await Promise.race([close, new Promise(done => { closeTimer = setTimeout(done, limits.killMs) })])
  clearTimeout(closeTimer)
  child.stdout.destroy(); child.stderr.destroy()
  if (!exited) child.unref() // Unknown cleanup remains a failed manifest-only outcome; no subsequent test is started.
  abort?.removeEventListener("abort", onAbort)
  return { code, signal, spawnError, timeout, cancelled, exited, cleanup, pipesClosed: closed, group: child.pid ?? null, output: reader.finish(), stderrBytes }
}

async function portFree(port) {
  await new Promise((done, reject) => { const server = net.createServer(); server.once("error", reject); server.listen(port, "127.0.0.1", () => server.close(error => error ? reject(error) : done())) })
}

/** Test-only command/limits/writer seams do not exist in the fixed-command CLI. No test is ever retried. */
export async function capture({ parent, upload, cwd, identity, command = "npm", args = ["run", "test:phone-scroll-ui", "--", "--port", "21333"], env = process.env, abort,
  limits = { runMs: 270000, termMs: 2000, killMs: 2000 }, inspectGroup, writeManifest = fs.writeFileSync }) {
  let owned, stage, run, validation = "not-run", error, packetBytes, packetStatus
  const generation = randomUUID()
  const manifest = { generation, kind: "instrumented diagnostic; not normative acceptance", identity, invocations: 0, evidence: {}, limits: { packetBytes: MAX_PACKET, manifestBytes: MAX_MANIFEST, outputBytes: MAX_OUTPUT, statusBytes: MAX_LINE, ...limits } }
  try {
    check(Number.isInteger(limits.runMs) && limits.runMs > 0 && limits.runMs <= 270000 && [limits.termMs, limits.killMs].every(ms => Number.isInteger(ms) && ms > 0 && ms <= 2000), "finite capture/cleanup limits required")
    ownedPath(parent, true); check(resolve(upload) === upload && dirname(upload) === parent, "upload must be a canonical immediate owned-parent child")
    check(absent(upload), "upload already exists")
    owned = fs.mkdtempSync(join(parent, "phone-capture-")); fs.chmodSync(owned, 0o700)
    const input = join(owned, "input"); fs.mkdirSync(input, { mode: 0o700 })
    await portFree(21333)
    check(!abort?.aborted, "cancelled before invocation")
    manifest.invocations = 1
    run = await childOnce(command, args, { cwd, env: { ...env, MAKO_FLICK_DIAGNOSTICS: "1", MAKO_TEST_EVIDENCE: input } }, limits, abort, inspectGroup)
    manifest.test = { code: run.code, signal: run.signal, timeout: run.timeout, cancelled: run.cancelled, spawnError: run.spawnError, exited: run.exited, cleanup: run.cleanup, group: run.group, pipesClosed: run.pipesClosed }
    manifest.output = { bytes: run.output.total, overflow: run.output.overflow, invalid: run.output.invalid, statusLines: run.output.statusCount, stderrBytes: run.stderrBytes }
    check(run.exited && run.cleanup === "group-empty", "writer/process cleanup unknown; packet not inspected")
    check(run.pipesClosed && !run.output.overflow && !run.output.invalid && run.output.statusCount === 2, "missing/truncated/excess output status")
    packetStatus = statusSchema(run.output.final)
    check(run.output.initial?.status === "requested" && run.output.initial.oracle === "not-run" && run.output.initial.file === packetStatus.file && run.output.initial.attempts?.length === 0, "initial status schema")
    manifest.captureStatus = { channel: "stdout observation; file integrity validated separately", status: packetStatus.status, oracle: packetStatus.oracle,
      disposition: packetStatus.disposition, file: packetStatus.file,
      attempts: packetStatus.attempts.map(({ name, status, lateSettlement }) => ({ name, status, lateSettlement })) }
    const directory = join(input, "phone-scroll-ui"); ownedPath(directory, true)
    const names = inventory(directory).filter(name => name.startsWith("flick-diagnostic-") && name.endsWith(".json"))
    check(names.length === 1 && names[0] === packetStatus.file, "packet count/name mismatch")
    packetBytes = readPacket(join(directory, names[0]))
    const packet = validatePacket(packetBytes, packetStatus)
    if (run.code === 0 && !run.timeout && !run.cancelled && !run.signal) {
      check(packetStatus.status === "completed" && packetStatus.oracle === "passed-instrumented-only" &&
        packetStatus.disposition === "continue-original-test" && packet.status === "completed",
      "zero-exit producer did not complete a passing flick oracle")
    }
    manifest.evidence = { status: packetStatus.status, oracle: packet.oracle.status, disposition: packetStatus.disposition, packetBytes: packetBytes.length, packetSha256: hash(packetBytes), write: packetStatus.attempts.at(-1).status, writeObservation: "stdout only; packet does not self-acknowledge" }
    validation = "validated"
  } catch (value) { error = message(value); validation = "unavailable"; packetBytes = undefined }
  manifest.validation = validation; manifest.error = error
  let primary = run?.code !== null && run?.code !== undefined && run.code !== 0 ? run.code : run?.timeout ? 124 : run?.cancelled ? 128 + osConstants.signals[run.cancelled] : abort?.aborted && !run ? 128 + (abort.reason === "SIGINT" ? osConstants.signals.SIGINT : osConstants.signals.SIGTERM) : run?.signal ? 128 + (osConstants.signals[run.signal] ?? 0) : run?.spawnError ? 127 : 0
  if (!primary && (!run || validation !== "validated" || packetStatus?.status !== "completed")) primary = 70
  manifest.exit = primary
  let published = false, publicationError
  try {
    ownedPath(parent, true); check(dirname(upload) === parent && absent(upload), "unsafe upload destination")
    stage = fs.mkdtempSync(join(parent, "phone-upload-stage-")); fs.chmodSync(stage, 0o700)
    const bytes = Buffer.from(JSON.stringify(manifest))
    check(bytes.length <= MAX_MANIFEST, "manifest over budget")
    writeManifest(join(stage, "manifest.json"), bytes, { flag: "wx", mode: 0o600 })
    const actual = readPacket(join(stage, "manifest.json")); check(actual.equals(bytes), "manifest write mismatch")
    if (packetBytes) fs.writeFileSync(join(stage, "packet.json"), packetBytes, { flag: "wx", mode: 0o600 })
    check(inventory(stage, 2).sort().join(",") === (packetBytes ? "manifest.json,packet.json" : "manifest.json"), "unexpected staged entry")
    fs.renameSync(stage, upload); published = true
  } catch (value) { publicationError = message(value); if (!primary) primary = 70 }
  // Leave input/unknown writers and unpublished staging untouched; only the atomically published directory is uploaded.
  return { exit: primary, manifest, published, publicationError, owned, upload, summary: `Phone diagnostic: test=${run?.code ?? "none"} signal=${run?.signal ?? "none"} timeout=${!!run?.timeout}; capture=${validation}; publish=${published}; exit=${primary}. Instrumented only; historical 68ms cause UNKNOWN.` }
}

function sourceIdentity(cwd, commit, tree) {
  check(/^[a-f0-9]{40}$/.test(commit) && /^[a-f0-9]{40}$/.test(tree), "exact commit/tree required")
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, maxBuffer: 1024 }).trim()
  check(git(["rev-parse", "HEAD"]) === commit && git(["rev-parse", "HEAD^{tree}"]) === tree && git(["status", "--porcelain", "--untracked-files=no"]) === "", "source checkout identity/cleanliness")
  check(hash(fs.readFileSync(join(cwd, "scripts/test-phone-scroll-ui.mjs"))) === SOURCE_SHA, "phone source differs from approved bytes")
  return { commit, tree, phoneSha256: SOURCE_SHA, lockSha256: hash(fs.readFileSync(join(cwd, "package-lock.json"))), node: process.versions.node,
    electron: JSON.parse(fs.readFileSync(join(cwd, "node_modules/electron/package.json"), "utf8")).version,
    imageOS: String(process.env.ImageOS ?? "unknown").slice(0, 80), imageVersion: String(process.env.ImageVersion ?? "unknown").slice(0, 80) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const abort = new AbortController()
  const reportingFailed = () => { process.exitCode ||= 70 }
  process.stdout.on("error", reportingFailed); process.stderr.on("error", reportingFailed)
  const onTerm = () => abort.abort("SIGTERM"), onInt = () => abort.abort("SIGINT")
  process.on("SIGTERM", onTerm); process.on("SIGINT", onInt)
  try {
    check(process.platform === "darwin", "representative capture requires macOS")
    const [parent, upload, commit, tree] = process.argv.slice(2), cwd = process.cwd()
    const result = await capture({ parent, upload, cwd, identity: sourceIdentity(cwd, commit, tree), abort: abort.signal })
    process.exitCode = result.exit
    try {
      console.log(result.summary)
      if (result.publicationError) console.error(`Capture publication unavailable: ${result.publicationError}`)
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.summary}\n`)
    } catch { if (!process.exitCode) process.exitCode = 70 }
  } catch (error) { process.exitCode ||= 70; console.error(`Capture unavailable before test: ${message(error)}`) }
  finally { process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt) }
}
