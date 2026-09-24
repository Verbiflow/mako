// Read-only diagnostic: process identities from the exact panel AX subtree.
import Foundation
import ApplicationServices
@_silgen_name("_AXUIElementGetWindow") func windowID(_ e:AXUIElement,_ id:UnsafeMutablePointer<CGWindowID>)->AXError
let app=AXUIElementCreateApplication(pid_t(CommandLine.arguments[1])!)
let target=UInt32(CommandLine.arguments[2])!
func read(_ e:AXUIElement,_ key:String)->CFTypeRef?{var value:CFTypeRef?;return AXUIElementCopyAttributeValue(e,key as CFString,&value) == .success ? value:nil}
let deadline=Date().addingTimeInterval(3)
var incomplete=false
var seen:[AXUIElement]=[]
var processes:[String:Int]=[:]
var roots:[[String:Any]]=[]
func walk(_ e:AXUIElement,_ depth:Int,_ inside:Bool){
 guard Date()<deadline && depth<30 && seen.count<2000 else{incomplete=true;return}
 guard !seen.contains(where:{CFEqual($0,e)}) else{return}
 seen.append(e);AXUIElementSetMessagingTimeout(e,0.2)
 let role=read(e,"AXRole") as? String ?? "unknown"
 var wid:CGWindowID=0;_ = windowID(e,&wid)
 let matched=inside || wid==target
 var pid:pid_t=0;let result=AXUIElementGetPid(e,&pid)
 if matched {processes[String(pid),default:0]+=1}
 if role=="AXSheet" || role=="AXWindow" {roots.append(["role":role,"window":wid,"pid":pid,"pidError":result.rawValue])}
 if let children=read(e,"AXChildren") as? [AXUIElement]{for c in children{walk(c,depth+1,matched)}}
 if depth==0,let children=read(e,"AXWindows") as? [AXUIElement]{for c in children{walk(c,depth+1,false)}}
}
walk(app,0,false)
print(String(data:try! JSONSerialization.data(withJSONObject:["processes":processes,"roots":roots,"incomplete":incomplete],options:[.sortedKeys]),encoding:.utf8)!)
