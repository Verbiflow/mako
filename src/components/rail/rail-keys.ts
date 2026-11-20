import type { KeyboardEvent } from "react"

const KEYS = ["ArrowDown", "ArrowUp", "Home", "End"]

/** Arrows through a rail's rows: each row opens what it opens, and focus goes with it. For the rail's own `onKeyDown`. */
export function moveInRail(event: KeyboardEvent<HTMLElement>): void {
  if (!KEYS.includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-surface-id]")]
  const index = rows.findIndex((row) => row === event.target)
  if (index < 0) return
  event.preventDefault()
  const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[(index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]
  if (!next) return
  next.click()
  next.focus()
}

/** The left rail's Thread rows as drawn, top to bottom, those folded away left out: what ⌘1–9 and a ⇧-click's range count. */
export function railThreadRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".thread-jump-scope [data-thread-row]")].filter((row) => row.offsetParent !== null && !row.closest("[inert]"))
}

/** Their keys (`data-flip-key`), for a ⇧-click's range. */
export function railThreadRowKeys(): string[] {
  return railThreadRows().flatMap((row) => (row.dataset.flipKey ? [row.dataset.flipKey] : []))
}
