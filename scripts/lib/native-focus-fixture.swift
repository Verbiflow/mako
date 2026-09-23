import AppKit
// Only this scratch app's activation events are retained; no key contents.
let output = CommandLine.arguments[1]
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let original = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
let window = NSWindow(contentRect:NSRect(x:320,y:270,width:480,height:180),styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title = "Mako focus regression fixture"
var events:[[String:Any]] = []
var clicks = 0
func persist() {
 let data:[String:Any] = ["pid":getpid(),"window":window.windowNumber,"original":original,"frontmost":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"clicks":clicks,"events":events]
 if let encoded = try? JSONSerialization.data(withJSONObject:data,options:.sortedKeys) {try? encoded.write(to:URL(fileURLWithPath:output),options:.atomic)}
}
final class Handler:NSObject {
 @objc func activate(_ sender:Any?) {
  clicks += 1
  NSRunningApplication.current.activate(options:[.activateIgnoringOtherApps])
  window.makeKeyAndOrderFront(nil)
  persist()
 }
}
let handler = Handler()
let button = NSButton(title:"Attempt system activation",target:handler,action:#selector(Handler.activate(_:)))
button.frame = NSRect(x:20,y:95,width:300,height:35)
window.contentView?.addSubview(button)
let label = NSTextField(labelWithString:"Temporary background focus regression. Closes automatically.")
label.frame = NSRect(x:20,y:35,width:440,height:30)
window.contentView?.addSubview(label)
let observer = NSWorkspace.shared.notificationCenter.addObserver(forName:NSWorkspace.didActivateApplicationNotification,object:nil,queue:.main){ note in
 guard let target = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else {return}
 events.append(["pid":target.processIdentifier,"time":Date().timeIntervalSince1970,"clicks":clicks])
 persist()
}
window.orderFrontRegardless()
persist()
Timer.scheduledTimer(withTimeInterval:0.02,repeats:true){_ in persist()}
DispatchQueue.main.asyncAfter(deadline:.now()+90){app.terminate(nil)}
app.run()
