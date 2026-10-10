import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSkillSource } from "@mako/host/tools"

const root = () => join(homedir(), ".cursor", "skills")

export const cursorSkillSource: ProviderSkillSource = {
  provider: "cursor",
  command: () => "cursor-agent",
  userRoots: () => [root()],
  workspaceFolder: ".cursor",
  targetUserRoot: root,
  readsUniversalRoot: true,
}
