import { applyEdits, modify, parseTree, type JSONPath, type Node as JsonNode, type ParseError } from "jsonc-parser"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import type { AuthoringDiffLine } from "../contracts/native-authoring.js"
import type { JsonValue } from "../contracts/json.js"

/**
 * The text work every native configuration edit shares: reading JSON with
 * comments, changing one value in place, finding a TOML table's lines, and
 * the line diff a preview shows. An edit changes the bytes it names and
 * nothing else, so comments, key order and fields Mako doesn't know survive.
 */

/** Keys whose values are credentials, wherever they sit. */
export const SECRET_KEY = /(?:authorization|api[-_]?key|access[-_]?token|bearer|credential|oauth|password|secret|token|cookie)/i
/** Tables and objects whose every value is a credential or may be one. */
const SECRET_CONTAINERS = new Set(["env", "environment", "headers", "http_headers", "env_http_headers"])
const REDACTED = "[redacted]"

const JsonValueSchema = z.json()

/** JSON or JSON with comments and trailing commas, which is what every harness's JSON config accepts. */
export function parseJsonc(text: string, path: string): JsonValue {
  if (!text.trim()) return {}
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors.length || !tree) throw new Error(`${path} isn't valid JSON (offset ${errors[0]?.offset ?? 0}). Fix it in your editor first.`)
  return JsonValueSchema.parse(nodeValue(tree))
}

function nodeValue(node: JsonNode): JsonValue {
  if (node.type === "object") return Object.fromEntries((node.children ?? []).flatMap((property) => {
    const [key, value] = property.children ?? []
    return key && value ? [[String(key.value), nodeValue(value)]] : []
  }))
  if (node.type === "array") return (node.children ?? []).map(nodeValue)
  return JsonValueSchema.parse(node.value ?? null)
}

/** How a file indents and ends its lines. */
interface Layout {
  tabSize: number
  insertSpaces: boolean
  eol: string
}

/** The file's own indentation and line ending, so an inserted value looks like its neighbours. */
function formatting(text: string): Layout {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? "  "
  return { tabSize: indent.startsWith("\t") ? 1 : indent.length, insertSpaces: !indent.startsWith("\t"), eol: text.includes("\r\n") ? "\r\n" : "\n" }
}

/**
 * How an edit is laid out. jsonc-parser formats the whole lines an edit
 * touches, so a file written on one line would be re-laid out entire: there
 * the edit goes in as is.
 */
function layout(base: string): { formattingOptions?: Layout } {
  return base.trim().includes("\n") ? { formattingOptions: formatting(base) } : {}
}

/** One value set, inserted or (with `undefined`) removed at `path`, everything else byte for byte. */
export function setJsonValue(text: string, path: JSONPath, value: JsonValue | undefined): string {
  const base = text.trim() ? text : "{\n}\n"
  const next = applyEdits(base, modify(base, path, value, layout(base)))
  return next.endsWith("\n") ? next : `${next}\n`
}

/** A new array element at `index` (the end when past it). */
export function insertJsonValue(text: string, path: JSONPath, index: number, value: JsonValue): string {
  const base = text.trim() ? text : "{\n}\n"
  const next = applyEdits(base, modify(base, [...path, index], value, { ...layout(base), isArrayInsertion: true }))
  return next.endsWith("\n") ? next : `${next}\n`
}

/**
 * Command arguments that are credentials: one naming a secret with its value
 * (`--token=…`), and the one after a flag that names a secret (`--token …`),
 * as the MCP registry reads them.
 */
class ArgumentRedaction {
  private next = false

  secret(argument: string): boolean {
    if (this.next) { this.next = false; return true }
    if (!SECRET_KEY.test(argument)) return false
    this.next = !argument.includes("=")
    return !this.next || !argument.startsWith("-")
  }
}

