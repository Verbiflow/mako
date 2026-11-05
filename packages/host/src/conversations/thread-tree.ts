import type { ThreadParent } from "../contracts/agents.js"

interface Edges {
  of(child: string): ThreadParent | undefined
  children(parent: string): readonly ThreadParent[]
}

/** How deep a tree is read: its edges can't loop, and this holds if a store's ever did. */
const TREE_DEPTH = 64

/** The Thread at the top of `thread`'s tree. */
export function rootThread(edges: Edges, thread: string): string {
  let at = thread
  for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
    const parent = edges.of(at)?.parent
    if (!parent) return at
    at = parent
  }
  return at
}

/**
 * Every Fin of the tree `thread` is part of, from its top Apex down: its own Fins, the Fins beside it and theirs. The
 * Threads an Apex and its Fins may read of each other (`thread_history`) and name (`context`).
 */
export function treeEdges(edges: Edges, thread: string): ThreadParent[] {
  const found: ThreadParent[] = []
  const visit = (parent: string, depth: number) => {
    for (const edge of edges.children(parent)) {
      found.push(edge)
      if (depth < TREE_DEPTH) visit(edge.child, depth + 1)
    }
  }
  visit(rootThread(edges, thread), 0)
  return found
}
