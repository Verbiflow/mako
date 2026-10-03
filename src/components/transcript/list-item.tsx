import { useContext, type ComponentProps, type CSSProperties } from "react"
import type { ExtraProps } from "react-markdown"
import { inlineFileLinks } from "@/lib/inline-file-links"
import { InlineFilePreview } from "./file-preview"
import { ProseListDepthContext } from "./prose-layout-context"

/** Tight Markdown lists have no paragraph; they use the same file discovery. */
export function ListItem({
  node,
  children,
  ...props
}: ComponentProps<"li"> & ExtraProps) {
  const depth = useContext(ProseListDepthContext) + 1
  const style: CSSProperties & { "--inline-file-inset": string } = {
    ...props.style,
    "--inline-file-inset": `calc(var(--text-prose) * ${depth * 1.35})`,
  }
  return (
    <ProseListDepthContext value={depth}>
    <li {...props} style={style}>
      {children}
      {inlineFileLinks(node).map((path) => (
        <InlineFilePreview
          key={path}
          path={path}
          name={path.split("/").at(-1) ?? path}
        />
      ))}
    </li>
    </ProseListDepthContext>
  )
}
