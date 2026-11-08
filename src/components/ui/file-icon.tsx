import { memo, type ReactNode } from "react"
import { fileGlyph, type GlyphName } from "@/lib/file-kinds"
import { cn } from "@/lib/utils"

/**
 * A file's or folder's mark, by what it is.
 *
 * One set on one 16-unit grid: a single stroke weight, square corners and joins, no fill but where a mark means a
 * solid thing (a picture's sun, a node). No hue: the design rules keep colour for what changed, and a type is told
 * apart by its shape, or by its language's letters where a language has no shape of its own. It takes the colour of
 * the text around it.
 */
export const FileIcon = memo(function FileIcon({ path, mimeType, folder, open, className }: { path: string; mimeType?: string; folder?: boolean; open?: boolean; className?: string }) {
  if (folder) return <Svg className={className}>{open ? FOLDER_OPEN : FOLDER}</Svg>
  const glyph = fileGlyph(path, mimeType)
  if (glyph.kind === "letters") return <Svg className={className}>{lettered(glyph.text)}</Svg>
  return <Svg className={className}>{GLYPHS[glyph.name]}</Svg>
})

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinejoin="miter"
      strokeLinecap="square"
      className={cn("size-4 shrink-0", className)}
    >
      {children}
    </svg>
  )
}

/**
 * A language's letters, filling the mark's box as a glyph would: two at full size, three condensed, one larger. A
 * short rule under them keeps a column of them reading as marks rather than as part of the name beside it.
 */
function lettered(text: string): ReactNode {
  const size = text.length > 2 ? 7 : text.length > 1 ? 9 : 11
  return (
    <>
      <text x="8" y={text.length > 2 ? 10.75 : 11.5} textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-sans)" fontWeight={640} fontSize={size} letterSpacing={text.length > 2 ? -0.45 : -0.4}>
        {text}
      </text>
      <path d="M3.25 14.5h9.5" strokeWidth={1} />
    </>
  )
}

const PAGE = <path d="M3.25 1.75h6l3.5 3.5v9H3.25z M9.25 1.75v3.5h3.5" />

const FOLDER = <path d="M1.75 3.25h4.5l1.5 1.5h6.5v8H1.75z" />
const FOLDER_OPEN = <path d="M1.75 12.75v-9.5h4.5l1.5 1.5h5v2 M1.75 12.75l1.75-5.5h11l-1.75 5.5z" />

