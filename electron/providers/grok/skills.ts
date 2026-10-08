import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "../skill-source.js"
import { grokHome } from "@mako/sessions"
import { grokTrustsProject } from "./permission-policy.js"

const root = () => join(grokHome(process.env), "skills")

export const grokSkillSource: ProviderSkillSource = {
  provider: "grok",
  command: () => join(homedir(), ".grok", "bin", "grok"),
  userRoots: () => [root()],
  workspaceFolder: ".grok",
  targetUserRoot: root,
  // grok 1.0.46 listed skills from `~/.agents/skills` and `.agents/skills` (`npm run harness:self-report -- grok`).
  readsUniversalRoot: true,
  // Grok skips a project's skills until the person trusts its folder (`folder-trust.ts`).
  readsWorkspace: (cwd) => grokTrustsProject({ cwd, home: homedir(), grokHome: grokHome(process.env) }),
}
