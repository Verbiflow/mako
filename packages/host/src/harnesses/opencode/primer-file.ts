import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import { z } from "zod"
import { publishFile } from "../../base/published-files.js"

const Config = z.looseObject({ instructions: z.array(z.string()).optional() })

/**
 * Names Mako's primer in the launch's inline config, as a file OpenCode
 * appends to its instructions. An agent's `prompt` would replace the
 * provider's own, so this doesn't use one. The file lives in a temp folder
 * this build owns, never the person's OpenCode home and never the project.
 */
export async function configureOpenCodePrimer(env: NodeJS.ProcessEnv, primer: string | undefined): Promise<void> {
  if (!primer) return
  const folder = join(tmpdir(), `mako-opencode-primer-${createHash("sha256").update(primer).digest("hex").slice(0, 16)}`)
  const file = join(folder, "MAKO.md")
  await publishFile(file, `${primer}\n`, { mode: 0o600, dirMode: 0o700 })
  const errors: ParseError[] = []
  const config = Config.parse(parse(env.OPENCODE_CONFIG_CONTENT || "{}", errors, { allowTrailingComma: true }))
  if (errors.length) throw new Error("OpenCode inline configuration contains invalid JSON.")
  const instructions = [...new Set([...(config.instructions ?? []), file])]
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ ...config, instructions })
}
