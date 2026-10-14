import type { JSONPath } from "jsonc-parser"
import { z } from "zod"
import type { AuthoringEntry, McpFields } from "../contracts/native-authoring.js"
import type { JsonObject, JsonValue } from "../contracts/json.js"
import type { AuthoringEdit, ReadSource } from "./editing-capability.js"
import { parseMcpDefinition } from "./mcp-registry.js"
import { insertJsonValue, parseJsonc, parseTomlText, removeTomlTables, setJsonValue, setTomlKey, tomlKey, tomlTables } from "./authoring-text.js"

/**
 * MCP servers where each harness keeps them: a map of named servers in JSON
 * or a table of tables in TOML, and the switch that turns one off, which is
 * a key on the server (`enabled = false`, `"disabled": true`) or a list of
 * names in a file of its own (Claude Code's per-project list, Cursor's
 * `mcp-disabled.json`). An edit touches only the server it names.
 */

/** How a server says it's off: a key on it, with the value that means off. */
export interface McpSwitchKey {
  key: string
  off: boolean
}

const ObjectSchema = z.record(z.string(), z.json())
const NamesSchema = z.array(z.string())
const asObject = (value: JsonValue | undefined): JsonObject | null => { const parsed = ObjectSchema.safeParse(value); return parsed.success ? parsed.data : null }

export function mcpEntryId(sourceId: string, name: string): string {
  return `${sourceId}#${encodeURIComponent(name)}`
}

/** Where an MCP entry is: its source and the server's name. */
export interface McpEntryAddress {
  sourceId: string
  name: string
}

export function parseMcpEntryId(id: string): McpEntryAddress {
  const index = id.lastIndexOf("#")
  if (index <= 0) throw new Error("That server is no longer where it was. Reload and try again.")
  return { sourceId: id.slice(0, index), name: decodeURIComponent(id.slice(index + 1)) }
}

function at(value: JsonValue, path: JSONPath): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const key of path) current = asObject(current)?.[String(key)]
  return current
}

/** Names, transport and where it runs; credentials never: environment and header values stay behind. */
function fields(name: string, value: JsonValue): McpFields | null {
  const raw = asObject(value)
  if (!raw) return null
  const command = z.array(z.string()).safeParse(raw.command)
  const normalized: JsonObject = command.success
    ? { ...raw, command: command.data[0] ?? "", args: command.data.slice(1), env: raw.environment ?? raw.env ?? {} }
    : raw
  const definition = parseMcpDefinition(name, normalized)
  if (!definition) return null
  const result: McpFields = { transport: definition.transport, envNames: definition.envNames, headerNames: definition.headerNames }
  if (definition.command) result.command = definition.command
  if (definition.args) result.args = definition.args
  if (definition.url) result.url = definition.url
  return result
}

/** The servers in a parsed file, under `root`; `skip` leaves out keys that aren't servers (OpenCode's `timeout`). */
export function readMcpServers(source: ReadSource, value: JsonValue, root: JSONPath, switchKey: McpSwitchKey | null, disabled: ReadonlySet<string>, skip: readonly string[] = []): AuthoringEntry[] {
  const servers = asObject(at(value, root)) ?? {}
  return Object.entries(servers).flatMap(([name, server]) => {
    if (skip.includes(name)) return []
    const mcp = fields(name, server)
    if (!mcp) return []
    const off = switchKey !== null && z.boolean().safeParse(asObject(server)?.[switchKey.key]).data === switchKey.off
    const enabled = !off && !disabled.has(name)
    return [{ id: mcpEntryId(source.spec.id, name), sourceId: source.spec.id, name, enabled, mcp }]
  })
}

/** A JSON source's servers, read as the harness reads JSON. */
export function jsonDocument(source: ReadSource): JsonValue {
  return source.text === null ? {} : parseJsonc(source.text, source.spec.path)
}

export function tomlDocument(source: ReadSource): JsonValue {
  return source.text === null ? {} : parseTomlText(source.text, source.spec.path)
}

function edit(source: ReadSource, after: string | null, summary: string): AuthoringEdit {
  if (source.problem) throw new Error(source.problem)
  if (!source.spec.writable.supported) throw new Error(source.spec.writable.reason)
  return { path: source.spec.path, root: source.spec.root, scope: source.spec.scope, format: source.spec.format, before: source.text, after, summary }
}

/** A server's switch key set (off) or removed (on, the harness's default), in a JSON file. */
export function jsonMcpSwitch(source: ReadSource, root: JSONPath, name: string, switchKey: McpSwitchKey, enabled: boolean): AuthoringEdit {
  if (!asObject(at(jsonDocument(source), [...root, name]))) throw new Error(`${name} is no longer in ${source.spec.path}. Reload and try again.`)
  const after = setJsonValue(source.text ?? "", [...root, name, switchKey.key], enabled ? undefined : switchKey.off)
  return edit(source, after, `${enabled ? "Turn on" : "Turn off"} ${name} in ${source.spec.label}`)
}

