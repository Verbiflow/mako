import AppKit
import UniformTypeIdentifiers
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
final class Gesture: NSView {
  var points:[[String:Any]]=[]
  override var isFlipped:Bool {true}
  override func acceptsFirstMouse(for event:NSEvent?)->Bool {true}
  override func draw(_ dirty:NSRect){NSColor(calibratedRed:0.18,green:0.35,blue:0.5,alpha:1).setFill();bounds.fill()}
  func record(_ event:NSEvent,_ kind:String){let p=convert(event.locationInWindow,from:nil);points.append(["kind":kind,"x":p.x,"y":p.y,"windowX":event.locationInWindow.x,"windowY":(window?.frame.height ?? 0)-event.locationInWindow.y,"at":Date().timeIntervalSince1970,"clickCount":event.type == .scrollWheel ? 0 : event.clickCount]);if points.count>2000{points.removeFirst()}}
  override func mouseDown(with e:NSEvent){record(e,"down")}
  override func rightMouseDown(with e:NSEvent){record(e,"right-down")}
  override func rightMouseUp(with e:NSEvent){record(e,"right-up")}
  override func otherMouseDown(with e:NSEvent){record(e,"middle-down")}
  override func otherMouseUp(with e:NSEvent){record(e,"middle-up")}
  override func mouseDragged(with e:NSEvent){record(e,"drag")}
  override func mouseUp(with e:NSEvent){record(e,"up")}
  override func scrollWheel(with e:NSEvent){record(e,"scroll")}
}
final class Handler: NSObject, NSMenuDelegate {
  var menuEvents: [[String: Any]] = []
  func menuWillOpen(_ menu: NSMenu) { menuEvents.append(["kind": "open", "at": Date().timeIntervalSince1970]) }
  func menuDidClose(_ menu: NSMenu) { menuEvents.append(["kind": "close", "at": Date().timeIntervalSince1970]) }
  var bursts=0
  var burstTimes:[Double]=[]
  @objc func burst(_ sender:Any?){
    bursts=0;burstTimes=[]
    let count = (sender as? NSButton)?.tag == 1 ? 160 : 8
    for i in 1...count {DispatchQueue.main.asyncAfter(deadline:.now()+Double(i)*0.025){self.bursts=i;self.burstTimes.append(Date().timeIntervalSince1970);self.result.stringValue="Change "+String(i);NSAccessibility.post(element:self.result,notification:.valueChanged)}}
  }

