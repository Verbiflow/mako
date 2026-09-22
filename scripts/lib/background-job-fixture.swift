import AppKit

// Independent state oracle for two windows in one process. The control driver
// never reads/writes this file to perform input; only the test checks it.
final class Form: NSObject {
    let window: NSWindow
    let field = NSTextField(frame: NSRect(x: 20, y: 115, width: 260, height: 26))
    var saved = ""
    var saves = 0
    init(_ index: Int) {
        window = NSWindow(contentRect: NSRect(x: 160 + index * 340, y: 200, width: 330, height: 190), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Mako background form \(index)"
        window.isReleasedWhenClosed = false
        field.setAccessibilityLabel("Proof")
        field.stringValue = "untouched-\(index)"
        window.contentView?.addSubview(field)
        let save = NSButton(title: "Save", target: self, action: #selector(saveValue))
        save.frame = NSRect(x: 20, y: 65, width: 100, height: 28)
        window.contentView?.addSubview(save)
        window.orderFrontRegardless()
    }
    @objc func saveValue() { saved = field.stringValue; saves += 1 }
    var state: [String: Any] { ["window": window.windowNumber, "input": field.stringValue, "saved": saved, "saves": saves, "selection": field.currentEditor()?.selectedRange.length ?? 0, "visible": window.isVisible, "minimized": window.isMiniaturized] }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let menu = NSMenu()
let item = NSMenuItem()
let edit = NSMenu(title: "Edit")
edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
item.submenu = edit; menu.addItem(item); app.mainMenu = menu
let forms = [Form(0), Form(1)]
let root = CommandLine.arguments[1]
var lastCommand = ""
let sheet = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 100), styleMask: [.titled], backing: .buffered, defer: false)
let sheetField = NSTextField(frame: NSRect(x: 20, y: 40, width: 220, height: 26))
sheetField.stringValue = "popup-untouched"
sheet.contentView?.addSubview(sheetField)
sheet.makeFirstResponder(sheetField)
Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { _ in
    // Scenario setup is external to the driver. No test command edits field data.
    if let command = try? String(contentsOfFile: root + "/scenario", encoding: .utf8), command != lastCommand {
        lastCommand = command
        switch command {
        case "popup": forms[0].window.beginSheet(sheet)
        case "dismiss-popup": forms[0].window.endSheet(sheet); sheet.orderOut(nil)
        case "minimize": forms[1].window.miniaturize(nil)
        case "restore": forms[1].window.deminiaturize(nil)
        case "hide": forms[1].window.orderOut(nil)
        case "show": forms[1].window.orderFrontRegardless()
        case "close": forms[1].window.close()
        default: break
        }
    }
    let state: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "forms": forms.map { $0.state }, "popup": ["visible": sheet.isVisible, "input": sheetField.stringValue]]
    if let data = try? JSONSerialization.data(withJSONObject: state) {
        try? data.write(to: URL(fileURLWithPath: root + "/state.json"), options: .atomic)
    }
}
app.run()
