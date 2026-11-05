import { diagnosticFormat, filePreviewFormat, type FilePreviewFormat } from "@mako/host/contracts/file-preview"

/**
 * What a file is, from its name: the glyph it wears in every list and the language its source is highlighted as.
 *
 * Names first (a `Dockerfile`, a `package.json`, a `.env`), then compound endings (`.d.ts`, `.test.tsx`), then the
 * extension. A language here overrides the renderer's own guess where that guess is wrong for code people keep in a
 * repository (`.m` is Objective-C, not Wolfram; `.pl` is Perl; a shell's rc file is shell).
 */

/** The glyphs, each drawn by `FileGlyph`. A two- or three-letter monogram is a language with no shape of its own. */
export type FileGlyph =
  | { kind: "glyph"; name: GlyphName }
  | { kind: "letters"; text: string }

export type GlyphName =
  | "file"
  | "text"
  | "document"
  | "markdown"
  | "readme"
  | "license"
  | "json"
  | "config"
  | "markup"
  | "style"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "table"
  | "archive"
  | "lock"
  | "key"
  | "git"
  | "terminal"
  | "database"
  | "package"
  | "test"
  | "font"
  | "notebook"
  | "diff"
  | "log"
  | "binary"
  | "container"
  | "profile"

export interface FileKind {
  glyph: FileGlyph
  /** What it is, in words: `TypeScript`, `Image`. */
  label: string
  /** The highlighter's language when the renderer's own guess is wrong or missing. */
  language?: string
}

const glyph = (name: GlyphName, label: string, language?: string): FileKind => ({ glyph: { kind: "glyph", name }, label, ...(language && { language }) })
const letters = (text: string, label: string, language?: string): FileKind => ({ glyph: { kind: "letters", text }, label, ...(language && { language }) })

const BY_NAME: ReadonlyMap<string, FileKind> = new Map([
  ["package.json", glyph("package", "Package manifest", "json")],
  ["package-lock.json", glyph("lock", "Lockfile", "json")],
  ["yarn.lock", glyph("lock", "Lockfile", "yaml")],
  ["pnpm-lock.yaml", glyph("lock", "Lockfile", "yaml")],
  ["bun.lockb", glyph("lock", "Lockfile")],
  ["bun.lock", glyph("lock", "Lockfile", "jsonc")],
  ["cargo.lock", glyph("lock", "Lockfile", "toml")],
  ["gemfile.lock", glyph("lock", "Lockfile")],
  ["poetry.lock", glyph("lock", "Lockfile", "toml")],
  ["uv.lock", glyph("lock", "Lockfile", "toml")],
  ["composer.lock", glyph("lock", "Lockfile", "json")],
  ["go.sum", glyph("lock", "Checksums")],
  ["flake.lock", glyph("lock", "Lockfile", "json")],
  ["cargo.toml", glyph("package", "Package manifest", "toml")],
  ["go.mod", glyph("package", "Go module", "go")],
  ["pyproject.toml", glyph("package", "Package manifest", "toml")],
  ["requirements.txt", glyph("package", "Requirements")],
  ["gemfile", glyph("package", "Gemfile", "ruby")],
  ["podfile", glyph("package", "Podfile", "ruby")],
  ["composer.json", glyph("package", "Package manifest", "json")],
  ["pubspec.yaml", glyph("package", "Package manifest", "yaml")],
  ["package.swift", glyph("package", "Swift package", "swift")],
  ["dockerfile", glyph("container", "Dockerfile", "dockerfile")],
  ["containerfile", glyph("container", "Containerfile", "dockerfile")],
  ["docker-compose.yml", glyph("container", "Compose file", "yaml")],
  ["docker-compose.yaml", glyph("container", "Compose file", "yaml")],
  ["compose.yml", glyph("container", "Compose file", "yaml")],
  ["compose.yaml", glyph("container", "Compose file", "yaml")],
  ["makefile", glyph("terminal", "Makefile", "makefile")],
  ["justfile", glyph("terminal", "Justfile", "just")],
  ["procfile", glyph("terminal", "Procfile", "shellscript")],
  ["rakefile", glyph("terminal", "Rakefile", "ruby")],
  ["license", glyph("license", "License")],
  ["licence", glyph("license", "License")],
  ["copying", glyph("license", "License")],
  ["notice", glyph("license", "Notice")],
  [".gitignore", glyph("git", "Git ignore rules", "shellscript")],
  [".gitattributes", glyph("git", "Git attributes")],
  [".gitmodules", glyph("git", "Git submodules", "ini")],
  [".gitkeep", glyph("git", "Placeholder")],
  [".mailmap", glyph("git", "Git mailmap")],
  [".editorconfig", glyph("config", "Editor settings", "ini")],
  [".npmrc", glyph("config", "npm settings", "ini")],
  [".nvmrc", glyph("config", "Node version")],
  [".node-version", glyph("config", "Node version")],
  [".tool-versions", glyph("config", "Tool versions")],
  [".prettierrc", glyph("config", "Prettier settings", "json")],
  [".eslintrc", glyph("config", "ESLint settings", "json")],
  [".babelrc", glyph("config", "Babel settings", "json")],
  [".zshrc", glyph("terminal", "Shell settings", "shellscript")],
  [".bashrc", glyph("terminal", "Shell settings", "shellscript")],
  [".bash_profile", glyph("terminal", "Shell settings", "shellscript")],
  [".profile", glyph("terminal", "Shell settings", "shellscript")],
  [".zprofile", glyph("terminal", "Shell settings", "shellscript")],
  ["tsconfig.json", glyph("config", "TypeScript settings", "jsonc")],
  ["jsconfig.json", glyph("config", "JavaScript settings", "jsonc")],
])