/** Credentials in a JSON text replaced in place, so a diff of the result can cross to the window. */
export function redactJson(text: string): string {
  if (!text.trim()) return text
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  if (!tree) return text.split("\n").map(() => REDACTED).join("\n")
  const spans: { offset: number; length: number }[] = []
  const visit = (node: JsonNode, secret: boolean) => {
    if (node.type === "string" || node.type === "number" || node.type === "boolean") {
      if (secret) spans.push({ offset: node.offset, length: node.length })
      return
    }
    for (const child of node.children ?? []) {
      if (child.type === "property") {
        const [key, value] = child.children ?? []
        const name = String(key?.value ?? "")
        if (value && name === "args" && value.type === "array" && !secret) {
          const flags = new ArgumentRedaction()
          for (const item of value.children ?? []) if (flags.secret(String(item.value ?? ""))) spans.push({ offset: item.offset, length: item.length })
        } else if (value) visit(value, secret || SECRET_CONTAINERS.has(name.toLowerCase()) || SECRET_KEY.test(name))
      } else visit(child, secret)
    }
  }
  visit(tree, false)
  let result = text
  for (const span of spans.sort((left, right) => right.offset - left.offset))
    result = `${result.slice(0, span.offset)}"${REDACTED}"${result.slice(span.offset + span.length)}`
  return result
}

/** One line of a TOML file as the table scanner reads it. */
interface TomlLine {
  text: string
  /** The table header this line opens, as its key path. */
  header?: { path: string[]; array: boolean }
  /** A `key = …` line's key path, relative to its table, and the last line its value runs onto. */
  key?: { path: string[]; end: number }
  /** Part of a value that began on an earlier line (a multi-line string, array or inline table), where nothing is syntax. */
  quoted: boolean
}

/** A TOML key path: bare keys, "basic" and 'literal' quoted keys, joined by dots. */
export function tomlKeyPath(source: string): string[] | null {
  const keys: string[] = []
  let rest = source.trim()
  while (rest) {
    let key: string
    if (rest.startsWith('"')) {
      const match = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
      if (!match) return null
      try { key = z.string().parse(JSON.parse(`"${match[1] ?? ""}"`)) } catch { return null }
      rest = rest.slice(match[0].length)
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1)
      if (end === -1) return null
      key = rest.slice(1, end)
      rest = rest.slice(end + 1)
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest)
      if (!match) return null
      key = match[0]
      rest = rest.slice(key.length)
    }
    keys.push(key)
    rest = rest.trimStart()
    if (!rest) break
    if (!rest.startsWith(".")) return null
    rest = rest.slice(1).trimStart()
  }
  return keys.length ? keys : null
}

/** A key written back into TOML: bare when it can be, quoted otherwise. */
export function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

/** A string as a TOML basic string; JSON's escapes are TOML's. */
export function tomlString(value: string): string {
  return JSON.stringify(value)
}

