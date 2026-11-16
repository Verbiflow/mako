import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { renderToStaticMarkup } from "react-dom/server"
import { useLiveActionNotice } from "../src/components/viewer/live-action-notice"
import { useTransferNotice } from "../src/components/viewer/transfer-notice"
import { recoverableRequests } from "../src/state/prompt-delivery"
import { acpStore, type LiveAcpConversation } from "../src/state/acp"
import { threadsStore } from "../src/state/threads"
import { fixtureHarnesses } from "../src/dev/harness-fixtures"
import type { CompactionRecovery, ContextTransfer } from "@mako/host/contracts/conversation-control"

threadsStore.set({ descriptors: fixtureHarnesses })
const id = randomUUID(), original = randomUUID(), retry = randomUUID(), episodeId = randomUUID()
const live: LiveAcpConversation = {
  key: id, draftKey: id, kind: "live", harness: "claude", cwd: "/synthetic", blocks: [], queued: [], hiddenUserPrompt: null,
  createdAt: 1, updatedAt: 1, permission: null, sending: false, canceling: false,
  control: { activeBindingId: id, bindings: [], merges: [], transfers: [], actions: [
    { input: { kind: "compact", id: original }, digest: "original", bindingId: id, createdAt: 1, state: { kind: "failed", reason: "Native summary failed" } },
    { input: { kind: "compact", id: retry }, digest: "retry", bindingId: id, createdAt: 2, state: { kind: "accepted" } },
  ] },
  session: { id, harness: "claude", cwd: "/synthetic", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
}
const episode: CompactionRecovery = { id: episodeId, actionId: original, retryActionId: retry, bindingId: id, createdAt: 1, epoch: "fixture", target: { provider: "claude" }, state: { kind: "retry" } }
function Notices() {
  const action = useLiveActionNotice(), transfer = useTransferNotice()
  return <>{[action, transfer].map(notice => notice ? <div key={notice.id} data-notice={notice.id}>{notice.title} {notice.description}{notice.actions?.map(button => <button key={button.label}>{button.label}</button>)}</div> : null)}</>
}
function draw(plan: CompactionRecovery | undefined, transfers: ContextTransfer[] = []) {
  acpStore.set({ activeKey: id, conversations: { [id]: { ...live, control: { ...live.control!, compactionRecovery: plan, transfers } } } })
  return renderToStaticMarkup(<Notices />)
}
for (const state of [{ kind: "retry" }, { kind: "replace", transferId: randomUUID() }] satisfies CompactionRecovery["state"][]) {
  const html = draw({ ...episode, state })
  assert.equal((html.match(/data-notice=/g) ?? []).length, 1, "recovery owns one line despite original and retry receipts")
  assert.match(html, /Recovering conversation/)
  assert.doesNotMatch(html, /<button|failed|Disconnect|acknowledge/i)
}
const done = draw({ ...episode, state: { kind: "completed", bindingId: id } })
assert.equal(done, "", "finished recovery does not resurrect its old failed/accepted action notices")
const transfer: ContextTransfer = { input: { id: randomUUID(), provider: "claude", text: "", attachments: [] }, createdAt: 1,
  compaction: { recoveryId: episode.id, bindingId: id }, state: { kind: "failed", error: "Native account refused", failure: "permission" } }
const permission = draw({ ...episode, state: { kind: "replace", transferId: transfer.input.id } }, [transfer])
assert.equal((permission.match(/data-notice=/g) ?? []).length, 1)
assert.match(permission, /Check account/)
assert.doesNotMatch(permission, /Recovering conversation/)
console.log("PASS: production notice hooks render one quiet compaction recovery line, retire old receipts, and keep one concrete permission action")

const failed = { id: original, text: "original task", attachments: [], status: "failed" as const }
const continuing = { id: randomUUID(), text: "discovery", attachments: [], status: "queued" as const,
  continues: { requestId: original, reason: "compaction-failed" as const, auto: true } }
assert.deepEqual(recoverableRequests({ blocks: [], requests: [failed, continuing] }), [], "an owned continuation must not offer another Compact and retry for its source")
assert.deepEqual(recoverableRequests({ blocks: [], requests: [failed, { ...continuing, status: "canceled" }] }).map(request => request.id), [original], "withdrawn work must not silently erase the original recovery")