const BY_EXTENSION: ReadonlyMap<string, FileKind> = new Map([
  ["ts", letters("TS", "TypeScript", "typescript")],
  ["mts", letters("TS", "TypeScript", "typescript")],
  ["cts", letters("TS", "TypeScript", "typescript")],
  ["tsx", letters("TSX", "TypeScript JSX", "tsx")],
  ["js", letters("JS", "JavaScript", "javascript")],
  ["mjs", letters("JS", "JavaScript", "javascript")],
  ["cjs", letters("JS", "JavaScript", "javascript")],
  ["jsx", letters("JSX", "JavaScript JSX", "jsx")],
  ["py", letters("PY", "Python", "python")],
  ["pyi", letters("PY", "Python stub", "python")],
  ["rs", letters("RS", "Rust", "rust")],
  ["go", letters("GO", "Go", "go")],
  ["rb", letters("RB", "Ruby", "ruby")],
  ["gemspec", glyph("package", "Gem specification", "ruby")],
  ["java", letters("JV", "Java", "java")],
  ["kt", letters("KT", "Kotlin", "kotlin")],
  ["kts", letters("KT", "Kotlin script", "kotlin")],
  ["swift", letters("SW", "Swift", "swift")],
  ["m", letters("M", "Objective-C", "objective-c")],
  ["mm", letters("MM", "Objective-C++", "objective-cpp")],
  ["c", letters("C", "C", "c")],
  ["h", letters("H", "C header", "c")],
  ["cc", letters("C++", "C++", "cpp")],
  ["cpp", letters("C++", "C++", "cpp")],
  ["cxx", letters("C++", "C++", "cpp")],
  ["hpp", letters("H++", "C++ header", "cpp")],
  ["hh", letters("H++", "C++ header", "cpp")],
  ["cs", letters("C#", "C#", "csharp")],
  ["fs", letters("F#", "F#", "fsharp")],
  ["php", letters("PHP", "PHP", "php")],
  ["lua", letters("LUA", "Lua", "lua")],
  ["dart", letters("DA", "Dart", "dart")],
  ["scala", letters("SC", "Scala", "scala")],
  ["ex", letters("EX", "Elixir", "elixir")],
  ["exs", letters("EX", "Elixir script", "elixir")],
  ["erl", letters("ERL", "Erlang", "erlang")],
  ["hs", letters("HS", "Haskell", "haskell")],
  ["ml", letters("ML", "OCaml", "ocaml")],
  ["clj", letters("CLJ", "Clojure", "clojure")],
  ["zig", letters("ZIG", "Zig", "zig")],
  ["nim", letters("NIM", "Nim", "nim")],
  ["jl", letters("JL", "Julia", "julia")],
  ["r", letters("R", "R", "r")],
  ["pl", letters("PL", "Perl", "perl")],
  ["pm", letters("PL", "Perl module", "perl")],
  ["groovy", letters("GR", "Groovy", "groovy")],
  ["gradle", letters("GR", "Gradle build", "groovy")],
  ["vue", letters("VUE", "Vue", "vue")],
  ["svelte", letters("SV", "Svelte", "svelte")],
  ["astro", letters("AS", "Astro", "astro")],
  ["graphql", letters("GQL", "GraphQL", "graphql")],
  ["gql", letters("GQL", "GraphQL", "graphql")],
  ["proto", letters("PB", "Protocol Buffers", "protobuf")],
  ["tf", letters("TF", "Terraform", "terraform")],
  ["hcl", letters("HCL", "HCL", "hcl")],
  ["nix", letters("NIX", "Nix", "nix")],
  ["sol", letters("SOL", "Solidity", "solidity")],
  ["tex", letters("TEX", "TeX", "latex")],
  ["wgsl", letters("GPU", "WGSL shader", "wgsl")],
  ["glsl", letters("GPU", "GLSL shader", "glsl")],
  ["metal", letters("GPU", "Metal shader", "cpp")],
  ["prisma", glyph("database", "Prisma schema", "prisma")],
  ["sql", glyph("database", "SQL", "sql")],
  ["sqlite", glyph("database", "SQLite database")],
  ["db", glyph("database", "Database")],
  ["json", glyph("json", "JSON", "json")],
  ["jsonc", glyph("json", "JSON with comments", "jsonc")],
  ["json5", glyph("json", "JSON5", "json5")],
  ["jsonl", glyph("json", "JSON lines", "json")],
  ["ndjson", glyph("json", "JSON lines", "json")],
  ["webmanifest", glyph("json", "Web manifest", "json")],
  ["tsbuildinfo", glyph("json", "Build info", "json")],
  ["yaml", glyph("config", "YAML", "yaml")],
  ["yml", glyph("config", "YAML", "yaml")],
  ["toml", glyph("config", "TOML", "toml")],
  ["ini", glyph("config", "INI", "ini")],
  ["cfg", glyph("config", "Settings", "ini")],
  ["conf", glyph("config", "Settings")],
  ["properties", glyph("config", "Properties", "properties")],
  ["xcconfig", glyph("config", "Xcode settings")],
  ["plist", glyph("config", "Property list", "xml")],
  ["entitlements", glyph("config", "Entitlements", "xml")],
  ["env", glyph("key", "Environment", "dotenv")],
  ["md", glyph("markdown", "Markdown", "markdown")],
  ["markdown", glyph("markdown", "Markdown", "markdown")],
  ["mdx", glyph("markdown", "MDX", "mdx")],
  ["mdc", glyph("markdown", "Markdown", "markdown")],
  ["rst", glyph("text", "reStructuredText", "rst")],
  ["txt", glyph("text", "Text")],
  ["log", glyph("log", "Log", "log")],
  ["html", glyph("markup", "HTML", "html")],
  ["htm", glyph("markup", "HTML", "html")],
  ["xml", glyph("markup", "XML", "xml")],
  ["xib", glyph("markup", "Interface", "xml")],
  ["storyboard", glyph("markup", "Storyboard", "xml")],
  ["css", glyph("style", "CSS", "css")],
  ["scss", glyph("style", "SCSS", "scss")],
  ["sass", glyph("style", "Sass", "sass")],
  ["less", glyph("style", "Less", "less")],
  ["styl", glyph("style", "Stylus", "stylus")],
  ["svg", glyph("vector", "SVG image", "xml")],
  ["png", glyph("image", "Image")],
  ["jpg", glyph("image", "Image")],
  ["jpeg", glyph("image", "Image")],
  ["gif", glyph("image", "Image")],
  ["webp", glyph("image", "Image")],
  ["avif", glyph("image", "Image")],
  ["heic", glyph("image", "Image")],
  ["bmp", glyph("image", "Image")],
  ["tiff", glyph("image", "Image")],
  ["ico", glyph("image", "Icon")],
  ["icns", glyph("image", "Icon")],
  ["psd", glyph("image", "Image")],
  ["mp4", glyph("video", "Video")],
  ["mov", glyph("video", "Video")],
  ["webm", glyph("video", "Video")],
  ["mkv", glyph("video", "Video")],
  ["avi", glyph("video", "Video")],
  ["mp3", glyph("audio", "Audio")],
  ["wav", glyph("audio", "Audio")],
  ["m4a", glyph("audio", "Audio")],
  ["aac", glyph("audio", "Audio")],
  ["flac", glyph("audio", "Audio")],
  ["ogg", glyph("audio", "Audio")],
  ["aiff", glyph("audio", "Audio")],
  ["pdf", glyph("document", "PDF")],
  ["doc", glyph("document", "Document")],
  ["docx", glyph("document", "Document")],
  ["pages", glyph("document", "Document")],
  ["rtf", glyph("document", "Rich text")],
  ["odt", glyph("document", "Document")],
  ["key", glyph("document", "Presentation")],
  ["ppt", glyph("document", "Presentation")],
  ["pptx", glyph("document", "Presentation")],
  ["csv", glyph("table", "CSV", "csv")],
  ["tsv", glyph("table", "TSV", "tsv")],
  ["xls", glyph("table", "Spreadsheet")],
  ["xlsx", glyph("table", "Spreadsheet")],
  ["numbers", glyph("table", "Spreadsheet")],
  ["parquet", glyph("table", "Parquet")],
  ["zip", glyph("archive", "Archive")],
  ["tar", glyph("archive", "Archive")],
  ["gz", glyph("archive", "Archive")],
  ["tgz", glyph("archive", "Archive")],
  ["bz2", glyph("archive", "Archive")],
  ["xz", glyph("archive", "Archive")],
  ["zst", glyph("archive", "Archive")],
  ["7z", glyph("archive", "Archive")],
  ["rar", glyph("archive", "Archive")],
  ["dmg", glyph("archive", "Disk image")],
  ["jar", glyph("archive", "Java archive")],
  ["lock", glyph("lock", "Lockfile")],
  ["pem", glyph("key", "Certificate or key")],
  ["crt", glyph("key", "Certificate")],
  ["cer", glyph("key", "Certificate")],
  ["p12", glyph("key", "Certificate")],
  ["pub", glyph("key", "Public key")],
  ["sh", glyph("terminal", "Shell script", "shellscript")],
  ["bash", glyph("terminal", "Shell script", "shellscript")],
  ["zsh", glyph("terminal", "Shell script", "shellscript")],
  ["fish", glyph("terminal", "Fish script", "fish")],
  ["ps1", glyph("terminal", "PowerShell", "powershell")],
  ["bat", glyph("terminal", "Batch file", "bat")],
  ["cmd", glyph("terminal", "Batch file", "bat")],
  ["command", glyph("terminal", "Shell script", "shellscript")],
  ["ttf", glyph("font", "Font")],
  ["otf", glyph("font", "Font")],
  ["woff", glyph("font", "Font")],
  ["woff2", glyph("font", "Font")],
  ["ipynb", glyph("notebook", "Notebook", "json")],
  ["diff", glyph("diff", "Diff", "diff")],
  ["patch", glyph("diff", "Patch", "diff")],
  ["wasm", glyph("binary", "WebAssembly")],
  ["exe", glyph("binary", "Program")],
  ["dll", glyph("binary", "Library")],
  ["so", glyph("binary", "Library")],
  ["dylib", glyph("binary", "Library")],
  ["a", glyph("binary", "Library")],
  ["o", glyph("binary", "Object file")],
  ["node", glyph("binary", "Native module")],
  ["bin", glyph("binary", "Binary")],
])

