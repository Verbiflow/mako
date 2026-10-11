import type { ToolType } from "@cursor/sdk"
import type { CURSOR_VOCABULARY } from "@mako/sessions/harnesses"

/**
 * Fails `npm run typecheck`, naming the tool, when an SDK upgrade adds a
 * tool type Cursor's vocabulary (packages/sessions/src/harnesses/cursor.ts)
 * doesn't declare.
 */
type Undeclared = Exclude<ToolType, keyof (typeof CURSOR_VOCABULARY)["tools"]>
export const everySdkToolDeclared: [Undeclared] extends [never] ? true : Undeclared = true
