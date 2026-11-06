import { useEffect, useState } from "react"
import type { FileFindResults, FileGrepResults } from "@mako/host/contracts/file-index"
import type { FilesSource } from "@/state/file-tree"

/** Lines a text search lists before "Show every match": a screenful and then some, which Git finds in milliseconds. */
export const TEXT_FIRST = 150
const TEXT_ALL = 3_000
/** A pause before a text search, so a word typed starts one search rather than six; names don't wait. */
const TEXT_SETTLE_MS = 90

export interface FileSearchState {
  names?: FileFindResults
  text?: FileGrepResults
  /** A text search for the query on screen is under way. */
  searching: boolean
  /** Asks for every matching line, past the first `TEXT_FIRST`. */
  showAllText(): void
}

/**
 * Both answers to one query, as it's typed: files by name from the index at every keystroke, and lines inside files
 * from a text search that waits for a pause and stops at a screenful. Each answer is kept with what it answered, so
 * one that comes back after the query moved on is never shown as the new one's; while the new one is on its way the
 * last answer stays on screen if the query only grew from it. The host stops the text search a newer one replaces.
 */
export function useFileSearch(source: FilesSource, query: string): FileSearchState {
  const term = query.trim()
  const [names, setNames] = useState<FileFindResults>()
  const [text, setText] = useState<{ asked: string; found: FileGrepResults }>()
  const [all, setAll] = useState<string>()
  const limit = all === term ? TEXT_ALL : TEXT_FIRST
  const asked = `${term}\0${limit}`

  useEffect(() => {
    if (!term) return
    let current = true
    void source.find(term, 200).then(
      (found) => {
        if (current) setNames(found)
      },
      () => {
        if (current) setNames({ query: term, version: 0, total: 0, hits: [], ms: 0 })
      }
    )
    return () => {
      current = false
    }
  }, [source, term])

  useEffect(() => {
    if (term.length < 2) return
    let current = true
    const timer = setTimeout(() => {
      void source.grep(term, { limit }).then(
        (found) => {
          if (current) setText({ asked: `${term}\0${limit}`, found })
        },
        (error: Error) => {
          if (current) setText({ asked: `${term}\0${limit}`, found: { query: term, files: [], total: 0, more: false, ms: 0, error: error.message } })
        }
      )
    }, limit === TEXT_ALL ? 0 : TEXT_SETTLE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [source, term, limit])

  const held = text && (text.found.query === term || term.startsWith(text.found.query)) ? text.found : undefined
  return {
    names: term && names && (names.query === term || term.startsWith(names.query)) ? names : undefined,
    text: term.length >= 2 ? held : undefined,
    searching: term.length >= 2 && text?.asked !== asked,
    showAllText: () => setAll(term),
  }
}
