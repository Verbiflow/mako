import { join } from "node:path"
import { storeReader, type Pair } from "./decode-compare.ts"

/**
 * What a pair's stores say about the child agents of the session they
 * recorded, against what the pair declares: every child a store names is
 * found and reads through the store's reader with its link to the parent,
 * unless the pair lists it with why it stays partial or missing. A listed
 * child the store now keeps whole, or no longer names, is a line to drop.
 */
export async function pairChildProblems(folder: string, pair: Pair): Promise<string[]> {
  const home = join(folder, "home")
  const problems: string[] = []
  for (const store of pair.stores) {
    const reader = storeReader(store.reader, home)
    try {
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
