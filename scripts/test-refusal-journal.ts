import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { makoFacts, makoLogDifference } from "@mako/host/conversations/mako-log"
import { PROVIDER_FAILURE_KINDS } from "@mako/host/contracts/provider-failure"
import { auditSnapshot, auditId } from "./performance-audit-fixtures.ts"

// The pre-refusal fields, applied to actual stored rows. This does not claim an older binary gains refusal policy.
const oldKind = z.enum(PROVIDER_FAILURE_KINDS.filter(kind => kind !== "model-refusal"))
const oldEvidence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("auth"), source: z.enum(["credential-missing", "refresh-failed", "provider-auth-error"]) }),
  z.object({ kind: z.literal("permission"), source: z.literal("provider-permission-error") }),
  z.object({ kind: z.literal("unknown"), source: z.literal("provider-error") }),
  z.object({ kind: z.literal("provider-unavailable"), source: z.enum(["credential-current", "gateway-response", "unconfirmed-auth"]) }),
])
const oldRequest = z.object({ id: z.string(), failure: oldKind.optional(), failureEvidence: oldEvidence.optional() })
const row = z.object({ value: z.string() })
const root = mkdtempSync(join(tmpdir(), "mako-refusal-journal-"))
const evidence = { kind: "model-refusal", source: "native-error" } as const
let snapshot = auditSnapshot(1)
let journal = new LiveJournal(root, snapshot.session.id)
try {
  journal.commit(snapshot)
  snapshot = { ...snapshot, revision: 2, session: { ...snapshot.session, failureEvidence: evidence },
    requests: snapshot.requests.map(request => ({ ...request, status: "failed", failure: "model-refusal", failureEvidence: evidence })),
    control: { merges: [], activeBindingId: auditId(40), bindings: [{ id: auditId(40), provider: "fixture", coveredBlocks: 0, includesBase: false }], transfers: [{ input: { id: auditId(50), provider: "fixture", text: "Try another model", attachments: [] }, createdAt: 2,
      state: { kind: "failed", error: "Model declined", failure: "model-refusal" } }] } }
  journal.commit(snapshot)
  const check = () => {
    const saved = journal.read()!
    assert.equal(saved.requests[0]?.failure, "model-refusal")
    assert.deepEqual(saved.requests[0]?.failureEvidence, evidence)
    assert.deepEqual(saved.session.failureEvidence, evidence)
    assert.equal(saved.control?.transfers[0]?.state.kind === "failed" && saved.control.transfers[0].state.failure, "model-refusal")
    assert.equal(makoLogDifference(journal.makoLog(), makoFacts(saved)), undefined, "exact failure survives log replay")
  }
  check()
  const db = new DatabaseSync(join(root, snapshot.session.id + ".sqlite"))
  try {
    const request = JSON.parse(row.parse(db.prepare("SELECT value FROM requests LIMIT 1").get()).value)
    assert.deepEqual(oldRequest.parse(request), { id: snapshot.requests[0]!.id, failure: "unknown", failureEvidence: { kind: "unknown", source: "provider-error" } })
    const metadata = JSON.parse(row.parse(db.prepare("SELECT value FROM metadata WHERE id=1").get()).value)
    assert.deepEqual(oldEvidence.parse(metadata.session.failureEvidence), { kind: "unknown", source: "provider-error" })
    assert.equal(oldKind.parse(metadata.control.transfers[0].state.failure), "unknown")
    const opaque = { kind: "permission.future", value: { payload: { failure: "model-refusal", failureEvidence: evidence } } }
    journal["appendLog"]([opaque], "host")
    assert.deepEqual(journal.makoLog().at(-1)?.value, opaque.value, "opaque provider payload is never re-encoded")
    const before = journal.read()!
    db.exec("CREATE TRIGGER refuse_log BEFORE INSERT ON log BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END")
    assert.throws(() => journal.commit({ ...before, revision: 3, requests: [...before.requests, { ...before.requests[0]!, id: auditId(99) }] }, before), /fixture rollback/)
    assert.equal(journal.read()!.requests.length, 1)
    db.exec("DROP TRIGGER refuse_log")
  } finally { db.close() }
  await journal.close()
  journal = new LiveJournal(root, snapshot.session.id)
  check()
  console.log("PASS: refusal request/session/transfer rows remain legacy-readable, exact current replay/reopen, rollback and opaque payload preservation")
} finally { await journal.close(); rmSync(root, { recursive: true, force: true }) }
