import { useEffect, useMemo, useState } from "react"
import { readWindowOutline, type ReadOutline } from "@mako/host/contracts/window-outline"
import { getMako } from "@/lib/bridge"

/**
 * A window capture's elements, for drawing their boxes over its picture:
 * the outline the desk still holds, else the copy staged beside the image
 * (`contextPath`), read once. A capture from before outlines (flat text)
 * reads as no elements, and the toggle stays away.
 */
export function useWindowOutline(contextPath: string | undefined, inline: string | undefined): ReadOutline | undefined {
  const [read, setRead] = useState<{ path: string; outline: ReadOutline } | null>(null)
  const path = inline === undefined ? contextPath : undefined
  useEffect(() => {
    if (!path) return
    let current = true
    void getMako()
      .readFile(path)
      .then(
        (file) => current && setRead({ path, outline: file.binary ? { elements: [] } : readWindowOutline(file.contents) }),
        () => current && setRead({ path, outline: { elements: [] } })
      )
    return () => {
      current = false
    }
  }, [path])
  const parsed = useMemo(() => (inline === undefined ? undefined : readWindowOutline(inline)), [inline])
  if (parsed) return parsed
  return read?.path === path ? read?.outline : undefined
}
