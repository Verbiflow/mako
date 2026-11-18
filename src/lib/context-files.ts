import type { ChatMessage } from "@/lib/types"
import { primaryArgument } from "@/lib/tools"

/**
 * The set of files the agent has actually touched this session, derived from
 * its own tool calls. This is computed in the renderer on purpose: the host
 * already sends the messages, so asking it to track a parallel index would be
 * a second source of truth for something that is a pure function of the log.
 */

export type FileAction = "read" | "edited" | "created"

export interface TouchedFile {
  path: string
  action: FileAction
  /** How many times the agent went back to it — a rough attention signal. */
  count: number
  /** Index of the last message that touched it, for ordering by recency. */
  lastAt: number
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"])
const EDIT_TOOLS = new Set(["edit", "multiedit"])
const CREATE_TOOLS = new Set(["write"])

/** Edited beats created beats read: show the strongest interaction. */
const RANK = { read: 0, created: 1, edited: 2 } satisfies Record<FileAction, number>

export function touchedFiles(messages: ChatMessage[]): TouchedFile[] {
  const byPath = new Map<string, TouchedFile>()

  messages.forEach((message, index) => {
    for (const block of message.blocks) {
      if (block.type !== "toolCall" || !block.name) continue
      const name = block.name.toLowerCase()
      const action: FileAction | null = EDIT_TOOLS.has(name)
        ? "edited"
        : CREATE_TOOLS.has(name)
          ? "created"
          : READ_TOOLS.has(name)
            ? "read"
            : null
      if (!action) continue

      const path =
        primaryArgument(block.arguments) || String(block.arguments ?? "")
      // `grep`/`find` carry a pattern in the primary slot; only keep things
      // that look like a path so the list stays about files.
      if (!path || !looksLikePath(path)) continue

      const existing = byPath.get(path)
      if (existing) {
        existing.count += 1
        existing.lastAt = index
        if (RANK[action] > RANK[existing.action]) existing.action = action
      } else {
        byPath.set(path, { path, action, count: 1, lastAt: index })
      }
    }
  })

  return [...byPath.values()].sort(
    (a, b) => RANK[b.action] - RANK[a.action] || b.lastAt - a.lastAt
  )
}

function looksLikePath(value: string) {
  if (value.length > 240) return false
  if (value.includes("\n")) return false
  return value.includes("/") || /\.\w{1,6}$/.test(value)
}
