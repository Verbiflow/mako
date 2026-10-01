import { acpLiveDriver } from "../acp-live-driver.js"
import { acpDecoderSource } from "../acp-decoder-source.js"
import { installHarness, lacks, notBuilt } from "../harness-definition.js"
import type { ProviderModule } from "../host.js"
import { devinAccountCapability } from "./accounts.js"
import { devinAcpSource } from "./acp.js"
import { devinMcpSource } from "./mcp.js"
import { devinNativeRunner } from "./native-runner.js"
import { devinProfileLoader } from "./profile.js"
import { devinSkillSource } from "./skills.js"
import { devinExecutable } from "./executable.js"
import { scriptInstall } from "../update-source.js"

export const installDevin: ProviderModule = (host) => installHarness(host, {
  provider: "devin",
  live: acpLiveDriver(devinAcpSource),
  decoder: acpDecoderSource(devinAcpSource),
  profile: devinProfileLoader,
  accounts: devinAccountCapability,
  acp: devinAcpSource,
  nativeRunner: devinNativeRunner,
  processProbe: notBuilt("Devin’s own processes are not matched to its sessions"),
  mcp: devinMcpSource,
  skills: devinSkillSource,
  sessionEmitter: notBuilt("Mako cannot write a Devin session to continue in"),
  connection: lacks("Signs in through `devin auth login`"),
  // Devin.app and Zed each replace their bundled copy on their own schedule;
  // `devin update` asks before it installs, so it is not run unattended.
  updates: {
    provider: "devin",
    binary: (env) => devinExecutable(env),
    managedBy: [["external_agents", "Zed"]],
    install: [scriptInstall("https://cli.devin.ai/install.sh")],
  },
  artifactPreview: lacks("Writes no artifact Mako previews"),
})
