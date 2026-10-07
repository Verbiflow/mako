import { CLAUDE_VOCABULARY } from "./claude.js"
import { CODEX_VOCABULARY } from "./codex.js"
import { CURSOR_VOCABULARY } from "./cursor.js"
import { DEVIN_VOCABULARY } from "./devin.js"
import { GROK_VOCABULARY } from "./grok.js"
import { OPENCODE_VOCABULARY } from "./opencode.js"
import type { HarnessVocabulary } from "./vocabulary.js"

export type { ConceptAbsent, ConceptPath, HarnessConcepts, HarnessVocabulary, NativeTool, McpNaming } from "./vocabulary.js"
export { CLAUDE_VOCABULARY, CODEX_VOCABULARY, CURSOR_VOCABULARY, DEVIN_VOCABULARY, GROK_VOCABULARY, OPENCODE_VOCABULARY }
export { CLAUDE_HOOK_EVENTS } from "./claude.js"
export { DEVIN_ACP_HOOKS, DEVIN_TOOL_READING } from "./devin.js"
export { GROK_ACP_HOOKS, grokCommandFailed, grokPlanId, grokProposedPlan, GrokToolMeta, grokToolName } from "./grok.js"

/** Every harness's declaration. A harness without one gets the names all of these share. */
export const VOCABULARIES: readonly HarnessVocabulary[] = [
  CLAUDE_VOCABULARY, CODEX_VOCABULARY, CURSOR_VOCABULARY, OPENCODE_VOCABULARY, GROK_VOCABULARY, DEVIN_VOCABULARY,
]