const HEADER = /^\s*(\[\[?)\s*([^\]]+?)\s*(\]\]?)\s*(?:#.*)?\r?$/
const ASSIGNMENT = /^\s*((?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*'))*)\s*=/
const TRIPLE_BASIC = '"""'
const TRIPLE_LITERAL = "'''"

/**
 * Where a value that starts at `column` of `lines[index]` ends: the line on
 * which its strings are closed and its brackets balanced. Comments and the
 * insides of strings don't count.
 */
function valueEnd(lines: readonly string[], index: number, column: number): number {
  let depth = 0
  let open: string | null = null
  for (let row = index; row < lines.length; row += 1) {
    const line = lines[row] ?? ""
    for (let at = row === index ? column : 0; at < line.length; at += 1) {
      if (open) {
        if (line.startsWith(open, at) && (open === TRIPLE_LITERAL || line[at - 1] !== "\\")) { open = null; at += 2 }
        continue
      }
      const rest = line.slice(at)
      if (rest.startsWith(TRIPLE_BASIC) || rest.startsWith(TRIPLE_LITERAL)) { open = rest.slice(0, 3); at += 2; continue }
      const char = line[at]
      if (char === "#") break
      if (char === '"') { at += (/^"(?:[^"\\]|\\.)*"/.exec(rest)?.[0].length ?? rest.length) - 1; continue }
      if (char === "'") { const close = rest.indexOf("'", 1); at += (close === -1 ? rest.length : close + 1) - 1; continue }
      if (char === "[" || char === "{") depth += 1
      if (char === "]" || char === "}") depth -= 1
    }
    if (!open && depth <= 0) return row
  }
  return lines.length - 1
}

function scanToml(text: string): TomlLine[] {
  const raw = text.split("\n")
  const lines: TomlLine[] = []
  for (let index = 0; index < raw.length; index += 1) {
    const line = raw[index] ?? ""
    const header = HEADER.exec(line)
    if (header && (header[1] === "[[") === (header[3] === "]]")) {
      const path = tomlKeyPath(header[2] ?? "")
      lines.push(path ? { text: line, header: { path, array: header[1] === "[[" }, quoted: false } : { text: line, quoted: false })
      continue
    }
    const assignment = ASSIGNMENT.exec(line)
    const path = assignment ? tomlKeyPath(assignment[1] ?? "") : null
    if (!assignment || !path) { lines.push({ text: line, quoted: false }); continue }
    const end = valueEnd(raw, index, assignment[0].length)
    lines.push({ text: line, key: { path, end }, quoted: false })
    for (let row = index + 1; row <= end; row += 1) lines.push({ text: raw[row] ?? "", quoted: true })
    index = end
  }
  return lines
}

const startsWith = (path: readonly string[], prefix: readonly string[]) => prefix.every((key, index) => path[index] === key)
const blank = (line: TomlLine | undefined) => !line?.quoted && /^\s*(?:#.*)?\r?$/.test(line?.text ?? "")

/** Where one TOML table's lines are: its header and the lines up to the next header. The root table has no header (-1). */
export interface TomlTableSpan {
  header: number
  /** One past the table's last key line, before the blank lines and comments that lead into the next table. */
  body: number
  end: number
}

function tableSpan(lines: readonly TomlLine[], header: number): TomlTableSpan {
  let end = header + 1
  while (end < lines.length && !lines[end]?.header) end += 1
  let body = end
  while (body > header + 1 && blank(lines[body - 1])) body -= 1
  return { header, body, end }
}

/** A table's own span, when it has a header of its own, and the spans of the tables below it. */
export interface TomlTables {
  own: TomlTableSpan | null
  nested: TomlTableSpan[]
}

/** The table at exactly `path` (the root table for `[]`), and every table below it. */
export function tomlTables(text: string, path: readonly string[]): TomlTables {
  const lines = scanToml(text)
  if (!path.length) return { own: tableSpan(lines, -1), nested: [] }
  let own: TomlTableSpan | null = null
  const nested: TomlTableSpan[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.header
    if (!header || !startsWith(header.path, path)) continue
    if (header.path.length === path.length && !header.array) own = tableSpan(lines, index)
    else nested.push(tableSpan(lines, index))
  }
  return { own, nested }
}

/** The table at `path` as a header of its own at the end of the file, unless it's already there. */
export function ensureTomlTable(text: string, path: readonly string[]): string {
  if (tomlTables(text, path).own) return text
  const base = text.replace(/\s*$/, "")
  return `${base}${base ? "\n\n" : ""}[${path.map(tomlKey).join(".")}]\n`
}

/**
 * `key = value` (`value` already TOML) set inside the table at `path`, or
 * removed when `value` is null, replacing every line the old value ran onto.
 * A new key goes after the table's last key, or for the root table before
 * the first header.
 */
export function setTomlKey(text: string, path: readonly string[], key: string, value: string | null): string {
  const { own } = tomlTables(text, path)
  if (!own) throw new Error(`[${path.map(tomlKey).join(".")}] isn't a table of its own in this file. Edit it in your editor.`)
  const lines = text.split("\n")
  const scanned = scanToml(text)
  for (let index = own.header + 1; index < own.end; index += 1) {
    const line = scanned[index]
    if (line?.key?.path.length !== 1 || line.key.path[0] !== key) continue
    const indent = /^\s*/.exec(lines[index] ?? "")?.[0] ?? ""
    lines.splice(index, line.key.end - index + 1, ...(value === null ? [] : [`${indent}${tomlKey(key)} = ${value}`]))
    return lines.join("\n")
  }
  if (value === null) return text
  const assignment = `${tomlKey(key)} = ${value}`
  const headed = scanned.some((line) => line.header)
  if (own.header === -1 && own.body === 0 && headed) lines.splice(0, 0, assignment, "")
  else if (own.header === -1 && !headed && !lines.at(-1)) lines.splice(lines.length - 1, 0, assignment)
  else lines.splice(own.header === -1 && !headed ? lines.length : own.body, 0, assignment)
  return lines.join("\n")
}

/** The table at `path` and every table below it removed, with the comment lines directly above each header. */
export function removeTomlTables(text: string, path: readonly string[]): string {
  const { own, nested } = tomlTables(text, path)
  const spans = own ? [own, ...nested] : nested
  if (!spans.length) return text
  const lines = text.split("\n")
  const scanned = scanToml(text)
  const drop = new Set<number>()
  for (const table of spans) {
    let start = table.header
    while (start > 0 && /^\s*#/.test(lines[start - 1] ?? "") && !scanned[start - 1]?.quoted) start -= 1
    for (let index = start; index < table.end; index += 1) drop.add(index)
  }
  const kept = lines.filter((_, index) => !drop.has(index))
  while (kept.length > 1 && !kept.at(-1)?.trim() && !kept.at(-2)?.trim()) kept.pop()
  return kept.join("\n")
}

/** TOML read the way the harness reads it; a file it can't parse is refused, never rewritten. */
export function parseTomlText(text: string, path: string): JsonValue {
  try { return JsonValueSchema.parse(JSON.parse(JSON.stringify(parseToml(text)))) }
  catch (error) { throw new Error(`${path} isn't valid TOML (${error instanceof Error ? error.message.split("\n")[0] : "unreadable"}). Fix it in your editor first.`, { cause: error }) }
}

/** Credentials in a TOML text replaced line by line: values under an env or headers table, inline or not, and secret-named keys. */
export function redactToml(text: string): string {
  let table: string[] = []
  let secretValue = false
  let flags: ArgumentRedaction | null = null
  const argumentsOf = (line: string, from: number) => line.slice(0, from) + line.slice(from).replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, (quoted) => flags?.secret(quoted.slice(1, -1)) ? `"${REDACTED}"` : quoted)
  return scanToml(text).map((line) => {
    if (line.header) { table = line.header.path; secretValue = false; flags = null; return line.text }
    if (line.quoted) return secretValue ? REDACTED : flags ? argumentsOf(line.text, 0) : line.text
    if (!line.key) return line.text
    secretValue = [...table, ...line.key.path].some((key) => SECRET_CONTAINERS.has(key.toLowerCase()) || SECRET_KEY.test(key))
    flags = !secretValue && line.key.path.at(-1) === "args" ? new ArgumentRedaction() : null
    if (secretValue) return line.text.replace(/=.*$/, `= "${REDACTED}"`)
    return flags ? argumentsOf(line.text, line.text.indexOf("=")) : line.text
  }).join("\n")
}

/** A Markdown file's frontmatter, read as `key: value` lines; the file itself is never rewritten from this. */
export function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match?.[1]) return fields
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (field?.[1]) fields.set(field[1], (field[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2"))
  }
  return fields
}

const CONTEXT_LINES = 2

/**
 * The lines an edit changed, with two lines of context either side. An edit
 * Mako makes touches one place, so the shared head and tail are trimmed in
 * one pass rather than searched for with a full diff.
 */
export function diffLines(before: string, after: string): AuthoringDiffLine[] {
  // A file's last newline ends its last line; it isn't a line of its own.
  const split = (text: string) => text ? text.replace(/\n$/, "").split("\n") : []
  const left = split(before)
  const right = split(after)
  let head = 0
  while (head < left.length && head < right.length && left[head] === right[head]) head += 1
  let tail = 0
  while (tail < left.length - head && tail < right.length - head && left[left.length - 1 - tail] === right[right.length - 1 - tail]) tail += 1
  const lines: AuthoringDiffLine[] = []
  for (let index = Math.max(0, head - CONTEXT_LINES); index < head; index += 1)
    lines.push({ kind: "context", text: left[index] ?? "", before: index + 1, after: index + 1 })
  for (let index = head; index < left.length - tail; index += 1) lines.push({ kind: "remove", text: left[index] ?? "", before: index + 1 })
  for (let index = head; index < right.length - tail; index += 1) lines.push({ kind: "add", text: right[index] ?? "", after: index + 1 })
  const shift = right.length - left.length
  for (let index = left.length - tail; index < Math.min(left.length, left.length - tail + CONTEXT_LINES); index += 1)
    lines.push({ kind: "context", text: left[index] ?? "", before: index + 1, after: index + 1 + shift })
  return lines
}

/** The diff as `diff -u` would print its one hunk, for the doctor and for logs. */
export function unifiedDiff(path: string, lines: readonly AuthoringDiffLine[]): string {
  if (!lines.some((line) => line.kind !== "context")) return `${path}: no change`
  const sign = { context: " ", add: "+", remove: "-" } as const
  return [`--- ${path}`, `+++ ${path}`, ...lines.map((line) => `${sign[line.kind]}${line.text}`)].join("\n")
}
