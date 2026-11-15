// The hands of the person in a Mac rehearsal run: the mouse and the keyboard of the Mac's real
// desktop session, driven with CGEvent, and nothing else. It is compiled on the rented Mac by
// prepare.sh and run inside the desktop session (launchctl asuser), where it has been allowed to
// control the computer.
//
// Points are given in the pixels of the picture `person look` returns, which is the whole screen
// scaled to PICTURE_WIDTH pixels wide; this tool turns them into the screen's own points.
//
//   hands size                         the screen's size in points and the picture's scale
//   hands click X Y | double X Y | right X Y
//   hands drag X1 Y1 X2 Y2 [X3 Y3 ...] press at the first point, move through the others, let go
//   hands scroll X Y up|down [N]       N notches of the wheel (3 if not given)
//   hands type TEXT | hands type -     types the text (or standard input), a character at a time
//   hands key NAME                     one key or chord: Return, Tab, Escape, Up, cmd+q, ctrl+c ...
//   hands place APP X Y W H            moves and sizes APP's front window, in screen points (harness only)
import AppKit
import ApplicationServices
import Foundation

let PICTURE_WIDTH = 1280.0
let screen = CGDisplayBounds(CGMainDisplayID())
let scale = screen.width / PICTURE_WIDTH
let src = CGEventSource(stateID: .hidSystemState)

func fail(_ s: String) -> Never {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  exit(2)
}
func pause(_ ms: Int) { usleep(useconds_t(ms * 1000)) }
func point(_ x: String, _ y: String) -> CGPoint {
  guard let px = Double(x), let py = Double(y) else { fail("Give numbers for points.") }
  return CGPoint(x: min(max(px * scale, 0), screen.width - 1), y: min(max(py * scale, 0), screen.height - 1))
}
func post(_ e: CGEvent?) {
  e?.post(tap: .cghidEventTap)
}
func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
  let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button)
  e?.setIntegerValueField(.mouseEventClickState, value: clicks)
  post(e)
}
func moveTo(_ p: CGPoint) {
  mouse(.mouseMoved, p)
  pause(60)
}

let KEYS: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
  "left": 123, "right": 124, "down": 125, "up": 126, "forwarddelete": 117, "home": 115, "end": 119,
  "pageup": 116, "pagedown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
  "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
  "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
  "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]
let MODS: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "ctrl": .maskControl, "control": .maskControl,
  "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate, "shift": .maskShift,
]

func press(_ code: CGKeyCode, _ flags: CGEventFlags = []) {
  let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
  down?.flags = flags
  post(down)
  pause(30)
  let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
  up?.flags = flags
  post(up)
  pause(30)
}

func typeText(_ text: String) {
  for ch in text {
    if ch == "\n" {
      press(36)
      continue
    }
    let units = Array(String(ch).utf16)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    post(down)
    pause(12)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    post(up)
    pause(28)
  }
}

func place(_ app: String, _ x: Double, _ y: Double, _ w: Double, _ h: Double) {
  guard AXIsProcessTrusted() else { fail("This tool is not allowed to control the computer.") }
  let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName == app }
  guard let target = apps.first else { fail("\(app) is not running.") }
  let ax = AXUIElementCreateApplication(target.processIdentifier)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &value) == .success,
    let windows = value as? [AXUIElement], let win = windows.first
  else { fail("\(app) has no window.") }
  var pos = CGPoint(x: x, y: y)
  var size = CGSize(width: w, height: h)
  if let p = AXValueCreate(.cgPoint, &pos) { AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, p) }
  if let s = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(win, kAXSizeAttribute as CFString, s) }
  if let p = AXValueCreate(.cgPoint, &pos) { AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, p) }
}

var args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("Name a command.") }
args.removeFirst()

switch cmd {
case "size":
  print("\(Int(screen.width)) \(Int(screen.height)) \(scale) trusted=\(AXIsProcessTrusted())")
case "click", "double", "right":
  guard args.count == 2 else { fail("Give X and Y.") }
  let p = point(args[0], args[1])
  moveTo(p)
  if cmd == "right" {
    mouse(.rightMouseDown, p, .right)
    pause(50)
    mouse(.rightMouseUp, p, .right)
  } else {
    mouse(.leftMouseDown, p)
    pause(50)
    mouse(.leftMouseUp, p)
    if cmd == "double" {
      pause(90)
      mouse(.leftMouseDown, p, clicks: 2)
      pause(50)
      mouse(.leftMouseUp, p, clicks: 2)
    }
  }
case "drag":
  guard args.count >= 4, args.count % 2 == 0 else { fail("Give at least two points.") }
  var pts: [CGPoint] = []
  var i = 0
  while i < args.count {
    pts.append(point(args[i], args[i + 1]))
    i += 2
  }
  moveTo(pts[0])
  mouse(.leftMouseDown, pts[0])
  pause(150)
  var last = pts[0]
  for next in pts.dropFirst() {
    for step in 1...16 {
      let t = Double(step) / 16
      let p = CGPoint(x: last.x + (next.x - last.x) * t, y: last.y + (next.y - last.y) * t)
      mouse(.leftMouseDragged, p)
      pause(18)
    }
    last = next
  }
  pause(150)
  mouse(.leftMouseUp, last)
case "scroll":
  guard args.count >= 2 else { fail("Give X and Y.") }
  let p = point(args[0], args[1])
  let up = args.count > 2 && args[2] == "up"
  let n = args.count > 3 ? (Int(args[3]) ?? 3) : 3
  moveTo(p)
  for _ in 0..<max(1, min(n, 30)) {
    post(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: Int32(up ? 3 : -3), wheel2: 0, wheel3: 0))
    pause(60)
  }
case "type":
  // "-" reads the text from standard input, so that it never passes through a shell's quoting
  if args == ["-"] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    typeText(String(decoding: data, as: UTF8.self))
  } else {
    typeText(args.joined(separator: " "))
  }
case "key":
  guard args.count == 1 else { fail("Name one key, such as Return or cmd+q.") }
  let parts = args[0].lowercased().split(separator: "+").map(String.init)
  var flags: CGEventFlags = []
  for m in parts.dropLast() {
    guard let f = MODS[m] else { fail("Unknown modifier \(m).") }
    flags.insert(f)
  }
  guard let last = parts.last, let code = KEYS[last] else { fail("Unknown key \(args[0]).") }
  press(code, flags)
case "place":
  guard args.count == 5, let x = Double(args[1]), let y = Double(args[2]), let w = Double(args[3]), let h = Double(args[4]) else {
    fail("place APP X Y W H")
  }
  place(args[0], x, y, w, h)
default:
  fail("Unknown command \(cmd).")
}
