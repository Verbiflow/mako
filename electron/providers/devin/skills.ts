import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"
import { devinExecutable } from "./executable.js"

const configRoot = () => join(homedir(), ".config", "devin", "skills")

export const devinSkillSource: ProviderSkillSource = {
  provider: "devin",
  command: () => devinExecutable(),
  userRoots: () => [configRoot()],
  workspaceFolder: ".devin",
  targetUserRoot: configRoot,
  readsUniversalRoot: true,
}
