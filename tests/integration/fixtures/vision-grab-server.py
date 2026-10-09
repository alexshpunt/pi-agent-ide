"""Hold only the fixture X11 server until the owned channel stops."""
import ctypes
import time

x11 = ctypes.CDLL("libX11.so.6")
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XGrabServer.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
display = x11.XOpenDisplay(None)
if not display:
    raise RuntimeError("No fixture display")
x11.XGrabServer(display)
x11.XSync(display, 0)
print("ready", flush=True)
while True:
    time.sleep(1)
