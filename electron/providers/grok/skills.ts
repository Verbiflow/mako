import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"

const root = () => join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "skills")

export const grokSkillSource: ProviderSkillSource = {
  provider: "grok",
  command: () => join(homedir(), ".grok", "bin", "grok"),
  userRoots: () => [root()],
  workspaceFolder: ".grok",
  targetUserRoot: root,
  // grok 1.0.46 listed skills from `~/.agents/skills` and `.agents/skills` (`npm run harness:self-report -- grok`).
  readsUniversalRoot: true,
}
