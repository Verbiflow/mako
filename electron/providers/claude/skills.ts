import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"

export const claudeSkillSource: ProviderSkillSource = {
  provider: "claude",
  command: () => "claude",
  userRoots: (account) => [
    join(account.dir ?? join(homedir(), ".claude"), "skills"),
  ],
  workspaceFolder: ".claude",
  targetUserRoot: (account) =>
    join(account.dir ?? join(homedir(), ".claude"), "skills"),
  readsUniversalRoot: false,
}
