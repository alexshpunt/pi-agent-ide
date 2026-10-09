"""Draw only one fixture-owned X11 window with its native PID property."""
import ctypes as c
import os
import sys
import time

x = c.CDLL("libX11.so.6")
pointer = c.c_void_p
number = c.c_ulong

def bind(name, result, arguments):
    function = getattr(x, name)
    function.restype = result
    function.argtypes = arguments
    return function

open_display = bind("XOpenDisplay", pointer, [c.c_char_p])
root_window = bind("XDefaultRootWindow", number, [pointer])
create = bind("XCreateSimpleWindow", number, [pointer, number, c.c_int, c.c_int,
    c.c_uint, c.c_uint, c.c_uint, number, number])
atom = bind("XInternAtom", number, [pointer, c.c_char_p, c.c_int])
property = bind("XChangeProperty", c.c_int, [pointer, number, number, number,
    c.c_int, c.c_int, pointer, c.c_int])
map_window = bind("XMapWindow", c.c_int, [pointer, number])
sync = bind("XSync", c.c_int, [pointer, c.c_int])

display = open_display(None)
if not display:
    raise RuntimeError("Fixture display unavailable")
window = create(display, root_window(display), int(sys.argv[1]), 4, int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[6]) if len(sys.argv) > 6 else 0, 0, int(sys.argv[2], 16))
pid = number(int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] else os.getpid())
property(display, window, atom(display, b"_NET_WM_PID", 0), 6, 32, 0, c.byref(pid), 1)
map_window(display, window)
sync(display, 0)
print("ready", flush=True)
while True:
    time.sleep(1)
