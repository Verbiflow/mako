import {
  createElement as h,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
export { useState, useEffect, useMemo, useCallback, useRef } from "react"

type Content = { children?: ReactNode; style?: CSSProperties }
type Align = "start" | "center" | "end" | "stretch"
export function Stack({
  children,
  gap = 12,
  style,
}: Content & { gap?: number }) {
  return h(
    "div",
    { style: { display: "flex", flexDirection: "column", gap, ...style } },
    children
  )
}
export function Row({
  children,
  gap = 8,
  align = "center",
  justify = "start",
  wrap,
  style,
}: Content & {
  gap?: number
  align?: Align
  justify?: "start" | "center" | "end" | "space-between"
  wrap?: boolean
}) {
  return h(
    "div",
    {
      style: {
        display: "flex",
        gap,
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? "wrap" : undefined,
        ...style,
      },
    },
    children
  )
}
export function Grid({
  children,
  columns,
  gap = 12,
  style,
}: Content & { columns: number | string; gap?: number }) {
  return h(
    "div",
    {
      className: "canvas-grid",
      style: {
        display: "grid",
        gridTemplateColumns: Number.isInteger(columns)
          ? `repeat(${columns}, minmax(0, 1fr))`
          : String(columns),
        gap,
        ...style,
      },
    },
    children
  )
}
export function Divider({ style }: { style?: CSSProperties }) {
  return h("hr", { style })
}
export function Spacer() {
  return h("span", { style: { flex: 1 } })
}
export function H1({ children, style }: Content) {
  return h("h1", { style }, children)
}
export function H2({ children, style }: Content) {
  return h("h2", { style }, children)
}
export function H3({ children, style }: Content) {
  return h("h3", { style }, children)
}
export function Text({
  children,
  as = "p",
  style,
  tone,
  size,
  weight,
}: Content & {
  as?: "p" | "span" | "div"
  tone?: string
  size?: string
  weight?: string
}) {
  return h(
    as,
    {
      className: "canvas-text",
      "data-tone": tone,
      "data-size": size,
      "data-weight": weight,
      style,
    },
    children
  )
}
export function Code({ children, style }: Content) {
  return h("code", { style }, children)
}
export function Card({
  children,
  style,
  collapsible,
  defaultOpen = true,
}: Content & {
  collapsible?: boolean
  defaultOpen?: boolean
  size?: string
  variant?: string
}) {
  return collapsible
    ? h(
        "details",
        { className: "canvas-card", style, open: defaultOpen },
        h("summary", null, "Details"),
        children
      )
    : h("section", { className: "canvas-card", style }, children)
}
export function CardHeader({
  children,
  trailing,
  style,
}: Content & { trailing?: ReactNode }) {
  return h(
    "div",
    { className: "canvas-card-header", style },
    h("strong", null, children),
    trailing
  )
}
export function CardBody({ children, style }: Content) {
  return h("div", { className: "canvas-card-body", style }, children)
}
export function Button({
  children,
  onClick,
  disabled,
  style,
  variant,
}: Content & { onClick?: () => void; disabled?: boolean; variant?: string }) {
  return h(
    "button",
    {
      type: "button",
      className: "pressable",
      onClick,
      disabled,
      style,
      "data-variant": variant,
    },
    children
  )
}
export function Pill({
  children,
  onClick,
  disabled,
  style,
  active,
  title,
  leadingContent,
}: Content & {
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  title?: string
  leadingContent?: ReactNode
  size?: string
}) {
  return h(
    onClick ? "button" : "span",
    {
      type: onClick ? "button" : undefined,
      className: "canvas-pill pressable",
      onClick,
      disabled,
      style,
      title,
      "aria-pressed": onClick ? Boolean(active) : undefined,
      "data-active": active,
    },
    leadingContent,
    children
  )
}
export function Callout({
  children,
  title,
  tone,
  style,
}: Content & { title?: string; tone?: string }) {
  return h(
    "aside",
    { className: "canvas-callout", "data-tone": tone, style },
    title ? h("strong", null, title) : null,
    h("div", null, children)
  )
}
export function Link({ children, href, style }: Content & { href: string }) {
  return h(
    "button",
    {
      type: "button",
      className: "canvas-link pressable",
      title: href,
      style,
      onClick: () => showAction(`Link: ${href}`),
    },
    children
  )
}
export function Table({
  headers,
  rows,
  columnAlign = [],
  style,
}: {
  headers: ReactNode[]
  rows: ReactNode[][]
  columnAlign?: ("left" | "center" | "right" | undefined)[]
  style?: CSSProperties
}) {
  return h(
    "div",
    {
      className: "canvas-table",
      tabIndex: 0,
      role: "region",
      "aria-label": "Table",
      style,
    },
    h(
      "table",
      null,
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          ...headers.map((header, index) =>
            h(
              "th",
              { key: index, style: { textAlign: columnAlign[index] } },
              header
            )
          )
        )
      ),
      h(
        "tbody",
        null,
        ...rows.map((row, index) =>
          h(
            "tr",
            { key: index },
            ...headers.map((_, column) =>
              h(
                "td",
                { key: column, style: { textAlign: columnAlign[column] } },
                row[column]
              )
            )
          )
        )
      )
    )
  )
}
export function CollapsibleSection({
  children,
  title,
  defaultOpen = false,
  leading,
  trailing,
  count,
  style,
}: Content & {
  title: string
  defaultOpen?: boolean
  leading?: ReactNode
  trailing?: ReactNode
  count?: number
}) {
  return h(
    "details",
    { open: defaultOpen, style },
    h(
      "summary",
      null,
      leading,
      title,
      count === undefined ? null : ` (${count})`,
      trailing
    ),
    children
  )
}
export function mergeStyle(base: CSSProperties, override?: CSSProperties) {
  return { ...base, ...override }
}

/** Interaction state lasts for this mounted preview; the provider's files remain unchanged. */
export function useCanvasState<T>(_key: string, initial: T) {
  return useState(initial)
}

let notice = ""
const noticeListeners = new Set<() => void>()
function showAction(text: string) {
  notice = text
  noticeListeners.forEach((listener) => listener())
}
function subscribeNotice(listener: () => void) {
  noticeListeners.add(listener)
  return () => noticeListeners.delete(listener)
}
export function useCanvasAction() {
  return (action: { type: string; path?: string; url?: string }) =>
    showAction(
      `${action.path ?? action.url ?? action.type} — open this from the workspace or your browser. This preview has no access to the source app's actions.`
    )
}
export function CanvasNotice() {
  const text = useSyncExternalStore(subscribeNotice, () => notice)
  return text
    ? h("p", { className: "canvas-notice", role: "status" }, text)
    : null
}
