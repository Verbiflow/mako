// Continuing a conversation in another harness (MH-35 step 5), on real CLIs:
// the flows `test-session-flows.mjs` runs for each harness H, with the next
// selected harness as its source S.
//
// switch        a conversation on S plants a marker; it switches to H, whose
//               new session answers from the transcript its first turn names.
//               The request carries the manifest (from S, its turns), the
//               transcript is on disk, and once the store captures H's
//               session it holds the transcript's files as that session's.
// switch-back   H plants a second marker; the conversation goes back to S,
//               which resumes its own session and recalls both.
// fork-other    S's conversation forked into H at the first answer: a new H
//               session from the transcript, knowing the first marker only.
// reference     a new H conversation whose message references S's session
//               with an `@thread` item, written as the composer writes it.
// history-tool  a fact only deep inside a long tool output on S, past the
//               transcript's payload threshold; H must find it after a switch.
//
// Each records how the destination read its history: the transcript, its
// payload files, or `thread_history`.
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"

const repo = () => process.env.MAKO_FLOWS_REPO ?? resolve(".")
const load = (path) => import(join(repo(), path))

/** A continuation flow needs a second harness to continue from. */
export const continuing = (driver, tools) => tools.source(driver.provider) ? true : "only one harness is selected, so there is none to continue from"

/** The conversation the `switch` flow made, which the flows after it go on with. */
function carried(h) {
  if (!h.carried?.to) throw new Error("The switch flow didn't pass, so there is no switched conversation to go on with")
  return h.carried
}

/** The blocks of one request's turn: from its prompt to the next prompt. */
function turnBlocks(h, id, requestId) {
  const blocks = h.snapshot(id).blocks
  const start = blocks.findIndex((block) => block.type === "user" && block.requestId === requestId)
  const end = blocks.findIndex((block, index) => index > start && block.type === "user" && !block.steeringFor)
  return blocks.slice(start + 1, end < 0 ? undefined : end)
}

/** How a destination read its history in one turn: calls to `thread_history`, and reads of the transcript and its payload files. */
export function historyReads(h, id, requestId, manifest) {
  const folder = manifest?.file ? basename(dirname(manifest.file)) : undefined
  const calls = turnBlocks(h, id, requestId).filter((block) => block.type === "tool")
  const said = (block) => `${block.name ?? ""} ${block.title ?? ""} ${block.input ?? ""}`
  // A search for the tool by its name (Grok's `search_tool`, Claude Code's `ToolSearch`) finds the tool and reads no history.
  const toolSearch = (block) => /^(?:search_tool|ToolSearch)$/i.test(block.name ?? "")
  // A payload file beside the transcript (`payloads/`), or beside a bundle from before it (`transcript-assets/`).
  const payload = /payloads\/|transcript-assets\//
  const named = (block) => (folder && said(block).includes(folder)) || /transcript\.md/.test(said(block)) || payload.test(said(block))
  // Claude Code keeps a long output in a file of its own and returns a preview naming it: reading that file reads what the history read returned.
  const kept = new Set()
  const history = []
  const files = []
  for (const block of calls) {
    if (toolSearch(block)) continue
    if (/thread_history/.test(said(block))) history.push(block)
    else if (named(block) || [...kept].some((path) => said(block).includes(path))) files.push(block)
    else continue
    for (const match of (block.output ?? "").matchAll(/Full output saved to: (\S+)/g)) kept.add(match[1])
  }
  const read = [...history, ...files]
  return {
    calls: calls.length,
    // What the agent got back from its history reads, apart from all it took in: the tool results' characters.
    historyChars: read.reduce((sum, block) => sum + readChars(block), 0),
    historyCalls: read.map((block) => `${(block.input ?? "").slice(0, 140)} → ${readChars(block)}`),
    // The calls' ids, to find each in the session's stream.
    callIds: read.map((block) => block.id),
    threadHistory: history.length,
    transcript: files.filter((block) => !payload.test(said(block))).length,
    payloads: files.filter((block) => payload.test(said(block))).length,
  }
}

const ReadArgumentsSchema = z.object({ file_path: z.string(), offset: z.number().int().optional(), limit: z.number().int().optional() })

/**
 * What a history read gave the agent, in characters: its output, or for a
 * read whose result only counts its lines (Devin's `read` reports "255 lines
 * (truncated)"), those lines of the file it names.
 */
function readChars(block) {
  const output = block.output ?? ""
  const counted = /^(\d+) lines?(?: \(truncated\))?$/.exec(output.trim())
  if (!counted) return output.length
  let args
  try {
    args = ReadArgumentsSchema.safeParse(JSON.parse(block.input ?? "")).data
  } catch {
    return output.length
  }
  const text = args && existsSync(args.file_path) ? readFileSync(args.file_path, "utf8") : undefined
  if (text === undefined) return output.length
  const from = Math.max(0, (args.offset ?? 1) - 1)
  return text.split("\n").slice(from, from + Number(counted[1])).join("\n").length
}

