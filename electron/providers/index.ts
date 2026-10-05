import { installClaude } from "./claude/index.js"
import { installCodex } from "./codex/index.js"
import { installCursor } from "./cursor/index.js"
import { installDevin } from "./devin/index.js"
import { installGrok } from "./grok/index.js"
import { createProviderHost, type ProviderModule } from "./host.js"
import { installOpenCode } from "./opencode/index.js"

/**
 * Every harness, in Mako's order: the order it tries them in when it must
 * pick one itself, such as setting a project up or drafting a commit
 * message, until the person reorders them in Settings › Models.
 */
const modules: ProviderModule[] = [
  installClaude,
  installCodex,
  installCursor,
  installOpenCode,
  installGrok,
  installDevin,
]

export const providerHost = createProviderHost()
for (const install of modules) install(providerHost)
