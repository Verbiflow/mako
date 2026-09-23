import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

export default defineConfig([
  // `ignore/` holds full reference monorepos; linting them costs minutes.
  globalIgnores([
    "**/.eve/**",
    "**/.next/**",
    "**/.output/**",
    "**/.vercel/**",
    "dist",
    "dist-electron",
    "dist-browser-extension",
    "ignore",
    "node_modules",
  ]),
  {
    files: ["src/**/*.{ts,tsx}", "electron/**/*.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["browser-extension/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser, chrome: "readonly" } },
  },
  {
    files: ["packages/backend/**/*.{ts,tsx}", "packages/control-runtime/src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/desk/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/bridge"],
              message:
                "Presentation cannot call the host transport; add the operation to its owning state domain.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["electron/providers/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../harnesses.js",
                "../../harnesses.js",
                "../drivers.js",
                "../../drivers.js",
                "../mcp-registry.js",
                "../../mcp-registry.js",
                "../skill-registry.js",
                "../../skill-registry.js",
              ],
              message:
                "Provider capabilities cannot import their consumers; move shared mechanics under electron/providers/.",
            },
          ],
        },
      ],
    },
  },
  {
    // Design-token guards: hue is spent only through the semantic tokens
    // (positive/negative/caution, diff add/remove), never as a raw Tailwind
    // palette class. provider-icon.tsx draws brand marks, which are logos,
    // not UI color.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/provider-icon.tsx"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/(?:text|bg|ring|border|from|to|via)-(?:red|emerald|amber|green|blue|orange|yellow|rose|sky|violet|indigo|teal|lime|cyan|fuchsia|pink)-[0-9]/]",
          message:
            "Raw Tailwind hue classes are banned; use the semantic tokens (positive, negative, caution, added, removed).",
        },
        {
          selector: "Literal[value=/(?:bg|text|ring|border)-brand/]",
          message:
            "The brand tokens were deleted; use primary, foreground, ember, or the fill tokens.",
        },
        {
          selector: "Literal[value=/text-\\[[0-9.]+px\\]/]",
          message:
            "Literal pixel type sizes are banned; use the scale (text-label, text-ui, text-title) or prose/code styles.",
        },
      ],
    },
  },
])
