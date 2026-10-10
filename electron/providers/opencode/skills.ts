import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "@mako/host/tools"
import { openCodeExecutable } from "./installation.js"

const configRoot = () => join(homedir(), ".config", "opencode", "skills")

export const openCodeSkillSource: ProviderSkillSource = {
  provider: "opencode",
  command: () => openCodeExecutable() ?? "opencode",
  userRoots: () => [configRoot()],
  workspaceFolder: ".opencode",
  targetUserRoot: configRoot,
  readsUniversalRoot: true,
}
