import AppKit

// Synthetic moving pixels only. No keyboard tap or activation.
final class CaptureWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
final class CaptureView: NSView {
  var frameNumber = 0
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedWhite: 0.15, alpha: 1).setFill()
    bounds.fill()
    let transform = NSAffineTransform()
    transform.scaleX(by: bounds.width / 960, yBy: bounds.height / 540)
    transform.concat()
    // Sixteen independently decodable blocks survive H.264 chroma subsampling.
    for bit in 0..<16 {
      NSColor(calibratedWhite: frameNumber & (1 << bit) == 0 ? 0.08 : 0.92, alpha: 1).setFill()
      NSRect(x: 16 + bit * 24, y: 500, width: 20, height: 20).fill()
    }
    let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 13, weight: .regular), .foregroundColor: NSColor.white]
    for row in 0..<22 {
      ("Mako native capture | exact window | line \(row) | 東京 café 12345" as NSString)
        .draw(at: NSPoint(x: 18, y: 22 + row * 20), withAttributes: attrs)
    }
    NSColor.systemOrange.setFill()
    NSRect(x: CGFloat(frameNumber % 900), y: 470, width: 45, height: 8).fill()
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = CaptureWindow(contentRect: NSRect(x: 100, y: 100, width: 960, height: 540), styleMask: [.borderless], backing: .buffered, defer: false)
window.title = "Mako capture rate fixture"
window.isReleasedWhenClosed = false
let view = CaptureView(frame: NSRect(x: 0, y: 0, width: 960, height: 540))
window.contentView = view
window.orderFrontRegardless()
window.orderBack(nil)
window.setContentSize(NSSize(width: 1920 / window.backingScaleFactor, height: 1080 / window.backingScaleFactor))
let output = CommandLine.arguments[1]
var lastWrite = Date.distantPast
var foreground: [[String: Any]] = []
var previousFront: pid_t = -1
Timer.scheduledTimer(withTimeInterval: 1.0 / 120, repeats: true) { _ in
  view.frameNumber += 1
  view.needsDisplay = true
  window.displayIfNeeded()
  if Date().timeIntervalSince(lastWrite) > 0.2 {
    lastWrite = Date()
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != previousFront {
      previousFront = front.processIdentifier
      foreground.append(["pid": previousFront, "name": front.localizedName ?? "unknown", "bundle": front.bundleIdentifier ?? "unknown"])
    }
    let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "window": window.windowNumber,
      "frame": view.frameNumber, "scale": window.backingScaleFactor, "foreground": foreground,
      "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1]
    if let data = try? JSONSerialization.data(withJSONObject: state) {
      try? data.write(to: URL(fileURLWithPath: output), options: .atomic)
    }
  }
}
app.run()
