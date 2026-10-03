import { createContext, useContext, useEffect } from "react"
import type { FileContents } from "@/lib/types"

export type AssetView = "preview" | "source"
export interface AssetPreviewOwner {
  enlarged: boolean
  setEnlarged(open: boolean): void
  resolved(file: FileContents | undefined, mode: AssetView, error?: string): void
}
export const AssetPreviewContext = createContext<AssetPreviewOwner | null>(null)

/** The collection owns the dialog; only its selected file owns a renderer. */
export function useAssetPreview(file: FileContents | undefined, mode: AssetView, error?: string) {
  const owner = useContext(AssetPreviewContext)
  const resolved = owner?.resolved
  useEffect(() => { resolved?.(file, mode, error) }, [resolved, file, mode, error])
  return owner
}
