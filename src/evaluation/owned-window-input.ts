import { spawnSync } from "node:child_process";

// XSendEvent targets only this evaluator-owned window. Never focus/map a window,
// warp the global pointer, clear global modifiers or use XTest global input.
const motion = String.raw`import ctypes as c, sys
x = c.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes=[c.c_char_p]; x.XOpenDisplay.restype=c.c_void_p
x.XDefaultRootWindow.argtypes=[c.c_void_p]; x.XDefaultRootWindow.restype=c.c_ulong
x.XSendEvent.argtypes=[c.c_void_p,c.c_ulong,c.c_int,c.c_long,c.c_void_p]; x.XSendEvent.restype=c.c_int
x.XSync.argtypes=[c.c_void_p,c.c_int]; x.XCloseDisplay.argtypes=[c.c_void_p]
class Motion(c.Structure):
    _fields_=[('type',c.c_int),('serial',c.c_ulong),('send_event',c.c_int),('display',c.c_void_p),('window',c.c_ulong),('root',c.c_ulong),('subwindow',c.c_ulong),('time',c.c_ulong),('x',c.c_int),('y',c.c_int),('x_root',c.c_int),('y_root',c.c_int),('state',c.c_uint),('is_hint',c.c_char),('same_screen',c.c_int)]
class Event(c.Union):
    _fields_=[('motion',Motion),('padding',c.c_long*24)]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('Owned-window probe requires the native X11 display')
try:
    e=Event(); e.motion.type=6; e.motion.send_event=1; e.motion.display=d
    e.motion.window=int(sys.argv[1]); e.motion.root=x.XDefaultRootWindow(d)
    e.motion.x=950; e.motion.y=120; e.motion.same_screen=1
    if not x.XSendEvent(d,e.motion.window,0,1<<6,c.byref(e)): raise RuntimeError('Owned motion event was not accepted')
    x.XSync(d,0)
finally: x.XCloseDisplay(d)
`;

/** Privileged native conformance helper; never an actor/game capability. */
export function ownedWindowInput(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("An actual owned native PID is required");
  const executable = Bun.which("xdotool");
  if (!executable) throw new Error("Install xdotool to run the active-owner native input-isolation proof");
  const run = (args: string[]) => {
    const result = spawnSync(executable, args, { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Owned-window input probe failed: ${result.error?.message ?? result.stderr.slice(0, 500)}`);
    return result.stdout.trim();
  };
  const candidates = run(["search", "--pid", String(pid)]).split(/\s+/);
  if (candidates.length > 16 || candidates.some(value => !/^\d+$/.test(value)))
    throw new Error("Owned native window search returned an invalid or excessive result");
  const windows = candidates.filter(window => {
    if (run(["getwindowpid", window]) !== String(pid)) return false;
    const geometry = run(["getwindowgeometry", "--shell", window]);
    const width = /^WIDTH=(\d+)$/m.exec(geometry), height = /^HEIGHT=(\d+)$/m.exec(geometry);
    return width !== null && height !== null && Number(width[1]) >= 320 && Number(height[1]) >= 240;
  });
  if (windows.length !== 1) throw new Error("Native input probe requires exactly one owned game-size X11 window");
  const window = windows[0]!;
  const assertOwner = () => {
    if (run(["getwindowpid", window]) !== String(pid)) throw new Error("Native window owner changed; no input sent");
  };
  let pressed = false;
  return {
    window_id: window,
    resize(width: number, height: number) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1920 || height < 240 || height > 1080)
        throw new Error("Owned resize must remain within native capture bounds");
      assertOwner();
      run(["windowsize", "--sync", window, String(width), String(height)]);
    },
    press() {
      assertOwner(); pressed = true;
      run(["keydown", "--window", window, "w", "Control_L"]);
      run(["mousedown", "--window", window, "1"]);
      run(["mousedown", "--window", window, "3"]);
      const sent = spawnSync("/usr/bin/python3", ["-c", motion, window], { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024 });
      if (sent.error || sent.status !== 0) throw new Error(`Owned-window motion probe failed: ${sent.error?.message ?? sent.stderr.slice(0, 500)}`);
    },
    release() {
      if (!pressed) return;
      assertOwner();
      run(["mouseup", "--window", window, "1"]);
      run(["mouseup", "--window", window, "3"]);
      run(["keyup", "--window", window, "w", "Control_L"]);
      pressed = false;
    },
  };
}
