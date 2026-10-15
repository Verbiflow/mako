import { installHarness, lacks } from "../harness-definition.js"
import { createOpenCodeCommands, createOpenCodeMcpEditing, createOpenCodePlugins } from "./authoring.js"
import { approvalRoot, type ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented } from "../live-capabilities.js"
import { makosOwn, native, shownAs, TOOL_ROWS } from "../../contracts/harness-features.js"
import { openCodeAccountCapability } from "./accounts.js"
import { openCodeDecoderSource } from "./decoder-source.js"
import { createOpenCodeDriver } from "./live-driver.js"
import { openCodeMcpSource } from "./mcp.js"
import { openCodeNativeRunner } from "./native-runner.js"
import { openCodeProcessProbeFor } from "./process-probe.js"
import { openCodeProfileLoader } from "./profile.js"
import { OpenCodeServers } from "./servers.js"
import { OpenCodeVersions } from "./installation.js"
import { emitOpenCodeSession } from "./session-emitter.js"
import { openCodeSkillSource } from "./skills.js"
import { openCodeUpdateSource } from "./updates.js"
import { openCodeUsageHistory } from "./usage-history.js"
import { openCodePresentation } from "./presentation.js"

/**
 * OpenCode v2 runs through its native API: one `opencode serve --stdio` per
 * conversation, typed by `@opencode/client`. `opencode acp` was the transport
 * before; its bridge dropped native questions, could not bind a turn to the
 * message it sent, and needed a plugin to see permission decisions.
 */
export const installOpenCode: ProviderModule = (host, context) => {
  const servers = new OpenCodeServers()
  const versions = new OpenCodeVersions()
  return installHarness(host, {
    provider: "opencode",
    presentation: openCodePresentation,
    diagnostics: { sdk: "@opencode/client" },
    usage: {
      context: implemented("The main session's last step: what it read, cached or not, and wrote."),
      window: implemented("The model's context limit in OpenCode's provider catalog."),
      compaction: byDefault("OpenCode doesn't say what a compaction left: it reports only the summarizing call's own tokens. The next reply measures it."),
      tokens: implemented("Each step's tokens."),
      cost: implemented("Each step's cost."),
      missedCalls: harnessLacks("OpenCode's steps never say they left a call out."),
      resetCredits: harnessLacks("OpenCode's providers report no reset credits to it."),
      balance: harnessLacks("OpenCode runs on the person's provider keys and reports no balance."),
      limitSwitch: harnessLacks("OpenCode keeps its logins in its own database, one per model provider; Mako reads them but never switches them, since a second login would split its session store."),
      toolSpend: harnessLacks("OpenCode reports tokens per step, one model call that reads every tool result before it; its tool parts carry no tokens."),
    },
    features: {
      goals: { mako: makosOwn("OpenCode has no goal; each prompt runs until the agent stops.") },
      review: { native: native("/review", "its built-in `review` command, run as a subtask, of the uncommitted changes, a commit, a branch or a pull request"), mako: shownAs("`/review` opens the review picker above the composer and sends OpenCode's `/review` for the target. OpenCode reports its findings as prose, so they show as its reply.") },
      sideQuestions: { native: native("session.generate", "its server's `session.generate`, text from the session's context that doesn't join its history"), mako: shownAs("`/btw` opens the side panel above the composer, and OpenCode answers through `session.generate`.") },
      scheduledPrompts: { mako: harnessLacks("OpenCode has no schedule.") },
      cloudRuns: { mako: harnessLacks("OpenCode shares a session as a link but doesn't run one in a cloud.") },
      backgroundSessions: { mako: makosOwn() },
      fileRewind: { native: native("/undo, /redo", "`revert/stage`, `commit` and `clear`"), mako: makosOwn("A revert another OpenCode client commits redraws the conversation.") },
      worktrees: { native: native("worktrees", "the experimental `/experimental/worktree` routes"), mako: makosOwn() },
      computerUse: { mako: makosOwn() },
      notifications: { mako: makosOwn() },
      folderTrust: { native: native("external_directory", "the `external_directory` permission, asked before it reaches outside the project"), mako: shownAs("An approval card when it reaches outside the project.") },
      editApprovals: { mako: harnessLacks("OpenCode's approvals answer once, always or reject, with an optional message.") },
      plugins: { native: native("plugins", "`plugin` in its config; `.opencode/plugins` and `~/.config/opencode/plugins`"), mako: byDefault("OpenCode loads its configured plugins in sessions Mako starts.") },
      responseStyle: { mako: harnessLacks("OpenCode shapes replies through each agent's prompt, not a style.") },
      webSearch: { mako: TOOL_ROWS },
      imageGeneration: { mako: harnessLacks("OpenCode has no image generation tool.") },
      codeMode: { mako: TOOL_ROWS },
    },
    unique: [],
    hooks: createOpenCodePlugins(),
    commands: createOpenCodeCommands(),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "opencode", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: createOpenCodeMcpEditing(),
    live: createOpenCodeDriver({
      stores: context.stores,
      approvalRoot: () => Promise.resolve(approvalRoot(context)),
      streams: context.streams,
      servers,
      versions,
    }),
    decoder: openCodeDecoderSource,
    profile: openCodeProfileLoader(servers, versions),
    accounts: openCodeAccountCapability(context.stores),
    acp: lacks("Runs on OpenCode’s native API"),
    nativeRunner: openCodeNativeRunner(context.stores, versions),
    processProbe: openCodeProcessProbeFor(servers),
    mcp: openCodeMcpSource,
    skills: openCodeSkillSource,
    sessionEmitter: {
      provider: "opencode",
      emit: async (thread) => emitOpenCodeSession(context.stores, thread, await host.accounts.env("opencode", process.env), versions),
    },
    connection: lacks("Signs in through OpenCode’s own providers"),
    updates: openCodeUpdateSource,
    usageHistory: openCodeUsageHistory(context.stores),
    artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
  })
}
