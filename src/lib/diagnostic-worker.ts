import { readDiagnosticInput } from "./diagnostic-input"
import { readDiagnosticDocument } from "./diagnostic-document"
import { summarizeDiagnostic } from "./diagnostic-summary"
import type { DiagnosticFormat } from "../../electron/contracts/file-preview"

self.onmessage = async (
  event: MessageEvent<{ url: string; format: DiagnosticFormat }>
) => {
  try {
    const contents = await readDiagnosticInput(event.data.url)
    self.postMessage({
      kind: "ready",
      summary: summarizeDiagnostic(
        readDiagnosticDocument(event.data.format, contents)
      ),
    })
  } catch (error) {
    self.postMessage({
      kind: "error",
      message:
        error instanceof SyntaxError
          ? "This file is not complete, valid JSON."
          : error instanceof Error && error.name === "ZodError"
            ? "This file does not match the supported diagnostic format or exceeds its structural limits."
            : error instanceof Error
              ? error.message
              : "The diagnostic file could not be inspected",
    })
  }
}
