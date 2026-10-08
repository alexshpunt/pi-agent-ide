"""Read one authorized X11 drawable. No controller desktop or root-image window fallback."""
import ctypes as c
import json
import os
import struct
import sys
import zlib

MAX_PIXELS = 16 * 1024 * 1024
MAX_BYTES = 20 * 1024 * 1024


class Refused(Exception):
    pass


def process_identity(pid):
    try:
        with open(f"/proc/{pid}/stat", encoding="utf8") as file:
            ticks = file.read().rsplit(")", 1)[1].split()[19]
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as file:
            boot = file.read().strip()
        return boot + ":" + ticks, os.readlink(f"/proc/{pid}/exe")
    except FileNotFoundError:
        raise Refused("ENOENT")
    except PermissionError:
        raise Refused("EACCES")


class Image(c.Structure):
    _fields_ = [("width", c.c_int), ("height", c.c_int), ("xoffset", c.c_int),
        ("format", c.c_int), ("data", c.c_void_p), ("byte_order", c.c_int),
        ("bitmap_unit", c.c_int), ("bitmap_bit_order", c.c_int), ("bitmap_pad", c.c_int),
        ("depth", c.c_int), ("bytes_per_line", c.c_int), ("bits_per_pixel", c.c_int),
        ("red_mask", c.c_ulong), ("green_mask", c.c_ulong), ("blue_mask", c.c_ulong)]


class Extension(c.Structure):
    _fields_ = [("name", c.c_char_p), ("global_id", c.c_int)]


class ProtocolRequest(c.Structure):
    _fields_ = [("count", c.c_size_t), ("ext", c.POINTER(Extension)),
        ("opcode", c.c_uint8), ("isvoid", c.c_uint8)]


class Iovec(c.Structure):
    _fields_ = [("base", c.c_void_p), ("length", c.c_size_t)]


def trusted_client_query(display):
    """Check X-Resource 1.2 on this Xlib connection without reading any pixels."""
    try:
        bridge = c.CDLL("libX11-xcb.so.1")
        xcb = c.CDLL("libxcb.so.1")
    except OSError:
        raise Refused("CAPABILITY_UNAVAILABLE")
    pointer = c.c_void_p
    bridge.XGetXCBConnection.restype = pointer
    bridge.XGetXCBConnection.argtypes = [pointer]
    # Share the grabbed Xlib connection. A second client would wait behind XGrabServer.
    connection = bridge.XGetXCBConnection(display)
    if not connection:
        raise Refused("CAPABILITY_UNAVAILABLE")
    extension = Extension(b"X-Resource", 0)
    xcb.xcb_get_extension_data.restype = pointer
    xcb.xcb_get_extension_data.argtypes = [pointer, c.POINTER(Extension)]
    information = xcb.xcb_get_extension_data(connection, c.byref(extension))
    if not information or c.string_at(information, 12)[8] != 1:
        raise Refused("CAPABILITY_UNAVAILABLE")
    xcb.xcb_send_request.restype = c.c_uint
    xcb.xcb_send_request.argtypes = [pointer, c.c_int, c.POINTER(Iovec), c.POINTER(ProtocolRequest)]
    xcb.xcb_wait_for_reply.restype = pointer
    xcb.xcb_wait_for_reply.argtypes = [pointer, c.c_uint, c.POINTER(pointer)]
    libc = c.CDLL(None)
    libc.free.argtypes = [pointer]
    libc.free.restype = None

    def query(opcode, data):
        buffer = c.create_string_buffer(data)
        # libxcb reserves two iovecs before the request for its wire header.
        vectors = (Iovec * 4)()
        vectors[2] = Iovec(c.cast(buffer, pointer), len(data))
        vectors[3] = Iovec(None, (-len(data)) & 3)
        protocol = ProtocolRequest(2, c.pointer(extension), opcode, 0)
        sequence = xcb.xcb_send_request(connection, 1,
            c.cast(c.byref(vectors, 2 * c.sizeof(Iovec)), c.POINTER(Iovec)), c.byref(protocol))
        error = pointer()
        reply = xcb.xcb_wait_for_reply(connection, sequence, c.byref(error)) if sequence else None
        try:
            if error or not reply:
                raise Refused("CAPABILITY_UNAVAILABLE")
            header = c.string_at(reply, 32)
            size = struct.unpack_from("=I", header, 4)[0] * 4
            if header[0] != 1 or size > 4096:
                raise Refused("CAPABILITY_UNAVAILABLE")
            return header + c.string_at(reply + 32, size)
        finally:
            if error:
                libc.free(error)
            if reply:
                libc.free(reply)

    version = query(0, struct.pack("=BBHBB2x", 0, 0, 0, 1, 2))
    if struct.unpack_from("=HH", version, 8) < (1, 2):
        raise Refused("CAPABILITY_UNAVAILABLE")
    return query


