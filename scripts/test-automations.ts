import { Git } from "@mako/git"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Automations, normalizeAutomation, parseAutomationDocument } from "@mako/host/workspaces/automations"
import { childBackend } from "@mako/host/workspaces/watch-backend"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"

const gitRunner = new Git()

const legacy = normalizeAutomation({
  id: "legacy",
  name: "Legacy files",
  prompt: "Check the docs",
  trigger: "files",
  paths: ["src/**/*.ts"],
})
assert.deepEqual(legacy.trigger, {
  kind: "files",
  paths: ["src/**/*.ts"],
})
assert.equal(legacy.enabled, false)

const external = parseAutomationDocument(
  JSON.stringify({
    automations: [
      {
        id: "slack",
        name: "Slack triage",
        prompt: "Triage this request",
        trigger: {
          kind: "slack",
          event: "reaction_added",
          channels: ["engineering"],
          messageFilter: "bug",
        },
      },
      {
        id: "gmail",
        name: "Mail triage",
        prompt: "Triage this email",
        trigger: {
          kind: "gmail",
          from: ["example.com"],
          labels: ["INBOX"],
          hasAttachment: true,
        },
      },
      {
        id: "calendar",
        name: "Meeting prep",
        prompt: "Prepare for this meeting",
        trigger: {
          kind: "google_calendar",
          event: "event_starting_soon",
          calendars: ["primary"],
        },
      },
    ],
  })
)
assert.deepEqual(external.automations[0]?.trigger, {
  kind: "slack",
  event: "reaction_added",
  channels: ["engineering"],
  messageFilter: "bug",
})
assert.equal(external.automations[1]?.trigger.kind, "gmail")
assert.equal(external.automations[2]?.trigger.kind, "google_calendar")

const events: HostEvent[] = []
const automations = new Automations({ git: gitRunner,
  watch: childBackend(),
  emit: (event) => events.push(event),
  launch: async () => {
    throw new Error("deliberate automation failure")
  },
})
const directory = await mkdtemp(join(tmpdir(), "mako-automations-"))
try {
  await mkdir(join(directory, ".mako"))
  await writeFile(
    join(directory, ".mako", "automations.json"),
    JSON.stringify({ automations: [legacy, ...external.automations] })
  )
  await automations.load(directory)
  assert.equal(automations.setEnabled("legacy", true)[0]?.enabled, true)
  assert.equal(
    automations.setEnabled("slack", true).find((entry) => entry.id === "slack")?.enabled,
    false
  )
  await automations.save(directory, automations.setEnabled("legacy", true))
  const saved = await readFile(
    join(directory, ".mako", "automations.json"),
    "utf8"
  )
  assert.equal(saved.includes('"enabled"'), false)
  assert.equal(saved.includes('"kind": "files"'), true)

  await automations.watch(directory)
  await automations.fire("legacy", "manual")
  const runs = events
    .filter((event) => event.type === "automation-run")
    .map((event) => event.run)
  assert.deepEqual(
    runs.map((run) => run.status),
    ["started", "failed"]
  )
  assert.equal(runs[0]?.runId, runs[1]?.runId)
  assert.equal(runs[1]?.error, "deliberate automation failure")
} finally {
  automations.stop()
  await rm(directory, { recursive: true, force: true })
}

console.log("Automation trigger parsing and safety checks passed")
