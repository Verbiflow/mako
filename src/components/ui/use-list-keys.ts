import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

/*
 * The keys of every list page (`components/ui/list.tsx`), the same on each: walk, open, back, search, views, check.
 */

const TYPING = "input, textarea, select, [contenteditable=''], [contenteditable='true']"

/** The rows the keyboard walks, in order: every row drawn, none inside a folded section. */
export function walkedRows(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLElement>("[data-list-row]")].filter((row) => !row.closest("[inert]"))
}

export interface ListKeys {
  /** Where the rows are. */
  root: RefObject<HTMLElement | null>
  /** Listening: the page is showing and nothing covers it. */
  enabled: boolean
  /** The keyboard's row, kept by the page's store so it comes back with the page. */
  selected: string | undefined
  onSelect: (key: string | undefined) => void
  /** Enter on the selected row. */
  onOpen?: (key: string) => void
  /** Escape, once nothing is being typed. */
  onBack?: () => void
  /** `/` focuses it. */
  search?: RefObject<HTMLInputElement | null>
  /** Number keys pick a view, 1 the first. */
  views?: { count: number; pick: (index: number) => void }
  /** `x` checks or unchecks the selected row. */
  onCheck?: (key: string) => void
  /**
   * A page's own keys, asked first with the selected row; true when it took the key. Asked for keys typed in a field
   * too (`typing`), where only Escape goes on to the list's own.
   */
  onKey?: (event: KeyboardEvent, selected: string | undefined, typing: boolean) => boolean
}

/**
 * Every list page's keys, from the window while the page shows: `j`/`k` or the arrows walk the rows (the row taking
 * focus and scrolling into view), Enter opens, Escape goes back (first leaving a field), `/` searches, 1–9 pick a view,
 * `x` checks. A key a menu, a dialog or a modifier holds is left alone. The first row is selected when none is, and a
 * row that leaves hands the selection to the one now in its place.
 */
export function useListKeys(keys: ListKeys): void {
  const current = useRef(keys)
  const index = useRef(0)
  useLayoutEffect(() => {
    current.current = keys
  })

  // Keep the selection on a row that's drawn: the first at the start, the one in a departed row's place after.
  useLayoutEffect(() => {
    if (!keys.enabled) return
    const rows = walkedRows(keys.root.current)
    const at = keys.selected === undefined ? -1 : rows.findIndex((row) => row.dataset.listRow === keys.selected)
    if (at !== -1) {
      index.current = at
      return
    }
    const next = rows[Math.min(index.current, rows.length - 1)]?.dataset.listRow
    if (next !== keys.selected) keys.onSelect(next)
  })

  // The selected row holds focus while focus is on the page or nowhere, so Enter and its own keys reach it.
  useEffect(() => {
    if (!keys.enabled || keys.selected === undefined) return
    const root = keys.root.current
    const row = walkedRows(root).find((each) => each.dataset.listRow === keys.selected)
    const active = document.activeElement
    if (!row || active === row) return
    const resting = !active || active === document.body || (root?.contains(active) && !active.matches(TYPING) && active.closest("[data-list-row]") !== null)
    if (resting) row.focus({ preventScroll: true })
  }, [keys.enabled, keys.selected, keys.root])

  useEffect(() => {
    if (!keys.enabled) return
    const onKey = (event: KeyboardEvent) => {
      const { root, selected, onSelect, onOpen, onBack, search, views, onCheck, onKey: own } = current.current
      if (event.defaultPrevented || event.isComposing) return
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox][data-state=open]")) return
      const target = event.target instanceof HTMLElement ? event.target : null
      // Keys typed somewhere else (another pane's field, the palette) aren't the list's.
      if (target && target !== document.body && !root.current?.contains(target)) return
      const typing = Boolean(target?.matches(TYPING))
      if (own?.(event, selected, typing)) {
        event.preventDefault()
        return
      }
      if (typing) {
        if (event.key !== "Escape") return
        event.preventDefault()
        target!.blur()
        walkedRows(root.current).find((row) => row.dataset.listRow === selected)?.focus({ preventScroll: true })
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const down = event.key === "ArrowDown" || event.key === "j"
      const up = event.key === "ArrowUp" || event.key === "k"
      if (down || up) {
        const rows = walkedRows(root.current)
        if (!rows.length) return
        const at = rows.findIndex((row) => row.dataset.listRow === selected)
        const next = rows[at === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, at + (down ? 1 : -1)))]!
        event.preventDefault()
        onSelect(next.dataset.listRow)
        next.focus({ preventScroll: true })
        next.scrollIntoView({ block: "nearest" })
        return
      }
      if (event.key === "Enter" && selected !== undefined && onOpen) {
        event.preventDefault()
        onOpen(selected)
      } else if (event.key === "Escape" && onBack) {
        event.preventDefault()
        onBack()
      } else if (event.key === "/" && search?.current) {
        event.preventDefault()
        search.current.focus()
        search.current.select()
      } else if (views && /^[1-9]$/.test(event.key) && Number(event.key) <= views.count) {
        event.preventDefault()
        views.pick(Number(event.key) - 1)
      } else if (event.key === "x" && selected !== undefined && onCheck) {
        event.preventDefault()
        onCheck(selected)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [keys.enabled])
}
