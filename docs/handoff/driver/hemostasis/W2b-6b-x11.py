#!/usr/bin/env python3
"""W2b-6b 用的 X11 小工具（由 W1a-8-x11.py 复制来，加了组合键与指针移动；零依赖：ctypes 直调 libX11 / libXtst）。
原生对话框不在任何网页里，playwright 截不到也点不到，只能在 X 层面做：
  list                      列出已映射的顶层窗口 JSON（名字、位置、大小）
  shot <png> [x y w h]      截根窗口（可裁剪）存 PNG
  click <x> <y>             把指针移到 (x,y) 并按一下左键
  key <keysym-name>         按一下键（Return / Escape）；组合键写成 ctrl+shift+i、ctrl+r（修饰键先按后放）
  move <x> <y>              只把指针移到 (x,y)（没有窗口管理器时键盘焦点跟着指针走）
"""
import ctypes, ctypes.util, json, os, struct, sys, zlib

x11 = ctypes.CDLL('libX11.so.6')
xtst = ctypes.CDLL('libXtst.so.6')

Window = ctypes.c_ulong
Atom = ctypes.c_ulong

class XWindowAttributes(ctypes.Structure):
    _fields_ = [('x', ctypes.c_int), ('y', ctypes.c_int), ('width', ctypes.c_int), ('height', ctypes.c_int),
                ('border_width', ctypes.c_int), ('depth', ctypes.c_int), ('visual', ctypes.c_void_p),
                ('root', Window), ('class_', ctypes.c_int), ('bit_gravity', ctypes.c_int),
                ('win_gravity', ctypes.c_int), ('backing_store', ctypes.c_int),
                ('backing_planes', ctypes.c_ulong), ('backing_pixel', ctypes.c_ulong),
                ('save_under', ctypes.c_int), ('colormap', ctypes.c_ulong), ('map_installed', ctypes.c_int),
                ('map_state', ctypes.c_int), ('all_event_masks', ctypes.c_long),
                ('your_event_mask', ctypes.c_long), ('do_not_propagate_mask', ctypes.c_long),
                ('override_redirect', ctypes.c_int), ('screen', ctypes.c_void_p)]

class XImage(ctypes.Structure):
    _fields_ = [('width', ctypes.c_int), ('height', ctypes.c_int), ('xoffset', ctypes.c_int),
                ('format', ctypes.c_int), ('data', ctypes.POINTER(ctypes.c_ubyte)), ('byte_order', ctypes.c_int),
                ('bitmap_unit', ctypes.c_int), ('bitmap_bit_order', ctypes.c_int), ('bitmap_pad', ctypes.c_int),
                ('depth', ctypes.c_int), ('bytes_per_line', ctypes.c_int), ('bits_per_pixel', ctypes.c_int),
                ('red_mask', ctypes.c_ulong), ('green_mask', ctypes.c_ulong), ('blue_mask', ctypes.c_ulong)]

x11.XOpenDisplay.restype = ctypes.c_void_p
x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
x11.XDefaultRootWindow.restype = Window
x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x11.XQueryTree.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(Window), ctypes.POINTER(Window),
                           ctypes.POINTER(ctypes.POINTER(Window)), ctypes.POINTER(ctypes.c_uint)]
x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, Window, ctypes.POINTER(XWindowAttributes)]
x11.XInternAtom.restype = Atom
x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
x11.XGetWindowProperty.argtypes = [ctypes.c_void_p, Window, Atom, ctypes.c_long, ctypes.c_long, ctypes.c_int, Atom,
                                   ctypes.POINTER(Atom), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong),
                                   ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte))]
x11.XGetImage.restype = ctypes.POINTER(XImage)
x11.XGetImage.argtypes = [ctypes.c_void_p, Window, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                          ctypes.c_ulong, ctypes.c_int]
x11.XFree.argtypes = [ctypes.c_void_p]
x11.XFlush.argtypes = [ctypes.c_void_p]
x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
x11.XStringToKeysym.restype = ctypes.c_ulong
x11.XStringToKeysym.argtypes = [ctypes.c_char_p]
x11.XKeysymToKeycode.restype = ctypes.c_ubyte
x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
xtst.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
xtst.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

dpy = x11.XOpenDisplay(None)
if not dpy:
    sys.exit('cannot open display ' + str(os.environ.get('DISPLAY')))
root = x11.XDefaultRootWindow(dpy)


