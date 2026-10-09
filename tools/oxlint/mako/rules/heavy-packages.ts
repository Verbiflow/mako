import { readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { defineRule } from "@oxlint/plugins";

const CHECKED = [/^electron\//, /^packages\/[^/]+\/src\//];

interface Manifest {
  packages: string[];
  declarations: string[];
  adapters: Record<string, { uses: string; loadedBy: string[] }>;
}

let manifest: Manifest | undefined;

/** scripts/heavy-packages.json, which the host's start-set check reads too. */
function heavyPackages(): Manifest {
  manifest ??= JSON.parse(readFileSync(join(process.cwd(), "scripts", "heavy-packages.json"), "utf8")) as Manifest;
  return manifest;
}

/** A listed name ending in `/` stands for every package of that scope; any other covers the package and its subpaths. */
function heavyPackage(specifier: string): boolean {
  return heavyPackages().packages.some((name) =>
    name.endsWith("/") ? specifier.startsWith(name) : specifier === name || specifier.startsWith(`${name}/`));
}

/** The repository file a relative specifier names, as `.ts` source. */
function sourceOf(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  return posix.normalize(posix.join(posix.dirname(file), specifier)).replace(/\.js$/, ".ts");
}

/**
 * Keeps each heavy package behind its one declaration, so no process pays to
 * load a package before something uses it, and every load is recorded with
 * what needed it and how long it took.
 *
 * A heavy package is loaded only through `lazyPackage` in a declaration file
 * (electron/heavy-packages.ts, packages/control-runtime/src/heavy-packages.ts).
 * Modules built around a heavy package, adapters, may import it at the top,
 * and are themselves loaded only by the files their entry lists. Elsewhere a
 * heavy package's types are imported with `import type`.
 */
export const heavyPackagesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Load heavy packages, and the adapters built on them, only through their lazy declaration.",
    },
    messages: {
      value:
        "`{{name}}` is a heavy package: load it where it's used with `await heavy.<package>.load(reason)` from {{declarations}}, and import only its types here (`import type`). A module built around it is an adapter: list it in scripts/heavy-packages.json and load it through a declaration.",
      dynamic:
        "Load `{{name}}` through its declaration in {{declarations}} (`await heavy.<package>.load(reason)`), so the load is recorded with what needed it. Declare it there if it isn't yet.",
      adapter:
        "{{adapter}} imports {{uses}} at its top, so loading it here loads that too. Load it through its declaration (`await heavy.<adapter>.load(reason)`), or add this file to its `loadedBy` in scripts/heavy-packages.json if this file is itself loaded lazily.",
      declaration:
        "A declaration loads `{{name}}` with `import()` inside `lazyPackage`, never at its top, or every importer of `heavy` would load it.",
    },
  },
  createOnce(context) {
    let file = "";
    /** What's wrong with this file loading `specifier`, at its top or with `import()`. */
    const problem = (specifier: string, kind: "static" | "dynamic") => {
      const { declarations, adapters } = heavyPackages();
      const declaration = declarations.includes(file);
      const list = declarations.join(" or ");
      if (heavyPackage(specifier)) {
        if (kind === "dynamic") return declaration ? undefined : { messageId: "dynamic", data: { name: specifier, declarations: list } } as const;
        if (declaration) return { messageId: "declaration", data: { name: specifier } } as const;
        return adapters[file] ? undefined : { messageId: "value", data: { name: specifier, declarations: list } } as const;
      }
      const target = sourceOf(file, specifier);
      const adapter = target === undefined ? undefined : adapters[target];
      if (!target || !adapter) return undefined;
      if (declaration && kind === "static") return { messageId: "declaration", data: { name: target } } as const;
      return adapter.loadedBy.includes(file) ? undefined : { messageId: "adapter", data: { adapter: target, uses: adapter.uses } } as const;
    };
    return {
      before() {
        file = relative(process.cwd(), context.filename).split(sep).join("/");
        return CHECKED.some((pattern) => pattern.test(file)) && !dirname(file).includes("/test");
      },
      ImportDeclaration(node) {
        const found = node.importKind === "type" ? undefined : problem(node.source.value, "static");
        if (found) context.report({ node, ...found });
      },
      ExportNamedDeclaration(node) {
        const found = !node.source || node.exportKind === "type" ? undefined : problem(node.source.value, "static");
        if (found) context.report({ node, ...found });
      },
      ExportAllDeclaration(node) {
        const found = node.exportKind === "type" ? undefined : problem(node.source.value, "static");
        if (found) context.report({ node, ...found });
      },
      ImportExpression(node) {
        const found = node.source.type === "Literal" && typeof node.source.value === "string" ? problem(node.source.value, "dynamic") : undefined;
        if (found) context.report({ node, ...found });
      },
    };
  },
});