def trusted_window_pid(display, window):
    """Ask for the server-observed local client PID, not a window property."""
    query = trusted_client_query(display)
    identifiers = query(4, struct.pack("=BBHIII", 0, 0, 0, 1, window, 2))
    # One requested client and one LOCAL_CLIENT_PID value (length is bytes).
    if len(identifiers) != 48 or struct.unpack_from("=I", identifiers, 8)[0] != 1:
        raise Refused("CAPABILITY_UNAVAILABLE")
    _, mask, length, pid = struct.unpack_from("=IIII", identifiers, 32)
    if mask != 2 or length != 4 or pid == 0:
        raise Refused("CAPABILITY_UNAVAILABLE")
    return pid

def display_library():
    if not os.environ.get("DISPLAY"):
        raise Refused("DESKTOP_UNAVAILABLE")
    try:
        x = c.CDLL("libX11.so.6")
    except OSError:
        raise Refused("CAPABILITY_UNAVAILABLE")
    return x


def probe():
    """Connect to the native desktop and check trusted identity support. Never acquire pixels."""
    x = display_library()
    x.XOpenDisplay.restype = c.c_void_p
    x.XOpenDisplay.argtypes = [c.c_char_p]
    x.XCloseDisplay.restype = c.c_int
    x.XCloseDisplay.argtypes = [c.c_void_p]
    display = x.XOpenDisplay(None)
    if not display:
        raise Refused("DESKTOP_UNAVAILABLE")
    try:
        try:
            trusted_client_query(display)
        except Refused as error:
            return {"display": True, "window": False, "error": str(error)}
        return {"display": True, "window": True}
    finally:
        x.XCloseDisplay(display)


