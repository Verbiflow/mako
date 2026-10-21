import { cursorCanvasPreview } from "./canvas-preview.js"
import { cursorSdkStateRoot, normalizeCursorSdkModels } from "@mako/sessions"
import { childProcessEnv } from "../../base/child-environment.js"
import { installHarness, lacks } from "../harness-definition.js"
import { createCursorHooks, createCursorMcpEditing } from "./authoring.js"
import { join } from "node:path"
import { logsRoot } from "../../base/host-log.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
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
import { createCursorIdentityCache, createCursorModelCache, listCursorSdkModels } from "./sdk/models.js"
import { cursorSdkNativeRunner } from "./sdk/native-runner.js"
import { cursorSkillSource } from "./skills.js"
import { cursorUsageHistory } from "./usage-history.js"
import { resolveExecutable } from "../../base/executable.js"
import { scriptInstall } from "../update-source.js"
import { CURSOR_VERSIONS } from "./versions.js"
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
  // What Cursor answers each account, kept an hour per credential and shared by display, sign-in checks and starts.
  const modelCache = createCursorModelCache()
  const identityCache = createCursorIdentityCache()
  const auth = new CursorSdkAuth({ env, openUrl: (url) => context.openUrl(url), credentials, identities: identityCache })
  installHarness(host, {
    provider: "cursor",
    presentation: cursorPresentation,
    diagnostics: { sdk: "@cursor/sdk", runsInSdk: true },
    usage: {
      context: implemented("Each checkpoint's `token_details.used_tokens`, the reading Cursor desktop's meter shows: the last model call's input and output, saved after every call."),
      window: implemented("The same reading's `max_tokens`, the answering model's window. The SDK's model list names none."),
      compaction: byDefault("Cursor doesn't say what a summary left: the checkpoint after the next model call measures it."),
      tokens: implemented("Each turn's `usage` message from the SDK."),
      cost: harnessLacks("Cursor's SDK reports tokens only and prices none of them."),
      missedCalls: harnessLacks("Cursor's usage messages never say they left a call out."),
      resetCredits: harnessLacks("Cursor's usage report has no reset credits."),
      balance: implemented("On-demand spend and promotional credit left, in Cursor's usage report."),
      limitSwitch: implemented("Each account's included usage for its billing period, from Cursor's dashboard service with that account's key, and a refused turn's usage or plan error."),
      toolSpend: harnessLacks("Cursor's SDK reports what each turn spent; its tool calls carry no tokens."),
    },
    features: {
      goals: { native: native("goals", "goal tool calls in its protocol (`create_goal_tool_call`)"), mako: makosOwn("Neither SDK 1.0.31 nor 1.0.37, the newest, offers a goal to a local run: its goal tool calls are protocol types the SDK's stream drops, and its API has no goal.") },
      review: { mako: makosOwn("Cursor's SDK has no review; Bugbot reviews pull requests on Cursor's servers.") },
      sideQuestions: { mako: makosOwn("SDK 1.0.31 has no side question, so Mako asks a read-only copy of the agent.") },
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
    hooks: createCursorHooks(),
    commands: lacks("Cursor's SDK reads no command folder; Cursor moved its commands into skills, under Skills"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "cursor", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: createCursorMcpEditing(),
    live: createCursorSdkDriver({
      auth,
      stateRoot,
      stores: context.stores,
      modelCache,
      identityCache,
      streams: context.streams,
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
    // Resolve credentials when Cursor is used. A locked keychain must not
    // prevent the shared host from starting for every other provider.
    connection: cursorConnection(auth, () => credentials.secure()),
    // The install script keeps versions under ~/.local/share/cursor-agent and
    // links ~/.local/bin/cursor-agent; there is no package to read a public
    // version from, so `cursor-agent update` is both the check and the update.
    updates: {
      provider: "cursor",
      binary: (env) => resolveExecutable("cursor-agent", env),
      versions: CURSOR_VERSIONS,
      native: {
        label: "Update Cursor Agent",
        args: ["update"],
        ownsPath: (path) =>
          path.includes("/.local/share/cursor-agent/") ||
          path.endsWith("/.local/bin/cursor-agent"),
      },
      install: [scriptInstall("https://cursor.com/install")],
    },
    usageHistory: cursorUsageHistory(context.stores),
    artifactPreview: cursorCanvasPreview,
  })
}
