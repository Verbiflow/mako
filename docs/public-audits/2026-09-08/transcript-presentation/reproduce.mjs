import { build } from 'esbuild'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Renders the production components. Does not launch an agent or read user data.
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const temporary = await mkdtemp(join(root, 'node_modules/.presentation-audit-'))
try {
  const bundle = join(temporary, 'render.mjs')
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { Prose } from './src/components/transcript/markdown';
        import { TranscriptAttachment } from './src/components/transcript/attachment';
        import { codexPresentation } from './packages/sessions/src/providers/codex-presentation';
        export const prose = text => renderToStaticMarkup(createElement(Prose, {text}));
        export const codex = text => prose(codexPresentation(text));
        export const attachment = source => renderToStaticMarkup(createElement(TranscriptAttachment, {
          attachment: {type: 'attachment', name: 'proof.png', mimeType: 'image/png', source}
        }));
      `,
      resolveDir: root,
      loader: 'tsx',
    },
    bundle: true,
    platform: 'node',
    packages: 'external',
    format: 'esm',
    jsx: 'automatic',
    tsconfig: join(root, 'tsconfig.app.json'),
    outfile: bundle,
    logLevel: 'silent',
  })
  const render = await import(pathToFileURL(bundle).href)
  const cases = [
    ['absolute-file-link', render.prose('[source](/work/source.ts:12)')],
    ['local-markdown-image', render.prose('![proof](/work/proof.png)')],
    ['audio-markdown-embed', render.prose('![audio](/work/proof.mp3)')],
    ['local-image-attachment', render.attachment({kind: 'file', path: '/work/proof.png'})],
    ['inline-image-attachment', render.attachment({kind: 'inline', data: 'aW1hZ2U='})],
    ['cursor-code-citation', render.prose('```12:18:src/example.ts\nconst proof = 1\n```')],
    ['mermaid', render.prose('```mermaid\ngraph LR\nA-->B\n```')],
    ['codex-review-directive', render.codex('::code-comment{title="Finding" body="Details" file="/work/a.ts" start=12}')],
    ['codex-review-link', render.codex('[review](codex://review?pr=https%3A%2F%2Fgithub.com%2Fexample%2Frepo%2Fpull%2F1)')],
  ]
  const result = Object.fromEntries(cases.map(([name, html]) => [name, {
    html,
    buttons: (html.match(/<button\b/g) ?? []).length,
    images: (html.match(/<img\b/g) ?? []).length,
    audio: (html.match(/<audio\b/g) ?? []).length,
    rawDirective: html.includes('::code-comment'),
  }]))
  await writeFile(join(here, 'render-evidence-fixed.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
} finally {
  await rm(temporary, {recursive: true, force: true})
}
