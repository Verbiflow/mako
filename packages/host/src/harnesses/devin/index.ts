import { createAcpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { emitDevinSession } from "@mako/sessions"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { makosOwn, native, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createDevinAccountCapability } from "./accounts.js"
import { createDevinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { createDevinProcessProbe } from "./process-probe.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"
import { scriptInstall } from "../update-source.js"
import { devinPresentation } from "./presentation.js"
import { devinUsageHistory } from "./usage-history.js"

export const installDevin: ProviderModule = (host, context) => {
  const acp = createDevinAcpSource(context.stores)
  installHarness(host, {
    provider: "devin",
    presentation: devinPresentation,
    diagnostics: { sdk: "@agentclientprotocol/sdk" },
    usage: {
      context: implemented("ACP's `usage_update` from the main agent: what is in context."),
      window: implemented("The same `usage_update`'s `size`."),
      compaction: byDefault("Devin doesn't say what a compaction left, so the meter keeps its earlier reading, marked, until the next reply."),
      tokens: implemented("The tokens in each `usage_update`'s `_meta`."),
      cost: makoLacks("Devin prices a turn in credits or ACUs (`totalCreditCost`, `totalAcuCost` on the reading that ends it), and every account recorded is billed by quota and reports 0, so Mako doesn't read them yet."),
      missedCalls: harnessLacks("Devin's usage updates never say they left a call out."),
      resetCredits: harnessLacks("Devin's usage report has no reset credits."),
      balance: implemented("Extra usage left beyond the plan, in Devin's plan status."),
    },
    features: {
      goals: { mako: makosOwn("Devin has no goal; its `/loop` repeats until its own review of the diff passes.") },
      review: { native: native("/loop", "`/loop`, which runs a prompt, then reviews the diff and fixes it, in a loop"), mako: makoLacks("Starting Devin's review loop from Mako isn't built.") },
      sideQuestions: { native: native("/btw", "`/btw`, a quick question that doesn't disrupt the main conversation"), mako: makoLacks("Mako doesn't ask side questions yet.") },
      scheduledPrompts: { mako: harnessLacks("Devin's scheduled sessions run in its cloud; the CLI has no schedule.") },
      cloudRuns: { native: native("/handoff", "`/handoff` and `/cloud-attach`"), mako: makoLacks("Mako runs Devin on this Mac; handing a session to Devin's cloud isn't built.") },
      backgroundSessions: { mako: makosOwn() },
      fileRewind: { native: native("/revert", "`_cognition.ai/revert/*`, which takes back files and history"), mako: makosOwn() },
      worktrees: { mako: makosOwn() },
      computerUse: { mako: makosOwn() },
      notifications: { mako: makosOwn() },
      folderTrust: { native: native("workspace trust", "workspace trust, which Mako's headless runs respect with `--respect-workspace-trust`"), mako: makoLacks("A conversation doesn't show or set Devin's workspace trust.") },
      editApprovals: { native: native("editable commands", "`cognition.ai/editableCommand` on an approval, and `command/revise`"), mako: makoLacks("The approval card shows the command Devin proposes; editing it before it runs isn't built.") },
      plugins: { native: native("plugins", "`cognition.ai/plugins`, with `_cognition.ai/plugins/changed`"), mako: byDefault("Devin loads its plugins in sessions Mako starts.") },
      responseStyle: { mako: harnessLacks("Devin has no response style.") },
      webSearch: { mako: TOOL_ROWS },
      imageGeneration: { mako: harnessLacks("Devin has no image generation tool.") },
      codeMode: { mako: harnessLacks("Devin has no code mode; each tool is its own call.") },
    },
    unique: [],
    hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
    commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "devin", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: { provider: "devin", route: "mcp-registry", operations: ["import"] },
    live: createAcpLiveDriver(acp, host, context),
    decoder: acpDecoderSource(acp),
    profile: devinProfileLoader(context.stores, host.discovery),
    accounts: createDevinAccountCapability(),
    acp,
    nativeRunner: devinNativeRunner,
    processProbe: createDevinProcessProbe(),
    mcp: devinMcpSource,
    skills: devinSkillSource,
    sessionEmitter: {
      provider: "devin",
      emit: (thread) => emitDevinSession(context.stores, thread, {}),
    },
    connection: lacks("Signs in through `devin auth login`"),
    // Devin.app and Zed each replace their bundled copy on their own schedule;
    // `devin update` asks before it installs, so it is not run unattended.
    updates: {
      provider: "devin",
      binary: (env) => devinExecutable(env),
      managedBy: [["external_agents", "Zed"]],
      install: [scriptInstall("https://cli.devin.ai/install.sh")],
    },
    usageHistory: devinUsageHistory(context.stores),
    artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
  })
}
