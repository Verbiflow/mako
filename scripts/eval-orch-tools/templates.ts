import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import { z } from "zod"

/**
 * A harness's own system prompt and tools, from one request it sent the
 * refusing stand-in of `harness:native-tools --keep` (no account, $0): the
 * replay starts every case from it, as T3 Code's suite starts from its
 * trimmed captures. Trimmed of what names the machine or the run: the
 * sandbox's folder, its device and cache IDs, and the stand-in's own turn.
 *
 *   npx tsx scripts/eval-orch-tools/run.ts --template <kept request.json> claude|codex|codex-lead
 */

export const TEMPLATES_DIR = join(import.meta.dirname, "templates")
export const TEMPLATE_NAMES = ["claude", "codex", "codex-lead"] as const
export type TemplateName = (typeof TEMPLATE_NAMES)[number]

/** Where the replay's agent works, as its prompt says. */
export const WORKSPACE = "/workspace/acme-app"
const SANDBOX = /(?:\/private)?\/var\/folders\/[^"\\\s`]*?\/T\/mako-native-tools-[a-z]+-[A-Za-z0-9]+(?:\/project)?/g
const SANDBOX_SLUG = /-(?:private-)?var-folders-[^"\\\s`/]*?-T-mako-native-tools-[a-z]+-[A-Za-z0-9]+(?:-project)?/g

const Body = z.record(z.string(), z.json())
type Body = z.infer<typeof Body>
/** A kept request: its body as JSON, or as the text a websocket frame carried. */
const Kept = z.object({ path: z.string(), body: z.union([Body, z.string().transform((text) => Body.parse(JSON.parse(text)))]) })

/** The template in a kept request's file text. */
export function trimCapture(name: TemplateName, keptText: string) {
  const { body } = Kept.parse(JSON.parse(keptText))
  const text = JSON.stringify(body).replace(SANDBOX, WORKSPACE).replace(SANDBOX_SLUG, "-workspace-acme-app")
  const trimmed = Body.parse(JSON.parse(text))
  if (name === "claude") {
    const { model, system, tools, max_tokens, thinking } = trimmed
    return { model, system, tools, max_tokens, thinking }
  }
  const input = z.array(z.record(z.string(), z.json())).parse(trimmed.input)
  // The stand-in's own "hi" is the last user message; the environment context before it stays.
  const turns = input.slice(0, input.findLastIndex((item) => item.role === "user"))
  const { model, tool_choice, parallel_tool_calls, reasoning, include, text: format } = trimmed
  return { model, input: turns, tool_choice, parallel_tool_calls, reasoning, include, text: format }
}

export function writeTemplate(name: TemplateName, keptFile: string): string {
  const file = join(TEMPLATES_DIR, `${name}.json.gz`)
  writeFileSync(file, gzipSync(JSON.stringify(trimCapture(name, readFileSync(keptFile, "utf8")))))
  return file
}

export function readTemplate(name: TemplateName): Body {
  return Body.parse(JSON.parse(gunzipSync(readFileSync(join(TEMPLATES_DIR, `${name}.json.gz`))).toString("utf8")))
}
