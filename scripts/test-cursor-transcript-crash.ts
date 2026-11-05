// A Cursor child killed while writing a transcript: the patched SDK's full
// writer and streamed writer, taken from the installed bundle, run in a
// process of their own that stops halfway through one real write and is
// SIGKILLed there. A full rewrite leaves the published transcript as it was;
// a torn append is cut back to its last whole line when the agent is next
// opened, with no model turn between.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { tokenizer, tokTypes } from "acorn"
import { cursorTranscriptFolder, repairCursorTranscripts } from "@mako/host/harnesses/cursor/sdk/transcript-tails"

const bundle = readFileSync(join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "../esm/336.js"), "utf8")

/** The source of the function or method starting at `head`, through its closing brace. */
function extract(head: string): string {
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

const write = extract("async function pO(e,t){")
const streamed = extract("async writeJsonlStreamed(e,t){")
assert.match(write, /\.sync\(\)/, "the installed SDK carries the staged full write")
assert.match(streamed, /\.rename\)\(r,f\)/, "the installed SDK carries the staged streamed write")

/**
 * Runs the SDK's writers with the bundle's own `fs` binding, except that the
 * `stall`th write puts half its bytes on disk and then hangs for the kill.
 */
const WORKER = `
const fs = require("node:fs"), promises = require("node:fs/promises"), path = require("node:path"), vm = require("node:vm")
const { write, streamed, mode, file, from, count, tag, stall } = JSON.parse(process.env.CASE)
const rows = Array.from({ length: count }, (_, at) => ({ role: (from + at) % 2 ? "assistant" : "user", id: tag + (from + at), text: "π🙂".repeat(50000) }))
let writes = 0
const hang = (fd, data) => {
  const bytes = Buffer.from(data)
  fs.writeSync(fd, bytes, 0, bytes.length >> 1)
  fs.fsyncSync(fd)
  process.stdout.write("stalled\\n")
  setInterval(() => {}, 1e9)
  return new Promise(() => {})
}
const Vs = {
  ...promises,
  async open(name, flags) {
    const handle = await promises.open(name, flags)
    if (flags !== "w") return handle
    return { writeFile: async (data, encoding) => (writes++ === stall ? hang(handle.fd, data) : handle.writeFile(data, encoding)), sync: () => handle.sync(), close: () => handle.close() }
  },
  async writeFile(name, data, options) {
    if (options?.flag === "a" && writes++ === stall) return hang(fs.openSync(name, "a"), data)
    return promises.writeFile(name, data, options)
  },
}
const appendFile = (p, d) => Vs.writeFile(p, d, { flag: "a" })
const lines = rows.map((row) => JSON.stringify(row))
const run = async () => {
  if (mode === "append") return appendFile(file, lines.join("\\n") + "\\n")
  const Store = vm.runInNewContext("(()=>{" + write + ";return class{constructor(){this.writeFile=pO}" + streamed + "}})()", {
    Vs, s: path, process, i: { OA: (ctx) => ctx },
    C$: async (ctx, store, list, stats, options) => { for (const row of list) await options.visit(row) },
    S$: async () => [], O$: (row) => JSON.stringify(row), b$: () => false, v$: () => true,
  })
  await new Store().writeJsonlStreamed({ ctx: {}, span: { setAttribute() {} } }, { state: { summaryArchives: [], rootPromptMessagesJson: rows }, filePath: file, appendFile, terminalLines: [] })
  process.stdout.write("chunks " + writes + "\\n")
}
run().then(() => process.exit(0), (cause) => { console.error(cause); process.exit(1) })
`

/** Rows `from` to `from + count`, each 100,000 characters of multibyte text, as the worker builds them. */
interface Rows { from: number; count: number; tag: string }
const rows = (from: number, count: number, tag: string): Rows => ({ from, count, tag })
const jsonl = ({ from, count, tag }: Rows) =>
  Array.from({ length: count }, (_, at) => `${JSON.stringify({ role: (from + at) % 2 ? "assistant" : "user", id: `${tag}${from + at}`, text: "π🙂".repeat(50_000) })}\n`).join("")

