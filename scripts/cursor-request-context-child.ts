import { Agent, Cursor } from "@cursor/sdk"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"

/**
 * One local Cursor agent, opened as Mako's SDK child opens it (`settingSources`
 * project and user), sent one message. Run by `harness-self-report.ts` with
 * its home in a sandbox and `CURSOR_BACKEND_URL` on a stand-in service, which
 * reads what the agent loaded from the request context it sends back.
 */
const project = process.env.MAKO_PROBE_PROJECT
const stateRoot = process.env.MAKO_PROBE_STATE
if (!project || !stateRoot) throw new Error("MAKO_PROBE_PROJECT and MAKO_PROBE_STATE name the sandbox")
const store = await SqliteLocalAgentStore.open({ workspaceRef: project, stateRoot })
Cursor.configure({ local: { store, useHttp1ForAgent: true } })
const agent = await Agent.create({
  apiKey: "mako-self-report",
  model: { id: "composer-2.5" },
  mode: "agent",
  local: { cwd: project, store, settingSources: ["project", "user"] },
})
const run = await agent.send("List what you loaded.")
await run.wait()
