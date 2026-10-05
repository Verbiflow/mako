import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ThreadArchives } from "../electron/thread-archives.ts"
import { ThreadLifecycle } from "../electron/thread-lifecycle.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import { NO_NATIVE_EXCLUSION } from "../electron/contracts/execution-context.ts"
import { NO_NATIVE_PROMPT_IDENTITY } from "../electron/contracts/native-prompt-identity.ts"
import type { LiveSessionState, ThreadRef } from "../electron/shared.ts"
import { archivedByKeys, threadArchiveKey, threadShownKey, type ThreadArchiveSnapshot } from "../electron/contracts/thread-lifecycle.ts"
import { followNativeArchives } from "../electron/thread-lifecycle.ts"
import type { HostEvent } from "../electron/shared.ts"

const root = await mkdtemp(join(tmpdir(), "mako-thread-lifecycle-"))
const archives = new ThreadArchives(join(root, "archives.sqlite"))
const states = new Map<string, LiveSessionState>()
const releases = new Map<string, () => void>()
const sent: string[] = []
let cancellations = 0
const driver: ProviderLiveDriver = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture" },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
  provider: "fixture", canResume: true, available: () => true,
  async start(cwd, options) {
    const state: LiveSessionState = { id:options.conversationId, nativeId:options.conversationId, nativePath:join(root,`${options.conversationId}.json`), harness:"fixture", cwd, status:"ready", connection:"connected", modes:[], currentMode:null, configOptions:[] }
    states.set(state.id, state)
    return state
  },
  async prompt(id, text) {
    const state = states.get(id)
    assert.ok(state)
    sent.push(text)
    owner.observe({type:"live-session",session:{...state,status:"running"}})
    await new Promise<void>((resolve) => releases.set(id, resolve))
  },
  async cancel(id) {
    cancellations++
    const state = states.get(id)
    assert.ok(state)
    owner.observe({type:"live-session",session:{...state,status:"ready",lastStop:"cancelled"}})
    releases.get(id)?.()
  },
  async permission() {}, async setMode() {}, close(id) { releases.get(id)?.() },
}
const owner = new LiveConversations({root:join(root,"journals"),appPath:root,driver:()=>driver,history:async()=>null,emit:()=>{}})
const lifecycle = new ThreadLifecycle({live:owner,archives,native:{list:()=>[],editQueued:()=>[]},threads:()=>[],nativeToken:()=>null,abortNative:()=>{},external:()=>false})
const wait = async (predicate: () => boolean) => { const end=Date.now()+2000; while(!predicate()) { if(Date.now()>end) throw new Error("Lifecycle did not settle"); await new Promise(resolve=>setImmediate(resolve)) } }
try {
  const id = randomUUID()
  const other = randomUUID()
  await owner.start("fixture", root, {conversationId:id})
  await owner.start("fixture", root, {conversationId:other})
  await wait(()=>owner.snapshot(id)?.session.status === "ready" && owner.snapshot(other)?.session.status === "ready")
  const requestId=randomUUID()
  owner.submit(id,requestId,"first")
  owner.submit(other,randomUUID(),"other")
  await wait(()=>releases.has(id) && releases.has(other))
  const queued=randomUUID()
  owner.submit(id,queued,"queued")
  const target={kind:"live",id} as const
  const command={id:randomUUID(),target,archived:true}
  lifecycle.archive(command)
  assert.equal(cancellations,0)
  assert.ok(archives.snapshot().keys.includes(threadArchiveKey(target)))
  assert.equal(lifecycle.controls(target).stop?.kind,"live")
  const restore={id:randomUUID(),target,archived:false}
  lifecycle.archive(restore)
  lifecycle.archive(command)
  assert.equal(archives.snapshot().keys.includes(threadArchiveKey(target)),false,"Retrying an old archive must not undo a newer restore")
  assert.throws(()=>lifecycle.archive({...command,archived:false}), /already used/)
  assert.equal(await lifecycle.stop({kind:"live",id,requestId:randomUUID()}),false)
  assert.equal(cancellations,0)
  await Promise.all([lifecycle.stop({kind:"live",id,requestId}),lifecycle.stop({kind:"live",id,requestId})])
  assert.equal(cancellations,1)
  assert.equal(owner.snapshot(id)?.requests.find(r=>r.id===queued)?.status,"held")
  assert.equal(owner.snapshot(other)?.session.status,"running")
  assert.deepEqual(sent.sort(),["first","other"])
  assert.equal(await lifecycle.stop({kind:"live",id,requestId}),true)
  assert.equal(cancellations,1)
  const otherTarget = { kind: "live", id: other } as const
  lifecycle.archive({ id: randomUUID(), target: otherTarget, archived: true })
  const otherState = states.get(other)
  assert.ok(otherState)
  owner.observe({
    type: "live-session",
    session: { ...otherState, status: "ready", lastStop: "end_turn" },
  })
  releases.get(other)?.()
  await wait(
    () => owner.snapshot(other)?.session.connection === "hibernated"
  )
  lifecycle.archive({id:randomUUID(),target,archived:true})
  const secondReader=new ThreadArchives(join(root,"archives.sqlite"))
  assert.deepEqual(secondReader.snapshot(),archives.snapshot())
  secondReader.close()

  // A Session its harness archived sits with the archived ones until it's
  // restored here; archiving it again here forgets that restore.
  const refs: ThreadRef[] = [
    { harness: "codex", nativeId: "archived-in-codex", path: "/home/.codex/archived_sessions/rollout-a.jsonl", nativeArchived: true, nativeArchiveStamp: "100" },
    { harness: "claude", nativeId: "plain", path: "/home/.claude/projects/p/plain.jsonl" },
  ]
  const natives = new ThreadLifecycle({live:owner,archives,native:{list:()=>[],editQueued:()=>[]},threads:()=>refs,nativeToken:()=>null,abortNative:()=>{},external:()=>false})
  const codex = { kind: "native", provider: "codex", nativeId: "archived-in-codex" } as const
  assert.equal(natives.controls(codex).archived, true, "archived in Codex is archived here")
  natives.archive({ id: randomUUID(), target: codex, archived: false })
  assert.equal(natives.controls(codex).archived, false, "restored here though Codex still has it archived")
  assert.ok(archives.snapshot().keys.includes(threadShownKey(threadArchiveKey(codex), "100")))
  natives.archive({ id: randomUUID(), target: codex, archived: true })
  assert.equal(natives.controls(codex).archived, true)
  assert.equal(archives.snapshot().keys.some((key) => key.startsWith("shown")), false, "archiving again forgets the restore")
  natives.archive({ id: randomUUID(), target: codex, archived: false })
  refs[0] = { ...refs[0]!, path: "/home/.codex/sessions/2026/09/28/rollout-a.jsonl", nativeArchived: undefined, nativeArchiveStamp: undefined }
  assert.equal(natives.controls(codex).archived, false, "unarchived in Codex, it stays out")

  // A restore holds for the harness's archive it answered, no longer.
  const shownKeys = () => archives.snapshot().keys.filter((key) => key.startsWith("shown"))
  const events = new Set<(event: HostEvent) => void>()
  const emitted: ThreadArchiveSnapshot[] = []
  const stopFollowing = followNativeArchives(
    natives,
    (subscriber) => { events.add(subscriber); return () => events.delete(subscriber) },
    (event) => { if (event.type === "thread-archives") emitted.push(event.snapshot) }
  )
  const observe = (event: HostEvent) => { for (const subscriber of events) subscriber(event) }
  const archivedPath = "/home/.codex/archived_sessions/rollout-a.jsonl"
  refs[0] = { ...refs[0]!, path: archivedPath, nativeArchived: true, nativeArchiveStamp: "100" }
  natives.archive({ id: randomUUID(), target: codex, archived: false })
  observe({ type: "threads", threads: refs })
  assert.equal(emitted.length, 0, "the archive a restore answered is no reason to forget it")
  assert.equal(natives.controls(codex).archived, false)
  refs[0] = { ...refs[0]!, nativeArchiveStamp: "200" }
  assert.equal(natives.controls(codex).archived, true, "archived again in Codex, even unseen in between, is archived here")
  observe({ type: "thread-ref", ref: refs[0]! })
  assert.deepEqual(shownKeys(), [], "the stale restore is forgotten")
  assert.equal(emitted.at(-1)?.revision, archives.snapshot().revision, "windows hear the forgetting")
  natives.archive({ id: randomUUID(), target: codex, archived: false })
  assert.equal(natives.controls(codex).archived, false)
  refs[0] = { ...refs[0]!, path: "/home/.codex/sessions/2026/09/28/rollout-a.jsonl", nativeArchived: undefined, nativeArchiveStamp: undefined }
  observe({ type: "thread-removed", path: archivedPath })
  observe({ type: "thread-ref", ref: refs[0]! })
  assert.deepEqual(shownKeys(), [], "unarchived in Codex, which moves the rollout out, the restore is done")
  refs[0] = { ...refs[0]!, path: archivedPath, nativeArchived: true, nativeArchiveStamp: "200" }
  assert.equal(natives.controls(codex).archived, true, "unarchived and archived again in Codex, even to the same stamp, is archived here")
  // Where Mako keeps a copy, unarchiving turns the old path into that copy
  // rather than a removal; Codex's next archive to it ends the restore.
  natives.archive({ id: randomUUID(), target: codex, archived: false })
  observe({ type: "thread-ref", ref: { ...refs[0]!, archived: true } })
  refs[0] = { ...refs[0]!, path: "/home/.codex/sessions/2026/09/28/rollout-a.jsonl", nativeArchived: undefined, nativeArchiveStamp: undefined }
  observe({ type: "thread-ref", ref: refs[0]! })
  assert.deepEqual(shownKeys(), [threadShownKey(threadArchiveKey({ kind: "file", path: archivedPath }), "200")], "only the saved copy's path keeps a marker")
  refs[0] = { ...refs[0]!, path: archivedPath, nativeArchived: true, nativeArchiveStamp: "300" }
  assert.equal(natives.controls(codex).archived, true)
  observe({ type: "thread-ref", ref: refs[0]! })
  assert.deepEqual(shownKeys(), [])

  // Cursor records no archive time: only a row seen unarchived ends a restore.
  const cursorRef: ThreadRef = { harness: "cursor-desktop", nativeId: "cursor-chat", path: "/cursor/state.vscdb#cursor-chat", nativeArchived: true }
  refs.push(cursorRef)
  const cursor = { kind: "native", provider: "cursor-desktop", nativeId: "cursor-chat" } as const
  natives.archive({ id: randomUUID(), target: cursor, archived: false })
  assert.equal(natives.controls(cursor).archived, false)
  observe({ type: "threads", threads: [{ ...cursorRef, nativeArchived: undefined, archived: true, path: "/mako/kept/cursor-chat.json" }] })
  assert.equal(natives.controls(cursor).archived, false, "Mako's saved copy says nothing about Cursor's archive")
  assert.equal(shownKeys().length > 0, true)
  observe({ type: "thread-ref", ref: { ...cursorRef, nativeArchived: undefined } })
  assert.deepEqual(shownKeys(), [], "unarchived in Cursor, the restore is done")
  assert.equal(natives.controls(cursor).archived, true, "archived again in Cursor is archived here")
  refs.pop()

  // A restore through a live conversation marks its live key; the row the
  // conversation owns ends that one too.
  const liveRef: ThreadRef = { harness: "fixture", nativeId: id, path: join(root, `${id}.json`), nativeArchived: true, nativeArchiveStamp: "1" }
  refs.push(liveRef)
  const liveTarget = { kind: "native", provider: "fixture", nativeId: id } as const
  const liveKey = threadArchiveKey({ kind: "live", id })
  lifecycle.archive({ id: randomUUID(), target: { kind: "live", id }, archived: false })
  natives.archive({ id: randomUUID(), target: liveTarget, archived: false })
  assert.ok(shownKeys().includes(threadShownKey(liveKey, "1")))
  observe({ type: "thread-ref", ref: { ...liveRef, nativeArchived: undefined, nativeArchiveStamp: undefined } })
  assert.deepEqual(shownKeys(), [], "the owning conversation's marker goes with the row's")
  refs.pop()
  stopFollowing()
  assert.equal(events.size, 0)
  const plain = { kind: "native", provider: "claude", nativeId: "plain" } as const
  natives.archive({ id: randomUUID(), target: plain, archived: true })
  natives.archive({ id: randomUUID(), target: plain, archived: false })
  assert.equal(archives.snapshot().keys.some((key) => key.startsWith("shown:") && key.includes("plain")), false, "restoring a Session only Mako archived records nothing more")
  assert.equal(archivedByKeys(["file:/x"], new Set(), { nativeArchived: true }), true)
  assert.equal(archivedByKeys(["file:/x"], new Set(["shown:file:/x"]), { nativeArchived: true }), false)
  assert.equal(archivedByKeys(["file:/x"], new Set(["shown:file:/x", "file:/x"]), { nativeArchived: true }), true, "Mako's own archive wins over a restore marker")
  assert.equal(archivedByKeys(["file:/x"], new Set(["shown@7:file:/x"]), { nativeArchived: true, nativeArchiveStamp: "7" }), false)
  assert.equal(archivedByKeys(["file:/x"], new Set(["shown@7:file:/x"]), { nativeArchived: true, nativeArchiveStamp: "8" }), true, "a restore of another archive doesn't answer this one")
  assert.equal(archivedByKeys(["file:/x"], new Set(["shown:file:/x"]), { nativeArchived: true, nativeArchiveStamp: "8" }), true)
  console.log("Thread lifecycle: shared archive/restore receipts, duplicate commands, exact-run Stop, held queue and unrelated-run isolation verified; a Session its harness archived is archived here until restored here, and archived again once its harness unarchives and re-archives it")
} finally { owner.stop(); archives.close(); await rm(root,{recursive:true,force:true}) }
