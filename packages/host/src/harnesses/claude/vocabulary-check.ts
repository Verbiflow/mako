import type { HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk"
import type { CLAUDE_HOOK_EVENTS } from "@mako/sessions/harnesses"

/**
 * Fails `npm run typecheck`, naming the event, when an SDK upgrade adds or
 * drops a hook event Claude's concepts (packages/sessions/src/harnesses/claude.ts)
 * declare.
 */
type SdkEvent = (typeof HOOK_EVENTS)[number]
type DeclaredEvent = (typeof CLAUDE_HOOK_EVENTS)[number]
type Undeclared = Exclude<SdkEvent, DeclaredEvent>
type Unknown = Exclude<DeclaredEvent, SdkEvent>
export const everySdkHookEventDeclared: [Undeclared] extends [never] ? true : Undeclared = true
export const everyDeclaredHookEventInSdk: [Unknown] extends [never] ? true : Unknown = true
