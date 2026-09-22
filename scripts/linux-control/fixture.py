import gi, json, os, sys
from pathlib import Path
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib

name, output = sys.argv[1:]
window = Gtk.Window(title=name)
window.set_default_size(640, 420)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12)
window.add(box)
entry = Gtk.Entry()
entry.get_accessible().set_name('Exact text')
box.pack_start(entry, False, False, 0)
text = Gtk.TextView()
text.get_accessible().set_name('Long text')
box.pack_start(text, True, True, 0)
button = Gtk.Button(label='Save')
box.pack_start(button, False, False, 0)
saves = 0
decoy = None
replaced = False
reordered_again = False
dialog = None

def save(_):
    global saves
    saves += 1
button.connect('clicked', save)

def report():
    global decoy, text, replaced, reordered_again, dialog
    if name == 'Mako target':
        try:
            command = json.loads(Path('/tmp/fixture-command.json').read_text())
            if command.get('modal') and dialog is None:
                dialog = Gtk.Dialog(title='Confirm change', transient_for=window, modal=True)
                dialog.add_button('Cancel', Gtk.ResponseType.CANCEL)
                dialog.show_all()
            if not command.get('modal') and dialog is not None:
                dialog.destroy()
                dialog = None
            if command.get('reorder') and decoy is None:
                decoy = Gtk.Entry()
                decoy.get_accessible().set_name('Decoy')
                decoy.set_text('untouched')
                box.pack_start(decoy, False, False, 0)
                box.reorder_child(decoy, 0)
                decoy.show()
            if command.get('reorderAgain') and not reordered_again:
                another = Gtk.Entry()
                another.get_accessible().set_name('Second decoy')
                box.pack_start(another, False, False, 0)
                box.reorder_child(another, 0)
                another.show()
                reordered_again = True
            if command.get('replace') and not replaced:
                text.destroy()
                text = Gtk.TextView()
                text.get_accessible().set_name('Long text')
                text.get_buffer().set_text('replacement untouched')
                box.pack_start(text, True, True, 0)
                text.show()
                replaced = True
        except (FileNotFoundError, json.JSONDecodeError):
            pass
    buf = text.get_buffer()
    data = dict(pid=os.getpid(), entry=entry.get_text(), text=buf.get_text(buf.get_start_iter(), buf.get_end_iter(), True), saves=saves, active=window.is_active(), decoy=decoy.get_text() if decoy else None, replaced=replaced, modal=dialog is not None)
    Path(output + '.tmp').write_text(json.dumps(data))
    os.replace(output + '.tmp', output)
    return True
window.connect('destroy', Gtk.main_quit)
window.show_all()
entry.grab_focus()
GLib.timeout_add(25, report)
Gtk.main()
