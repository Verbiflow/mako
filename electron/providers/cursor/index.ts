import { cursorCanvasPreview } from "./canvas-preview.js"
import { cursorSdkStateRoot, emitCursorSession, normalizeCursorSdkModels } from "@mako/sessions"
import { childProcessEnv } from "../../accounts-common.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { harnessLacks, implemented } from "../live-capabilities.js"
import { cursorAccountCapability } from "./accounts.js"
import { cursorConnection } from "./connection.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorProcessProbe } from "./process-probe.js"
import { createCursorProfileLoader } from "./profile.js"
import { CursorSdkAuth } from "./sdk/auth.js"
import { CursorAccountKeys, CursorCredentialStore, cursorAccountKeysRoot, cursorCredentialPath } from "./sdk/credentials.js"
import { cursorDecoderSource } from "./sdk/decoder-source.js"
import { createCursorSdkDriver } from "./sdk/driver.js"
import { createCursorModelCache, listCursorSdkModels } from "./sdk/models.js"
import { cursorSdkNativeRunner } from "./sdk/native-runner.js"
import { cursorSkillSource } from "./skills.js"
import { resolveExecutable } from "../../executable.js"
import { scriptInstall } from "../update-source.js"
import { electronSecretEncryption } from "../../secure-storage.js"
import { cursorPresentation } from "./presentation.js"

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
  // Cursor's own login, whichever account new sessions use; a selected
  // account's key arrives in each launch's prepared environment instead.
  const env = async () => childProcessEnv(process.env)
  const stateRoot = () => cursorSdkStateRoot()
  const encryption = electronSecretEncryption()
  const credentials = new CursorCredentialStore(cursorCredentialPath(stateRoot()), encryption)
  const keys = new CursorAccountKeys(cursorAccountKeysRoot(stateRoot()), encryption)
  const auth = new CursorSdkAuth({ env, openUrl: openExternal, credentials })
  const modelCache = createCursorModelCache()
  installHarness(host, {
    provider: "cursor",
    presentation: cursorPresentation,
    diagnostics: { sdk: "@cursor/sdk", runsInSdk: true },
    usage: {
      context: harnessLacks("Cursor's SDK reports what each turn spent, never how full the context is."),
      window: harnessLacks("Cursor's SDK names no model's window."),
      compaction: harnessLacks("With no context reading, a summary Cursor writes has no meter to update."),
      tokens: implemented("Each turn's `usage` message from the SDK."),
      cost: harnessLacks("Cursor's SDK reports tokens only and prices none of them."),
      missedCalls: harnessLacks("Cursor's usage messages never say they left a call out."),
      resetCredits: harnessLacks("Cursor's usage report has no reset credits."),
    },
    hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
    commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "cursor", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: { provider: "cursor", route: "mcp-registry", operations: ["import"] },
    live: createCursorSdkDriver({ auth, stateRoot, modelCache }),
    decoder: cursorDecoderSource,
    profile: createCursorProfileLoader({
      sdkModels: async (base, cwd, context) => {
        const { env } = await auth.childLaunch(base)
        return modelCache(env, () => listCursorSdkModels({ env, cwd, signal: context?.signal }), true, context?.signal)
      },
      accountKey: () => {
        const state = auth.current?.state
        return state?.status === "signed-in"
          ? `${state.source}:${state.email ?? ""}:${state.keyName ?? ""}`
          : "signed-out"
      },
    }),
    accounts: cursorAccountCapability(auth, keys),
    acp: lacks("Runs on the Cursor SDK"),
    nativeRunner: cursorSdkNativeRunner({
      childLaunch: env => auth.childLaunch(env),
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
    usageHistory: lacks("Cursor's SDK store keeps no token counts"),    artifactPreview: cursorCanvasPreview,
  })
}
