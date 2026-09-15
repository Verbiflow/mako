import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"
import { openCodeExecutable } from "./installation.js"

const configRoot = () => join(homedir(), ".config", "opencode", "skills")

export const openCodeSkillSource: ProviderSkillSource = {
  provider: "opencode",
  command: () => openCodeExecutable() ?? "opencode",
  userRoots: () => [configRoot(), join(homedir(), ".opencode", "skills")],
  workspaceFolder: ".opencode",
  targetUserRoot: configRoot,
  readsUniversalRoot: false,
}
