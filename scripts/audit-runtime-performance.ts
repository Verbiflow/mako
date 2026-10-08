import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir, cpus } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { LiveJournal } from "../electron/live-journal.js"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { projectLive } from "../src/state/live-projection"
import { selectAcpPresence, sameAcpPresence } from "../src/state/acp-presence"
import { acpForThread, type AcpState } from "../src/state/acp-state"
import { providerHost } from "../electron/providers/index.js"
import {
  auditId,
  auditSnapshot,
  auditStats,
} from "./performance-audit-fixtures.js"
import { SessionCatalog } from "../packages/sessions/src/catalog.js"
import type { SessionProvider } from "../packages/sessions/src/providers/types.js"

const root = await mkdtemp(join(tmpdir(), "mako-runtime-performance-"))
function measured<T>(samples: number[], operation: () => T): T {
  const began = performance.now()
  const result = operation()
  samples.push(performance.now() - began)
  return result
}
const history = []
for (const turns of [10, 1000, 5000]) {
  let snapshot = auditSnapshot(turns)
  let projection = projectLive(snapshot)
  const first = projection.messages[0]
  const stages = {
    reduce: new Array<number>(),
    project: new Array<number>(),
    files: new Array<number>(),
    journal: new Array<number>(),
  }
  const journal = new LiveJournal(
    join(root, String(turns)),
    snapshot.session.id
  )
  try {
    journal.commit(snapshot)
    for (let frame = 0; frame < 24; frame++) {
      const previous = snapshot
      const blocks = measured(stages.reduce, () =>
        reduceLiveUpdates(previous.blocks, [
          { kind: "text", id: `text-${turns - 1}`, text: " next text chunk" },
        ])
      )
      snapshot = { ...snapshot, revision: snapshot.revision + 1, blocks }
      projection = measured(stages.project, () =>
        projectLive(snapshot, projection)
      )
      measured(stages.files, () => projection.files)
      measured(stages.journal, () => journal.commit(snapshot, previous))
    }
    assert.equal(projection.messages[0], first)
    const restored = journal.read()
    assert.ok(restored)
    assert.deepEqual(restored.blocks, snapshot.blocks)
    history.push({
      turns,
      blocks: snapshot.blocks.length,
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      stages: Object.fromEntries(
        Object.entries(stages).map(([key, values]) => [key, auditStats(values)])
      ),
      settledIdentityPreserved: true,
    })
  } finally {
    journal.close()
  }
}
const growingBlock = []
for (const chars of [1024, 65_536, 524_288]) {
  let snapshot = auditSnapshot(2, "fixture", chars, 0)
  const journal = new LiveJournal(
    join(root, `block-${chars}`),
    snapshot.session.id
  )
  const times: number[] = []
  let serializedBlockBytes = 0
  try {
    journal.commit(snapshot)
    for (let frame = 0; frame < 24; frame++) {
      const previous = snapshot
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        blocks: reduceLiveUpdates(snapshot.blocks, [
          { kind: "text", id: "text-1", text: " next text chunk" },
        ]),
      }
      serializedBlockBytes += Buffer.byteLength(
        JSON.stringify(snapshot.blocks.at(-1))
      )
      measured(times, () => journal.commit(snapshot, previous))
    }
    const database = new DatabaseSync(
      join(root, `block-${chars}`, `${snapshot.session.id}.sqlite`),
      { readOnly: true }
    )
    try {
      const row = z
        .object({ bytes: z.number() })
        .parse(
          database
            .prepare(
              "SELECT coalesce(sum(length(CAST(value AS BLOB))), 0) AS bytes FROM block_appends"
            )
            .get()
        )
      growingBlock.push({
        initialChars: chars,
        deltaBytes: 24 * 16,
        fullPrefixEquivalentBytes: serializedBlockBytes,
        persistedAppendBytes: row.bytes,
        commit: auditStats(times),
      })
    } finally {
      database.close()
    }
  } finally {
    journal.close()
  }
}
const sidebar = []
for (const conversations of [10, 100, 1000]) {
  const state: AcpState = { activeKey: auditId(0), conversations: {} }
  for (let index = 0; index < conversations; index++) {
    const id = auditId(index)
    const snapshot = auditSnapshot(1)
    state.conversations[id] = {
      kind: "live",
      key: id,
      draftKey: id,
      harness: "fixture",
      cwd: snapshot.session.cwd,
      createdAt: index,
      updatedAt: index,
      blocks: [],
      queued: [],
      hiddenUserPrompt: null,
      sending: false,
      canceling: false,
      permission: null,
      session: { ...snapshot.session, id },
      threadPath: `/native/${index}`,
    }
  }
  const previous = selectAcpPresence(state)
  const presence: number[] = [],
    rowSelectors: number[] = []
  for (let frame = 0; frame < 24; frame++) {
    measured(presence, () =>
      assert.ok(sameAcpPresence(previous, selectAcpPresence(state)))
    )
    measured(rowSelectors, () => {
      for (let row = 0; row < 36; row++) {
        acpForThread(state, { path: `/native/${row}` })
        acpForThread(state, { path: `/native/${row}` })
      }
    })
  }
  sidebar.push({
    conversations,
    visibleRows: 36,
    presence: auditStats(presence),
    rowSelectors: auditStats(rowSelectors),
  })
}
const providers = providerHost.profiles.list().map((loader) => {
  const snapshot = auditSnapshot(1000, loader.provider)
  let projection = projectLive(snapshot)
  const samples: number[] = []
  for (let frame = 0; frame < 12; frame++) {
    snapshot.blocks = reduceLiveUpdates(snapshot.blocks, [
      { kind: "text", text: " delta", id: "text-999" },
    ])
    projection = measured(samples, () => projectLive(snapshot, projection))
  }
  return {
    provider: loader.provider,
    transport: loader.transport,
    commonProjection: auditStats(samples),
  }
})
const catalogues = []
for (const count of [5000, 20000]) {
  const files = Array.from({ length: count }, (_, index) => ({
    path: `${root}/virtual/${index}`,
    bytes: 128,
    mtimeMs: index,
  }))
  let peeks = 0
  const source: SessionProvider = {
    harness: "fixture",
    displayName: "Fixture",
    roots: () => [],
    discover: async () => files,
    records: async () => null,
    peek: async (file) => {
      peeks++
      return {
        harness: "fixture",
        nativeId: auditId(file.mtimeMs),
        path: file.path,
        updatedAt: new Date(file.mtimeMs).toISOString(),
      }
    },
    read: async () => null,
  }
  const catalogue = new SessionCatalog([source])
  try {
    const refs = await catalogue.scan()
    const reads = peeks
    const began = performance.now()
    await catalogue.scan()
    const warmScanMs = performance.now() - began
    assert.equal(
      peeks,
      reads,
      "An unchanged catalogue must not reread native content"
    )
    const lists: number[] = [],
      indexing: number[] = []
    for (let sample = 0; sample < 24; sample++) {
      measured(lists, () => assert.equal(catalogue.count, count))
      measured(indexing, () => {
        const byPath = new Map(refs.map((ref) => [ref.path, ref]))
        const byIdentity = new Map(
          refs.map((ref) => [`${ref.harness}:${ref.nativeId}`, ref])
        )
        assert.equal(byPath.size, count)
        assert.equal(byIdentity.size, count)
      })
    }
    catalogues.push({
      refs: count,
      warmScanMs,
      warmScanNativeReads: peeks - reads,
      daemonListForCount: auditStats(lists),
      equivalentHostActivityIndexRebuild: auditStats(indexing),
    })
  } finally {
    await catalogue.stop()
  }
}
const report = {
  node: process.version,
  cpu: cpus()[0]?.model,
  kind: "synthetic production-function audit; not external-provider throughput or browser frame timing",
  history,
  growingBlock,
  sidebar,
  providers,
  catalogues,
}
await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2))
for (const item of history)
  console.log(
    `History ${item.turns} turns: project ${item.stages.project?.medianMs.toFixed(2)} ms, files ${item.stages.files?.medianMs.toFixed(2)} ms, journal ${item.stages.journal?.medianMs.toFixed(2)} ms`
  )
console.log(`Runtime performance evidence: ${join(root, "result.json")}`)
for (const entry of [
  "10",
  "1000",
  "5000",
  "block-1024",
  "block-65536",
  "block-524288",
])
  await rm(join(root, entry), { recursive: true, force: true })
