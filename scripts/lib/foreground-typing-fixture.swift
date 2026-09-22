import AppKit
import CoreGraphics

// This fixture records only its own tagged synthetic input. It never installs
// a global event tap, reads another app's text, or saves the user's keystrokes.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 260, width: 480, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Mako foreground typing check"
let field = NSTextField(frame: NSRect(x: 20, y: 90, width: 440, height: 30))
field.setAccessibilityLabel("Synthetic typing check")
window.contentView?.addSubview(field)
let label = NSTextField(labelWithString: "Disposable test. Only tagged synthetic keystrokes are counted.")
label.frame = NSRect(x: 20, y: 35, width: 440, height: 25)
window.contentView?.addSubview(label)
window.makeFirstResponder(field)
window.orderFrontRegardless()
let path = CommandLine.arguments[1]
let marker: Int64 = 0x4d414b4f54455354
var sent = 0, received = 0
var failures: [String] = []
var focusChanges: [[String: Any]] = []
var started = false
var stopped = false
let startedAt = Date()
NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { event in
    if event.cgEvent?.getIntegerValueField(.eventSourceUserData) == marker {
        received += 1
        if !event.modifierFlags.intersection([.command,.control,.option,.shift]).isEmpty { failures.append("unexpected-modifier") }
        if window.firstResponder !== field.currentEditor() { failures.append("wrong-responder") }
    }
    return event
}
Timer.scheduledTimer(withTimeInterval: 0.04, repeats: true) { _ in
    let foreground = NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
    stopped = FileManager.default.fileExists(atPath: path + ".stop")
    if foreground && window.isKeyWindow { started = true }
    if started && !stopped && foreground && !window.isKeyWindow && failures.last != "key-window-lost" { failures.append("key-window-lost") }
    if started && !stopped && !foreground { if failures.last != "foreground-lost" { failures.append("foreground-lost"); focusChanges.append(["pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "time": Date().timeIntervalSince1970]) } }
    if started && !stopped && foreground && window.isKeyWindow && failures.isEmpty {
        let source = CGEventSource(stateID: .privateState)
        if let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) {
            for event in [down,up] { event.flags = []; event.setIntegerValueField(.eventSourceUserData, value: marker) }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap); sent += 1
        }
    }
    let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,"started":started,"stopped":stopped,"sent":sent,"received":received,"failures":failures,"focusChanges":focusChanges,"elapsed":Date().timeIntervalSince(startedAt)]
    if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to:URL(fileURLWithPath:path),options:.atomic) }
}
if CommandLine.arguments.contains("--activate") { app.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
app.run()
