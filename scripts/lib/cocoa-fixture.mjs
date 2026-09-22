export const cocoaFixtureSource = `
import AppKit
final class Handler: NSObject {
  let field: NSTextField
  let output: NSTextField
  init(field: NSTextField, output: NSTextField) { self.field = field; self.output = output }
  @objc func verify(_ sender: Any?) { output.stringValue = field.stringValue }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 240, y: 240, width: 480, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Mako cocoa fixture"
let field = NSTextField(frame: NSRect(x: 20, y: 130, width: 300, height: 24))
field.setAccessibilityLabel("Proof")
let button = NSButton(title: "Verify proof", target: nil, action: nil)
button.frame = NSRect(x: 330, y: 128, width: 130, height: 28)
let output = NSTextField(labelWithString: "")
output.frame = NSRect(x: 20, y: 70, width: 440, height: 24)
output.setAccessibilityLabel("Result")
let handler = Handler(field: field, output: output)
button.target = handler
button.action = #selector(Handler.verify(_:))
window.contentView?.addSubview(field)
window.contentView?.addSubview(button)
window.contentView?.addSubview(output)
window.orderFrontRegardless()
let statusPath = CommandLine.arguments[1]
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  let selection = field.currentEditor()?.selectedRange.length ?? 0
  let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "input": field.stringValue, "selection": selection, "value": output.stringValue]
  if let data = try? JSONSerialization.data(withJSONObject: state) {
    try? data.write(to: URL(fileURLWithPath: statusPath + ".next"))
    rename(statusPath + ".next", statusPath)
  }
}
app.run()
`
