import path from "node:path"
import { createRequire } from "node:module"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

const root = import.meta.dirname

/**
 * A desk served from a checkout wears the ember fin; the installed app keeps
 * the silver one. `npm run web` and the installed app are routinely open in
 * the same window, and in a tab strip they are the same six pixels otherwise.
 */
function developmentMark(): Plugin {
  return {
    name: "mako-development-mark",
    apply: "serve",
    transformIndexHtml: (html) =>
      html.replaceAll("/icons/favicon.", "/icons/favicon-dev."),
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), developmentMark()],
  resolve: {
    alias: {
      "@": path.resolve(root, "./src"),
      "decode-named-character-reference": createRequire(
        import.meta.url
      ).resolve("decode-named-character-reference"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ["**/ignore/**", "**/node_modules/**"],
    },
    fs: {
      deny: ["ignore"],
    },
  },
  optimizeDeps: {
    entries: ["index.html", "src/**/*.{ts,tsx}"],
  },
  // Desktop assets are read locally; gzip size reporting compresses every chunk
  // only to print a number and does not change the shipped files.
  build: { reportCompressedSize: false },
  base: "./",
})
