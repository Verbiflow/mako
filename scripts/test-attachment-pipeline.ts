import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { performance } from "node:perf_hooks"
import { setImmediate as nextTurn } from "node:timers/promises"
import type { PromptAttachment } from "@mako/host/contracts/providers-acp"
import { STAGED_PART_BYTES, type FileContents, type StagedFile } from "@mako/host/contracts/git-workspace-search"
import { LiveAssets, promptFingerprint, type AssetWork } from "@mako/host/conversations/live-assets"
import { acpPromptBlocks } from "@mako/host/harnesses/acp-prompt"
import { claudeInputContent } from "@mako/host/harnesses/claude/input"
import { codexInput } from "@mako/host/harnesses/codex/input"
import { promptImages, promptText } from "@mako/host/harnesses/cursor/sdk/driver"
import { promptFiles } from "@mako/host/harnesses/opencode/live-driver"
import { stageBytes, stagePart, stagePath } from "@mako/host/workspaces/staging"
import { headOf } from "@mako/sessions/attachment-sweep"
import type { LiveSnapshot } from "@/lib/types"
import { auditId, auditSnapshot } from "./performance-audit-fixtures"

/**
 * An attachment is a reference from the composer to the harness, never its bytes: staged once, sent by its path,
 * kept by the host under its content's hash off the turn that admits the message, and drawn from a URL.
 *
 * - The window stages a file with a path by that path, and one without in pieces of a bounded size; the draft and
 *   the message carry no base64.
 * - The host reads a sent file once, clones it once, keeps the same picture once however often it's sent, and
 *   admits the message without touching a file.
 * - A message that still carries its bytes (another device's, a cloud move's, an older window's) is kept as before.
 * - Each harness is handed what it was handed before.
 * - The message just sent, and a preview mounted again, draw from a URL the window already holds.
 *
 * It ends with what sending a 10 MB picture costs, before and after.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/test-attachment-pipeline.ts
 */

const root = mkdtempSync(join(tmpdir(), "mako-attachment-pipeline-"))
const MB = 1024 * 1024
const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=", "base64")

/**
 * How the loop fared while `run` ran: the longest it went without a turn, in milliseconds, and how many turns it
 * took. Work done in one call takes no turn at all; the longest wait is what a person would feel, but a loaded
 * machine stretches it, so a test holds the turns to a number and the wait only to the one call measured beside it.
 */
async function loopDuring(run: () => Promise<void>) {
  let last = performance.now()
  let longest = 0
  let turns = 0
  let going = true
  const tick = (): void => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    turns += 1
    if (going) setImmediate(tick)
  }
  setImmediate(tick)
  await nextTurn()
  await run()
  going = false
  return { longest, turns }
}

/** What crossed the bridge: each call, and how many characters its arguments came to. */
interface Crossing { method: string; chars: number }
const charsOf = (args: readonly (string | PromptAttachment[] | { path: string; offset: number } | undefined)[]) => JSON.stringify(args).length

/** A bridge onto the host's own staging, in `dir`, that counts what crosses it. `paths`: the files that have a path on this Mac. */
function stagingBridge(dir: string, paths: Map<File, string>, crossed: Crossing[]) {
  return {
    pathForFile: (file: File) => paths.get(file) ?? null,
    stageFilePath: (sourcePath: string): Promise<StagedFile> => {
      crossed.push({ method: "stageFilePath", chars: charsOf([sourcePath]) })
      return stagePath(dir, sourcePath)
    },
    stageFile: (name: string, base64: string): Promise<StagedFile> => {
      crossed.push({ method: "stageFile", chars: charsOf([name, base64]) })
      return stageBytes(dir, name, base64)
    },
    stageFilePart: (name: string, base64: string, into?: { path: string; offset: number }): Promise<StagedFile> => {
      crossed.push({ method: "stageFilePart", chars: charsOf([name, base64, into]) })
      return stagePart(dir, name, base64, into)
    },
  }
}

