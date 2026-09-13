import { useEffect, useState } from "react"

/** The orb's palette follows the document's theme class, live. */
export function useOrbTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    globalThis.document?.documentElement.classList.contains("light") ? "light" : "dark"
  )
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.classList.contains("light") ? "light" : "dark")
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return theme
}
