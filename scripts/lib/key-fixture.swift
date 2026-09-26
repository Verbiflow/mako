import AppKit

// Independent oracle for native keystrokes: one window whose input view
// records every key event and the process that posted it. It offers no
// accessibility text insertion, so a driver must type into it key by key.
// Launch it with `open -g`: AppKit activates a directly executed app when it
// finishes launching, and the person's typing would then land here.
// Only the test reads the state file.
final class KeyView: NSView {
    var text = ""
    var events: [[Any]] = []
    override var acceptsFirstResponder: Bool { true }
    private func source(_ event: NSEvent) -> Int {
        Int(event.cgEvent?.getIntegerValueField(.eventSourceUnixProcessID) ?? -1)
    }
    override func keyDown(with event: NSEvent) {
        events.append(["keydown", Int(event.keyCode), event.characters ?? "", event.isARepeat, source(event)])
        if let characters = event.characters { text += characters }
    }
    override func keyUp(with event: NSEvent) {
        events.append(["keyup", Int(event.keyCode), event.characters ?? "", false, source(event)])
    }
    override func flagsChanged(with event: NSEvent) {
        events.append(["flags", Int(event.keyCode), String(event.modifierFlags.rawValue), false, source(event)])
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.textBackgroundColor.setFill()
        dirtyRect.fill()
        (text as NSString).draw(at: NSPoint(x: 6, y: 8), withAttributes: [.font: NSFont.systemFont(ofSize: 18)])
    }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .textField }
    override func accessibilityLabel() -> String? { "Proof" }
    override func accessibilityValue() -> Any? { text }
    override func isAccessibilityFocused() -> Bool { window?.firstResponder === self }
    override func setAccessibilityFocused(_ focused: Bool) { if focused { window?.makeFirstResponder(self) } }
}

let root = CommandLine.arguments[1]
let index = Int(CommandLine.arguments[2]) ?? 0
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 160 + index * 420, y: 420, width: 400, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Mako key fixture \(index)"
let view = KeyView(frame: NSRect(x: 20, y: 25, width: 360, height: 40))
window.contentView?.addSubview(view)
window.makeFirstResponder(view)
window.orderFrontRegardless()
var activations = 0
NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in activations += 1 }
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    view.needsDisplay = true
    let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber, "value": view.text, "events": view.events, "activations": activations]
    if let data = try? JSONSerialization.data(withJSONObject: state) {
        try? data.write(to: URL(fileURLWithPath: root + "/state-\(index).json"), options: .atomic)
    }
}
app.run()
