import { useEffect, useState } from "react"

/** The person's choice of look on this browser: the system's, or one of Mako's two. */
export type WebTheme = "system" | "light" | "dark"

const KEY = "mako:web:theme"
const LIGHT = "(prefers-color-scheme: light)"

function stored(): WebTheme {
  const value = localStorage.getItem(KEY)
  return value === "light" || value === "dark" ? value : "system"
}

/** Puts the choice on the page as the desktop does (`.light` on the root), with the browser's own bars to match. */
export function applyTheme(theme: WebTheme = stored()): void {
  const light = theme === "light" || (theme === "system" && matchMedia(LIGHT).matches)
  document.documentElement.classList.toggle("light", light)
  document.documentElement.style.colorScheme = light ? "light" : "dark"
  const bar = getComputedStyle(document.documentElement).getPropertyValue("--shell").trim()
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bar || (light ? "#f6f4f1" : "#161412")
}

/** Follows the system's look while the choice is "system". */
export function followSystemTheme(): () => void {
  const media = matchMedia(LIGHT)
  const changed = () => {
    if (stored() === "system") applyTheme("system")
  }
  media.addEventListener("change", changed)
  return () => media.removeEventListener("change", changed)
}

export function useTheme(): [WebTheme, (theme: WebTheme) => void] {
  const [theme, setTheme] = useState<WebTheme>(stored)
  useEffect(() => applyTheme(theme), [theme])
  return [
    theme,
    (next) => {
      if (next === "system") localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
      setTheme(next)
    },
  ]
}
