import { createRoot } from "react-dom/client"
import { OceanScene } from "@/components/ui/ocean-scene"
import { AboutSection } from "@/components/settings/about-section"
import PdfDocument from "@/components/viewer/pdf-document"
import "../index.css"

// Load the actual asset consumers under both HTTP and Electron's file protocol.
createRoot(document.getElementById("root")!).render(
  <main className="relative isolate h-full p-8">
    <OceanScene animated={false} />
    <AboutSection />
    {location.protocol === "mako-app:" ? <PdfDocument url="mako-app://desk/__mako_file/asset/document.pdf?client=fixture" name="Protocol fixture.pdf" /> : null}
  </main>
)