/** The way a turn found what it needed, in a word. */
export function readBy(reads) {
  const ways = [reads.threadHistory && "thread_history", reads.payloads && "payload file", reads.transcript && "transcript"].filter(Boolean)
  return ways.length ? ways.join(" + ") : "nothing read"
}

/** The transcript a request carried, checked against what it should hold. */
function carriedManifest(h, id, requestId, from) {
  const manifest = h.request(id, requestId)?.context?.[0]
  if (!manifest) throw new Error("The request carried no transcript")
  if (!isDeepStrictEqual(manifest.from, from)) throw new Error(`The transcript says it came from ${JSON.stringify(manifest.from)}, not ${JSON.stringify(from)}`)
  if (!manifest.turns) throw new Error("The transcript counts no turns")
  if (!existsSync(manifest.file)) throw new Error(`The transcript isn't on disk: ${manifest.file}`)
  const missing = (manifest.resources ?? []).filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`${missing.length} of the transcript's files aren't on disk: ${missing[0]}`)
  return manifest
}

/**
 * The record store, capturing `harness`'s session as the app does, holds the
 * transcript folder its first turn named as that session's own files, whole.
 */
async function heldTranscript(h, harness, nativeId, path, manifest) {
  const { carriedFolders } = await load("packages/sessions/dist/record-carried.js")
  const { RecordStore } = await load("packages/sessions/dist/record-store.js")
  const { NativeStores } = await load("packages/sessions/dist/read-only-sqlite.js")
  const folder = dirname(manifest.file)
  // The host notes the folder once the session has its id; a harness that names it with its first reply notes it then.
  for (const started = Date.now(); !(await carriedFolders(h.tools.records, harness, nativeId)).includes(folder);) {
    if (Date.now() - started > 10_000) throw new Error(`The record store was never told ${harness}'s session was given ${folder}`)
    await new Promise((done) => setTimeout(done, 200))
  }
  if (!path) throw new Error(`${harness}'s session has no path for the record store to capture`)
  if (!await h.tools.catalog.hold(path)) throw new Error(`The record store didn't take ${harness}'s session at ${path}`)
  const files = [manifest.file, ...manifest.resources ?? []]
  const store = new RecordStore(h.tools.records, new NativeStores(true))
  try {
    const units = store.units(harness, nativeId).filter((unit) => unit.key.startsWith("mako-carried@"))
    let whole = 0
    for (const file of files) {
      const name = relative(dirname(folder), file)
      const unit = units.find((candidate) => candidate.key.endsWith(name))
      if (!unit) throw new Error(`The store holds no unit of ${harness}'s session for ${name}`)
      const parts = []
      for await (const part of store.content(harness, unit.key)) parts.push(Buffer.from(part))
      const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
      if (sha(Buffer.concat(parts)) !== sha(await readFile(file))) throw new Error(`The store's ${name} differs from the file`)
      whole++
    }
    return { units: whole, of: files.length }
  } finally {
    await store.close()
  }
}

/** The transcript of a native session and the note that names it, as `mako:thread-contexts` prepares a reference. */
async function referenceContext(h, path) {
  const { buildTranscript, transcriptNote, writeTranscript } = await load("packages/sessions/dist/transcript-builder.js")
  const thread = await h.tools.catalog.open(path)
  if (!thread) throw new Error(`The catalog reads no session at ${path}`)
  const harness = h.tools.label(thread.ref.harness)
  const built = await buildTranscript({
    entries: thread.entries, harness, label: h.tools.label,
    ...thread.ref.title !== undefined && { title: thread.ref.title },
    ...thread.ref.cwd !== undefined && { cwd: thread.ref.cwd },
  })
  const file = await writeTranscript(join(h.root, "transcripts"), built)
  const context = { kind: "file", file, note: transcriptNote(file, built, harness), harness: thread.ref.harness, turns: built.turns, digest: built.digest, losses: built.losses, ...thread.ref.title !== undefined && { title: thread.ref.title } }
  return { ref: thread.ref, context }
}

/** A message that references a conversation, written by the composer's own writer (`scripts/fixtures/reference-message.ts`). */
export function referenceMessage(input) {
  const out = spawnSync(join(repo(), "node_modules/.bin/tsx"), ["--tsconfig", "tsconfig.app.json", "scripts/fixtures/reference-message.ts"], { cwd: repo(), input: JSON.stringify(input), encoding: "utf8" })
  if (out.status !== 0) throw new Error(`The reference couldn't be written: ${out.stderr.slice(-400)}`)
  return out.stdout
}

const ASK_MARKER = "What marker did I ask you to remember? Reply with only the marker."