def capture(request):
    x = display_library()
    pointer, number = c.c_void_p, c.c_ulong
    def bind(name, result, arguments):
        function = getattr(x, name)
        function.restype, function.argtypes = result, arguments
        return function
    open_display = bind("XOpenDisplay", pointer, [c.c_char_p])
    close_display = bind("XCloseDisplay", c.c_int, [pointer])
    root_window = bind("XRootWindow", number, [pointer, c.c_int])
    screen_count = bind("XScreenCount", c.c_int, [pointer])
    query_tree = bind("XQueryTree", c.c_int, [pointer, number, c.POINTER(number),
        c.POINTER(number), c.POINTER(c.POINTER(number)), c.POINTER(c.c_uint)])
    get_geometry = bind("XGetGeometry", c.c_int, [pointer, number, c.POINTER(number),
        c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_uint), c.POINTER(c.c_uint),
        c.POINTER(c.c_uint), c.POINTER(c.c_uint)])
    translate = bind("XTranslateCoordinates", c.c_int, [pointer, number, number,
        c.c_int, c.c_int, c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(number)])
    atom = bind("XInternAtom", number, [pointer, c.c_char_p, c.c_int])
    get_property = bind("XGetWindowProperty", c.c_int, [pointer, number, number, c.c_long,
        c.c_long, c.c_int, number, c.POINTER(number), c.POINTER(c.c_int),
        c.POINTER(number), c.POINTER(number), c.POINTER(pointer)])
    free = bind("XFree", c.c_int, [pointer])
    get_image = bind("XGetImage", c.POINTER(Image), [pointer, number, c.c_int, c.c_int,
        c.c_uint, c.c_uint, number, c.c_int])
    destroy_image = bind("XDestroyImage", c.c_int, [c.POINTER(Image)])
    grab = bind("XGrabServer", c.c_int, [pointer])
    ungrab = bind("XUngrabServer", c.c_int, [pointer])
    sync = bind("XSync", c.c_int, [pointer, c.c_int])
    error_handler = c.CFUNCTYPE(c.c_int, pointer, pointer)
    error_seen = []
    @error_handler
    def on_error(_display, _event):
        error_seen.append(True)
        return 0
    bind("XSetErrorHandler", pointer, [error_handler])(on_error)
    display = open_display(None)
    if not display:
        raise Refused("DESKTOP_UNAVAILABLE")
    image = None
    grabbed = False
    try:
        def children(window):
            root, parent, count = number(), number(), c.c_uint()
            values = c.POINTER(number)()
            if not query_tree(display, window, c.byref(root), c.byref(parent), c.byref(values), c.byref(count)):
                raise Refused("EACCES")
            try:
                if count.value > 4096:
                    raise Refused("CONTENT_LIMIT")
                return list(values[:count.value])
            finally:
                if values:
                    free(values)
        def geometry(window, root, include_border=False):
            owner, child = number(), number()
            left, top, rx, ry = c.c_int(), c.c_int(), c.c_int(), c.c_int()
            width, height, border, depth = c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
            if not get_geometry(display, window, c.byref(owner), c.byref(left), c.byref(top),
                c.byref(width), c.byref(height), c.byref(border), c.byref(depth)):
                raise Refused("EACCES")
            if not translate(display, window, root, 0, 0, c.byref(rx), c.byref(ry), c.byref(child)):
                raise Refused("EACCES")
            edge = border.value if include_border else 0
            return rx.value - edge, ry.value - edge, width.value + 2 * edge, height.value + 2 * edge
        pid_atom = atom(display, b"_NET_WM_PID", 1)
        def window_pid(window):
            actual, count, remaining = number(), number(), number()
            format = c.c_int()
            value = pointer()
            result = get_property(display, window, pid_atom, 0, 1, 0, 6,
                c.byref(actual), c.byref(format), c.byref(count), c.byref(remaining), c.byref(value))
            try:
                if result == 0 and actual.value == 6 and format.value == 32 and count.value == 1 and remaining.value == 0:
                    return c.cast(value, c.POINTER(number))[0]
                return None
            finally:
                if value:
                    free(value)
        grab(display)
        grabbed = True
        if request["kind"] == "display":
            index = request["index"]
            if index < 0 or index >= screen_count(display):
                raise Refused("ENOENT")
            root = drawable = root_window(display, index)
        else:
            pid = request["pid"]
            expected = (request["identity"], request["executable"])
            if process_identity(pid) != expected:
                raise Refused("STALE_PROCESS")
            matches = []
            visited = 0
            for screen in range(screen_count(display)):
                root = root_window(display, screen)
                top_windows = children(root)
                pending = [(window, position) for position, window in enumerate(top_windows)]
                while pending:
                    window, position = pending.pop()
                    visited += 1
                    if visited > 4096:
                        raise Refused("CONTENT_LIMIT")
                    if pid_atom and window_pid(window) == pid:
                        matches.append((root, window, top_windows[position + 1:]))
                    pending.extend((child, position) for child in children(window))
            if not matches:
                raise Refused("ENOENT")
            if len(matches) != 1:
                raise Refused("AMBIGUOUS_WINDOW")
            root, drawable, above = matches[0]
            sync(display, 0)
            if trusted_window_pid(display, drawable) != pid:
                raise Refused("EACCES")
            left, top, width, height = geometry(drawable, root)
            for other in above:
                ox, oy, ow, oh = geometry(other, root, include_border=True)
                if left < ox + ow and ox < left + width and top < oy + oh and oy < top + height:
                    # XGetImage has undefined obscured pixels. Never replace them with root pixels.
                    raise Refused("WINDOW_OBSCURED")
        _, _, width, height = geometry(drawable, root)
        if width < 1 or height < 1 or width * height > MAX_PIXELS:
            raise Refused("PIXEL_LIMIT")
        image = get_image(display, drawable, 0, 0, width, height, number(-1), 2)
        sync(display, 0)
        if not image or error_seen:
            raise Refused("EACCES")
        if request["kind"] == "window" and process_identity(request["pid"]) != expected:
            raise Refused("STALE_PROCESS")
        ungrab(display)
        grabbed = False
        pixels = image.contents
        if (pixels.width, pixels.height) != (width, height) or pixels.xoffset != 0 or pixels.byte_order != 0 or pixels.bits_per_pixel not in (24, 32) or (pixels.red_mask, pixels.green_mask, pixels.blue_mask) != (0xff0000, 0xff00, 0xff):
            raise Refused("CAPABILITY_UNAVAILABLE")
        step = pixels.bits_per_pixel // 8
        if pixels.bytes_per_line < width * step or pixels.bytes_per_line * height > MAX_PIXELS * 4:
            raise Refused("PIXEL_LIMIT")
        raw = c.string_at(pixels.data, pixels.bytes_per_line * height)
        scanlines = bytearray()
        for row in range(height):
            data = raw[row * pixels.bytes_per_line:row * pixels.bytes_per_line + width * step]
            rgb = bytearray(width * 3)
            rgb[0::3], rgb[1::3], rgb[2::3] = data[2::step], data[1::step], data[0::step]
            scanlines.extend(b"\0" + rgb)
        def chunk(kind, data):
            return struct.pack("!I", len(data)) + kind + data + struct.pack("!I", zlib.crc32(kind + data))
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(scanlines)) + chunk(b"IEND", b"")
        if len(png) > MAX_BYTES:
            raise Refused("BYTE_LIMIT")
        return png
    finally:
        if image:
            destroy_image(image)
        if grabbed:
            ungrab(display)
        close_display(display)


try:
    request = json.loads(sys.argv[1])
    if request["kind"] == "probe":
        print(json.dumps(probe()))
    else:
        sys.stdout.buffer.write(capture(request))
except Refused as error:
    print(json.dumps({"error": str(error)}))
except Exception:
    # Do not return display names, authorization paths, native logs or environment values.
    print(json.dumps({"error": "CAPABILITY_UNAVAILABLE"}))
