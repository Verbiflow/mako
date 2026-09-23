import AppKit
final class Text: NSTextView {
  var compositions = 0
  var inserts = 0
  override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
    compositions += 1
    super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
  }
  override func insertText(_ string: Any, replacementRange: NSRange) {
    inserts += 1
    super.insertText(string, replacementRange: replacementRange)
  }
}
final class Handler: NSObject {
  let window: NSWindow
  let text: Text
  let result: NSTextField
  var saves = 0
  init(_ window:NSWindow,_ text:Text,_ result:NSTextField) { self.window=window;self.text=text;self.result=result }
  @objc func verify(_ sender:Any?) { saves += 1;result.stringValue=text.string }
  @objc func panel(_ sender:Any?) {
    let panel=NSOpenPanel();panel.directoryURL=URL(fileURLWithPath:"/tmp/mako-reference-evidence");panel.title="Mako test panel";panel.prompt="Choose fixture"
    panel.beginSheetModal(for:window){_ in}
  }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
let mainMenu=NSMenu()
let appItem=NSMenuItem();let appMenu=NSMenu();appMenu.addItem(withTitle:"Quit fixture",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q");appItem.submenu=appMenu;mainMenu.addItem(appItem)
let editItem=NSMenuItem();editItem.title="Edit";let editMenu=NSMenu(title:"Edit")
for (title,action,key) in [("Select All","selectAll:","a"),("Copy","copy:","c"),("Cut","cut:","x"),("Paste","paste:","v")] {
 editMenu.addItem(withTitle:title,action:NSSelectorFromString(action),keyEquivalent:key)
}
editItem.submenu=editMenu;mainMenu.addItem(editItem);app.mainMenu=mainMenu
let window=NSWindow(contentRect:NSRect(x:260,y:220,width:600,height:320),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
window.title="Mako reference evidence fixture"
let text=Text(frame:NSRect(x:20,y:110,width:560,height:180));text.isRichText=false;text.font=NSFont.systemFont(ofSize:18);text.setAccessibilityLabel("Evidence text")
let result=NSTextField(labelWithString:"");result.frame=NSRect(x:20,y:18,width:550,height:24);result.setAccessibilityLabel("Saved text")
let handler=Handler(window,text,result)
let verify=NSButton(title:"Save fixture",target:handler,action:#selector(Handler.verify(_:)));verify.frame=NSRect(x:20,y:65,width:140,height:30)
let panel=NSButton(title:"Open test panel",target:handler,action:#selector(Handler.panel(_:)));panel.frame=NSRect(x:175,y:65,width:160,height:30)
let choices=NSPopUpButton(frame:NSRect(x:350,y:65,width:200,height:30));choices.addItems(withTitles:["First choice","Second choice","Third choice"]);choices.setAccessibilityLabel("Test menu")
for view in [text,result,verify,panel,choices] as [NSView] {window.contentView?.addSubview(view)}
window.makeFirstResponder(text)
window.orderFrontRegardless()
let output=CommandLine.arguments.count>1 ? CommandLine.arguments[1] : NSTemporaryDirectory()+"mako-reference-native.json"
Timer.scheduledTimer(withTimeInterval:0.025,repeats:true){_ in
  let record:[String:Any]=["pid":ProcessInfo.processInfo.processIdentifier,"window":window.windowNumber,"text":text.string,"saved":result.stringValue,"saves":handler.saves,"marked":text.hasMarkedText(),"compositions":text.compositions,"inserts":text.inserts,"choice":choices.titleOfSelectedItem ?? "","frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"appActive":app.isActive,"windowKey":window.isKeyWindow]
  if let data=try? JSONSerialization.data(withJSONObject:record){try? data.write(to:URL(fileURLWithPath:output),options:.atomic)}
}
app.run()
