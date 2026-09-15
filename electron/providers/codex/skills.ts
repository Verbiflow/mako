import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"

export const codexSkillSource: ProviderSkillSource = {
  provider: "codex",
  command: () => "codex",
  userRoots: (account) => [
    join(account.dir ?? join(homedir(), ".codex"), "skills"),
  ],
  workspaceFolder: ".codex",
  targetUserRoot: (account) =>
    join(account.dir ?? join(homedir(), ".codex"), "skills"),
  readsUniversalRoot: false,
}
