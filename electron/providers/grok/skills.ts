import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"

const root = () => join(homedir(), ".grok", "skills")

export const grokSkillSource: ProviderSkillSource = {
  provider: "grok",
  command: () => join(homedir(), ".grok", "bin", "grok"),
  userRoots: () => [root()],
  workspaceFolder: ".grok",
  targetUserRoot: root,
  readsUniversalRoot: false,
}
