/**
 * The one highlighting theme: TextMate scopes onto the `--syntax-*` tokens in index.css, so files, diffs and the
 * transcript's code blocks read alike in light and dark, and a theme change is a CSS change.
 *
 * Rules listed later win over earlier ones for a scope they share, and a more specific scope wins over a shorter one
 * (`keyword.operator` over `keyword`), as in any TextMate theme.
 */

type SyntaxToken = "text" | "keyword" | "function" | "type" | "string" | "constant" | "property" | "parameter" | "tag" | "punctuation" | "comment"

const rules: Array<{ scope: string[]; token?: SyntaxToken; fontStyle?: "italic" | "bold" | "underline" }> = [
  { scope: ["source", "text", "variable", "meta.embedded", "variable.other.readwrite"], token: "text" },
  { scope: ["comment", "punctuation.definition.comment", "string.quoted.docstring", "comment.block.documentation"], token: "comment", fontStyle: "italic" },
  { scope: ["string", "string.quoted", "string.template", "string.unquoted", "markup.inline.raw", "markup.fenced_code", "markup.raw", "punctuation.definition.string"], token: "string" },
  { scope: ["string.regexp", "constant.character.escape", "constant.other.character-class", "constant.character"], token: "constant" },
  { scope: ["constant.numeric", "constant.language", "constant.other", "variable.other.constant", "variable.other.enummember", "support.constant", "keyword.other.unit", "constant.other.color", "support.constant.property-value"], token: "constant" },
  { scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.typeof", "keyword.operator.instanceof", "keyword.other", "variable.language", "support.type.primitive", "keyword.type"], token: "keyword" },
  { scope: ["keyword.operator", "punctuation", "meta.brace", "punctuation.separator", "punctuation.terminator", "punctuation.accessor", "punctuation.definition.tag", "meta.tag.sgml", "keyword.operator.assignment"], token: "punctuation" },
  { scope: ["entity.name.function", "support.function", "variable.function", "meta.function-call entity.name.function", "entity.name.method", "support.function.builtin"], token: "function" },
  { scope: ["entity.name.type", "entity.name.class", "entity.name.struct", "entity.name.enum", "entity.name.interface", "entity.name.namespace", "entity.other.inherited-class", "support.type", "support.class", "entity.name.type.module", "entity.other.attribute-name.class.css", "entity.other.attribute-name.pseudo-class.css"], token: "type" },
  { scope: ["entity.name.tag", "support.class.component", "entity.name.tag.css", "entity.name.label"], token: "tag" },
  { scope: ["entity.other.attribute-name", "meta.object-literal.key", "support.type.property-name", "variable.other.property", "variable.other.object.property", "meta.property-name", "entity.name.tag.yaml", "support.type.property-name.json", "support.type.property-name.css", "variable.css", "variable.scss", "entity.name.variable.field"], token: "property" },
  { scope: ["variable.parameter", "meta.parameter", "variable.parameter.function"], token: "parameter" },
  { scope: ["entity.name.section", "markup.heading", "markup.heading entity.name"], token: "keyword", fontStyle: "bold" },
  { scope: ["markup.bold"], fontStyle: "bold" },
  { scope: ["markup.italic"], fontStyle: "italic" },
  { scope: ["markup.underline.link", "string.other.link", "markup.link"], token: "function", fontStyle: "underline" },
  { scope: ["markup.list punctuation.definition.list", "beginning.punctuation.definition.list.markdown", "markup.quote"], token: "comment" },
  { scope: ["meta.diff.header", "meta.diff.range"], token: "type" },
]

/** The theme's rules, its colours the CSS tokens. */
export const SYNTAX_TOKEN_COLORS = rules.map(({ scope, token, fontStyle }) => ({
  scope,
  settings: { ...(token && { foreground: `var(--syntax-${token})` }), ...(fontStyle && { fontStyle }) },
}))

/** A whole theme by name, for a highlighter that takes one. */
export function syntaxTheme(name: string) {
  return {
    name,
    type: "dark" as const,
    colors: { "editor.foreground": "var(--syntax-text)", "editor.background": "var(--surface)" },
    fg: "var(--syntax-text)",
    bg: "var(--surface)",
    tokenColors: [{ settings: { foreground: "var(--syntax-text)" } }, ...SYNTAX_TOKEN_COLORS],
  }
}
