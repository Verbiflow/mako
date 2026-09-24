import gi, json, sys, os
from pathlib import Path
gi.require_version('Gtk','3.0')
from gi.repository import Gtk, GLib, Gdk
name, output, color = sys.argv[1:]
window=Gtk.Window(title=name)
window.set_default_size(640,420)
window.move(100,100)
box=Gtk.Box(orientation=Gtk.Orientation.VERTICAL,spacing=8)
entry=Gtk.Entry();entry.get_accessible().set_name('Exact text')
button=Gtk.Button(label='Save')
area=Gtk.DrawingArea();area.set_size_request(400,300)
state={'pid':os.getpid(),'saves':0,'text':'','frames':0,'points':[]}
def draw(widget,ctx):
    ctx.set_source_rgb(*[int(color[i:i+2],16)/255 for i in (0,2,4)]);ctx.paint()
    ctx.set_source_rgb(1,1,1);ctx.set_font_size(24);ctx.move_to(30,50);ctx.show_text(name+' '+str(state['frames']))
    ctx.set_source_rgb(224/255,88/255,69/255);ctx.rectangle(widget.get_allocated_width()-50,widget.get_allocated_height()-50,30,30);ctx.fill()
    return False
area.connect('draw',draw)
area.add_events(Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.SCROLL_MASK)
def pointer(kind):
    def receive(widget,event):
        offset=area.translate_coordinates(window,0,0)
        state['points'].append({'kind':kind,'event_ms':event.time,'x':event.x,'y':event.y,'window_x':event.x+offset[0],'window_y':event.y+offset[1],'root_x':event.x_root,'root_y':event.y_root})
        state['points']=state['points'][-1000:]
        return False
    return receive
for signal,kind in [('button-press-event','down'),('motion-notify-event','move'),('button-release-event','up'),('scroll-event','scroll')]:area.connect(signal,pointer(kind))

def save(_):state['saves']+=1
button.connect('clicked',save)
for view in [entry,button,area]:box.pack_start(view,view==area,view==area,0)
window.add(box);window.show_all();entry.grab_focus()
def tick():
    command=Path(output+'.command')
    if command.exists():
        operation=command.read_text().strip();command.unlink()
        if operation=='minimize':window.iconify()
        elif operation=='restore':window.deiconify()
    frame=window.get_window().get_frame_extents()
    state['frame']={'x':frame.x,'y':frame.y,'width':frame.width,'height':frame.height}
    state['text']=entry.get_text();state['frames']+=1;state['active']=window.is_active();state['width']=window.get_allocated_width();state['height']=window.get_allocated_height();area.queue_draw()
    Path(output+'.next').write_text(json.dumps(state));os.replace(output+'.next',output);return True
GLib.timeout_add(round(1000/int(os.environ.get("MAKO_RECORDING_FPS","30"))),tick)
window.connect('destroy',Gtk.main_quit)
Gtk.main()
