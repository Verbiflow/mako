import assert from "node:assert/strict"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { resolveSessionSettings } from "@mako/sessions/settings"
import { acpReadable, acpWritable } from "../electron/acp-stream.ts"
import { acpObservedSettings } from "../electron/acp-config.ts"
import { withDiscoveryProcess } from "../electron/providers/discovery-process.ts"
import { runDiscovery } from "../electron/providers/profile-transport.ts"
import { openCodeProfileLoader } from "../electron/providers/opencode/profile.ts"
import { resolveOpenCodeInstallation } from "../electron/providers/opencode/installation.ts"

const variants = { low: {}, medium: {}, high: {} }
for (const defaultVariant of ["low", "high"]) {
  const catalog = normalizeOpenCodeModels([
    { id: "model", providerID: "provider", variants, defaultVariant },
  ])
  const resolved = resolveSessionSettings({
    models: catalog.models,
    context: "new",
    phase: "launch",
    overrides: { model: "provider/model" },
  })
  assert.equal(
    resolved.options.effort?.kind === "known" && resolved.options.effort.value,
    defaultVariant
  )
}
assert.equal(
  normalizeOpenCodeModels([{ id: "model", providerID: "provider", variants }])
    .models[0]?.options[0]?.current,
  undefined
)
console.log(
  "OpenCode catalog preserves declared reasoning defaults without inventing them from an unordered list"
)

if (process.argv.includes("--live")) {
  const installation = await resolveOpenCodeInstallation()
  assert.ok(installation)
  const profile = await openCodeProfileLoader.load(process.env, process.cwd())
  const expected = resolveSessionSettings({
    models: profile.models,
    context: "new",
    phase: "launch",
    defaults: profile.settings,
  })
  let created: string | undefined
  try {
    const observed = await withDiscoveryProcess(
      {
        command: installation.command,
        args: ["acp"],
        env: process.env,
        cwd: process.cwd(),
      },
      async ({ child, phase }) => {
        const connection = new ClientSideConnection(
          () => ({
            sessionUpdate: async () => {},
            requestPermission: async () => ({
              outcome: { outcome: "cancelled" },
            }),
          }),
          ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
        )
        phase("initialize")
        await connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { session: { configOptions: { boolean: {} } } },
        })
        phase("OpenCode default session")
        const session = await connection.newSession({
          cwd: process.cwd(),
          mcpServers: [],
        })
        created = session.sessionId
        return acpObservedSettings(session.configOptions ?? [])
      }
    )
    console.log(
      `OpenCode discovery: ${JSON.stringify(expected.settings)}; ACP session: ${JSON.stringify(observed)}`
    )
    assert.equal(observed.model, expected.settings.model)
    assert.equal(observed.options?.effort, expected.settings.options?.effort)
  } finally {
    if (created)
      await runDiscovery(
        installation.command,
        ["api", "v2.session.remove", "--param", `sessionID=${created}`],
        process.env,
        undefined,
        process.cwd()
      )
  }
}
