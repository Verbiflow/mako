import { worktreeAt, plainPath } from "../src/lib/worktree-paths.ts"
const refs = Array.from({ length: 2813 }, (_, i) => ({ cwd: `/Users/kashyab/project-${i % 40}/sub`, worktrees: i % 50 === 0 ? [{ path: `/Users/kashyab/.mako/worktrees/p-${i}/x`, repoRoot: `/Users/kashyab/p-${i}`, mirrors: true as const }] : undefined }))
const mirrorsOf = () => { const found = new Map(); for (const ref of refs) for (const l of ref.worktrees ?? []) if (l.mirrors) found.set(plainPath(l.path), l); return [...found.values()] }
const time = (label: string, f: () => unknown, n = 200) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); console.log(label, ((performance.now() - t) / n).toFixed(3), "ms") }
const mirrors = mirrorsOf()
console.log("mirror checkouts in this worst case", mirrors.length)
time("collect them once per Thread list change", mirrorsOf)
time("extra lookup for every row in one sidebar grouping", () => { let n = 0; for (const ref of refs) if (worktreeAt(mirrors, ref.cwd)) n++; return n })