export const CONTINUATIONS = [
  {
    name: "switch", declared: continuing,
    async run(h) {
      const from = h.tools.source(h.provider)
      const marker = `switch-${randomUUID().slice(0, 8)}`
      const { id } = await h.conversation("switch", {}, undefined, from)
      h.carried = { ids: new Set([id]), id, from, marker }
      h.carried.first = await h.completed(id, `Remember the marker ${marker}. Reply with only ACK. Do not use any tools.`)
      h.carried.fromNativeId = h.snapshot(id).session.nativeId
      if (!h.carried.fromNativeId) throw new Error(`${from} reported no native session ID`)
      const began = Date.now()
      const requestId = await h.transferred(id, h.provider, ASK_MARKER)
      const ms = Date.now() - began
      const reply = h.reply(id, requestId)
      if (!reply.includes(marker)) throw new Error(`${h.provider} didn't recall the marker from ${from}: ${JSON.stringify(reply.slice(0, 200))}`)
      const { session, threadPath } = h.snapshot(id)
      if (session.harness !== h.provider || !session.nativeId || session.nativeId === h.carried.fromNativeId) throw new Error(`The switch left the conversation on ${session.harness} ${session.nativeId}`)
      const manifest = carriedManifest(h, id, requestId, [from])
      const held = await heldTranscript(h, h.provider, session.nativeId, session.nativePath ?? threadPath, manifest)
      h.carried.to = { nativeId: session.nativeId }
      const reads = historyReads(h, id, requestId, manifest)
      return { from, turns: manifest.turns, ms, read: readBy(reads), reads, held: `${held.units} of ${held.of} files` }
    },
  },
  {
    name: "switch-back", declared: continuing,
    async run(h) {
      const conversation = carried(h)
      const second = `back-${randomUUID().slice(0, 8)}`
      await h.completed(conversation.id, `Also remember a second marker, ${second}. Reply with only ACK. Do not use any tools.`)
      conversation.second = second
      const requestId = await h.transferred(conversation.id, conversation.from, "Which two markers did I ask you to remember in this conversation? Reply with only the two markers, separated by a space.")
      const reply = h.reply(conversation.id, requestId)
      const lost = [conversation.marker, second].filter((marker) => !reply.includes(marker))
      if (lost.length) throw new Error(`${conversation.from} lost ${lost.join(" and ")} on the way back: ${JSON.stringify(reply.slice(0, 200))}`)
      const { session } = h.snapshot(conversation.id)
      if (session.harness !== conversation.from || session.nativeId !== conversation.fromNativeId)
        throw new Error(`Switching back opened ${session.harness} ${session.nativeId}, not ${conversation.from}'s own session ${conversation.fromNativeId}`)
      const manifest = carriedManifest(h, conversation.id, requestId, [h.provider])
      if (manifest.includesBase || manifest.fromBlock === 0) throw new Error("Switching back carried the whole conversation, not the turns since")
      if (manifest.turns !== 2) throw new Error(`The turns since ${conversation.from} left are 2, but its transcript carries ${manifest.turns}`)
      const reads = historyReads(h, conversation.id, requestId, manifest)
      return { resumed: session.nativeId, turnsSince: manifest.turns, read: readBy(reads), reads }
    },
  },
  {
    name: "fork-other", declared: continuing,
    async run(h) {
      const conversation = carried(h)
      const forkId = randomUUID()
      const parent = h.snapshot(conversation.id).session.nativeId
      await h.owner.historyReady(conversation.id)
      h.owner.fork(conversation.id, { id: forkId, provider: h.provider, point: { kind: "run", requestId: conversation.first } })
      h.open.add(forkId)
      h.current = forkId
      const requestId = await h.completed(forkId, "List every marker I asked you to remember in this conversation. Reply with only the markers, separated by spaces.")
      const reply = h.reply(forkId, requestId)
      if (!reply.includes(conversation.marker)) throw new Error(`The fork into ${h.provider} lost the marker: ${JSON.stringify(reply.slice(0, 200))}`)
      if (conversation.second && reply.includes(conversation.second)) throw new Error("The fork knows a marker from after the answer it forked at")
      const forked = h.snapshot(forkId)
      if (forked.control?.ancestry?.nativeFork) throw new Error("A fork into another harness claims to be the harness's own fork")
      if (forked.session.harness !== h.provider) throw new Error(`The fork runs on ${forked.session.harness}`)
      const manifest = carriedManifest(h, forkId, requestId, [conversation.from])
      if (!manifest.includesBase || manifest.turns !== 1) throw new Error(`The fork's transcript carries ${manifest.turns} turns${manifest.includesBase ? "" : " without the history"}, not the one turn before its point`)
      if (h.snapshot(conversation.id).session.nativeId !== parent) throw new Error("Forking moved the source conversation")
      const reads = historyReads(h, forkId, requestId, manifest)
      return { turns: manifest.turns, read: readBy(reads), reads }
    },
  },
  {
    name: "reference", declared: continuing,
    async run(h) {
      const conversation = carried(h)
      const binding = h.snapshot(conversation.id).control.bindings.find((entry) => entry.provider === conversation.from && entry.nativeId === conversation.fromNativeId)
      if (!binding?.path) throw new Error(`The conversation names no path for ${conversation.from}'s session`)
      const { ref, context } = await referenceContext(h, binding.path)
      const text = referenceMessage({ ref, context, words: "What was the first marker I asked you to remember in that conversation? Reply with only the marker." })
      const { id } = await h.conversation("reference")
      const requestId = await h.completed(id, text)
      const reply = h.reply(id, requestId)
      if (!reply.includes(conversation.marker)) throw new Error(`${h.provider} didn't recall the marker from the referenced conversation: ${JSON.stringify(reply.slice(0, 200))}`)
      const reads = historyReads(h, id, requestId, { file: context.file })
      return { turns: context.turns, read: readBy(reads), reads }
    },
  },
  {
    name: "history-tool", declared: continuing,
    async run(h) {
      const from = h.tools.source(h.provider)
      // A line like every other, so the source has no reason to remark on it (Devin's thinking once quoted a `DEPLOY_SUFFIX=` line as a possible injection).
      const LINE = 97
      const crate = (n) => createHash("sha1").update(`${n}`).digest("hex").slice(0, 10)
      const fact = `${randomUUID().replaceAll("-", "").slice(0, 10)}`
      const inventory = Array.from({ length: 120 }, (_, index) => {
        const n = index + 1
        return `${String(n).padStart(3, "0")} inventory item ${n}: crate ${n === LINE ? fact : crate(n)}, shelf ${n % 17}`
      }).join("\n")
      const { id, cwd } = await h.conversation("history-tool", {}, (folder) => writeFile(join(folder, "inventory.txt"), `${inventory}\n`), from)
      const printed = await h.completed(id, "Run exactly one shell command, `cat inventory.txt`, and wait for it to finish. Then reply with only DONE. Don't quote or summarise the file.")
      await rm(join(cwd, "inventory.txt"))
      const outputs = turnBlocks(h, id, printed).filter((block) => block.type === "tool").map((block) => block.output ?? "").join("\n")
      if (!outputs.includes(fact)) throw new Error(`${from}'s turn holds no output with item ${LINE}'s line, so there is nothing to carry`)
      const said = turnBlocks(h, id, printed).filter((block) => block.type !== "tool").map((block) => block.text ?? "").join("\n")
      if (said.includes(fact)) throw new Error(`${from} repeated the crate code in its own words, so it isn't only in the output`)
      const requestId = await h.transferred(id, h.provider, `Earlier in this conversation a file was printed with cat. What crate code did inventory item ${LINE} have? The file has been deleted since. Reply with only the code.`)
      const reply = h.reply(id, requestId)
      const manifest = carriedManifest(h, id, requestId, [from])
      const transcript = await readFile(manifest.file, "utf8")
      if (transcript.includes(fact)) throw new Error("The transcript shows the crate code inline: the output wasn't past the payload threshold")
      const payload = await Promise.all((manifest.resources ?? []).map(async (file) => (await readFile(file, "utf8").catch(() => "")).includes(fact) ? file : undefined)).then((files) => files.find(Boolean))
      if (!payload) throw new Error("No payload file beside the transcript holds the fact")
      const reads = historyReads(h, id, requestId, manifest)
      if (!reply.includes(fact)) throw new Error(`${h.provider} didn't find the crate code deep in ${from}'s tool output (read: ${readBy(reads)}): ${JSON.stringify(reply.slice(0, 200))}`)
      return { from, payload: relative(dirname(manifest.file), payload), read: readBy(reads), reads }
    },
  },
]

/**
 * `--record`'s switched conversation: started on the source, switched to
 * this harness, answered there and left idle, for `--continue` to ask again.
 */
export const SWITCHED = {
  name: "switched", declared: continuing,
  async run(h) {
    const from = h.tools.source(h.provider)
    const marker = `switched-${randomUUID().slice(0, 8)}`
    const { id } = await h.conversation("switched", {}, undefined, from)
    await h.completed(id, `Remember the marker ${marker}. Reply with only ACK. Do not use any tools.`)
    const requestId = await h.transferred(id, h.provider, ASK_MARKER)
    if (!h.reply(id, requestId).includes(marker)) throw new Error(`${h.provider} didn't recall the marker from ${from}`)
    h.recorded.push({ kind: "switched", harness: h.provider, from, id, marker, nativeId: h.snapshot(id).session.nativeId })
    return { from }
  },
}