  let window: NSWindow
  let text: Text
  let result: NSTextField
  var saves = 0
  var panelEvents: [[String: Any]] = []
  init(_ window:NSWindow,_ text:Text,_ result:NSTextField) { self.window=window;self.text=text;self.result=result }
  @objc func verify(_ sender:Any?) { saves += 1;result.stringValue=text.string }
  @objc func panel(_ sender:Any?) {
    let saving=CommandLine.arguments.contains("--save-panel")
    let panel:NSSavePanel = saving ? NSSavePanel() : NSOpenPanel()
    let directory=URL(fileURLWithPath:CommandLine.arguments.dropFirst().first ?? NSTemporaryDirectory()+"mako-reference-native.json").deletingLastPathComponent()
    panel.directoryURL=directory
    panel.title="Mako test panel";panel.prompt=saving ? "Save fixture file" : "Choose fixture"
    panel.allowedContentTypes = [.plainText]
    if let open=panel as? NSOpenPanel {
      open.allowsMultipleSelection = false
      open.canChooseDirectories = false
    } else {
      panel.nameFieldStringValue="untouched.txt"
      panel.canCreateDirectories=false
    }
    panelEvents.append(["kind":"open","at":Date().timeIntervalSince1970])
    panel.beginSheetModal(for:window){response in
      var writeError=""
      if saving && response == .OK, let url=panel.url {
        if url.deletingLastPathComponent().resolvingSymlinksInPath().path != directory.resolvingSymlinksInPath().path {writeError="outside fixture directory"}
        else {do {try Data("saved fixture\n".utf8).write(to:url,options:.withoutOverwriting)} catch {writeError=String(describing:error)}}
      }
      self.panelEvents.append(["kind":"close","response":response.rawValue,"selected":response == .OK ? (panel.url?.lastPathComponent ?? "") : "","writeError":writeError,"at":Date().timeIntervalSince1970])
    }
  }
}
let app=NSApplication.shared
app.setActivationPolicy(CommandLine.arguments.contains("--regular") ? .regular : .accessory)
let mainMenu=NSMenu()
let appItem=NSMenuItem();let appMenu=NSMenu();appMenu.addItem(withTitle:"Quit fixture",action:#selector(NSApplication.terminate(_:)),keyEquivalent:"q");appItem.submenu=appMenu;mainMenu.addItem(appItem)
let editItem=NSMenuItem();editItem.title="Edit";let editMenu=NSMenu(title:"Edit")
for (title,action,key) in [("Select All","selectAll:","a"),("Copy","copy:","c"),("Cut","cut:","x"),("Paste","paste:","v")] {
 editMenu.addItem(withTitle:title,action:NSSelectorFromString(action),keyEquivalent:key)
}
editItem.submenu=editMenu;mainMenu.addItem(editItem);app.mainMenu=mainMenu
let window=NSWindow(contentRect:NSRect(x:260,y:220,width:600,height:320),styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
window.title="Mako settling and gesture fixture"
let text=Text(frame:NSRect(x:20,y:110,width:280,height:180));text.isRichText=false;text.font=NSFont.systemFont(ofSize:18);text.setAccessibilityLabel("Evidence text")
let result=NSTextField(labelWithString:"");result.frame=NSRect(x:20,y:18,width:550,height:24);result.setAccessibilityLabel("Saved text")
let handler=Handler(window,text,result)
let verify=NSButton(title:"Save fixture",target:handler,action:#selector(Handler.verify(_:)));verify.frame=NSRect(x:20,y:65,width:140,height:30)
let panel=NSButton(title:"Open test panel",target:handler,action:#selector(Handler.panel(_:)));panel.frame=NSRect(x:175,y:65,width:160,height:30)
let choices=NSPopUpButton(frame:NSRect(x:350,y:65,width:200,height:30));choices.addItems(withTitles:["First choice","Second choice","Third choice"]);choices.setAccessibilityLabel("Test menu")
choices.menu?.delegate = handler
let gesture=Gesture(frame:NSRect(x:320,y:125,width:250,height:150));gesture.setAccessibilityElement(true);gesture.setAccessibilityRole(.group);gesture.setAccessibilityLabel("Gesture pad")
let burst=NSButton(title:"Change asynchronously",target:handler,action:#selector(Handler.burst(_:)));burst.frame=NSRect(x:310,y:290,width:260,height:25)
let busy=NSButton(title:"Keep changing",target:handler,action:#selector(Handler.burst(_:)));busy.tag=1;busy.frame=NSRect(x:20,y:290,width:270,height:25)
for view in [text,result,verify,panel,choices,gesture,burst,busy] as [NSView] {window.contentView?.addSubview(view)}
let keyboardRouting=CommandLine.arguments.contains("--keyboard-routing")
let decoy=Text(frame:NSRect(x:320,y:125,width:250,height:150))
if keyboardRouting {
  gesture.removeFromSuperview()
  text.string="abcdef";text.setSelectedRange(NSRange(location:6,length:0))
  decoy.isRichText=false;decoy.string="leave this untouched";decoy.setAccessibilityLabel("Decoy text")
  decoy.setSelectedRange(NSRange(location:decoy.string.utf16.count,length:0))
  window.contentView?.addSubview(decoy)
}
window.makeFirstResponder(keyboardRouting ? decoy : text)
window.orderFrontRegardless()
let output=CommandLine.arguments.count>1 ? CommandLine.arguments[1] : NSTemporaryDirectory()+"mako-reference-native.json"
var foregroundEvents: [[String: Any]] = []
let activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { notification in
  guard let active = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
  foregroundEvents.append(["pid": active.processIdentifier, "app": active.localizedName ?? "", "bundle": active.bundleIdentifier ?? "", "at": Date().timeIntervalSince1970])
}
let evidenceTimer = Timer(timeInterval:0.025,repeats:true){_ in
  let record:[String:Any]=["pid":ProcessInfo.processInfo.processIdentifier,"window":window.windowNumber,"text":text.string,"saved":result.stringValue,"saves":handler.saves,"bursts":handler.bursts,"burstTimes":handler.burstTimes,"points":gesture.points,"marked":text.hasMarkedText(),"compositions":text.compositions,"inserts":text.inserts,"choice":choices.titleOfSelectedItem ?? "","frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"pressedButtons":NSEvent.pressedMouseButtons,"appActive":app.isActive,"windowKey":window.isKeyWindow]
  var evidence = record
  evidence["foregroundEvents"] = foregroundEvents
  evidence["menuEvents"] = handler.menuEvents
  evidence["panelEvents"] = handler.panelEvents
  evidence["sheetAttached"] = window.attachedSheet != nil
  if keyboardRouting {
    evidence["selection"]=["location":text.selectedRange().location,"length":text.selectedRange().length]
    evidence["decoy"]=["text":decoy.string,"location":decoy.selectedRange().location,"length":decoy.selectedRange().length]
    evidence["focusedField"]=window.firstResponder === decoy ? "decoy" : window.firstResponder === text ? "target" : "other"
  }
  if let data=try? JSONSerialization.data(withJSONObject:evidence){try? data.write(to:URL(fileURLWithPath:output),options:.atomic)}
}
RunLoop.main.add(evidenceTimer, forMode: .common)
app.run()
