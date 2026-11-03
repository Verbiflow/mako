// The desk's simulator panel as the production component draws it, against a fake stream: the mock bridge lists a
// stand-in host's iPhone and iPad (`mock-simulators.ts`, `?panel=agent|person|idle|none`), and each frame is a drawn
// picture marked as fake, not a simulator's. `?theme=dark` draws the dark theme; `&form=tablet` shows the iPad;
// `&width=` and `&height=` size the panel. No host is touched.
import { createRoot } from "react-dom/client"
import { SimulatorPanel } from "@/components/inspector/simulator-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { simulatorsStore } from "@/state/simulators"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const search = new URLSearchParams(location.search)
const dark = search.get("theme") === "dark"
document.documentElement.classList.toggle("light", !dark)

installMockBridge()
const tablet = search.get("form") === "tablet"
simulatorsStore.set({
  ...(tablet && { chosen: "stand-in/stand-in-tablet" }),
  frames: {
    "stand-in/stand-in-phone": { src: fakeFrame(402, 874, dark), width: 402, height: 874, at: Date.now() },
    "stand-in/stand-in-tablet": { src: fakeFrame(1032, 1376, dark), width: 1032, height: 1376, at: Date.now() },
  },
})
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground">
        <div className="border-r border-hairline" style={{ width: Number(search.get("width") ?? 440), height: Number(search.get("height") ?? 900) }} data-fixture-simulator-panel>
          <SimulatorPanel />
        </div>
      </div>
    </TooltipProvider>,
  )

/** A page in Safari, drawn: a chat, its composer and Safari's bar, with "fake frame" written on it. */
function fakeFrame(width: number, height: number, dark: boolean): string {
  const ink = dark ? "#ECECEC" : "#1C1C1E"
  const page = dark ? "#151517" : "#FFFFFF"
  const bubble = dark ? "#2A2A2E" : "#F0F0F2"
  const mine = dark ? "#3A2A22" : "#FBEDE6"
  const bar = dark ? "#1E1E21" : "#F6F6F7"
  const field = dark ? "#2C2C30" : "#E8E8EA"
  const faint = "#8E8E93"
  // Drawn 402 points wide whatever the form, so text keeps a phone's size and an iPad's frame shows more room.
  const tall = Math.round((402 * height) / width)
  const rows = [
    { mine: true, lines: ["Why does the reply jump when it", "starts streaming on iPad?"] },
    { mine: false, lines: ["The list re-measures as the first", "chunk lands, and the anchor moves", "48 px up before it settles."] },
    { mine: false, lines: ["I'll pin the anchor to the newest", "message and check it on the iPad."] },
    { mine: true, lines: ["Show me before and after."] },
  ]
  let y = 130
  const bubbles = rows
    .map((row) => {
      const h = 22 + row.lines.length * 21
      const x = row.mine ? 82 : 20
      const text = row.lines.map((line, index) => `<text x="${x + 16}" y="${y + 29 + index * 21}" font-size="15" fill="${ink}">${line}</text>`).join("")
      const drawn = `<rect x="${x}" y="${y}" width="300" height="${h}" rx="18" fill="${row.mine ? mine : bubble}"/>${text}`
      y += h + 12
      return drawn
    })
    .join("")
  const composer = tall - 160
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 402 ${tall}" font-family="-apple-system, system-ui, sans-serif">
<rect width="402" height="${tall}" fill="${page}"/>
<text x="34" y="36" font-size="16" font-weight="600" fill="${ink}">9:41</text>
<rect x="344" y="24" width="26" height="12" rx="4" fill="none" stroke="${ink}" stroke-width="1.4"/><rect x="347" y="27" width="18" height="6" rx="2" fill="${ink}"/>
<text x="20" y="98" font-size="26" font-weight="700" fill="${ink}">Fix the jump</text>
${bubbles}
<rect x="16" y="${composer}" width="370" height="46" rx="23" fill="${bubble}"/>
<text x="36" y="${composer + 29}" font-size="15" fill="${faint}">Message</text>
<text x="201" y="${composer + 66}" font-size="11" fill="${faint}" text-anchor="middle">Fake frame for the panel check, not a simulator</text>
<rect x="0" y="${tall - 84}" width="402" height="84" fill="${bar}"/>
<rect x="24" y="${tall - 74}" width="354" height="38" rx="12" fill="${field}"/>
<text x="201" y="${tall - 50}" font-size="14" fill="${ink}" text-anchor="middle">app.runmako.co</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