/** The window's encoder, which a page has as `FileReader`: counted, so a test sees how much was ever encoded. */
function countingEncoder() {
  const encoded = { calls: 0, bytes: 0, largest: 0 }
  const encode = async (blob: Blob): Promise<string> => {
    encoded.calls += 1
    encoded.bytes += blob.size
    encoded.largest = Math.max(encoded.largest, blob.size)
    return Buffer.from(await blob.arrayBuffer()).toString("base64")
  }
  return { encoded, encode }
}

try {
  const { stageAttachment, promptAttachment } = await import("../src/lib/attachment-staging")
  const staged = join(root, "attachments")
  const picture = randomBytes(10 * MB)
  PNG_1x1.copy(picture)
  const onDisk = join(root, "screenshot.png")
  writeFileSync(onDisk, picture)

  // The window: a file with a path is staged by that path, and no byte of it is read or encoded there.
  {
    const crossed: Crossing[] = []
    const { encoded, encode } = countingEncoder()
    const file = new File([picture], "screenshot.png", { type: "image/png" })
    const kept = await stageAttachment(file, stagingBridge(staged, new Map([[file, onDisk]]), crossed), encode)
    assert.deepEqual(crossed.map((call) => call.method), ["stageFilePath"])
    assert.ok(crossed[0]!.chars < 1024, "only the path crosses")
    assert.equal(encoded.calls, 0, "nothing is encoded in the window")
    assert.equal(kept.size, picture.length, "its size is recorded as it's staged")
    assert.ok(readFileSync(kept.path).equals(picture))
    assert.match(basename(kept.path), /^[0-9a-z]{1,12}-[0-9a-z]{1,8}-screenshot\.png$/, "named as the sweep reads a staged file")
    assert.ok(headOf(basename(kept.path)), "and the sweep finds its head")
    const sent = promptAttachment({ id: "a", index: 1, name: "screenshot.png", mimeType: "image/png", size: kept.size, kind: "image", stagedPath: kept.path })
    assert.deepEqual(sent, { name: "screenshot.png", mimeType: "image/png", size: kept.size, data: undefined, path: kept.path })
    // A draft restored from before this (or from a message that carried bytes) still sends its path alone.
    assert.equal(promptAttachment({ id: "a", index: 1, name: "s.png", mimeType: "image/png", kind: "image", stagedPath: kept.path, data: "AAAA" }).data, undefined)
    assert.equal(promptAttachment({ id: "a", index: 1, name: "s.png", mimeType: "image/png", kind: "image", data: "AAAA" }).data, "AAAA", "an image with no path keeps the bytes it came with")
    console.log("PASS: a file with a path is staged by its path; the draft and the message carry a reference and no bytes")
  }

  // The window: a paste has no path, so it crosses in pieces of a bounded size and lands whole.
  {
    const crossed: Crossing[] = []
    const { encoded, encode } = countingEncoder()
    const pasted = new File([picture], "pasted.png", { type: "image/png" })
    const kept = await stageAttachment(pasted, stagingBridge(staged, new Map(), crossed), encode)
    assert.equal(crossed.length, Math.ceil(picture.length / STAGED_PART_BYTES), "one call a piece")
    assert.ok(crossed.every((call) => call.method === "stageFilePart"))
    const bound = Math.ceil(STAGED_PART_BYTES / 3) * 4 + 512
    assert.ok(Math.max(...crossed.map((call) => call.chars)) <= bound, `no call carries more than a piece (${Math.max(...crossed.map((call) => call.chars))} of ${bound})`)
    assert.equal(encoded.largest, STAGED_PART_BYTES, "and the window never encodes more than a piece at once")
    assert.equal(kept.size, picture.length)
    assert.ok(readFileSync(kept.path).equals(picture), "the pieces land as the file")
    // A piece sent twice writes the same bytes to the same place.
    const again = await stagePart(staged, "pasted.png", picture.subarray(0, STAGED_PART_BYTES).toString("base64"), { path: kept.path, offset: 0 })
    assert.equal(again.size, picture.length)
    assert.ok(readFileSync(kept.path).equals(picture))
    // A piece goes only into a file an earlier piece made in the staging folder.
    await assert.rejects(stagePart(staged, "x", "AAAA", { path: onDisk, offset: 0 }), /isn't one being staged here/)
    await assert.rejects(stagePart(staged, "x", "AAAA", { path: join(staged, "never-made.png"), offset: 0 }), /ENOENT/)
    await assert.rejects(stagePart(staged, "x", "A".repeat(MB + 4)), /larger than one message carries/)
    // What fits in one piece is the one call it always was.
    const small: Crossing[] = []
    await stageAttachment(new File([PNG_1x1], "dot.png", { type: "image/png" }), stagingBridge(staged, new Map(), small), encode)
    assert.deepEqual(small.map((call) => call.method), ["stageFile"])
    console.log(`PASS: a ${picture.length / MB} MB paste crosses in ${crossed.length} pieces of at most ${STAGED_PART_BYTES / 1024} KiB`)
  }

  // The host: a sent file is read once and cloned once off the admitting turn, and the same picture is kept once.
  const work: AssetWork[] = []
  const store = join(root, "assets")
  const assets = new LiveAssets(store, (did) => work.push(did))
  const count = (kind: AssetWork["kind"]) => work.filter((did) => did.kind === kind).length
  const digest = createHash("sha256").update(picture).digest("hex")
  {
    const first = await stagePath(staged, onDisk)
    const wire: PromptAttachment[] = [{ name: "screenshot.png", mimeType: "image/png", size: first.size, path: first.path }]
    await assets.hold("request-1", wire)
    assert.deepEqual([count("hash"), count("clone"), count("sync")], [1, 1, 0], "one read to hash it, one clone")
    const began = performance.now()
    const [kept] = assets.retainPrompt(wire, "request-1")
    const admitted = performance.now() - began
    assert.equal(count("sync"), 0, "admitting it touches no file")
    // The count above is the proof; the time only has to be far from a file's worth, whatever else the machine is doing.
    assert.ok(admitted < 25, `admitting it only swaps a path in (${admitted.toFixed(3)} ms)`)
    assert.equal(kept?.path, join(store, `${digest}-screenshot.png`), "kept under its content's hash")
    assert.equal(kept.data, undefined)
    assert.equal(headOf(basename(kept.path!)), digest, "which is the head the sweep matches it by")
    assert.ok(readFileSync(kept.path!).equals(picture))
    assert.equal(statSync(kept.path!).mode & 0o777, 0o600)

    // Attached again (another staging of the same picture): hashed, found, and not copied.
    const second = await stagePath(staged, onDisk)
    const old = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(kept.path!, old, old)
    await assets.hold("request-2", [{ ...wire[0]!, path: second.path }])
    const [reused] = assets.retainPrompt([{ ...wire[0]!, path: second.path }], "request-2")
    assert.equal(reused?.path, kept.path)
    assert.deepEqual([count("hash"), count("clone"), count("reuse"), count("sync")], [2, 1, 1, 0], "the same picture is stored once")
    assert.deepEqual(readdirSync(store), [`${digest}-screenshot.png`])
    assert.ok(Date.now() - statSync(kept.path!).mtimeMs < 60_000, "a reused file's times start again, so the sweep's grace covers it")
    // The same staged file sent again (a retry, a second message) is not read again.
    await assets.hold("request-3", wire)
    assert.equal(count("hash"), 2, "a file already hashed is known by what stat says of it")
    assets.release("request-3")
    // A file already in the store is kept where it is.
    await assets.hold("request-4", [{ ...wire[0]!, path: kept.path }])
    assert.deepEqual(assets.retainPrompt([{ ...wire[0]!, path: kept.path }], "request-4"), [{ ...wire[0]!, path: kept.path }])
    assert.equal(count("sync"), 0)
    console.log("PASS: the host hashes a sent file once, clones it once, keeps the same picture once, and admits the message without touching a file")
  }

  // A message that isn't held ahead (a caller from before this) is kept as it's admitted, as it always was.
  {
    const direct = await stagePath(staged, onDisk)
    const before = count("sync")
    const [kept] = assets.retainPrompt([{ name: "screenshot.png", mimeType: "image/png", path: direct.path }])
    assert.equal(count("sync"), before + 1)
    assert.match(basename(kept!.path!), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-screenshot\.png$/)
    assert.ok(readFileSync(kept!.path!).equals(picture))
    // Held under one request and admitted under another, or changed since: not taken for it.
    await assets.hold("request-5", [{ name: "screenshot.png", mimeType: "image/png", path: direct.path }])
    const [other] = assets.retainPrompt([{ name: "other.png", mimeType: "image/png", path: direct.path }], "request-5")
    assert.match(basename(other!.path!), /-other\.png$/)
    // A file that's gone still refuses the prompt, saying why.
    await assets.hold("request-6", [{ name: "gone.png", mimeType: "image/png", path: join(root, "gone.png") }])
    assert.throws(() => assets.retainPrompt([{ name: "gone.png", mimeType: "image/png", path: join(root, "gone.png") }], "request-6"), /gone\.png could not be read \(ENOENT\)/)
    console.log("PASS: a message nobody held ahead is still kept as it's admitted, and a missing file still refuses it")
  }

  // A message that carries its bytes is kept by their hash, decoded a piece at a time, and keeps them for its harness.
  {
    const data = picture.toString("base64")
    const wire: PromptAttachment[] = [{ name: "from-phone.png", mimeType: "image/png", size: picture.length, data }]
    const before = count("sync")
    await assets.hold("legacy-1", wire)
    const [kept] = assets.retainPrompt(wire, "legacy-1")
    assert.equal(count("sync"), before, "decoded and written off the admitting turn")
    assert.equal(kept?.path, join(store, `${digest}-from-phone.png`))
    assert.equal(kept.data, data, "its bytes stay with it, as its harness takes them")
    assert.ok(readFileSync(kept.path!).equals(picture))
    // Not held ahead: exactly the old path, with the same file as its answer.
    assert.deepEqual(assets.retainPrompt(wire), [kept])
    // Base64 that isn't clean (line breaks, as some encoders write it) decodes to the same bytes.
    const broken = data.replace(/(.{76})/g, "$1\n")
    await assets.hold("legacy-2", [{ ...wire[0]!, name: "wrapped.png", data: broken }])
    const [wrapped] = assets.retainPrompt([{ ...wire[0]!, name: "wrapped.png", data: broken }], "legacy-2")
    assert.equal(basename(wrapped!.path!), `${digest}-wrapped.png`)
    assert.ok(readFileSync(wrapped!.path!).equals(picture))
    assert.deepEqual(readdirSync(store).filter((name) => name.endsWith(".tmp")), [], "nothing temporary is left")
    // What a message is known by doesn't move: a retry under its ID is the same message to a host from before this.
    const fingerprint = (attachments: PromptAttachment[]) => createHash("sha256").update(JSON.stringify(["hello", attachments.map((each) => [each.name, each.mimeType, each.size, each.data, each.path])])).digest("hex")
    const byPath: PromptAttachment[] = [{ name: "screenshot.png", mimeType: "image/png", size: 3, path: "/staged/1-2-screenshot.png" }]
    assert.equal(promptFingerprint("hello", byPath), fingerprint(byPath))
    assert.equal(promptFingerprint("hello", [{ name: "dot.png", mimeType: "image/png", size: 68, data: PNG_1x1.toString("base64") }]), fingerprint([{ name: "dot.png", mimeType: "image/png", size: 68, data: PNG_1x1.toString("base64") }]))
    console.log("PASS: a message carrying its bytes is kept by their hash off the admitting turn, and still carries them")
  }

  // Each harness is handed what it was handed before: only the kept file's name differs (a hash where a UUID was).
  {
    const small = join(root, "dot.png")
    writeFileSync(small, PNG_1x1)
    const notes = join(root, "notes.pdf")
    writeFileSync(notes, "%PDF-1.4 fixture")
    const drivers = new LiveAssets(join(root, "driver-assets"))
    const handedTo = async (attachments: PromptAttachment[]) => {
      const named = (path: string | undefined) => path?.replace(/\/(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/g, "/<kept>-")
      const text = JSON.stringify({
        acp: acpPromptBlocks("look", attachments, { image: true }),
        acpTextOnly: acpPromptBlocks("look", attachments, { image: false }),
        claude: await claudeInputContent("look", attachments),
        codex: codexInput("look", attachments),
        cursor: { images: promptImages(attachments), text: promptText("look", attachments) },
        opencode: promptFiles(attachments),
      })
      return named(text)
    }
    const fromDesk = (): PromptAttachment[] => [
      { name: "dot.png", mimeType: "image/png", size: PNG_1x1.length, path: small },
      { name: "notes.pdf", mimeType: "application/pdf", size: 16, path: notes },
    ]
    const fromPhone = (): PromptAttachment[] => [{ name: "dot.png", mimeType: "image/png", size: PNG_1x1.length, data: PNG_1x1.toString("base64") }]
    for (const [label, wire] of [["a staged file", fromDesk], ["inline bytes", fromPhone]] as const) {
      const before = await handedTo(drivers.retainPrompt(wire()))
      await drivers.hold(label, wire())
      const after = await handedTo(drivers.retainPrompt(wire(), label))
      assert.equal(after, before, `${label}: every driver's input is what it was`)
    }
    const desk = drivers.retainPrompt(fromDesk())
    assert.deepEqual(acpPromptBlocks("look", desk, { image: true }).map((block) => block.type), ["text", "resource_link", "resource_link"], "ACP: a staged file is a link to it")
    assert.deepEqual(codexInput("look", desk).map((input) => input.type), ["text", "localImage", "text"], "Codex: a picture by its path")
    const claude = await claudeInputContent("look", desk)
    assert.ok(Array.isArray(claude) && claude[1]?.type === "image" && claude[1].source.type === "base64" && claude[1].source.data === PNG_1x1.toString("base64"), "Claude: the picture's bytes, read from the kept file")
    assert.deepEqual(promptImages(desk), [], "Cursor: a staged picture goes as a named file")
    assert.match(promptFiles(desk)[0]!.uri, /^file:\/\//, "OpenCode: a file URL")
    const phone = drivers.retainPrompt(fromPhone())
    assert.equal(acpPromptBlocks("look", phone, { image: true })[1]?.type, "image", "ACP: inline bytes stay an image block")
    assert.deepEqual(promptImages(phone), [{ data: PNG_1x1.toString("base64"), mimeType: "image/png" }])
    assert.match(promptFiles(phone)[0]!.uri, /^data:image\/png;base64,/)
    // Claude's encode, a step at a time, is byte for byte the encode of the whole file.
    const large = join(root, "large.png")
    const bytes = randomBytes(3 * MB + 1234)
    writeFileSync(large, bytes)
    const encoded = await claudeInputContent("look", [{ name: "large.png", mimeType: "image/png", size: bytes.length, path: large }])
    assert.ok(Array.isArray(encoded) && encoded[1]?.type === "image" && encoded[1].source.type === "base64" && encoded[1].source.data === bytes.toString("base64"))
    console.log("PASS: ACP, Claude, Codex, Cursor and OpenCode are each handed an attachment in the shape they were before")
  }

  // The window's state: what's sent crosses as a reference, the message just sent draws from its file, and a preview
  // mounted again draws from what the window holds.
  {
    const memory = new Map<string, string>()
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      get length() { return memory.size },
      key: (index: number) => [...memory.keys()][index] ?? null,
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
      removeItem: (key: string) => void memory.delete(key),
    } })
    Object.defineProperty(globalThis, "window", { value: { addEventListener() {}, removeEventListener() {} }, configurable: true })
    const { installMockBridge } = await import("../src/dev/mock-bridge")
    const { getMako } = await import("../src/lib/bridge")
    const { acpStore } = await import("../src/state/acp-state")
    const { applyLiveSnapshot } = await import("../src/state/live-recovery")
    const { sendTo } = await import("../src/state/acp-queue")
    const { hostConnectionStore } = await import("../src/state/host-connection")
    const { projectLive } = await import("../src/state/live-projection")
    const media = await import("../src/state/transcript-media")
    const { lonePictureUrl } = await import("../src/lib/transcript-media")
    installMockBridge()
    const bridge = getMako()
    const conversation = auditId(900)
    const snapshot = (status: LiveSnapshot["session"]["status"] = "ready"): LiveSnapshot => {
      const base = auditSnapshot(1, "claude")
      base.session.id = conversation
      base.session.status = status
      base.requests = []
      return base
    }
    applyLiveSnapshot(snapshot())
    acpStore.set({ activeKey: conversation })
    const sent: PromptAttachment[][] = []
    let admit = (): void => undefined
    mock.method(bridge, "livePrompt", (_id: string, _request: string, _text: string, attachments: PromptAttachment[]) => {
      sent.push(attachments)
      // Held until the test has looked at the message as it's drawn before the host has it.
      return new Promise<void>((resolve) => { admit = resolve })
    })
    mock.method(bridge, "liveSnapshot", async () => snapshot())
    mock.method(bridge, "liveRead", async () => { throw new Error("Unknown Mako host method") })

    const stagedPath = join(staged, "1-2-screenshot.png")
    const delivery = sendTo(conversation, "look at this", [{ name: "screenshot.png", mimeType: "image/png", size: picture.length, path: stagedPath, data: picture.subarray(0, 300).toString("base64") }], auditId(901))
    await nextTurn()
    const live = acpStore.get().conversations[conversation]
    const optimistic = live?.projection?.messages.at(-1)
    assert.equal(optimistic?.role, "user")
    const drawn = optimistic?.blocks.find((block) => block.type === "attachment")
    assert.deepEqual(drawn?.type === "attachment" ? drawn.source : undefined, { kind: "file", path: stagedPath }, "the message just sent draws from its staged file, never a data: URL")
    for (let turn = 0; turn < 50 && !sent.length; turn += 1) await nextTurn()
    assert.equal(sent.length, 1)
    assert.deepEqual(sent[0], [{ name: "screenshot.png", mimeType: "image/png", size: picture.length, path: stagedPath, data: undefined }], "and crosses the bridge as its path")
    assert.ok(JSON.stringify(sent[0]).length < 1024)
    admit()
    await delivery
    // Only a message with no file anywhere (another device's, before its record lands) draws from its bytes.
    const inline = projectLive(snapshot(), undefined, [{ id: auditId(902), text: "from a phone", attachments: [{ name: "dot.png", mimeType: "image/png", data: "AAAA" }] }])
    const carried = inline.messages.at(-1)?.blocks.find((block) => block.type === "attachment")
    assert.equal(carried?.type === "attachment" ? carried.source.kind : undefined, "inline")

    // A preview mounted again draws from what the window holds, with no call to the host.
    let reads = 0
    const signed = (name: string): FileContents => ({ path: name, contents: "", size: 1, binary: true, truncated: false, media: "image", mimeType: "image/png", previewUrl: `mako-file://asset/p/s/${name}`, thumbnailUrl: `mako-file://asset/p/s/${name}?rendition=thumbnail`, width: 3840, height: 2160 })
    mock.method(bridge, "readLiveFile", async (_id: string, path: string) => {
      reads += 1
      await nextTurn()
      return path.endsWith(".md") ? { path, contents: "# Notes", size: 7, binary: false, truncated: false } : signed(basename(path))
    })
    const kept = { path: join(store, `${digest}-screenshot.png`), liveId: conversation, settled: true }
    assert.equal(media.heldTranscriptMedia(kept), undefined)
    const [one, two] = await Promise.all([media.readTranscriptMedia(kept), media.readTranscriptMedia(kept)])
    assert.equal(reads, 1, "two previews asking at once share one call")
    assert.equal(one, two)
    assert.equal(media.heldTranscriptMedia(kept), one, "mounted again, it's drawn from what's held")
    assert.equal(await media.readTranscriptMedia(kept), one)
    assert.equal(reads, 1, "with no call to the host")
    assert.doesNotMatch(one.previewUrl, /^data:/)
    await media.readTranscriptMedia(kept, { fresh: true })
    assert.equal(reads, 2, "a Retry asks the host again")
    // A file the agent may rewrite is held only while its conversation is at rest and its calls have touched nothing since.
    const notes = { path: "notes.md", liveId: conversation, purpose: "preview" as const }
    await media.readTranscriptFile(notes)
    assert.equal(reads, 3)
    assert.equal((await media.readTranscriptFile(notes)).contents, "# Notes")
    assert.equal(reads, 3, "at rest: held")
    assert.equal(media.heldTranscriptFile(notes, Date.now() + 6 * 60_000), undefined, "text is held a few minutes, no longer")
    await media.readTranscriptFile(notes)
    assert.equal(reads, 4)
    // The agent starts work: what was read before the conversation moved is asked again, and a read made while
    // it works is held only a moment.
    applyLiveSnapshot({ ...snapshot("running"), revision: (acpStore.get().conversations[conversation]?.revision ?? 0) + 1 })
    assert.equal(media.heldTranscriptFile(notes), undefined, "the conversation moved since: asked again")
    await media.readTranscriptFile(notes)
    assert.equal(reads, 5)
    assert.ok(media.heldTranscriptFile(notes), "just read: held a moment even as the agent works")
    assert.equal(media.heldTranscriptFile(notes, Date.now() + 6_000), undefined, "while the agent works, a read is soon asked again")
    assert.ok(media.heldTranscriptMedia(kept), "Mako's own copy of an attachment is never rewritten, so it stays held")
    hostConnectionStore.set({ kind: "disconnected", message: "gone", since: Date.now(), stage: "quiet" })
    assert.equal(media.heldTranscriptMedia(kept), undefined, "a URL doesn't outlive the host that signed it")
    hostConnectionStore.set({ kind: "connected" })

    // A picture alone draws from the rendition that fills its box; the original is left for the lightbox.
    const large = signed("shot.png")
    assert.equal(lonePictureUrl(large, 2), "mako-file://asset/p/s/shot.png?rendition=inline")
    assert.equal(lonePictureUrl(large, 1), large.thumbnailUrl, "at one pixel to a point the tile's thumbnail fills the box")
    assert.equal(lonePictureUrl(large, 4), large.previewUrl, "a display denser than the rendition draws the original")
    assert.equal(lonePictureUrl({ ...large, width: 1600, height: 1000 }, 2), large.previewUrl, "a picture not much larger than its rendition draws as it is")
    assert.equal(lonePictureUrl({ ...large, thumbnailUrl: undefined }, 2), large.previewUrl, "a host that offers no rendition is asked for none")
    assert.equal(lonePictureUrl({ ...large, thumbnailUrl: "data:image/png;base64,AAAA" }, 2), large.previewUrl)
    assert.equal(large.previewUrl, "mako-file://asset/p/s/shot.png", "the lightbox's URL is the file itself")
    console.log("PASS: a sent picture crosses as its path and draws from its file; a preview mounted again asks the host nothing; a picture alone draws a rendition")
  }

  // What sending a 10 MB picture costs. `before` is the code as it was: the window read and encoded every image as
  // it was attached, and the host kept a file as the message was admitted, on that turn.
  {
    const timed = async (run: () => Promise<void>) => {
      const began = performance.now()
      await run()
      return performance.now() - began
    }
    const before = countingEncoder()
    const file = new File([picture], "screenshot.png", { type: "image/png" })
    const paths = new Map([[file, onDisk]])
    let held = ""
    // The staging call is the same before and after; what went is the read and encode of the whole file beside it.
    const windowBefore = await timed(async () => void (held = await before.encode(file)))
    const after = countingEncoder()
    const stagingCall = await timed(async () => void await stageAttachment(file, stagingBridge(staged, paths, []), after.encode))
    const windowAfter = 0
    const pasteBefore = charsOf(["screenshot.png", held])
    const pasteAfter: Crossing[] = []
    const paste = countingEncoder()
    await stageAttachment(new File([picture], "pasted.png", { type: "image/png" }), stagingBridge(staged, new Map(), pasteAfter), paste.encode)

    const bench = new LiveAssets(join(root, "bench-assets"))
    mkdirSync(join(root, "bench-assets"), { recursive: true })
    const byPath = async (name: string): Promise<PromptAttachment[]> => [{ name, mimeType: "image/png", size: picture.length, path: (await stagePath(staged, onDisk)).path }]
    // Before, by its path: copied on the admitting turn. After: held ahead, then admitted.
    const pathWire = await byPath("by-path-before.png")
    const hostPathBefore = await timed(async () => void bench.retainPrompt(pathWire))
    const heldWire = await byPath("by-path-after.png")
    const hostPathLoop = (await loopDuring(() => bench.hold("bench-path", heldWire))).longest
    const hostPathAfter = await timed(async () => void bench.retainPrompt(heldWire, "bench-path"))
    // Before, with its bytes (as the earlier audit read it, and as another device's or a cloud move's message is):
    // decoded, hashed and written on the admitting turn.
    const dataBefore: PromptAttachment[] = [{ name: "by-bytes-before.png", mimeType: "image/png", size: picture.length, data: held }]
    const hostDataBefore = await timed(async () => void bench.retainPrompt(dataBefore))
    const other = randomBytes(10 * MB).toString("base64")
    const dataAfter: PromptAttachment[] = [{ name: "by-bytes-after.png", mimeType: "image/png", size: picture.length, data: other }]
    const dataLoop = await loopDuring(() => bench.hold("bench-data", dataAfter))
    const hostDataLoop = dataLoop.longest
    const hostDataAfter = await timed(async () => void bench.retainPrompt(dataAfter, "bench-data"))

    const ms = (value: number) => `${value.toFixed(value < 10 ? 2 : 0)} ms`
    console.log([
      "Sending a 10 MB picture, before and after:",
      `  window, attaching a file with a path   before ${ms(windowBefore)} to read and encode it here (Node's encoder; a page's FileReader is slower), ${held.length} base64 characters held in the draft   after ${ms(windowAfter)}, ${after.encoded.bytes} bytes read, a path held (the staging call itself, ${ms(stagingCall)}, is the same)`,
      `  bridge, the message                    before ${charsOf([pathWire])} characters   after ${charsOf([heldWire])} characters (a path either way: the queue already dropped the bytes of a staged file)`,
      `  bridge, a paste with no path           before 1 call of ${pasteBefore} characters   after ${pasteAfter.length} calls of at most ${Math.max(...pasteAfter.map((call) => call.chars))}`,
      `  host turn held, sent by its path       before ${ms(hostPathBefore)} (a clone on the admitting turn)   after ${ms(hostPathAfter)} admitting, longest hold while keeping it ${ms(hostPathLoop)}`,
      `  host turn held, sent with its bytes    before ${ms(hostDataBefore)} (decode, hash and write on the admitting turn)   after ${ms(hostDataAfter)} admitting, longest hold while keeping it ${ms(hostDataLoop)}`,
    ].join("\n"))
    assert.equal(after.encoded.bytes, 0, "after: a file with a path is never read in the window")
    assert.ok(paste.encoded.largest <= STAGED_PART_BYTES, "and a paste a piece at a time")
    assert.ok(hostPathAfter < 25 && hostDataAfter < 25, "admitting a held message is a path swapped in")
    // The loop is never held for the whole of it: it turns between the pieces, where the one call took no turn.
    assert.ok(dataLoop.turns >= 10, `keeping 10 MB of inline bytes gave the loop ${dataLoop.turns} turns`)
  }

  // A large file: the loop keeps turning while it's hashed and kept.
  {
    const big = join(root, "recording.mov")
    writeFileSync(big, randomBytes(96 * MB))
    const large = new LiveAssets(join(root, "large-assets"))
    const wire: PromptAttachment[] = [{ name: "recording.mov", mimeType: "video/quicktime", size: 96 * MB, path: big }]
    const whole = performance.now()
    createHash("sha256").update(readFileSync(big)).digest("hex")
    const oneCall = performance.now() - whole
    const { longest, turns } = await loopDuring(() => large.hold("big", wire))
    const [kept] = large.retainPrompt(wire, "big")
    assert.equal(statSync(kept!.path!).size, 96 * MB)
    assert.ok(turns >= 48, `the loop turned ${turns} times while 96 MB was hashed: at least once every two megabytes`)
    assert.ok(longest < oneCall, `hashing 96 MB held the loop ${longest.toFixed(1)} ms at most, where reading and hashing it in one call takes ${oneCall.toFixed(0)} ms`)
    console.log(`PASS: a 96 MB file is hashed and kept with the loop held ${longest.toFixed(1)} ms at most over ${turns} turns (one call: ${oneCall.toFixed(0)} ms)`)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
// The mock bridge keeps timers of its own.
process.exit(0)