const FILE = glyph("file", "File")

/** A file's kind from its path or name. */
export function fileKind(path: string): FileKind {
  const name = (path.slice(path.lastIndexOf("/") + 1) || path).toLowerCase()
  const named = BY_NAME.get(name)
  if (named) return named
  if (name.startsWith(".env")) return glyph("key", "Environment", "dotenv")
  if (/^readme(\.|$)/.test(name)) return { ...glyph("readme", "Read me"), ...(name.endsWith(".md") && { language: "markdown" }) }
  if (/^(license|licence|copying)(\.|$)/.test(name)) return glyph("license", "License")
  if (/^(changelog|changes|history|authors|contributors)(\.|$)/.test(name)) return name.endsWith(".md") ? glyph("markdown", "Markdown", "markdown") : glyph("text", "Text")
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) || /(^|_)test\.(go|py)$|^test_.*\.py$/.test(name)) {
    const extension = name.slice(name.lastIndexOf(".") + 1)
    return { ...glyph("test", "Test"), ...(BY_EXTENSION.get(extension)?.language && { language: BY_EXTENSION.get(extension)!.language }) }
  }
  if (name.endsWith(".d.ts") || name.endsWith(".d.mts") || name.endsWith(".d.cts")) return letters("DTS", "Type declarations", "typescript")
  if (/^\.(eslintrc|prettierrc|stylelintrc|babelrc|swcrc)\./.test(name) || /^(eslint|prettier|vite|vitest|tailwind|postcss|webpack|rollup|babel|jest|next|nuxt|svelte|astro|drizzle|playwright)\.config\./.test(name)) {
    const extension = name.slice(name.lastIndexOf(".") + 1)
    const language = BY_EXTENSION.get(extension)?.language
    return language === "typescript" || language === "javascript" ? letters(language === "typescript" ? "TS" : "JS", "Settings", language) : glyph("config", "Settings", language)
  }
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return FILE
  return BY_EXTENSION.get(name.slice(dot + 1)) ?? FILE
}

