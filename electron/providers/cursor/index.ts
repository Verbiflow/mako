import { cursorCanvasPreview } from "./canvas-preview.js"
import { cursorSdkStateRoot, emitCursorSession } from "@mako/sessions"
import { accountEnv } from "../../accounts.js"
import type { ProviderModule } from "../host.js"
import { cursorConnection } from "./connection.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorProcessProbe } from "./process-probe.js"
import { createCursorProfileLoader } from "./profile.js"
import { CursorSdkAuth } from "./sdk/auth.js"
import {
  CursorCredentialStore,
  cursorCredentialPath,
  electronKeyEncryption,
} from "./sdk/credentials.js"
import { createCursorSdkDriver } from "./sdk/driver.js"
import { listCursorSdkModels } from "./sdk/models.js"
import { cursorSkillSource } from "./skills.js"
import { resolveExecutable } from "../../executable.js"

async function openExternal(url: string): Promise<void> {
  const { shell } = await import("electron")
  await shell.openExternal(url)
}

/**
 * Cursor runs through its SDK and nothing else. `cursor-agent acp` was the
 * transport before; it ended turns on one reset HTTP/2 frame, asked for
 * every command, and could not reopen the CLI's own `chats/` stores. The
 * SDK retries its stream, enforces the access ladder itself, and imports any
 * `cursor-agent` store it is asked to continue. What remains of the CLI is
 * its sign-in, which the SDK runs under when Mako holds no key of its own.
 */
export const installCursor: ProviderModule = (host) => {
  const env = () => accountEnv("cursor", process.env)
  const stateRoot = () => cursorSdkStateRoot()
  const credentials = new CursorCredentialStore(cursorCredentialPath(stateRoot()), electronKeyEncryption())
  const auth = new CursorSdkAuth({ env, openUrl: openExternal, credentials })
  host.artifactPreviews.register(cursorCanvasPreview)
  host.liveDrivers.register(createCursorSdkDriver({ auth, stateRoot }))
  host.profiles.register(
    createCursorProfileLoader({
      sdkModels: async (_env, cwd) => listCursorSdkModels({ env: await auth.childEnv(), cwd }),
      accountKey: () => {
        const state = auth.current?.state
        return state?.status === "signed-in"
          ? `${state.source}:${state.email ?? ""}:${state.keyName ?? ""}`
          : "signed-out"
      },
    })
  )
  // Resolve credentials when Cursor is used. A locked keychain must not
  // prevent the shared host from starting for every other provider.
  host.processProbes.register(cursorProcessProbe)
  host.mcpSources.register(cursorMcpSource)
  host.skillSources.register(cursorSkillSource)
  host.connections.register(cursorConnection(auth, () => credentials.secure()))
  host.sessionEmitters.register({
    provider: "cursor",
    emit: (thread) => emitCursorSession(thread, {}),
  })
  // The install script keeps versions under ~/.local/share/cursor-agent and
  // links ~/.local/bin/cursor-agent; there is no package to read a public
  // version from, so `cursor-agent update` is both the check and the update.
  host.updateSources.register({
    provider: "cursor",
    binary: (env) => resolveExecutable("cursor-agent", env),
    native: {
      label: "Update Cursor Agent",
      args: ["update"],
      ownsPath: (path) =>
        path.includes("/.local/share/cursor-agent/") ||
        path.endsWith("/.local/bin/cursor-agent"),
    },
  })
}
