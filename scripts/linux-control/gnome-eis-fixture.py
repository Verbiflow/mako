"""Expose a real Mutter EIS session inside the disposable acceptance container.

This exercises the native libei transport, not desktop-portal consent UI. The
socket is private to this container's uid and never runs on the user's desktop.
SCM_RIGHTS messages (keyboard maps) are forwarded with their descriptors.
"""
import array
import os
import select
import socket
import sys
from gi.repository import Gio, GLib

address = sys.argv[1]
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
destination = 'org.gnome.Mutter.RemoteDesktop'
interface = destination + '.Session'

def call(dest, path, iface, method, args=None):
    return bus.call_sync(dest, path, iface, method, args, None,
                         Gio.DBusCallFlags.NONE, 5000, None)

session = call(destination, '/org/gnome/Mutter/RemoteDesktop', destination,
               'CreateSession').unpack()[0]
# Link a monitor stream so Mutter advertises an absolute-pointer region.
identifier = call(destination, session, 'org.freedesktop.DBus.Properties',
                  'Get', GLib.Variant('(ss)', (interface, 'SessionId'))).unpack()[0]
cast = 'org.gnome.Mutter.ScreenCast'
cast_session = call(cast, '/org/gnome/Mutter/ScreenCast', cast, 'CreateSession',
                    GLib.Variant('(a{sv})', ({'remote-desktop-session-id': GLib.Variant('s', identifier)},))).unpack()[0]
call(cast, cast_session, cast + '.Session', 'RecordMonitor', GLib.Variant('(sa{sv})', ('', {})))
call(destination, session, interface, 'Start')
result, descriptors = bus.call_with_unix_fd_list_sync(
    destination, session, interface, 'ConnectToEIS',
    GLib.Variant('(a{sv})', ({},)), None, Gio.DBusCallFlags.NONE, 5000, None, None)
remote = socket.socket(fileno=descriptors.get(result.unpack()[0]))
listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(address)
os.chmod(address, 0o600)
listener.listen(1)
print('Mutter EIS fixture ready', flush=True)
try:
    client, _ = listener.accept()
    with client:
        while True:
            readable, _, _ = select.select([client, remote], [], [], 60)
            if not readable:
                break
            for source in readable:
                target = remote if source is client else client
                data, ancillary, flags, _ = source.recvmsg(65536, socket.CMSG_SPACE(256))
                if not data:
                    sys.exit(0)
                if flags & socket.MSG_CTRUNC:
                    raise RuntimeError('EIS ancillary data truncated')
                try:
                    sent = target.sendmsg([data], ancillary)
                    if sent < len(data):
                        target.sendall(data[sent:])
                finally:
                    for level, kind, payload in ancillary:
                        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                            fds = array.array('i'); fds.frombytes(payload)
                            for fd in fds:
                                os.close(fd)
finally:
    remote.close()
    listener.close()
    os.unlink(address)
    call(destination, session, interface, 'Stop')
