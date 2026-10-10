/** Legacy display lineage for explicitly known native paths.
 * New live conversations own exact provider bindings in their journals.
 * Old pending folder/time guesses are intentionally discarded when loading.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { ThreadOrigin, ThreadRef } from "@mako/sessions"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { hostEnvironment } from "./host-environment.js"

interface LineageFile {
  version: 1
  byPath: Record<string, ThreadOrigin[]>
}

let state: LineageFile = { version: 1, byPath: {} }
let loaded = false
let saveTimer: NodeJS.Timeout | null = null

function filePath(): string {
  return join(hostEnvironment().dataRoot, "lineage.json")
}

export async function loadLineage(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const parsed = parseLineageFile(await readFile(filePath(), "utf8"))
    if (parsed) state = parsed
  } catch {
    // First run, or an unreadable file: lineage starts empty.
  }
}

function parseLineageFile(raw: string): LineageFile | null {
  const value: JsonValue = JSON.parse(raw)
  const root = objectValue(value)
  const byPathValue = objectValue(root?.byPath)
  if (root?.version !== 1 || !byPathValue)
    return null

  const byPath: Record<string, ThreadOrigin[]> = {}
  for (const [path, chainValue] of Object.entries(byPathValue)) {
    const chain = parseOriginList(chainValue)
    if (!chain) return null
    byPath[path] = chain
  }

  return { version: 1, byPath }
}

function parseOriginList(value: JsonValue | undefined): ThreadOrigin[] | null {
  if (!Array.isArray(value)) return null
  const origins: ThreadOrigin[] = []
  for (const originValue of value) {
    const root = objectValue(originValue)
    const harness = stringValue(root?.harness)
    if (!root || harness === undefined) return null
    const origin: ThreadOrigin = { harness }
    const title = stringValue(root.title)
    if (title !== undefined) origin.title = title
    origins.push(origin)
  }
  return origins
}

function objectValue(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

/**
 * The chain a continuation of `ref` would carry: everywhere the conversation
 * has been, ending with the ref's own life.
 */
export function chainOf(ref: ThreadRef): ThreadOrigin[] {
  return [...(ref.lineage ?? []), { harness: ref.harness, title: ref.title }]
}

/** A continuation whose file we created ourselves binds without guessing. */
export function bindLineageDirect(path: string, chain: ThreadOrigin[]): void {
  state.byPath[path] = chain
  scheduleSave()
}

/** Decorate a ref with its lineage, inheriting the title where it should. */
export function annotate(ref: ThreadRef): ThreadRef {
  const chain = state.byPath[ref.path]
  if (!chain || chain.length === 0) return ref
  const inherited = [...chain].reverse().find((origin) => origin.title)?.title
  // The conversation's name travels with it. The native store's own title is
  // the handoff preamble ("You are continuing a conversation…"), which is
  // provenance, not a name — the title it had before is the one that means
  // anything to the person who started it.
  const preamble =
    ref.title?.startsWith("You are continuing a conversation") ||
    ref.title?.startsWith("# Continuing a conversation") ||
    ref.title?.startsWith("Continuing a conversation")
  const title = inherited && (!ref.title || preamble) ? inherited : ref.title
  return { ...ref, lineage: chain, title }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save()
  }, 1000)
}

async function save(): Promise<void> {
  try {
    await mkdir(dirname(filePath()), { recursive: true })
    await writeFile(filePath(), JSON.stringify(state), "utf8")
  } catch {
    // Lost lineage is cosmetic; the sessions themselves are untouched.
  }
}
