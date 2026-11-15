import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { processesUsingSync, removeScratch } from "./scratch-processes.mjs"
import { z } from "zod"

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

const RECOVERY_PREFIXES = ["mako-host-load-", "mako-package-inputs-"]
const RecoveryPolicy = z.object({ mode: z.enum(["preview", "remove"]), idleDays: z.number().int().min(1).max(3650) })
const RecoveryRecord = z.object({
  version: z.literal(2), prefix: z.enum(RECOVERY_PREFIXES), generation: z.string().uuid(),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), uid: z.number().int().nonnegative(),
  createdAt: z.number().finite(), expiresAt: z.number().finite(),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), keep: z.boolean(),
}).strict().refine(record => record.expiresAt > record.createdAt)
function recoverySettings() {
  try {
    return RecoveryPolicy.parse(JSON.parse(readFileSync(join(homedir(), ".mako", "scratch-retention.json"), "utf8")))
  } catch { /* Missing or unreadable policy never authorizes recovery. */ }
  return { mode: "preview", idleDays: 7 }
}

/** Fixed script worlds only. The default preview writes nothing; unknown retirement stays locked for review. */
export function recoverScriptScratch(prefix, { parent = process.env.MAKO_THREAD_SCRATCH_DIR || tmpdir(), remove = false } = {}) {
  if (!RECOVERY_PREFIXES.includes(prefix)) throw new Error("Scratch recovery purpose is not supported.")
  const root = realpathSync(parent), entries = []
  for (const name of readdirSync(root).filter(name => name.startsWith(prefix) && name.endsWith(".owner.json")).sort().slice(0, 64)) {
    const note = join(root, name), path = note.slice(0, -".owner.json".length), lock = `${note}.retiring`
    const entry = { path, eligible: false, removed: false, reason: "Ownership or process state is unknown." }
    entries.push(entry)
    let locked = false, lockIdentity
    const releaseLock = () => {
      const current = lstatSync(lock, { bigint: true })
      if (!lockIdentity || !current.isDirectory() || current.isSymbolicLink() || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino) throw new Error("Scratch recovery lock changed.")
      rmdirSync(lock); locked = false
    }
    try {
      const receipt = lstatSync(note, { bigint: true })
      const uid = process.getuid?.()
      if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.nlink !== 1n || Number(receipt.uid) !== uid || (receipt.mode & 0o077n) !== 0n || receipt.size > 16_384n) continue
      const text = readFileSync(note, "utf8"), parsed = RecoveryRecord.safeParse(JSON.parse(text))
      if (!parsed.success || parsed.data.prefix !== prefix || parsed.data.uid !== uid) continue
      const record = parsed.data
      const same = () => {
        const current = lstatSync(path, { bigint: true }), metadata = lstatSync(note, { bigint: true })
        return current.isDirectory() && !current.isSymbolicLink() && Number(current.uid) === uid && String(current.dev) === record.device && String(current.ino) === record.inode &&
          metadata.dev === receipt.dev && metadata.ino === receipt.ino && metadata.isFile() && !metadata.isSymbolicLink() && readFileSync(note, "utf8") === text
      }
      if (record.keep || existsSync(join(path, ".keep"))) { entry.reason = "Explicitly kept."; continue }
      if (!same() || existsSync(lock)) continue
      if (remove) { mkdirSync(lock, { mode: 0o700 }); locked = true; lockIdentity = lstatSync(lock, { bigint: true }) }
      // A reused PID or EPERM is held too. Only positive ESRCH proves the recorded creator has ended.
      let ended = false
      try { process.kill(record.pid, 0) } catch (error) { ended = error?.code === "ESRCH" }
      if (!ended) { entry.reason = "The creator is live or its identity is unknown."; continue }
      if (processesUsingSync(path, true).length) { entry.reason = "A process has this world open."; continue }
      if (!same() || existsSync(join(path, ".keep"))) continue
      entry.eligible = true; entry.reason = "The recorded creator ended and no process holds the world."
      if (!remove) continue
      const retired = `${path}.retiring-${record.generation}`
      renameSync(path, retired)
      const moved = lstatSync(retired, { bigint: true })
      if (!moved.isDirectory() || moved.isSymbolicLink() || String(moved.dev) !== record.device || String(moved.ino) !== record.inode) throw new Error("Scratch retirement identity is unknown.")
      rmSync(retired, { recursive: true, force: false })
      const currentNote = lstatSync(note, { bigint: true })
      if (currentNote.dev !== receipt.dev || currentNote.ino !== receipt.ino || !currentNote.isFile() || currentNote.isSymbolicLink() || readFileSync(note, "utf8") !== text) throw new Error("Scratch recovery receipt changed.")
      rmSync(note); releaseLock()
      entry.removed = true
    } catch { entry.eligible = false; entry.reason = "Recovery is unconfirmed; remaining artifacts are kept for review." }
    finally {
      // No mutation was admitted when an owner or open file held the world. Unknown IO retains its lock.
      if (locked && !entry.eligible && entry.reason !== "Recovery is unconfirmed; remaining artifacts are kept for review.") {
        try { releaseLock() } catch { entry.reason = "Recovery is unconfirmed; remaining artifacts are kept for review." }
      }
    }
  }
  return entries
}

/** Creates one new world. Recovery considers only fixed-purpose versioned receipts, never unregistered folders. */
export function ownedScratch(prefix, { root: given, keep = false } = {}) {
  const parent = process.env.MAKO_THREAD_SCRATCH_DIR || tmpdir()
  mkdirSync(given ? dirname(resolve(given)) : parent, { recursive: true, mode: 0o700 })
  const policy = recoverySettings()
  // The host owns managed roots and their per-Thread keep rules. This recovery is only for standalone temp worlds.
  if (!given && !process.env.MAKO_THREAD_SCRATCH_DIR && policy.mode === "remove" && RECOVERY_PREFIXES.includes(prefix)) {
    const retained = recoverScriptScratch(prefix, { parent, remove: true }).filter(row => !row.removed).length
    if (retained) console.error(`Scratch recovery retained ${retained} worlds; their keep, ownership or live-use guards refused removal.`)
  }
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
  const createdAt = Date.now()
  writeFileSync(note, JSON.stringify({ version: 2, prefix, generation: randomUUID(), pid: process.pid, uid: process.getuid?.(), createdAt, expiresAt: createdAt + policy.idleDays * 86_400_000, device: String(identity.dev), inode: String(identity.ino), keep }), { mode: 0o600, flag: "wx" })
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
