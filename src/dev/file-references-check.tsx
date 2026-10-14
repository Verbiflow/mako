/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry is never imported by the application. */
// File links in an answer as the production prose draws them, from a fixture
// bridge answering each kind of resolution: a file found (renamed since, in
// another checkout, a bare name the Thread edited), a real tie that opens the
// chooser, one with enough candidates for a filter, one the person picked
// (Option-click picks again), and spellings that link nothing. `?theme=dark` draws the dark theme. No host is touched.
import { createRoot } from "react-dom/client"
import type { FileCandidate, FileResolution } from "@mako/host/contracts/file-references"
import { Prose } from "@/components/transcript/markdown"
import { TranscriptSourceContext } from "@/components/transcript/source-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

document.documentElement.classList.toggle("light", new URLSearchParams(location.search).get("theme") !== "dark")
installMockBridge()

const now = Date.now()
const minutes = (n: number) => now - n * 60_000
const file = (path: string, fields: Partial<FileCandidate> = {}): FileCandidate => ({ path, reason: "touched", ...fields })
const answers = new Map<string, FileResolution>([
  ["tracker.ts", { kind: "file", file: file("/Users/you/code/mako/packages/host/src/attribution/tracker.ts", { place: { name: "mako", folder: "packages/host/src/attribution" }, touch: { kind: "wrote", at: minutes(3) } }) }],
  ["electron/acp.ts", { kind: "file", file: file("/Users/you/code/mako/packages/host/src/harnesses/acp.ts", { reason: "renamed", was: "/Users/you/code/mako/electron/acp.ts", place: { name: "mako", folder: "packages/host/src/harnesses" } }) }],
  ["harnesses/index.ts", {
    kind: "choice",
    candidates: [
      file("/Users/you/code/mako/packages/sessions/src/harnesses/index.ts", { reason: "only-match", place: { name: "mako", folder: "packages/sessions/src/harnesses" }, touch: { kind: "read", at: minutes(2) } }),
      file("/Users/you/code/mako-backend/apps/gateway/src/harnesses/index.ts", { reason: "only-match", place: { name: "mako-backend", folder: "apps/gateway/src/harnesses" } }),
    ],
  }],
  ["config.ts", {
    kind: "file",
    file: file("/Users/you/code/mako/packages/host/src/config.ts", { reason: "chosen", place: { name: "mako", folder: "packages/host/src" } }),
    others: [file("/Users/you/code/mako/src/config.ts", { reason: "only-match", place: { name: "mako", folder: "src" } })],
  }],
  ["README.md", {
    kind: "choice",
    candidates: ["", "docs", "packages/host", "packages/sessions", "packages/git", "scripts", "browser-extension", "packages/protocol"].map((folder) =>
      file(`/Users/you/code/mako/${folder ? `${folder}/` : ""}README.md`, { reason: "only-match", place: { name: "mako", folder } })),
  }],
])
const bridge = window.mako
if (bridge) window.mako = { ...bridge, resolveFileReferences: async (_source, spellings) => spellings.map((spelling) => answers.get(spelling.replace(/:\d+$/, "")) ?? { kind: "none" }) }

const answer = `I changed \`tracker.ts:932\` so the rename keeps its file, and followed \`electron/acp.ts\` to where it lives now.

Two files end in \`harnesses/index.ts\`, so that link asks which; you picked the host's \`config.ts\` earlier; \`README.md\` has eight, so its chooser can be filtered.

\`src/app.ts\` was only an example, and \`notes.md\` was never written, so neither links.`

function Fixture() {
  return (
    <TooltipProvider>
      <main className="flex min-h-screen flex-col gap-6 bg-background p-8 text-foreground">
        <section className="w-[640px]" data-fixture-answer>
          <TranscriptSourceContext value={{ liveId: "fixture-conversation" }}>
            <Prose text={answer} />
          </TranscriptSourceContext>
        </section>
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
