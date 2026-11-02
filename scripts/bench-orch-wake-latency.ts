import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentsStartInput } from "@mako/host/contracts/agent-tools"
import { FROM_AGENTS, RESULT_COALESCE_MS, WAKE_COALESCE_MS } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/*
 * How long a child's report takes to reach its lead (`npm run
 * bench:orch-wake-latency`): LEADS leads per case at once, each with one
 * child, on the real store, `LiveConversations` and `Agents` with scripted
 * models, so the numbers are Mako's own cost and its coalescing windows,
 * never a model's. A sample runs from the child's report (or, for a lead
 * busy in a turn that can't be steered, from that turn's end) to the lead
 * hearing it: its next turn starting, its running turn taking the steer, or
 * its wait answering. Each case's p95 over its budget fails the run.
 */
const LEADS = 20
const SLACK_MS = 500

type Case = {
  name: string
  lead: string
  start: Omit<AgentsStartInput, "brief" | "cwd" | "clientKey">
  /** The lead's turn stays running until the sample is taken. */
  busy?: true
  heard: "turn" | "steer" | "answer"
  budgetMs: number
}

const CASES: Case[] = [
  { name: "background, idle lead", lead: "codex", start: { harness: "codex" }, heard: "turn", budgetMs: WAKE_COALESCE_MS + SLACK_MS },
  { name: "wait, answered in the call", lead: "codex", start: { harness: "codex", mode: "wait" }, heard: "answer", budgetMs: 250 },
  { name: "wait, result after the window", lead: "codex", start: { harness: "codex", mode: "wait", timeoutMs: 100 }, heard: "turn", budgetMs: RESULT_COALESCE_MS + SLACK_MS },
  { name: "background, busy lead, steered", lead: "claude", start: { harness: "codex" }, busy: true, heard: "steer", budgetMs: WAKE_COALESCE_MS + SLACK_MS },
  { name: "background, busy lead, from its turn's end", lead: "cursor", start: { harness: "codex" }, busy: true, heard: "turn", budgetMs: WAKE_COALESCE_MS + SLACK_MS },
]

const percentile = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

async function until(what: string, done: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function run(bench: Case, root: string): Promise<number[]> {
  const reportedAt = new Map<string, number>()
  const answeredAt = new Map<string, number>()
  const childOf = new Map<string, string>()
  const world = new AgentsWorld({
    root,
    script: async (turn) => {
      const go = /^go (\d+)$/.exec(turn.text)
      if (go) {
        const lead = turn.conversation
        const answer = await turn.world.agents.start(turn.caller, { ...bench.start, brief: { objective: `Bench ${go[1]}` }, clientKey: "b", cwd: root })
        assert.ok(!("refused" in answer), JSON.stringify(answer))
        answeredAt.set(lead, Date.now())
        if (bench.busy) await turn.world.hold(lead)
        return "Noted."
      }
      if (turn.text.startsWith(FROM_AGENTS)) return "Going on."
      const lead = /Bench (\d+)/.exec(turn.text)?.[1]
      assert.ok(lead, turn.text)
      childOf.set(lead, turn.conversation)
      await turn.world.hold(turn.conversation)
      reportedAt.set(turn.conversation, Date.now())
      const told = await turn.world.agents.report(turn.caller, { status: "done", summary: "There are 12 files.", clientKey: "r" })
      assert.ok(!("refused" in told), JSON.stringify(told))
      return "Reported."
    },
  })
  try {
    const leads = await Promise.all(Array.from({ length: LEADS }, () => world.lead(bench.lead)))
    leads.forEach((lead, i) => world.say(lead.conversation, `go ${i}`))
    await until("every child running", () => childOf.size === LEADS)
    if (bench.heard !== "answer") await until("every start answered", () => answeredAt.size === LEADS)
    for (const child of childOf.values()) world.release(child)
    await until("every report", () => reportedAt.size === LEADS)
    const endedAt = new Map<string, number>()
    if (bench.busy && bench.heard === "turn") {
      await new Promise((resolve) => setTimeout(resolve, WAKE_COALESCE_MS + 1_000))
      assert.equal(world.prompts.filter((prompt) => prompt.text.startsWith(FROM_AGENTS)).length, 0, "no wake starts a turn while the lead's runs")
      for (const lead of leads) {
        endedAt.set(lead.conversation, Date.now())
        world.release(lead.conversation)
      }
    }
    const heardAt = (lead: string): number | undefined => {
      if (bench.heard === "answer") return answeredAt.get(lead)
      if (bench.heard === "steer") return world.steers.find((steer) => steer.conversation === lead)?.at
      return world.prompts.find((prompt) => prompt.conversation === lead && prompt.text.startsWith(FROM_AGENTS))?.at
    }
    await until("every lead hearing it", () => leads.every((lead) => heardAt(lead.conversation) !== undefined))
    if (bench.busy && bench.heard === "steer") for (const lead of leads) world.release(lead.conversation)
    await world.settle()
    return leads.map((lead, i) => {
      const from = endedAt.get(lead.conversation) ?? reportedAt.get(childOf.get(String(i))!)!
      return heardAt(lead.conversation)! - from
    })
  } finally {
    await world.close()
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-orch-wake-latency-"))
const over: string[] = []
try {
  for (const [i, bench] of CASES.entries()) {
    const samples = (await run(bench, join(root, String(i)))).sort((a, b) => a - b)
    const p50 = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)
    console.log(JSON.stringify({ case: bench.name, lead: bench.lead, leads: LEADS, p50Ms: p50, p95Ms: p95, maxMs: samples.at(-1), budgetMs: bench.budgetMs }))
    if (p95 > bench.budgetMs) over.push(`${bench.name}: p95 ${p95} ms, budget ${bench.budgetMs} ms`)
  }
  assert.deepEqual(over, [], "a case went over its budget")
} finally {
  rmSync(root, { recursive: true, force: true })
}