const GLYPHS = {
  file: PAGE,
  text: (
    <>
      {PAGE}
      <path d="M5.5 8h5 M5.5 10.5h5 M5.5 13h2.5" strokeWidth={1} />
    </>
  ),
  document: (
    <>
      {PAGE}
      <path d="M5.25 9h5.5v3.25h-5.25z" strokeWidth={1} />
    </>
  ),
  markdown: (
    <>
      <path d="M1.75 3.25h12.5v9.5H1.75z" />
      <path d="M4 10.25V5.75l2 2.25 2-2.25v4.5 M11 5.75v4.5 M9.5 8.75l1.5 1.5 1.5-1.5" strokeWidth={1.1} />
    </>
  ),
  readme: <path d="M8 4.25C6.5 3 4.25 2.5 1.75 2.75v10c2.5-.25 4.75.25 6.25 1.5 1.5-1.25 3.75-1.75 6.25-1.5v-10C11.75 2.5 9.5 3 8 4.25z M8 4.25v10" />,
  license: <path d="M8 2v12 M4.75 13.75h6.5 M2.75 4.25h10.5 M2.75 4.25L1.25 9h3z M13.25 4.25L11.75 9h3z" />,
  json: <path d="M5.75 2.25c-1.5 0-2 .5-2 2v1.75c0 1.1-.6 1.9-1.5 2 .9.1 1.5.9 1.5 2v1.75c0 1.5.5 2 2 2 M10.25 2.25c1.5 0 2 .5 2 2v1.75c0 1.1.6 1.9 1.5 2-.9.1-1.5.9-1.5 2v1.75c0 1.5-.5 2-2 2" strokeLinecap="butt" />,
  config: <path d="M1.75 4.5h2.5 M6.75 4.5h7.5 M4.25 3h2.5v3h-2.5z M1.75 8h7.5 M11.75 8h2.5 M9.25 6.5h2.5v3h-2.5z M1.75 11.5h4 M8.25 11.5h6 M5.75 10h2.5v3h-2.5z" />,
  markup: <path d="M5.25 4.5L1.75 8l3.5 3.5 M10.75 4.5L14.25 8l-3.5 3.5 M9.25 2.75l-2.5 10.5" />,
  style: <path d="M6.25 2.25l-1.5 11.5 M11.25 2.25l-1.5 11.5 M2.25 5.75h11.5 M1.75 10.25h11.5" />,
  image: (
    <>
      <path d="M1.75 2.75h12.5v10.5H1.75z" />
      <path d="M1.75 11.5l3.75-4 3 3 1.75-1.75 4 4" />
      <path d="M10 4.75h1.75v1.75H10z" fill="currentColor" stroke="none" />
    </>
  ),
  vector: <path d="M3.25 11.25C3.25 6.5 12.75 9.5 12.75 4.75 M1.75 11.25h3v3h-3z M11.25 1.75h3v3h-3z" />,
  video: (
    <>
      <path d="M1.75 2.75h12.5v10.5H1.75z" />
      <path d="M6.5 5.5v5L10.5 8z" fill="currentColor" strokeWidth={0.75} />
    </>
  ),
  audio: (
    <>
      <path d="M6.25 12.25V3.25l7-1.5v9" />
      <path d="M3.25 10.75h3v3h-3z M10.25 9.25h3v3h-3z" fill="currentColor" stroke="none" />
    </>
  ),
  table: <path d="M1.75 2.75h12.5v10.5H1.75z M1.75 6.25h12.5 M1.75 9.75h12.5 M6.25 2.75v10.5" />,
  archive: (
    <>
      <path d="M2.75 1.75h10.5v12.5H2.75z" />
      <path d="M8 1.75v1.5 M8 4.5V6 M8 7.25v1.5" />
      <path d="M6.75 9.75h2.5v2.5h-2.5z" />
    </>
  ),
  lock: <path d="M4.75 7V4.75a3.25 3.25 0 0 1 6.5 0V7 M2.75 7h10.5v7.25H2.75z M8 9.5v2.25" />,
  key: <path d="M1.75 9.75h4.5v4.5h-4.5z M6.25 9.75l7.5-7.5 M11.25 4.75l1.75 1.75 M9.25 6.75l1.5 1.5" />,
  git: (
    <>
      <path d="M5 4.25v7.5 M11 6.25c0 3.25-6 2-6 5.5" />
      <path d="M3.75 1.75h2.5v2.5h-2.5z M3.75 11.75h2.5v2.5h-2.5z M9.75 3.75h2.5v2.5h-2.5z" fill="currentColor" stroke="none" />
    </>
  ),
  terminal: (
    <>
      <path d="M1.75 2.75h12.5v10.5H1.75z" />
      <path d="M4.25 6l2 2-2 2 M8 10.25h3.75" />
    </>
  ),
  database: <path d="M2.75 4c0-1.25 2.35-2.25 5.25-2.25S13.25 2.75 13.25 4v8c0 1.25-2.35 2.25-5.25 2.25S2.75 13.25 2.75 12z M2.75 4c0 1.25 2.35 2.25 5.25 2.25S13.25 5.25 13.25 4 M2.75 8c0 1.25 2.35 2.25 5.25 2.25S13.25 9.25 13.25 8" />,
  package: <path d="M8 1.5l6.25 3.25v6.5L8 14.5l-6.25-3.25v-6.5z M1.75 4.75L8 8l6.25-3.25 M8 8v6.5" />,
  test: <path d="M5.75 1.75h4.5 M6.75 1.75v4.5l-4.25 8h11l-4.25-8v-4.5 M4.5 10.5h7" />,
  font: (
    <text x="8" y="12" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="var(--font-sans)" fontWeight={530} fontSize={9.5} letterSpacing={-0.4}>
      Aa
    </text>
  ),
  notebook: <path d="M3.25 1.75h10v12.5h-10z M5.75 1.75v12.5 M8 5h3 M8 7.5h3 M1.75 4.25h3 M1.75 8h3 M1.75 11.75h3" />,
  diff: <path d="M8 2.25v6 M5 5.25h6 M5 12h6" />,
  log: <path d="M1.75 3.75h12.5 M1.75 6.75h12.5 M1.75 9.75h9 M1.75 12.75h6" />,
  binary: <path d="M4.25 4.25h7.5v7.5h-7.5z M6.25 1.75v2.5 M9.75 1.75v2.5 M6.25 11.75v2.5 M9.75 11.75v2.5 M1.75 6.25h2.5 M1.75 9.75h2.5 M11.75 6.25h2.5 M11.75 9.75h2.5" />,
  profile: <path d="M1.75 8.5h3l1.75-5 3 9.5 1.75-4.5h3" />,
  container: <path d="M1.75 7.25h12.5v6.5H1.75z M3.25 3.75h2.75v3.5H3.25z M6.6 3.75h2.75v3.5H6.6z M9.95 3.75h2.75v3.5H9.95z" />,
} satisfies Record<GlyphName, ReactNode>
