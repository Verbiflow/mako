import { useWebPreferences, webPreferencesStore, type WebPreferences, type WebPreferencesState } from "./account-preferences"

/** The person's choice of look: the system's, or one of Mako's two. It follows their account (`theme` preference). */
export type WebTheme = "system" | "light" | "dark"

/** The look this browser showed last, painted before the account answers so a visit opens without a flash. */
const SHOWN = "mako:web:theme-shown"
/** What this browser kept before the account kept it, read only until the account's preferences take it over. */
const LEGACY = "mako:web:theme"
const LIGHT = "(prefers-color-scheme: light)"

function asTheme(value: string | null | undefined): WebTheme {
  return value === "light" || value === "dark" ? value : "system"
}

/** The account's theme once it's known; until then what this browser showed last. */
function current({ values, held, read }: WebPreferencesState = webPreferencesStore.get()): WebTheme {
  if (held.has("theme") || read) return values.theme ?? "system"
  return asTheme(localStorage.getItem(SHOWN) ?? localStorage.getItem(LEGACY))
}

/** Puts the choice on the page as the desktop does (`.light` on the root), with the browser's own bars to match. */
export function applyTheme(theme: WebTheme = current()): void {
  localStorage.setItem(SHOWN, theme)
  const light = theme === "light" || (theme === "system" && matchMedia(LIGHT).matches)
  document.documentElement.classList.toggle("light", light)
  document.documentElement.style.colorScheme = light ? "light" : "dark"
  const bar = getComputedStyle(document.documentElement).getPropertyValue("--shell").trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bar || (light ? "#f6f4f1" : "#161412")
}

/** Follows the system's look while the choice is "system", and the account's choice as it changes, on any device. */
export function followSystemTheme(): () => void {
  const media = matchMedia(LIGHT)
  const changed = () => {
    if (current() === "system") applyTheme("system")
  }
  media.addEventListener("change", changed)
  let shown = current()
  const stop = webPreferencesStore.subscribe(() => {
    const next = current()
    if (next === shown) return
    shown = next
    applyTheme(next)
  })
  return () => {
    media.removeEventListener("change", changed)
    stop()
  }
}

/** The theme in effect, and a change to it, which goes to the account (`preferences`) and so to every device. */
export function useTheme(preferences: Pick<WebPreferences, "set">): [WebTheme, (theme: WebTheme) => void] {
  const theme = current(useWebPreferences((state) => state))
  return [theme, (next) => void preferences.set("theme", next === "system" ? null : next)]
}
