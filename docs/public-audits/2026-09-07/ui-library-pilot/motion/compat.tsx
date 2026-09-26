import { SlotText } from 'slot-text/react';
import { Toaster, toast } from 'sonner';
import { Drawer } from 'vaul';
export function Pilot() {
 return <><SlotText text="Copied answer" options={{rollBy:'word', duration:180, stagger:0, bounce:0}}/><Toaster hotkey={[]}/><Drawer.Root direction="right" modal={false} handleOnly><Drawer.Trigger>Changes</Drawer.Trigger><Drawer.Portal><Drawer.Content><Drawer.Title>Changes</Drawer.Title><Drawer.Description>Workspace changes</Drawer.Description><Drawer.Handle/><Drawer.Close>Close</Drawer.Close></Drawer.Content></Drawer.Portal></Drawer.Root></>;
}
toast.loading('Creating pull request', {id:'operation'});
toast.success('Pull request created', {id:'operation',action:{label:'Open',onClick(){}}});
