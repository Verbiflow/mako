import type { LiveSessionMode } from "../../../contracts/providers-acp.js"

/**
 * The one mode a Cursor SDK session runs under: Agent, on the full tier.
 *
 * The SDK has no permission prompt: a tool either exists for the model or it
 * does not. Verified with SDK 1.0.31 on 2026-09-13: a `.cursor/hooks.json`
 * hook answering `"ask"` ran the command as if it had said `"allow"`,
 * `"deny"` refused it, and under `autoReview` the model's own attempt to run
 * `git push --force` "with approval" came back "Local SDK runs cannot
 * request interactive approval for this shell command" — the SDK's words.
 * No `request` message and no answering method exist on a local run.
 *
 * So no tier that asks (`ask`, `edits`, `deny`) can be made true, and the
 * SDK's `autoReview` classifier is not used either: it refuses instead of
 * asking, the reason reaches the model only, and nobody at the desk can
 * overrule it, so a blocked call is a turn lost to a decision the user never
 * saw. Cursor's planning mode and a read-only tool allowlist would work, but
 * they are deliberately not offered: Cursor in Mako is Agent and nothing
 * else, and the composer's access chip says so rather than opening a ladder.
 * A workspace's `.cursor/hooks.json` remains the one policy hook, which is
 * why the child loads project settings.
 *
 * The id is not `agent` on purpose: Cursor's old ACP transport advertised a
 * mode with that id, and an id this ladder does not know falls back to the
 * one mode there is, so nothing saved under the old ids is refused.
 */
export const CURSOR_SDK_MODE_IDS = ["full-access"] as const
export type CursorSdkModeId = (typeof CURSOR_SDK_MODE_IDS)[number]

export const CURSOR_SDK_DEFAULT_MODE: CursorSdkModeId = "full-access"

export const CURSOR_SDK_MODES: readonly LiveSessionMode[] = [
  {
    id: "full-access",
    name: "Agent",
    access: "full",
    enforcement: "provider",
    description: "Every tool runs without approval; the SDK has no prompt to ask through.",
  },
]

export function isCursorSdkModeId(value: string): value is CursorSdkModeId {
  return CURSOR_SDK_MODE_IDS.some((id) => id === value)
}
