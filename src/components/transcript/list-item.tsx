import { useContext, type ComponentProps, type CSSProperties } from "react"
import type { ExtraProps } from "react-markdown"
import { inlineFileSpellings, type InlineFileSpelling } from "@/lib/inline-file-links"
import { FilePreviewCollection } from "./attachment-collection"
import { useResolvedPreviews } from "./use-resolved-previews"
import { ProseListDepthContext } from "./prose-layout-context"

/** A list item's previews, resolved by the host as a paragraph's are. */
function ListItemPreviews({ spellings }: { spellings: InlineFileSpelling[] }) {
  const paths = useResolvedPreviews(spellings)
  return paths?.length ? <FilePreviewCollection paths={paths} /> : null
}

/** Tight Markdown lists have no paragraph; they use the same file discovery. */
export function ListItem({
  node,
  children,
  ...props
}: ComponentProps<"li"> & ExtraProps) {
  const depth = useContext(ProseListDepthContext) + 1
  const spellings = inlineFileSpellings(node)
  const style: CSSProperties & { "--inline-file-inset": string } = {
    ...props.style,
    "--inline-file-inset": `calc(var(--text-prose) * ${depth * 1.35})`,
  }
  return (
    <ProseListDepthContext value={depth}>
    <li {...props} style={style}>
      {children}
      {spellings.length ? <ListItemPreviews spellings={spellings} /> : null}
    </li>
    </ProseListDepthContext>
  )
}
