import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { nativeFileOf, rescansFor, writtenSession } from "../packages/sessions/src/catalog.ts"
import type { NativeFile, SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { storeReader, type Pair } from "./decode-compare.ts"

/**
 * What a pair's stores say about the child agents of the session they
 * recorded, against what the pair declares: every child a store names is
 * found and reads through the store's reader with its link to the parent,
 * unless the pair lists it with why it stays partial or missing. A listed
 * child the store now keeps whole, or no longer names, is a line to drop.
 * The catalog lists the pair's own store as a session and nothing else,
 * found by discovery or by a write to any file the pair keeps: a child's
 * transcript peeked as a session of its own named its parent (Claude's child
 * lines carry the parent's `sessionId`), and a write to it moved the
 * parent's conversation to the child.
 */
export async function pairChildProblems(folder: string, pair: Pair): Promise<string[]> {
  const home = join(folder, "home")
  const problems: string[] = []
  for (const store of pair.stores) {
    const reader = storeReader(store.reader, home)
    try {
      if (!pair.stores.slice(0, pair.stores.indexOf(store)).some((earlier) => earlier.reader === store.reader)) {
        const own = new Set(pair.stores.filter((kept) => kept.reader === store.reader).map((kept) => join(home, kept.path)))
        const rows = new Set<string>()
        const listed = async (file: NativeFile, how: string) => {
          const ref = await reader.peek(file)
          if (!ref) return
          if (own.has(file.path)) rows.add(file.path)
          else problems.push(`${store.reader} lists ${relative(home, file.path)} as session ${ref.nativeId} ${how}; only the stores the pair keeps are sessions`)
        }
        for (const file of await reader.discover()) await listed(file, "when discovered")
        for (const path of await written(reader)) {
          const file = await nativeFileOf(reader, path)
          if (file) await listed(file, "when written")
        }
        for (const path of own) if (!rows.has(path)) problems.push(`${store.reader} does not list its store ${relative(home, path)} as a session`)
      }
      const listed = (await reader.children?.(join(home, store.path))) ?? []
      const declared = store.children ?? []
      for (const child of listed) {
        const note = declared.find((entry) => entry.nativeId === child.nativeId)
        if (child.path) {
          const thread = await reader.read(child.path).catch(() => null)
          if (!thread?.entries.length) problems.push(`${store.reader} child ${child.nativeId} is found at ${child.path} but reads no transcript`)
          else if (!thread.ref.childOf) problems.push(`${store.reader} child ${child.nativeId} reads without its link to the parent (ref.childOf)`)
        }
        if (child.state.kind === "complete") {
          if (note) problems.push(`${store.reader} child ${child.nativeId} is listed as ${note.state}, but the store keeps it whole now; drop it`)
        } else if (!note) problems.push(`${store.reader} child ${child.nativeId} is ${child.state.kind} (${child.state.reason}); list it under the store's children with why that stays`)
        else if (note.state !== child.state.kind) problems.push(`${store.reader} child ${child.nativeId} is listed as ${note.state}, but reads ${child.state.kind} (${child.state.reason})`)
      }
      for (const note of declared)
        if (!listed.some((child) => child.nativeId === note.nativeId)) problems.push(`${store.reader} lists child ${note.nativeId}, which the store no longer names; drop it`)
    } finally {
      reader.close?.()
    }
  }
  return problems
}

/** The session file a write to each file under the reader's roots refreshes, as the catalog's watch maps it; a shared store rescans, which discovery covers. */
async function written(reader: SessionProvider): Promise<string[]> {
  const files = (await Promise.all(reader.roots().map((root) => readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])))).flat()
  const targets = files.filter((entry) => entry.isFile()).flatMap((entry) => {
    const target = writtenSession(reader, join(entry.parentPath, entry.name))
    return target && !rescansFor(reader, target) ? [target] : []
  })
  return [...new Set(targets)]
}
