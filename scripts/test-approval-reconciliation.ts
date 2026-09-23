import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { LiveDriverEvent, LiveSessionState } from "../electron/shared.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"

const root = mkdtempSync(join(tmpdir(), "mako-approval-reconciliation-"))
try {
  for (const provider of [
    "claude",
    "codex",
    "cursor",
    "grok",
    "devin",
    "opencode",
    "future",
  ]) {
    const id = randomUUID()
    let emit: ((event: LiveDriverEvent) => void) | undefined
    let dispatches = 0
    let settle = Promise.withResolvers<void>()
    const driver: ProviderLiveDriver = {
      approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
      provider,
      canResume: false,
      available: () => true,
      async start(cwd, options) {
        emit = options.emit
        const session: LiveSessionState = {
          id,
          harness: provider,
          cwd,
          status: "running",
          connection: "connected",
          nativeRunId: "run",
          modes: [],
          currentMode: null,
          configOptions: [],
        }
        return session
      },
      async prompt() {},
      async cancel() {},
      close() {},
      async setMode() {},
      async permission(_id, _request, _answer, dispatch) {
        dispatch.assertCurrent()
        dispatches++
        await settle.promise
        dispatch.report({ kind: "submitted", source: "callback" })
      },
    }
    const journalRoot = join(root, provider)
    const owner = new LiveConversations({
      root: journalRoot,
      appPath: root,
      driver: () => driver,
      history: async () => null,
      emit() {},
    })
    try {
      await owner.start(provider, root, { conversationId: id })
      for (
        let i = 0;
        i < 100 && owner.snapshot(id)?.session.connection !== "connected";
        i++
      )
        await delay(5)
      assert.ok(emit)
      const events = emit
      const ask = (observationId: string, title: string) => {
        events({
          type: "live-permission",
          request: {
            id: "reused-native-id",
            observationId,
            sessionId: id,
            title,
            options: [
              { optionId: "allow", name: "Allow once", kind: "allow_once" },
            ],
          },
        })
        const permission = owner.snapshot(id)?.permissions.at(-1)
        assert.ok(permission)
        return permission.id
      }
      const end = (observationId: string) =>
        events({
          type: "live-permission-ended",
          id,
          requestId: "reused-native-id",
          observationId,
          source: "native-resolution",
        })
      const first = ask(
        "first-occurrence",
        "Old approval awaiting a native decision"
      )
      const before = owner.snapshot(id)
      end("unknown-occurrence")
      assert.equal(
        owner.snapshot(id)?.permissions[0]?.id,
        first,
        "uncorrelated native events cannot clear a question"
      )
      end("first-occurrence")
      assert.equal(
        owner.snapshot(id)?.permissions.length,
        0,
        "native end removes stale controls while the turn still runs"
      )
      assert.equal(owner.snapshot(id)?.session.status, "running")
      await assert.rejects(
        owner.permission(id, first, { kind: "choice", optionId: "allow" }),
        /no longer pending/
      )
      assert.equal(dispatches, 0)
      const second = ask(
        "second-occurrence",
        "New approval: allow this operation?"
      )
      const newer = owner.snapshot(id)
      end("first-occurrence")
      const after = owner.snapshot(id)
      assert.equal(
        after?.permissions[0]?.id,
        second,
        "late old resolution must preserve reused native ID in the same turn"
      )
      const answering = owner.permission(id, second, {
        kind: "choice",
        optionId: "allow",
      })
      end("second-occurrence")
      assert.equal(
        owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.state.kind,
        "uncertain"
      )
      assert.equal(owner.snapshot(id)?.permissions.length, 0)
      settle.resolve()
      await answering
      const receipt = owner.snapshot(id)?.control?.approvalResponses?.at(-1)
      assert.equal(
        receipt?.state.kind,
        "submitted",
        "callback handoff stays distinct from native consumption"
      )
      assert.equal(
        receipt?.ended?.source,
        "native-resolution",
        "adapter completion cannot overwrite concurrent native evidence"
      )
      const endedAt = receipt.ended.observedAt
      end("second-occurrence")
      assert.equal(
        owner.snapshot(id)?.control?.approvalResponses?.at(-1)?.ended
          ?.observedAt,
        endedAt
      )
      await owner.permission(id, second, { kind: "choice", optionId: "allow" })
      assert.equal(dispatches, 1, "native resolution never grants replay")
      const journal = new LiveJournal(journalRoot, id)
      try {
        assert.deepEqual(
          journal.read()?.control?.approvalResponses?.at(-1),
          receipt
        )
      } finally {
        journal.close()
      }
      if (process.env.MAKO_APPROVAL_RECONCILIATION_FIXTURES) {
        mkdirSync(process.env.MAKO_APPROVAL_RECONCILIATION_FIXTURES, {
          recursive: true,
        })
        writeFileSync(
          join(
            process.env.MAKO_APPROVAL_RECONCILIATION_FIXTURES,
            `${provider}.json`
          ),
          JSON.stringify({ before, newer, after })
        )
      }
      settle = Promise.withResolvers<void>()
      console.log(
        `PASS ${provider}: exact native end, same-turn ID reuse, late evidence, durable receipt and no replay`
      )
    } finally {
      settle.resolve()
      owner.stop()
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
