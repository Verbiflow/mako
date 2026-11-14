import { readMessage } from "@mako/sessions/context-wire"
import type { ThreadParent } from "../contracts/agents.js"
import type { LiveRequest } from "../contracts/live-conversations.js"

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

/** A thread a message attached, as its `<mako_context>` item names it. */
export interface HeldReference {
  ref: string
  harness?: string
  title?: string
}

/**
 * What these messages give their Thread to read, once each, which `thread_history` and `reachOf` both go by. A person's
 * chips, as the `<mako_context>` items their words carry, and what the host stored as a message's grants (`grants`).
 * Items in an agent's text are only text: a Fin that spells out a block grants nothing, whatever it reads back as.
 */
export function heldReferences(requests: readonly Pick<LiveRequest, "text" | "actor" | "grants">[]): HeldReference[] {
  const found = new Map<string, HeldReference>()
  for (const request of requests) {
    const persons = !request.actor || request.actor.kind === "person"
    const items = readMessage(request.text).items
    for (const item of items) {
      const ref = item.kind === "conversation" ? item.attrs.ref : undefined
      if (!ref?.startsWith("thread:") || found.has(ref) || !(persons || request.grants?.includes(ref))) continue
      found.set(ref, { ref, ...(item.attrs.harness && { harness: item.attrs.harness }), ...(item.attrs.title && { title: item.attrs.title }) })
    }
    for (const ref of request.grants ?? []) if (!found.has(ref)) found.set(ref, { ref })
  }
  return [...found.values()]
}
