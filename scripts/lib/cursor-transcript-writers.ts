// The patched SDK's transcript writers, cut out of the installed bundle and run
// as they are on the fs binding a test hands them, for either build.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import type * as promises from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { tokenizer, tokTypes } from "acorn"
import { TRANSCRIPT_BUILDS } from "../patch-cursor-sdk.mjs"

export type Build = "esm" | "cjs"
export const BUILDS: readonly Build[] = ["esm", "cjs"]

/** The bundle's own names for what the streamed writer calls, which differ between the two builds. */
const HELPERS = {
  esm: { ctx: "i", archive: "nM", visit: "iM", line: "wM", merge: "rM", keep: "tM" },
  cjs: { ctx: "c", archive: "iM", visit: "lM", line: "bM", merge: "sM", keep: "oM" },
} as const

export interface Row { role: string; id: string; text: string }
export interface Writers {
  /** The SDK's file writer, `TranscriptStore`'s `writeFile`. */
  writeFile(file: string, text: string): Promise<void>
  /** The store's `appendFile` option, as the patched writer is constructed with it. */
  appendFile(file: string, text: string): Promise<void>
  /** A full streamed rewrite of `file` from `rows`. */
  rewrite(file: string, rows: Row[]): Promise<void>
}

/** The handle the writers use: a test's recorder hands back one of its own. */
export type BundleHandle = Pick<promises.FileHandle, "fd" | "writeFile" | "sync" | "close">
/** What the bundle's `fs` binding is to the writers: `fs/promises`, or a recorder in front of it. */
export interface BundleFs extends Omit<typeof promises, "open" | "writeFile" | "rename"> {
  open(name: string, flags: string): Promise<BundleHandle>
  writeFile(name: string, data: string, options?: Parameters<typeof promises.writeFile>[2]): Promise<void>
  rename(from: string, to: string): Promise<void>
}

interface StreamSpan { ctx: Record<string, never>; span: { setAttribute(): void } }
interface StreamOptions { state: { summaryArchives: never[]; rootPromptMessagesJson: Row[] }; filePath: string; appendFile: Writers["appendFile"]; terminalLines: never[] }
interface Loaded {
  write: Writers["writeFile"]
  appendFile: Writers["appendFile"]
  Store: new () => { writeJsonlStreamed(span: StreamSpan, options: StreamOptions): Promise<void> }
}
const LOCK_HOOK = Symbol.for("mako:cursor-transcript-lock")

const sdk = path.join(path.dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "..")

/** The source of the function or method starting at `head`, through its closing brace. */
function extract(bundle: string, head: string): string {
  const start = bundle.indexOf(head)
  assert.ok(start >= 0 && bundle.indexOf(head, start + 1) < 0, `one ${head} in the bundle`)
  const body = bundle.indexOf("{", bundle.indexOf(")", start))
  let depth = 0
  for (const token of tokenizer(bundle.slice(body), { ecmaVersion: "latest" })) {
    if (token.type === tokTypes.braceL || token.type === tokTypes.dollarBraceL) depth++
    else if (token.type === tokTypes.braceR && --depth === 0) return bundle.slice(start, body + token.end)
  }
  throw new Error(`${head} has no end`)
}

/** `platform` stands in for `process.platform`, which the folder sync reads. */
export function loadWriters(build: Build, fs: BundleFs, platform: NodeJS.Platform = process.platform): Writers {
  const names = TRANSCRIPT_BUILDS[build]
  const bundle = readFileSync(path.join(sdk, "..", names.target), "utf8")
  const write = extract(bundle, `async function ${names.write}(e,t){`)
  const lock = extract(bundle, "function makoLock(p,w){")
  const syncDir = extract(bundle, "async function makoSyncDir(p){")
  const streamed = extract(bundle, "async writeJsonlStreamed(e,t){")
  const made = extract(bundle, "async makoWriteJsonlStreamed(e,t){")
  const options = /appendFile:(\(p,d\)=>makoLock\(p,.*?\)\)\)),streamFullJsonlWrites/.exec(bundle)
  assert.ok(options?.[1], "the writer is constructed with a locked appendFile")
  const names2 = HELPERS[build]
  // The bundle reads the child's lock hook from its own global, which a test's context doesn't share.
  const hook: unknown = Object.getOwnPropertyDescriptor(globalThis, LOCK_HOOK)?.value
  const context = {
    [names.fs]: fs,
    s: path,
    process: platform === process.platform ? process : { pid: process.pid, platform },
    [names2.ctx]: { OA: <T>(value: T) => value },
    [names2.archive]: async () => [],
    [names2.visit]: async (_ctx: never, _store: never, rows: Row[], _stats: never, visit: { visit(row: Row): Promise<void> }) => {
      for (const row of rows) await visit.visit(row)
    },
    [names2.line]: (row: Row) => JSON.stringify(row),
    [names2.merge]: () => false,
    [names2.keep]: () => true,
    ...hook !== undefined && { [LOCK_HOOK]: hook },
  }
  // SAFETY: the script's value is the object literal it ends with, built from the bundle's own functions.
  const parts = runInNewContext(
    `(()=>{${write};${lock};${syncDir};const ${"appendFile"}=${options[1]};` +
      `return {write:${names.write},appendFile,Store:class{constructor(){this.writeFile=${names.write}}${streamed}${made}}}})()`,
    context,
  ) as Loaded
  return {
    writeFile: parts.write,
    appendFile: parts.appendFile,
    rewrite: (file, rows) =>
      new parts.Store().writeJsonlStreamed(
        { ctx: {}, span: { setAttribute() {} } },
        { state: { summaryArchives: [], rootPromptMessagesJson: rows }, filePath: file, appendFile: parts.appendFile, terminalLines: [] },
      ),
  }
}

/** Row `at` of a transcript, 100,000 characters of multibyte text so a rewrite takes several chunks. */
export const row = (at: number, tag: string): Row => ({ role: at % 2 ? "assistant" : "user", id: `${tag}${at}`, text: "π🙂".repeat(50_000) })
export const rowsOf = (from: number, count: number, tag: string): Row[] => Array.from({ length: count }, (_, at) => row(from + at, tag))
export const jsonl = (rows: Row[]) => rows.map((value) => `${JSON.stringify(value)}\n`).join("")