/** A server removed from a JSON file, and its map with it when that was the last one. */
export function jsonMcpRemove(source: ReadSource, root: JSONPath, name: string): AuthoringEdit {
  const servers = asObject(at(jsonDocument(source), root)) ?? {}
  if (!(name in servers)) throw new Error(`${name} is no longer in ${source.spec.path}. Reload and try again.`)
  const after = setJsonValue(source.text ?? "", Object.keys(servers).length === 1 ? root : [...root, name], undefined)
  return edit(source, after, `Remove ${name} from ${source.spec.label}`)
}

/** The servers of a TOML file, each its own `[<table>.<name>]`. */
export function tomlMcpServers(source: ReadSource, table: string, disabled: ReadonlySet<string>): AuthoringEntry[] {
  return readMcpServers(source, tomlDocument(source), [table], { key: "enabled", off: false }, disabled)
}

/** `enabled = false` written into the server's own table, or removed to turn it back on. */
export function tomlMcpSwitch(source: ReadSource, table: string, name: string, enabled: boolean): AuthoringEdit {
  const before = source.text ?? ""
  if (!tomlTables(before, [table, name]).own) throw new Error(`[${table}.${tomlKey(name)}] isn't its own table in ${source.spec.path}; it's written inline. Edit it in your editor.`)
  const after = setTomlKey(before, [table, name], "enabled", enabled ? null : "false")
  return edit(source, verifyToml(source, after, (value) => {
    const servers = asObject(value[table]) ?? {}
    const server = asObject(servers[name]) ?? {}
    if (enabled) delete server.enabled
    else server.enabled = false
    value[table] = { ...servers, [name]: server }
  }), `${enabled ? "Turn on" : "Turn off"} ${name} in ${source.spec.label}`)
}

export function tomlMcpRemove(source: ReadSource, table: string, name: string): AuthoringEdit {
  const before = source.text ?? ""
  if (!tomlTables(before, [table, name]).own) throw new Error(`[${table}.${tomlKey(name)}] isn't its own table in ${source.spec.path}; it's written inline. Edit it in your editor.`)
  return edit(source, verifyToml(source, removeTomlTables(before, [table, name]), (value) => {
    const servers = asObject(value[table]) ?? {}
    delete servers[name]
    value[table] = servers
  }), `Remove ${name} from ${source.spec.label}`)
}

/**
 * A TOML edit is made on the text, so it is checked on the meaning: the new
 * file must parse to the old one with exactly `expected` applied, or it is
 * refused rather than written. `expected` changes the top-level object it is
 * given; what it reads below that is a copy, so it assigns its changes back.
 */
export function verifyToml(source: ReadSource, after: string, expected: (value: JsonObject) => void): string {
  const value = asObject(tomlDocument(source)) ?? {}
  expected(value)
  const written = parseTomlText(after, source.spec.path)
  if (JSON.stringify(canonical(written)) !== JSON.stringify(canonical(value)))
    throw new Error(`Mako couldn't change ${source.spec.path} without touching something else in it. Edit it in your editor.`)
  return after
}

/** Keys in order and empty tables left out, which TOML can't tell from absent ones once their last key goes. */
function canonical(value: JsonValue): JsonValue {
  const object = asObject(value)
  if (object) return Object.fromEntries(Object.keys(object).sort().flatMap((key) => {
    const inner = canonical(object[key] ?? null)
    return asObject(inner) && !Object.keys(asObject(inner) ?? {}).length ? [] : [[key, inner]]
  }))
  const list = z.array(z.json()).safeParse(value)
  return list.success ? list.data.map(canonical) : value
}

/** Names on a list of servers turned off, as a harness keeps it in a file of its own or under a key. */
export function namesAt(value: JsonValue, path: JSONPath): Set<string> {
  return new Set(NamesSchema.safeParse(at(value, path)).data ?? [])
}

/**
 * A name added to (off) or taken from (on) a list of servers turned off,
 * one element at a time so the rest of the list keeps its layout; the list,
 * or a file that holds only the list, goes when it empties.
 */
export function nameListSwitch(source: ReadSource, path: JSONPath, name: string, enabled: boolean, label: string): AuthoringEdit {
  const names = [...namesAt(jsonDocument(source), path)]
  const index = names.indexOf(name)
  const before = source.text ?? ""
  let after: string | null = source.text
  if (enabled && index !== -1) {
    if (names.length > 1) after = setJsonValue(before, [...path, index], undefined)
    else after = path.length ? setJsonValue(before, path, undefined) : null
  }
  if (!enabled && index === -1) {
    if (names.length) after = insertJsonValue(before, path, names.length, name)
    else after = path.length ? setJsonValue(before, path, [name]) : `${JSON.stringify([name], null, 2)}\n`
  }
  return edit(source, after, `${enabled ? "Turn on" : "Turn off"} ${label} in ${source.spec.label}`)
}
