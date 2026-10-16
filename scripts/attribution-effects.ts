import { createHash } from "node:crypto"
import { parseArgs } from "node:util"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import type { Thread } from "../packages/sessions/src/format.ts"
import { savedToolEffects } from "../packages/sessions/src/tool-effect-reading.ts"
import type { ToolEffect } from "../packages/sessions/src/tool-effects.ts"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"

/**
 * A saved session's tool calls with what each reported doing, read through
 * the harness's history reader and `savedToolEffects`: the effects
 * attribution starts from.
 *
 *   npm run attribution:effects -- <harness> <session id or store path> [--patches]
 *
 * Prints each call's status, its tool and its effects by kind and path; a
 * path outside the session's folder is marked. `--patches` adds each
 * change's patch, edit strings or content. Stores are opened read-only.
 */

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { patches: { type: "boolean", default: false } } })
const [harness, wanted] = positionals
if (!harness || !wanted) {
  console.error("Usage: npm run attribution:effects -- <harness> <session id or store path> [--patches]")
  process.exit(2)
}

const stores = new NativeStores(false)
const providers = SAVED_HISTORY_READERS.map((reader) => reader(stores)).filter((provider) => provider.harness === harness)
if (!providers.length) {
  console.error(`No history reader for ${harness}. Readers: ${[...new Set(SAVED_HISTORY_READERS.map((reader) => reader(stores).harness))].join(", ")}`)
  process.exit(2)
}

/** The session at a store path, or the one whose store path names the id (Cursor's SDK names an agent's store by its hash). */
async function find(): Promise<Thread | null> {
  const hashed = createHash("sha256").update(wanted!).digest("hex")
  for (const provider of providers) {
    const direct = wanted!.includes("/") ? await provider.read(wanted!).catch(() => null) : null
    if (direct) return direct
    const files = await provider.discover().catch(() => [])
    const match = files.find((file) => file.path.includes(wanted!) || file.path.includes(hashed))
    const thread = match ? await provider.read(match.path).catch(() => null) : null
    if (thread) return thread
  }
  return null
}

const thread = await find()
for (const provider of providers) provider.close?.()
if (!thread) {
  console.error(`No ${harness} session found for ${wanted}`)
  process.exit(1)
}

const cwd = thread.ref.cwd
const names = new Map<string, string>()
for (const entry of thread.entries) if (entry.type === "tool" && entry.id && entry.name) names.set(entry.id, entry.name)

const calls = savedToolEffects(harness, thread.entries, cwd)
console.log(`${harness} ${thread.ref.nativeId} in ${cwd ?? "(no folder)"}: ${calls.length} calls, ${calls.filter((call) => call.effects.length).length} with effects\n`)
const outside = (path: string) => cwd !== undefined && path !== cwd && !path.startsWith(`${cwd}/`) ? "  (outside the folder)" : ""
for (const [index, call] of calls.entries()) {
  if (!call.effects.length) continue
  console.log(`#${index + 1} ${names.get(call.callId) ?? "tool"} ${call.status}  ${call.callId}`)
  for (const effect of call.effects) console.log(`  ${describe(effect)}`)
}

function describe(effect: ToolEffect): string {
  switch (effect.kind) {
    case "command": {
      const facts = [effect.cwd && `in ${effect.cwd}`, effect.exitCode !== undefined && `exit ${effect.exitCode}`, effect.background && "background"].filter(Boolean).join(", ")
      const named = (effect.named ?? []).map((path) => `\n      names ${path}${outside(path)}`).join("")
      return `command ${oneLine(effect.command)}${facts ? ` (${facts})` : ""}${named}`
    }
    case "rename":
      return `rename ${effect.from}${outside(effect.from)} -> ${effect.to}${outside(effect.to)}`
    case "modify": {
      const how = effect.patch ? `patch, ${effect.patch.match(/^@@ /gm)?.length ?? 0} hunks` : effect.edits ? `${effect.edits.length} edits` : "no patch"
      const shown = options.patches ? `\n${indent(effect.patch ?? effect.edits?.map((edit) => `- ${edit.old}\n+ ${edit.new}${edit.all ? "\n  (every occurrence)" : ""}`).join("\n") ?? "")}` : ""
      return `modify ${effect.path}${outside(effect.path)} (${how})${shown}`
    }
    case "create":
    case "write": {
      const how = effect.content === undefined ? "no content" : `${effect.content.length} characters`
      return `${effect.kind} ${effect.path}${outside(effect.path)} (${how})${options.patches && effect.content !== undefined ? `\n${indent(effect.content)}` : ""}`
    }
    case "delete":
    case "read":
      return `${effect.kind} ${effect.path}${outside(effect.path)}`
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, " ⏎ ")
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}

function indent(text: string): string {
  return text.replace(/\n$/, "").split("\n").map((line) => `      ${line}`).join("\n")
}
