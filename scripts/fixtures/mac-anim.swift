// A plain AppKit window for the Mac video helper's checks (scripts/test-video-helper-mac.mjs): moving blocks at a
// fixed rate, or still. Prints its window number (a CGWindowID), then runs until killed.
// `mac-anim list` prints the other apps' normal windows on screen as JSON instead.
// swiftc -o mac-anim mac-anim.swift ; mac-anim <fps> <width> <height> [still] | mac-anim list
import AppKit
let args = CommandLine.arguments
if args.count > 1 && args[1] == "list" {
  let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let normal = all.filter { ($0[kCGWindowLayer as String] as? Int) == 0 && ((($0[kCGWindowBounds as String] as? [String: Any])?["Width"] as? Double) ?? 0) > 200 }
  let found = normal.map { ["id": $0[kCGWindowNumber as String] ?? 0, "owner": $0[kCGWindowOwnerName as String] ?? ""] }
  print(String(data: try! JSONSerialization.data(withJSONObject: found), encoding: .utf8)!)
  exit(0)
}
let fps = args.count > 1 ? Double(args[1]) ?? 30 : 30
let width = args.count > 2 ? Double(args[2]) ?? 640 : 640, height = args.count > 3 ? Double(args[3]) ?? 400 : 400
let still = args.count > 4 && args[4] == "still"
final class View: NSView {
  var n = 0
  override func draw(_ dirty: NSRect) {
    NSColor(calibratedRed: 0.96, green: 0.96, blue: 0.97, alpha: 1).setFill(); bounds.fill()
    let colors: [NSColor] = [.systemRed, .systemGreen, .systemYellow, .systemBlue, .systemPurple, .systemTeal]
    for (i, color) in colors.enumerated() {
      color.setFill()
      NSRect(x: Double((n * 7 + i * 120) % Int(bounds.width)), y: Double((i * 60 + n * 3) % Int(bounds.height)), width: 120, height: 80).fill()
    }
    ("frame \(n)" as NSString).draw(at: NSPoint(x: 20, y: 20), withAttributes: [.font: NSFont.systemFont(ofSize: 24)])
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let window = NSWindow(contentRect: NSRect(x: 80, y: 80, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
let view = View(frame: NSRect(x: 0, y: 0, width: width, height: height))
window.contentView = view
window.title = "mako video check"
window.orderFrontRegardless()
print(window.windowNumber)
fflush(stdout)
if !still {
  Timer.scheduledTimer(withTimeInterval: 1 / fps, repeats: true) { _ in view.n += 1; view.needsDisplay = true }
}
app.run()
