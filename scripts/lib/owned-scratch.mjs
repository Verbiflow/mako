import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { processesUsingSync, removeScratch } from "./scratch-processes.mjs"

const exits = new Set()
const signals = new Map()
function registerExit(listener) {
  exits.add(listener); process.once("exit", listener)
  for (const [signal, number] of [["SIGINT", 2], ["SIGHUP", 1], ["SIGTERM", 15]]) {
    if (signals.has(signal)) continue
    const onSignal = () => {
      // A caller's resource owner handles its own signal. Otherwise turn default termination into an exit
      // that can run the same guarded filesystem cleanup; this adds no child-signal authority.
      if (process.listeners(signal).some(other => other !== onSignal)) return
      process.exit(128 + number)
    }
    signals.set(signal, onSignal); process.on(signal, onSignal)
  }
}
function unregisterExit(listener) {
  exits.delete(listener); process.removeListener("exit", listener)
  if (!exits.size) {
    for (const [signal, listener] of signals) process.removeListener(signal, listener)
    signals.clear()
  }
}

/** One newly acquired script world. Never adopts or sweeps existing folders. */
export function ownedScratch(prefix, { root: given, keep = false } = {}) {
  const parent = process.env.MAKO_THREAD_SCRATCH_DIR || tmpdir()
  mkdirSync(given ? dirname(resolve(given)) : parent, { recursive: true, mode: 0o700 })
  // A caller-provided existing world may be retained evidence, not ours to overwrite or remove.
  const path = given ? (mkdirSync(resolve(given), { mode: 0o700 }), realpathSync(given)) : realpathSync(mkdtempSync(join(parent, prefix)))
  const note = `${path}.owner.json`
  let identity, noteIdentity, state = "open", pending
  const same = () => {
    const current = lstatSync(path, { bigint: true })
    return identity && current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino
  }
  const removeNote = () => {
    if (!noteIdentity) return
    const current = lstatSync(note, { bigint: true })
    if (current.dev !== noteIdentity.dev || current.ino !== noteIdentity.ino || !current.isFile() || current.isSymbolicLink()) throw new Error("Scratch receipt changed; kept for review.")
    rmSync(note)
  }
  const preserve = () => {
    if (!process.env.MAKO_THREAD_SCRATCH_DIR) return
    const managed = realpathSync(process.env.MAKO_THREAD_SCRATCH_DIR), part = relative(managed, path)
    if (part && part !== ".." && !part.startsWith(`..${sep}`) && !part.startsWith(sep)) writeFileSync(join(managed, ".keep"), "", { mode: 0o600 })
  }
  // Registered before stat/metadata/caller callbacks. Unknown identity or liveness means retained, never guessed gone.
  const onExit = () => {
    if (state !== "open") return
    try {
      if (keep || existsSync(join(path, ".keep"))) { preserve(); state = "kept"; return }
      if (!same() || processesUsingSync(path).length) { state = "unknown"; return }
      rmSync(path, { recursive: true, force: false }); removeNote(); state = "removed"
    } catch { state = "unknown" }
  }
  registerExit(onExit)
  identity = lstatSync(path, { bigint: true })
  writeFileSync(note, JSON.stringify({ generation: randomUUID(), pid: process.pid, device: String(identity.dev), inode: String(identity.ino), keep }), { mode: 0o600, flag: "wx" })
  noteIdentity = lstatSync(note, { bigint: true })
  if (keep) { writeFileSync(join(path, ".keep"), "", { mode: 0o600 }); preserve() }
  return {
    path,
    dispose() {
      if (pending) return pending
      state = "closing"
      pending = Promise.resolve().then(async () => {
        if (keep || existsSync(join(path, ".keep"))) { preserve(); state = "kept"; return }
        if (!same()) throw new Error("Scratch identity changed; kept for review.")
        // Callers first stop their owned resources. A survivor or unreadable probe is a failure, not permission to delete.
        await removeScratch(path)
        removeNote()
        state = "removed"
      }).catch(error => { state = "unknown"; throw error }).finally(() => unregisterExit(onExit))
      return pending
    },
  }
}
