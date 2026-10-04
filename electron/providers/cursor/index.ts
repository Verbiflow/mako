import { cursorCanvasPreview } from "./canvas-preview.js"
import { cursorSdkStateRoot, emitCursorSession, normalizeCursorSdkModels } from "@mako/sessions"
import { accountEnv } from "../../accounts.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { cursorAccountCapability } from "./accounts.js"
import { cursorConnection } from "./connection.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorProcessProbe } from "./process-probe.js"
import { createCursorProfileLoader } from "./profile.js"
import { CursorSdkAuth } from "./sdk/auth.js"
import { CursorCredentialStore, cursorCredentialPath } from "./sdk/credentials.js"
import { cursorDecoderSource } from "./sdk/decoder-source.js"
import { createCursorSdkDriver } from "./sdk/driver.js"
import { createCursorModelCache, listCursorSdkModels } from "./sdk/models.js"
import { cursorSdkNativeRunner } from "./sdk/native-runner.js"
import { cursorSkillSource } from "./skills.js"
import { resolveExecutable } from "../../executable.js"
import { scriptInstall } from "../update-source.js"
import { electronSecretEncryption } from "../../secure-storage.js"

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
  const credentials = new CursorCredentialStore(cursorCredentialPath(stateRoot()), electronSecretEncryption())
  const auth = new CursorSdkAuth({ env, openUrl: openExternal, credentials })
  const modelCache = createCursorModelCache()
  installHarness(host, {
    provider: "cursor",
    presentation: { icon: { id: "cursor-cube", tint: "currentColor" } },
    hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
    commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "cursor", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: { provider: "cursor", route: "mcp-registry", operations: ["import"] },
    live: createCursorSdkDriver({ auth, stateRoot, modelCache }),
    decoder: cursorDecoderSource,
    profile: createCursorProfileLoader({
      sdkModels: async (_env, cwd) => {
        const env = await auth.childEnv()
        return modelCache(env, () => listCursorSdkModels({ env, cwd }), true)
      },
      accountKey: () => {
        const state = auth.current?.state
        return state?.status === "signed-in"
          ? `${state.source}:${state.email ?? ""}:${state.keyName ?? ""}`
          : "signed-out"
      },
    }),
    accounts: cursorAccountCapability(auth),
    acp: lacks("Runs on the Cursor SDK"),
    nativeRunner: cursorSdkNativeRunner({
      childEnv: () => auth.childEnv(),
      stateRoot,
      models: async (env) => normalizeCursorSdkModels(await modelCache(env, () => listCursorSdkModels({ env }))),
    }),
    processProbe: cursorProcessProbe,
    mcp: cursorMcpSource,
    skills: cursorSkillSource,
    sessionEmitter: {
      provider: "cursor",
      emit: (thread) => emitCursorSession(thread, {}),
    },
    // Resolve credentials when Cursor is used. A locked keychain must not
    // prevent the shared host from starting for every other provider.
    connection: cursorConnection(auth, () => credentials.secure()),
    // The install script keeps versions under ~/.local/share/cursor-agent and
    // links ~/.local/bin/cursor-agent; there is no package to read a public
    // version from, so `cursor-agent update` is both the check and the update.
    updates: {
      provider: "cursor",
      binary: (env) => resolveExecutable("cursor-agent", env),
      native: {
        label: "Update Cursor Agent",
        args: ["update"],
        ownsPath: (path) =>
          path.includes("/.local/share/cursor-agent/") ||
          path.endsWith("/.local/bin/cursor-agent"),
      },
      install: [scriptInstall("https://cursor.com/install")],
    },
    utility: notBuilt("Cursor's SDK keeps every agent it runs in a store; a one-off request would need a store of its own, removed after, which Mako doesn't build yet"),
    artifactPreview: cursorCanvasPreview,
  })
}
