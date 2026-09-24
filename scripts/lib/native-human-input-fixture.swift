import AppKit
import Carbon

// Records only input delivered to this scratch window. No global keyboard tap.
final class EvidenceText: NSTextView {
  var events: [[String: Any]] = []
  func record(_ kind: String, _ value: String = "") {
    events.append(["kind": kind, "text": value, "at": Date().timeIntervalSince1970,
                   "marked": hasMarkedText(), "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1])
  }
  override func keyDown(with event: NSEvent) {
    record("keyDown")
    super.keyDown(with: event)
  }
  override func setMarkedText(_ value: Any, selectedRange: NSRange, replacementRange: NSRange) {
    super.setMarkedText(value, selectedRange: selectedRange, replacementRange: replacementRange)
    record("composition", (value as? NSAttributedString)?.string ?? value as? String ?? "")
  }
  override func insertText(_ value: Any, replacementRange: NSRange) {
    super.insertText(value, replacementRange: replacementRange)
    record("commit", (value as? NSAttributedString)?.string ?? value as? String ?? "")
  }
}
final class Session: NSObject {
  let text: EvidenceText
  let label: NSTextField
  var phase = "ready"
  var startedAt: Double = 0
  var finishedAt: Double = 0
  var foreground: [[String: Any]] = []
  init(_ text: EvidenceText, _ label: NSTextField) { self.text = text; self.label = label }
  @objc func start(_ sender: NSButton) {
    guard phase == "ready" else { return }
    phase = "running"; startedAt = Date().timeIntervalSince1970
    sender.isEnabled = false
    label.stringValue = "Type the displayed lines by hand. Click Finish when done."
    text.window?.makeFirstResponder(text)
  }
  @objc func finish(_ sender: NSButton) {
    guard phase == "running" else { return }
    phase = "finished"; finishedAt = Date().timeIntervalSince1970
    label.stringValue = "Finished. Your scratch input is saved for verification."
    sender.isEnabled = false
  }
}
let output = CommandLine.arguments[1]
let ime = CommandLine.arguments.count > 2 && CommandLine.arguments[2] == "ime"
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 160, y: 240, width: 680, height: 370), styleMask: [.titled, .closable], backing: .buffered, defer: false)
window.title = "Mako — physical typing check"
let instructions = ime
  ? "Click Start. Use Japanese input for the first line, choosing candidates and committing normally. Switch to English for the second. Do not paste.\n日本語の入力テストです。\nHuman typing stays here 12345."
  : "Use your normal English keyboard. Click Start, then type these two lines by hand, with Return between them. Do not paste. Click Finish after the final period.\nHuman typing stays here 12345.\nBackground edits must not steal my keys."
let title = NSTextField(wrappingLabelWithString: instructions)
title.frame = NSRect(x: 20, y: 250, width: 640, height: 100)
let text = EvidenceText(frame: NSRect(x: 20, y: 75, width: 640, height: 165))
text.isRichText = false; text.font = NSFont.systemFont(ofSize: 20)
text.setAccessibilityLabel("Human typing only")
let label = NSTextField(wrappingLabelWithString: "Ready. Only this scratch window records your input.")
label.frame = NSRect(x: 20, y: 10, width: 640, height: 25)
let session = Session(text, label)
let start = NSButton(title: "Start", target: session, action: #selector(Session.start(_:)))
start.frame = NSRect(x: 20, y: 40, width: 90, height: 30)
let finish = NSButton(title: "Finish", target: session, action: #selector(Session.finish(_:)))
finish.frame = NSRect(x: 120, y: 40, width: 90, height: 30)
for view in [title, text, label, start, finish] as [NSView] { window.contentView?.addSubview(view) }
window.orderFrontRegardless()
var previousFront: pid_t = -1
// Keep activation notifications as well as periodic state. Sampling alone can
// miss a brief focus theft and return between two 20 ms ticks.
let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
  guard let activated = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  session.foreground.append(["pid": activated.processIdentifier, "at": Date().timeIntervalSince1970])
}
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
  let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
  if front != previousFront {
    session.foreground.append(["pid": front, "at": Date().timeIntervalSince1970]); previousFront = front
  }
  let input = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  let source = TISGetInputSourceProperty(input, kTISPropertyInputSourceID)
  let sourceID = source.map { Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String } ?? "unknown"
  let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber,
    "phase": session.phase, "startedAt": session.startedAt, "finishedAt": session.finishedAt,
    "text": text.string, "marked": text.hasMarkedText(), "events": text.events,
    "foreground": session.foreground, "inputSource": sourceID, "frontmostPid": front]
  if let data = try? JSONSerialization.data(withJSONObject: state) { try? data.write(to: URL(fileURLWithPath: output), options: .atomic) }
}
app.run()
