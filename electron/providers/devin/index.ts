import { acpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { emitDevinSession } from "@mako/sessions"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { byDefault, harnessLacks, implemented, makoLacks } from "../live-capabilities.js"
import { shownBy } from "../../contracts/harness-unique.js"
import { devinAccountCapability } from "./accounts.js"
import { devinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProcessProbe } from "./process-probe.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"
import { scriptInstall } from "../update-source.js"
import { devinPresentation } from "./presentation.js"
import { devinUsageHistory } from "./usage-history.js"

export const installDevin: ProviderModule = (host) => installHarness(host, {
  provider: "devin",
  presentation: devinPresentation,
  diagnostics: { sdk: "@agentclientprotocol/sdk" },
  usage: {
    context: implemented("ACP's `usage_update` from the main agent: what is in context."),
    window: implemented("The same `usage_update`'s `size`."),
    compaction: byDefault("Devin doesn't say what a compaction left, so the meter keeps its earlier reading, marked, until the next reply."),
    tokens: implemented("The tokens in each `usage_update`'s `_meta`."),
    cost: harnessLacks("Devin's usage updates carry no cost."),
    missedCalls: harnessLacks("Devin's usage updates never say they left a call out."),
    resetCredits: harnessLacks("Devin's usage report has no reset credits."),
  },
  unique: [
    { name: "Step revert and fork", native: "`cognition.ai/revert/*`", mako: shownBy("capabilities.fork") },
    { name: "Editable approvals", native: "`cognition.ai/editableCommand`, `command/revise`", mako: makoLacks("The approval card shows the command Devin proposes; editing it before it runs isn't built.") },
    { name: "Cloud handoff", native: "`/handoff`, `/cloud-attach`", mako: makoLacks("Mako runs Devin on this Mac; handing a session to Devin's cloud isn't built.") },
    { name: "Credits and ACUs", native: "`usage_update` `_meta` `totalCreditCost` and `totalAcuCost` on the reading that ends a turn, for an account billed in credits or ACUs", mako: makoLacks("Every account recorded is billed by quota and reports 0, so Mako doesn't read them yet.") },
  ],
  hooks: notBuilt("Hook discovery and editing have not been verified in Mako"),
  commands: notBuilt("Custom command authoring is not implemented; live command discovery remains available"),
  toolEditing: lacks("Native tools are supplied by the runtime; additional tools use MCP"),
  skillEditing: { provider: "devin", route: "skill-registry", operations: ["import", "remove"] },
  mcpEditing: { provider: "devin", route: "mcp-registry", operations: ["import"] },
  live: acpLiveDriver(devinAcpSource),
  decoder: acpDecoderSource(devinAcpSource),
  profile: devinProfileLoader,
  accounts: devinAccountCapability,
  acp: devinAcpSource,
  nativeRunner: devinNativeRunner,
  processProbe: devinProcessProbe,
  mcp: devinMcpSource,
  skills: devinSkillSource,
  sessionEmitter: {
    provider: "devin",
    emit: (thread) => emitDevinSession(thread, {}),
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
  usageHistory: devinUsageHistory,  artifactPreview: lacks("It writes no artifact files of its own; the file viewer previews what it writes by file type."),
})