async function crash(mode: "append" | "rewrite", file: string, list: Rows, stall: number): Promise<string> {
  const worker = spawn(process.execPath, ["-e", WORKER], {
    env: { ...process.env, NODE_OPTIONS: "", CASE: JSON.stringify({ write, streamed, mode, file, ...list, stall }) },
    stdio: ["ignore", "pipe", "inherit"],
  })
  let out = ""
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => worker.on("exit", (code, signal) => resolve({ code, signal })))
  worker.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString()
    if (out.includes("stalled")) worker.kill("SIGKILL")
  })
  const ended = await exit
  if (stall >= 0) assert.deepEqual(ended, { code: null, signal: "SIGKILL" }, `${mode} at write ${stall} was killed mid-write`)
  else assert.deepEqual(ended, { code: 0, signal: null }, `${mode} finished`)
  return out
}

const root = mkdtempSync(join(tmpdir(), "mako-cursor-transcripts-"))
try {
  const folder = cursorTranscriptFolder("/Users/someone/My Repo", "agent-1", {}, root)
  assert.equal(folder, join(root, ".cursor/projects/Users-someone-My-Repo/agent-transcripts/agent-1"))
  assert.equal(cursorTranscriptFolder("/w", "a/b", { CURSOR_DATA_DIR: "/data" }, root), "/data/projects/w/agent-transcripts/a_2Fb")
  mkdirSync(join(folder, "subagents"), { recursive: true })
  const primary = join(folder, "agent-1.jsonl")
  const child = join(folder, "subagents", "child-1.jsonl")
  const before = jsonl(rows(0, 20, "old"))
  const staged = () => readdirSync(folder).filter((name) => name.includes(".mako-"))

  // A full rewrite killed at its first chunk, then at a later one.
  for (const stall of [0, 1]) {
    writeFileSync(primary, before)
    await crash("rewrite", primary, rows(0, 20, "new"), stall)
    assert.equal(readFileSync(primary, "utf8"), before, `a rewrite killed at chunk ${stall} leaves the published transcript whole`)
    assert.equal(staged().length, 1, "the killed rewrite's staged file is left beside it")
    assert.deepEqual(repairCursorTranscripts(folder), [])
    assert.deepEqual(staged(), [], "opening the agent deletes a dead writer's staged file")
    assert.equal(readFileSync(primary, "utf8"), before)
  }

  // A full rewrite that finishes publishes all of it, in more than one chunk.
  const out = await crash("rewrite", primary, rows(0, 20, "new"), -1)
  assert.ok(Number(/chunks (\d+)/.exec(out)?.[1]) > 1, "the rewrite streamed in several chunks")
  assert.equal(readFileSync(primary, "utf8"), jsonl(rows(0, 20, "new")))
  assert.deepEqual(staged(), [])

  // An incremental append killed mid-line, in a subagent's transcript.
  writeFileSync(child, before)
  await crash("append", child, rows(20, 1, "old"), 0)
  const torn = readFileSync(child, "utf8")
  assert.ok(torn.length > before.length && !torn.endsWith("\n"), "the killed append left a torn last line")
  assert.deepEqual(repairCursorTranscripts(folder), [child])
  assert.equal(readFileSync(child, "utf8"), before, "opening the agent cuts the transcript back to its last whole line")
  for (const line of readFileSync(child, "utf8").trimEnd().split("\n")) JSON.parse(line)
  assert.deepEqual(repairCursorTranscripts(folder), [], "a whole transcript is left alone")

  // A transcript holding no whole line is emptied; a missing folder is nothing to repair.
  writeFileSync(child, '{"role":"us')
  assert.deepEqual(repairCursorTranscripts(folder), [child])
  assert.equal(readFileSync(child, "utf8"), "")
  assert.deepEqual(repairCursorTranscripts(join(root, "absent")), [])
  assert.ok(!existsSync(join(root, "absent")))
  console.log("Cursor transcripts: a rewrite killed at its first or a later chunk leaves the transcript whole, a killed append is cut back on open")
} finally {
  rmSync(root, { recursive: true, force: true })
}
