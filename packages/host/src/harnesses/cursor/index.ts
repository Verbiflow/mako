import { cursorCanvasPreview } from "./canvas-preview.js"
import { cursorSdkStateRoot, emitCursorSession, normalizeCursorSdkModels } from "@mako/sessions"
import { childProcessEnv } from "../../base/child-environment.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import { join } from "node:path"
import { logsRoot } from "../../base/host-log.js"
import { captureRoot, type ProviderModule } from "../host.js"
import { harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { makosOwn, native, shownInTools, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createCursorAccountCapability } from "./accounts.js"
import { cursorConnection } from "./connection.js"
import { cursorMcpSource } from "./mcp.js"
import { cursorProcessProbe } from "./process-probe.js"
import { createCursorProfileLoader } from "./profile.js"
import { CursorSdkAuth } from "./sdk/auth.js"
import { CursorAccountKeys, CursorCredentialStore, cursorLegacyFiles } from "./sdk/credentials.js"
import { cursorDecoderSource } from "./sdk/decoder-source.js"
import { createCursorSdkDriver } from "./sdk/driver.js"
import { createCursorModelCache, listCursorSdkModels } from "./sdk/models.js"
import { cursorSdkNativeRunner } from "./sdk/native-runner.js"
import { cursorSkillSource } from "./skills.js"
import { resolveExecutable } from "../../base/executable.js"
import { scriptInstall } from "../update-source.js"
import { cursorPresentation } from "./presentation.js"

/**
 * Cursor runs through its SDK and nothing else. `cursor-agent acp` was the
 * transport before; it ended turns on one reset HTTP/2 frame, asked for
 * every command, and could not reopen the CLI's own `chats/` stores. The
 * SDK retries its stream, enforces the access ladder itself, and imports any
 * `cursor-agent` store it is asked to continue. What remains of the CLI is
 * its sign-in, which the SDK runs under when Mako holds no key of its own.
 */
export const installCursor: ProviderModule = (host, context) => {
  // Cursor's own login, whichever account new sessions use; a selected
  // account's key arrives in each launch's prepared environment instead.
  const env = async () => childProcessEnv(process.env)
  const stateRoot = () => cursorSdkStateRoot()
  context.secrets.adoptLegacy(cursorLegacyFiles(stateRoot()))
  const credentials = new CursorCredentialStore(context.secrets.secrets)
  const keys = new CursorAccountKeys(context.secrets.secrets)
  const auth = new CursorSdkAuth({ env, openUrl: (url) => context.openUrl(url), credentials })
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
      balance: implemented("On-demand spend and promotional credit left, in Cursor's usage report."),
    },
    features: {
      goals: { native: native("goals", "goal tool calls in its protocol (`create_goal_tool_call`)"), mako: makosOwn("SDK 1.0.31 offers no goal to a local run.") },
      review: { mako: harnessLacks("Cursor's SDK has no review; Bugbot reviews pull requests on Cursor's servers.") },
      sideQuestions: { mako: harnessLacks("SDK 1.0.31 has no way to ask one.") },
      scheduledPrompts: { mako: harnessLacks("Cursor's SDK has no schedule.") },
      cloudRuns: { native: native("cloud agents", "`AgentOptions.cloud`; agent IDs starting `bc-`"), mako: makoLacks("Mako runs Cursor's agents on this Mac; starting a cloud agent isn't built.") },
      backgroundSessions: { mako: makosOwn() },
      fileRewind: { mako: makosOwn() },
      worktrees: { mako: makosOwn() },
      computerUse: { mako: makosOwn() },
      notifications: { mako: makosOwn() },
      folderTrust: { mako: harnessLacks("A local SDK run has no folder trust.") },
      editApprovals: { mako: harnessLacks("A local SDK run asks for no approvals.") },
      plugins: { native: native("plugins", "the SDK's `plugins` setting source"), mako: makoLacks("Mako loads Cursor's project and user settings, not its plugins.") },
      responseStyle: { mako: harnessLacks("Cursor's SDK has no response style.") },
      webSearch: { native: native("webSearch", "`webSearch` in its CLI, ACP and Desktop stores"), mako: harnessLacks("The SDK reports no web search call, so a local run's searches don't show.") },
      imageGeneration: { mako: TOOL_ROWS },
      codeMode: { mako: harnessLacks("Cursor has no code mode; each tool is its own call.") },
    },
    unique: [
      { name: "Screen recording", native: "the `recordScreen` tool: start, save or discard a recording of the screen", mako: shownInTools(["recordScreen"]) },
    ],
    hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
    commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "cursor", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: { provider: "cursor", route: "mcp-registry", operations: ["import"] },
    live: createCursorSdkDriver({
      auth,
      stateRoot,
      stores: context.stores,
      modelCache,
      captures: captureRoot(context),
      heapSnapshots: join(logsRoot(context.dataRoot), "cursor-heaps"),
    }),
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
    accounts: createCursorAccountCapability(auth, keys),
    acp: lacks("Runs on the Cursor SDK"),
    nativeRunner: cursorSdkNativeRunner({
      childLaunch: env => auth.childLaunch(env),
      stateRoot,
      stores: context.stores,
      models: async (env) => normalizeCursorSdkModels(await modelCache(env, () => listCursorSdkModels({ env }))),
    }),
    processProbe: cursorProcessProbe,
    mcp: cursorMcpSource,
    skills: cursorSkillSource,
    sessionEmitter: {
      provider: "cursor",
      emit: (thread) => emitCursorSession(context.stores, thread, {}),
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