/** The renderer's language for a file whose own guess this table overrides, or undefined to let it guess. */
export function fileLanguage(path: string): string | undefined {
  return fileKind(path).language
}

/** What a preview format looks like, for a file its name doesn't place (an attachment named by its type alone). */
const BY_FORMAT = {
  image: "image",
  video: "video",
  audio: "audio",
  pdf: "document",
  word: "document",
  workbook: "table",
  presentation: "document",
  markdown: "markdown",
  html: "markup",
  table: "table",
  text: "text",
  har: "profile",
  "cpu-profile": "profile",
  "heap-profile": "profile",
  "heap-snapshot": "profile",
  trace: "profile",
} satisfies Record<FilePreviewFormat, GlyphName>

/** A file's mark, as `FileIcon` draws it: a diagnostic recording's by its format, else its kind's, else what its type says it holds. */
export function fileGlyph(path: string, mimeType?: string): FileGlyph {
  const diagnostic = diagnosticFormat(path)
  if (diagnostic) return { kind: "glyph", name: BY_FORMAT[diagnostic] }
  const kind = fileKind(path)
  if (kind.glyph.kind === "letters" || kind.glyph.name !== "file") return kind.glyph
  // A type that says nothing (application/octet-stream) leaves the name to say it, as `filePreviewFormat` alone would.
  const format = filePreviewFormat(path, mimeType) ?? filePreviewFormat(path)
  return format ? { kind: "glyph", name: BY_FORMAT[format] } : kind.glyph
}
