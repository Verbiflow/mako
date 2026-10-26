import { useMemo } from "react"
import type { InlineFileSpelling } from "@/lib/inline-file-links"
import { useResolvedPaths } from "@/state/file-references"
import { useReferenceSource } from "./source-context"

/**
 * The files a paragraph's or list item's spellings mean, as the host
 * resolves them for this transcript: undefined while asking. A bare name
 * previews only as a file the Thread touched.
 */
export function useResolvedPreviews(spellings: readonly InlineFileSpelling[]): string[] | undefined {
  const written = useMemo(() => spellings.map((entry) => entry.spelling), [spellings])
  const bare = useMemo(() => new Set(spellings.flatMap((entry) => (entry.bare ? [entry.spelling] : []))), [spellings])
  return useResolvedPaths(useReferenceSource(), written, bare)
}
