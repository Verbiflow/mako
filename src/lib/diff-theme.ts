import { registerCustomCSSVariableTheme } from "@pierre/diffs"

/**
 * The theme every diff and file view highlights with. Its colors are the
 * `--syntax-*` tokens in index.css, so light, dark and the transcript's code
 * blocks share one palette.
 */
export const DIFF_THEME = "mako"

registerCustomCSSVariableTheme(DIFF_THEME, {})
