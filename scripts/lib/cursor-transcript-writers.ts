// The patched SDK's transcript writers, cut out of the installed bundle and run
// as they are on the fs binding a test hands them, for either build. Every name
// is found by shape, so a release that only renames changes nothing here.
import assert from "node:assert/strict"
import type * as promises from "node:fs/promises"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { findInBuild, installedPatch, readSdk, rename, sdkFiles, throughBlock } from "./cursor-sdk-sites.mjs"

export type Build = "esm" | "cjs"
export const BUILDS: readonly Build[] = ["esm", "cjs"]

/**
 * What the streamed writer calls, by 1.4.0's ESM names: `$` the tracing context, `BD` reads a summary archive,
 * `qD` visits messages, `jD` keeps one, `UD` merges two leading user messages, `tO` writes one as a line. Each snippet
 * binds them wherever the writer is, in this release's names.
 */
const HELPER_PROBES = [
  "r=await BD(e,t,s)}catch{continue}await qD(e,t,r,o,{skipFailedReads:!0,visit:n})",
  "visit:async e=>{jD(e)&&await n(e)}}),o}((0,$.OA)(e.ctx)",
  "(UD(u,e)||await l(tO(u)),u=void 0)",
]

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

/** The function or method in `source` starting with `head` (1.4.0's names, in this release's), through its closing brace. */
function extract(source: string, head: string, names: Map<string, string>): string {
  const text = rename(head, names)
  const start = source.indexOf(text)
  assert.ok(start >= 0 && source.indexOf(text, start + 1) < 0, `one ${text} in the bundle`)
  return throughBlock(source, start)
}

/** `platform` stands in for `process.platform`, which the folder sync reads. */
export function loadWriters(build: Build, fs: BundleFs, platform: NodeJS.Platform = process.platform): Writers {
  const { source: bundle, sites } = installedPatch(readSdk, sdkFiles, "transcripts", build)
  // The file writer's site binds it (`Pj`), `fs` (`fo`) and `path` (`s`); the streamed writer's head binds its own.
  const [file, head] = sites
  const writeName = file.names.get("Pj") ?? assert.fail("the transcript writer's site binds its file writer")
  const write = extract(bundle, "async function Pj(e,t){", file.names)
  const lock = extract(bundle, "function makoLock(mako$p,mako$w){", file.names)
  const syncDir = extract(bundle, "async function makoSyncDir(mako$p){", file.names)
  const streamed = extract(bundle, "async writeJsonlStreamed(e,t){", head.names)
  const made = extract(bundle, "async makoWriteJsonlStreamed(e,t){", head.names)
  const options = /appendFile:(\(mako\$p,mako\$d\)=>makoLock\(mako\$p,.*?\)\)\)),streamFullJsonlWrites/.exec(bundle)
  assert.ok(options?.[1], "the writer is constructed with a locked appendFile")
  const helpers = new Map<string, string>()
  for (const probe of HELPER_PROBES) for (const [old, now] of findInBuild(build, probe, "the streamed writer's helpers").names) helpers.set(old, now)
  const helper = (old: string) => helpers.get(old) ?? assert.fail(`the streamed writer's helpers bind no ${old}`)
  // The bundle reads the child's lock hook from its own global, which a test's context doesn't share.
  const hook: unknown = Object.getOwnPropertyDescriptor(globalThis, LOCK_HOOK)?.value
  const context = {
    [file.names.get("fo") ?? assert.fail("the file writer binds fs")]: fs,
    [file.names.get("s") ?? assert.fail("the file writer binds path")]: path,
    process: platform === process.platform ? process : { pid: process.pid, platform },
    [helper("$")]: { OA: <T>(value: T) => value },
    [helper("BD")]: async () => [],
    [helper("qD")]: async (_ctx: never, _store: never, rows: Row[], _stats: never, visit: { visit(row: Row): Promise<void> }) => {
      for (const row of rows) await visit.visit(row)
    },
    [helper("tO")]: (row: Row) => JSON.stringify(row),
    [helper("UD")]: () => false,
    [helper("jD")]: () => true,
    ...hook !== undefined && { [LOCK_HOOK]: hook },
  }
  // SAFETY: the script's value is the object literal it ends with, built from the bundle's own functions.
  const parts = runInNewContext(
    `(()=>{${write};${lock};${syncDir};const ${"appendFile"}=${options[1]};` +
      `return {write:${writeName},appendFile,Store:class{constructor(){this.writeFile=${writeName}}${streamed}${made}}}})()`,
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
