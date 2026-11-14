import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs"
import { syntaxTheme } from "@/lib/syntax-theme"

/**
 * The theme every diff and file view highlights with. Its colors are the
 * `--syntax-*` tokens in index.css, so light, dark and the transcript's code
 * blocks share one palette.
 */
export const DIFF_THEME = "mako"

// SAFETY: a TextMate theme whose colours are CSS variables, as shiki's own CSS-variables theme is; the highlighter
// passes each colour through to the style it writes.
registerCustomTheme(DIFF_THEME, () => Promise.resolve(syntaxTheme(DIFF_THEME) as ThemeRegistration))