def prop_text(w, name):
    atom = x11.XInternAtom(dpy, name.encode(), 1)
    if not atom:
        return None
    t, f, n, after = Atom(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong()
    data = ctypes.POINTER(ctypes.c_ubyte)()
    if x11.XGetWindowProperty(dpy, w, atom, 0, 4096, 0, 0, ctypes.byref(t), ctypes.byref(f), ctypes.byref(n),
                              ctypes.byref(after), ctypes.byref(data)) != 0 or not data:
        return None
    raw = bytes(data[:n.value * (f.value // 8)]) if f.value else b''
    x11.XFree(data)
    return raw.decode('utf-8', 'replace')


def windows():
    r, p = Window(), Window()
    kids = ctypes.POINTER(Window)()
    n = ctypes.c_uint()
    x11.XQueryTree(dpy, root, ctypes.byref(r), ctypes.byref(p), ctypes.byref(kids), ctypes.byref(n))
    out = []
    for i in range(n.value):
        w = kids[i]
        a = XWindowAttributes()
        x11.XGetWindowAttributes(dpy, w, ctypes.byref(a))
        if a.map_state != 2:  # IsViewable
            continue
        out.append({'id': w, 'name': prop_text(w, '_NET_WM_NAME') or prop_text(w, 'WM_NAME'),
                    'x': a.x, 'y': a.y, 'w': a.width, 'h': a.height})
    if kids:
        x11.XFree(kids)
    return out


def shot(path, x=0, y=0, w=None, h=None):
    a = XWindowAttributes()
    x11.XGetWindowAttributes(dpy, root, ctypes.byref(a))
    w = w or a.width
    h = h or a.height
    img = x11.XGetImage(dpy, root, x, y, w, h, 0xFFFFFFFF, 2)  # ZPixmap
    im = img.contents
    if im.bits_per_pixel != 32:
        sys.exit('unsupported bpp %d' % im.bits_per_pixel)
    bpl = im.bytes_per_line
    buf = ctypes.string_at(im.data, bpl * h)
    raw = bytearray()
    for row in range(h):
        line = buf[row * bpl: row * bpl + w * 4]
        rgb = bytearray(w * 3)
        rgb[0::3] = line[2::4]
        rgb[1::3] = line[1::4]
        rgb[2::3] = line[0::4]
        raw += b'\x00' + rgb

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b'')
    with open(path, 'wb') as fh:
        fh.write(png)
    return {'path': path, 'w': w, 'h': h}


def click(x, y):
    xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    x11.XSync(dpy, 0)
    xtst.XTestFakeButtonEvent(dpy, 1, 1, 0)
    xtst.XTestFakeButtonEvent(dpy, 1, 0, 30)
    x11.XSync(dpy, 0)


MODS = {'ctrl': 'Control_L', 'shift': 'Shift_L', 'alt': 'Alt_L'}


def keycode(name):
    sym = x11.XStringToKeysym(name.encode())
    if not sym:
        sys.exit('unknown keysym ' + name)
    return x11.XKeysymToKeycode(dpy, sym)


def key(combo):
    parts = combo.split('+') if '+' in combo and len(combo) > 1 else [combo]
    mods = [keycode(MODS[p.lower()]) for p in parts[:-1]]
    code = keycode(parts[-1])
    for m in mods:
        xtst.XTestFakeKeyEvent(dpy, m, 1, 0)
    xtst.XTestFakeKeyEvent(dpy, code, 1, 20)
    xtst.XTestFakeKeyEvent(dpy, code, 0, 30)
    for m in reversed(mods):
        xtst.XTestFakeKeyEvent(dpy, m, 0, 10)
    x11.XSync(dpy, 0)


def move(x, y):
    xtst.XTestFakeMotionEvent(dpy, -1, x, y, 0)
    x11.XSync(dpy, 0)


cmd = sys.argv[1]
if cmd == 'list':
    print(json.dumps(windows(), ensure_ascii=False))
elif cmd == 'shot':
    args = [int(v) for v in sys.argv[3:7]]
    print(json.dumps(shot(sys.argv[2], *args)))
elif cmd == 'click':
    click(int(sys.argv[2]), int(sys.argv[3]))
    print('{"ok":true}')
elif cmd == 'key':
    key(sys.argv[2])
    print('{"ok":true}')
elif cmd == 'move':
    move(int(sys.argv[2]), int(sys.argv[3]))
    print('{"ok":true}')
else:
    sys.exit('unknown command ' + cmd)
