import { createAcpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { installHarness, lacks } from "../harness-definition.js"
import { createDevinHooks, createDevinMcpEditing } from "./authoring.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { makosOwn, native, shownAs, TOOL_ROWS } from "../../contracts/harness-features.js"
import { createDevinAccountCapability } from "./accounts.js"
import { createDevinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { createDevinProcessProbe } from "./process-probe.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"
import { DEVIN_VERSIONS, devinSetup } from "./versions.js"
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
      compaction: byDefault("Devin doesn't say what a compaction left: its notice carries only the summary, and its store counts the summary's own tokens, not the context around it. The next reply measures it."),
      tokens: implemented("The tokens in each `usage_update`'s `_meta`."),
      cost: makoLacks("Devin prices a turn in credits or ACUs (`totalCreditCost`, `totalAcuCost` on the reading that ends it), and every account recorded is billed by quota and reports 0, so Mako doesn't read them yet."),
      missedCalls: harnessLacks("Devin's usage updates never say they left a call out."),
      resetCredits: harnessLacks("Devin's usage report has no reset credits."),
      balance: implemented("Extra usage left beyond the plan, in Devin's plan status."),
      limitSwitch: implemented("Each account's daily and weekly quota from its plan status, read with that account's key. A turn Devin stops with `quota_exhausted` ends without failing, so it is the reading at its limit that offers the switch."),
      toolSpend: harnessLacks("Devin's `usage_update` reports tokens per model call; its tool calls carry no tokens."),
    },
    features: {
      goals: { mako: makosOwn("Devin has no goal; its `/loop` repeats until its own review of the diff passes.") },
      review: { native: native("/loop", "`/loop`, which runs a prompt, then reviews the diff and fixes it, in a loop"), mako: makosOwn("Devin has no command that only reviews, so Mako's review prompt asks Devin to hand the review to its read-only review subagent.") },
      sideQuestions: { native: native("/btw", "`/btw`, a quick question that doesn't disrupt the main conversation"), mako: shownAs("`/btw` opens the side panel above the composer, and Devin answers on its side chain.") },
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
    hooks: createDevinHooks(),
    commands: lacks("Devin's slash commands are its skills, under Skills; 3000.10.23 reads no command folder"),
    toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
    skillEditing: { provider: "devin", route: "skill-registry", operations: ["import", "remove"] },
    mcpEditing: createDevinMcpEditing(),
    live: createAcpLiveDriver(acp, host, context),
    decoder: acpDecoderSource(acp),
    profile: devinProfileLoader(context.stores, host.discovery),
    accounts: createDevinAccountCapability(host.accounts.root),
    acp,
    nativeRunner: devinNativeRunner,
    processProbe: createDevinProcessProbe(),
    mcp: devinMcpSource,
    skills: devinSkillSource,
    connection: lacks("Signs in through `devin auth login`"),
    // Devin.app and Zed each replace their bundled copy on their own schedule;
    // `devin update` asks before it installs, so it is not run unattended.
    updates: {
      provider: "devin",
      binary: (env) => devinExecutable(env),
      managedBy: [["external_agents", "Zed"]],
      versions: DEVIN_VERSIONS,
      // The standalone install keeps versions under ~/.local/share/devin and
      // links ~/.local/bin/devin; its versioned setup script installs one.
      native: {
        label: "Update Devin",
        args: [],
        ownsPath: (path) => path.includes("/.local/share/devin/"),
        installVersion: devinSetup,
      },
      install: [devinSetup(DEVIN_VERSIONS.tested)],
    },
    usageHistory: devinUsageHistory(context.stores),
    artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
  })
}
