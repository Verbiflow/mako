import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

/**
 * A test's scratch folder, gone when the test ends however it ends. A UI test's Chromium profile and Vite cache come to
 * about 200 MB a run, and left behind they filled a Mac's disk. On success it all goes. On a failure or a signal its
 * pictures and video are copied to the kept folder first, and what's kept is bounded. SIGKILL runs nothing, so each
 * folder is noted with its owner's pid, and the next test to start removes those whose owner is gone.
 *
 * `MAKO_KEEP_TEST_SCRATCH=1` keeps it all, for a person reading a run. A folder the caller names (`given`) is the
 * caller's: it's used as it is and left, as CI's upload is.
 */
const OWNED = join(tmpdir(), "mako-test-owned")
export const KEPT = join(tmpdir(), "mako-test-kept")
/** What a kept run and all kept runs may hold. A run past the first is cut, the oldest runs past the second go. */
export const KEPT_RUN_BYTES = 25 * 1024 * 1024
export const KEPT_BYTES = 200 * 1024 * 1024
/** How long a stopped test's children have to end on SIGTERM. */
const CHILD_GRACE_MS = 3_000
/**
 * What outlives a failed run: pictures and video, named here rather than everything but a list of exclusions. A scratch
 * folder can hold a copied credential, and this runs before the disposer of a home made after it, so a file nothing
 * here names goes with its folder.
 */
const EVIDENCE = /\.(?:png|jpe?g|gif|webp|webm|mp4)$/i
/** Never looked in: a home and anything hidden, however it's named inside, and what's all bytes and no evidence. */
const NOT_SEARCHED = /^(?:\..*|home|profile|cache|node_modules|.*user-data.*|.*keychain.*)$/i

const folders = new Set()
const given = new Set()
let installed = false
let signalled = false

function ownerGone(pid) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH"
  }
}

/** Tests start together, so another may have got there first: cleanup never fails a test. */
function ifStillThere(work) {
  try {
    return work()
  } catch {
    return undefined
  }
}

/** Removes what tests that can't clean up (SIGKILL, a power cut) left. */
function sweepLeft() {
  for (const name of readdirSync(OWNED)) {
    ifStillThere(() => {
      const note = join(OWNED, name)
      const pid = Number(readFileSync(note, "utf8"))
      if (!Number.isInteger(pid) || pid <= 0 || !ownerGone(pid)) return
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
      rmSync(note, { force: true })
    })
  }
}

function sizeOf(path) {
  const info = lstatSync(path)
  if (!info.isDirectory()) return info.size
  return readdirSync(path).reduce((sum, name) => sum + (ifStillThere(() => sizeOf(join(path, name))) ?? 0), 0)
}

/** Pictures and video under `folder`. */
function evidenceIn(folder, found = []) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!NOT_SEARCHED.test(entry.name)) evidenceIn(join(folder, entry.name), found)
    } else if (entry.isFile() && EVIDENCE.test(entry.name)) found.push({ path: join(folder, entry.name), size: statSync(join(folder, entry.name)).size })
  }
  return found
}

function keepEvidence(folder) {
  const into = join(KEPT, basename(folder))
  let room = KEPT_RUN_BYTES
  for (const { path, size } of evidenceIn(folder).sort((left, right) => left.size - right.size)) {
    if (size > room) break
    room -= size
    cpSync(path, join(into, path.slice(folder.length)))
  }
  if (!existsSync(into)) return
  let held = 0
  const runs = readdirSync(KEPT).flatMap((name) => ifStillThere(() => [{ path: join(KEPT, name), at: statSync(join(KEPT, name)).mtimeMs }]) ?? [])
  for (const { path } of runs.sort((left, right) => right.at - left.at)) {
    held += ifStillThere(() => sizeOf(path)) ?? 0
    if (held > KEPT_BYTES) ifStillThere(() => rmSync(path, { recursive: true, force: true }))
  }
  console.error(`Kept from this failed run: ${into}`)
}

function finish(failed) {
  for (const folder of folders) {
    folders.delete(folder)
    if (process.env.MAKO_KEEP_TEST_SCRATCH === "1") console.log(`Test scratch kept: ${folder}`)
    else {
      try {
        if (failed) ifStillThere(() => keepEvidence(folder))
      } finally {
        rmSync(folder, { recursive: true, force: true, maxRetries: 3 })
      }
    }
    // A stopped Electron can write once more after its wrapper has gone: the note leaves that to the next sweep.
    if (!signalled) rmSync(join(OWNED, basename(folder)), { force: true })
  }
  for (const folder of given) console.log(`Test evidence: ${folder}`)
  given.clear()
}

/**
 * Its children stopped before their folder goes, or an Electron would go on writing there with nobody left to stop it.
 * SIGTERM first: `.bin/electron` is a wrapper that passes it on, and SIGKILL would orphan the Electron under it.
 */
async function childrenStopped() {
  const running = (process._getActiveHandles?.() ?? []).filter((handle) => handle instanceof ChildProcess && handle.exitCode === null && handle.signalCode === null)
  const ended = running.map((child) => new Promise((resolve) => child.once("exit", resolve)))
  for (const child of running) child.kill("SIGTERM")
  const waited = new Promise((resolve) => setTimeout(resolve, CHILD_GRACE_MS))
  await Promise.race([Promise.all(ended), waited])
  for (const child of running) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
}

function install() {
  if (installed) return
  installed = true
  process.once("exit", (code) => finish(code !== 0))
  for (const [signal, number] of [["SIGINT", 2], ["SIGHUP", 1], ["SIGTERM", 15]])
    process.once(signal, () => {
      signalled = true
      void childrenStopped().finally(() => process.exit(128 + number))
    })
}

/** A new folder named from `prefix` under the temporary folder, or `options.given` as it is. */
export function testScratch(prefix, options = {}) {
  install()
  if (options.given) {
    given.add(options.given)
    return options.given
  }
  mkdirSync(OWNED, { recursive: true })
  sweepLeft()
  const folder = mkdtempSync(join(tmpdir(), prefix))
  folders.add(folder)
  writeFileSync(join(OWNED, basename(folder)), String(process.pid))
  return folder
}
