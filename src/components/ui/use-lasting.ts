import { useEffect, useState } from "react"

/**
 * Whether `key` has stood for `ms`: false while it is absent, new, or just
 * replaced by another. For a wait worth naming only once it is a wait, so
 * work that ends before a person could read about it draws nothing.
 */
export function useLasting(key: string | undefined, ms: number): boolean {
  const [lasted, setLasted] = useState<string | undefined>(undefined)
  // Gone and back is new again.
  if (key === undefined && lasted !== undefined) setLasted(undefined)
  useEffect(() => {
    if (key === undefined) return
    const timer = setTimeout(() => setLasted(key), ms)
    return () => clearTimeout(timer)
  }, [key, ms])
  return key !== undefined && lasted === key
}
