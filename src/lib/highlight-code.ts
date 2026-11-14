import { codeToTokens, bundledLanguages, type BundledLanguage } from "shiki"
import { syntaxTheme } from "@/lib/syntax-theme"

/** The file viewer's theme; code blocks sit on the raised plane, so their ground is that. */
const theme = { ...syntaxTheme("mako"), bg: "var(--shiki-background)" }

function supportedLanguage(language: string): language is BundledLanguage {
  return Object.hasOwn(bundledLanguages, language)
}

export async function highlightCode(source: string, language: string) {
  return (
    await codeToTokens(source, {
      lang: supportedLanguage(language) ? language : "text",
      theme,
    })
  ).tokens
}
