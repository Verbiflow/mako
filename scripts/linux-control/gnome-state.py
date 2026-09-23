import gi
gi.require_version('Gio', '2.0')
from gi.repository import Gio
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
result = bus.call_sync('org.cua.WinRects', '/org/cua/WinRects',
                      'org.cua.WinRects', 'GetRects', None, None,
                      Gio.DBusCallFlags.NONE, 2000, None)
print(result.unpack()[0])
