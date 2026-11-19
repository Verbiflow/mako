import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import type { ThreadRef } from "@/lib/types"

/**
 * `?app=crowded`: a rail shaped like a person's who works in many places: 36 projects, a few to a dozen Threads in
 * each, an Apex with 60 Fins, conversations whose last message from the person is much newer than their file's start,
 * and Sessions on another device. It arrives as a real host's does, in steps: this Mac's conversations with the boot,
 * then half the catalog while the host still scans (`ready: false`), the rest when it's ready, and last the account's
 * rows from the other device. The rail's order once everything has landed must be the order it painted first.
 */

const DAY = 86_400_000
const NAMES = [
  "api", "web", "infra", "docs", "billing", "mobile", "search", "auth", "design-system", "analytics",
  "notifications", "payments", "gateway", "scheduler", "importer", "exporter", "ledger", "reports", "onboarding", "admin",
  "cli", "sdk", "edge", "workers", "observability", "pricing", "marketing-site", "status-page", "data-pipeline", "ml-ranker",
  "email", "webhooks", "sandbox", "migrations", "playground", "ops",
] as const
const HARNESSES = ["claude", "codex", "cursor", "grok"] as const

/** A small deterministic generator, so every run and every screenshot is the same world. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

export const CROWDED_ROOT = "/Users/you/code"
export const CROWDED_APEX_FOLDER = `${CROWDED_ROOT}/mobile`
export const CROWDED_FINS = 60

export interface CrowdedRail {
  /** Every catalog row, as the host lists them once it is ready. */
  refs: ThreadRef[]
  /** The rows a host still scanning lists first: its first harnesses' rows only. */
  early: ThreadRef[]
  /** This Mac's own conversations, with the boot. */
  own: LiveSummary[]
  /** The other device's Sessions, as the account lists them after the window has painted. */
  elsewhere: LiveSummary[]
}

const uuid = (group: number, n: number) => `c7c7c7c7-${String(group).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`

export function crowdedRail(now = Date.now()): CrowdedRail {
  const next = random(17)
  const refs: ThreadRef[] = []
  const own: LiveSummary[] = []
  const elsewhere: LiveSummary[] = []
  NAMES.forEach((name, folderIndex) => {
    const cwd = `${CROWDED_ROOT}/${name}`
    const count = 2 + Math.floor(next() * 10)
    for (let index = 0; index < count; index++) {
      const started = now - Math.floor((2 + next() * 60) * DAY)
      const updated = Math.min(now - 60_000, started + Math.floor(next() * 3 * DAY))
      const harness = HARNESSES[Math.floor(next() * HARNESSES.length)]!
      const n = folderIndex * 100 + index
      const path = `/mock/crowded/${name}-${index}.jsonl`
      const ref: ThreadRef = {
        harness,
        nativeId: `crowded-${n}`,
        path,
        cwd,
        workspace: cwd,
        title: `${name} task ${index + 1}`,
        startedAt: new Date(started).toISOString(),
        updatedAt: new Date(updated).toISOString(),
        bytes: 1_000 + n,
        threadId: uuid(1, n),
        sessionId: uuid(2, n),
      }
      refs.push(ref)
      // About one in three a Mako conversation reads, the person's last message to it much newer than its file's start.
      if (next() < 0.35) {
        own.push({
          session: { id: uuid(3, n), harness, nativeId: ref.nativeId, cwd, title: ref.title, status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
          revision: 1,
          createdAt: started,
          promptedAt: now - Math.floor(next() * 20 * DAY),
          movedAt: updated,
          threadPath: path,
          nativePaths: [path],
          threadId: ref.threadId,
          sessionId: ref.sessionId,
        })
      }
    }
    // Every seventh project's newest Session was started an hour ago in a harness the host scans last.
    if (folderIndex % 7 === 3) {
      const n = folderIndex * 100 + 99
      refs.push({ harness: "cursor", nativeId: `crowded-${n}`, path: `/mock/crowded/${name}-fresh.jsonl`, cwd, workspace: cwd, title: `${name}: fresh in the editor`, startedAt: new Date(now - 60 * 60_000 - folderIndex * 1_000).toISOString(), updatedAt: new Date(now - 5 * 60_000).toISOString(), bytes: 2_000, threadId: uuid(1, n), sessionId: uuid(2, n) })
    }
    // Every fifth project also has a Session on the laptop, which the person wrote to there.
    if (folderIndex % 5 === 2) {
      const n = folderIndex
      elsewhere.push({
        session: { id: uuid(4, n), harness: "claude", cwd, title: `${name} on the laptop`, status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
        revision: 0,
        createdAt: now - 40 * DAY,
        // The person wrote there within the last hour: the newest work of all, which only the account's list knows.
        promptedAt: now - (folderIndex + 1) * 60_000,
        movedAt: now - folderIndex * 60_000,
        elsewhere: "Laptop",
        elsewhereKind: "desktop",
        threadId: uuid(5, n),
        sessionId: uuid(6, n),
      })
    }
  })
  // An Apex in mobile and its 60 Fins: the Fins' catalog rows belong to the Apex's Thread, never rows of their own.
  const apexThread = uuid(7, 1)
  const apexSession = uuid(8, 1)
  const apexPath = "/mock/crowded/mobile-apex.jsonl"
  refs.push({ harness: "claude", nativeId: "crowded-apex", path: apexPath, cwd: CROWDED_APEX_FOLDER, workspace: CROWDED_APEX_FOLDER, title: "Mobile polish (Apex)", startedAt: new Date(now - 30 * DAY).toISOString(), updatedAt: new Date(now - 2 * 60_000).toISOString(), threadId: apexThread, sessionId: apexSession, bytes: 90_000 })
  own.push({
    session: { id: uuid(9, 1), harness: "claude", nativeId: "crowded-apex", cwd: CROWDED_APEX_FOLDER, title: "Mobile polish (Apex)", status: "ready", connection: "hibernated", modes: [], currentMode: null, configOptions: [] },
    revision: 1,
    createdAt: now - 30 * DAY,
    promptedAt: now - 3 * DAY,
    threadPath: apexPath,
    nativePaths: [apexPath],
    threadId: apexThread,
    sessionId: apexSession,
  })
  for (let index = 0; index < CROWDED_FINS; index++) {
    const fin = uuid(10, index)
    refs.push({ harness: "claude", nativeId: `crowded-fin-${index}`, path: `/mock/crowded/fin-${index}.jsonl`, cwd: CROWDED_APEX_FOLDER, title: `Fin ${index + 1}`, startedAt: new Date(now - 2 * DAY).toISOString(), updatedAt: new Date(now - index * 30_000).toISOString(), threadId: fin, parent: { thread: apexThread, session: apexSession } })
  }
  // A host still scanning has listed its first harnesses' sessions only.
  const early = refs.filter((ref) => ref.harness === "claude" || ref.harness === "codex")
  return { refs, early, own, elsewhere }
}
