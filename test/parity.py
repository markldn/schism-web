#!/usr/bin/env python3
"""Pixel-compare this JS port against the reference build of the original C code.

The reference is ../schism-web/dist (the same Schism source compiled with
Emscripten). Both are driven with the same keys in headless Chrome and the
640x400 frames are compared per region.

Usage: test/parity.py [outdir]
"""
import base64, io, subprocess, sys, time
from pathlib import Path
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent.parent
REF = HERE.parent / "schism-web" / "dist"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "test" / "out"
OUT.mkdir(parents=True, exist_ok=True)
CHROME = "/usr/bin/google-chrome"

# (name, keys to press after reaching the pattern editor, [(region name, x1, y1, x2, y2 in cells)])
TOP = ("top info", 0, 0, 61, 8)          # excludes the visualiser box and the clock
TITLE = ("title bar", 0, 10, 79, 11)
BODY = ("page body", 0, 10, 79, 48)  # row 49 is border only; the reference draws its cursor there
CASES = [
    ("pattern-frame", [], [TOP, TITLE]),
    ("main-menu", ["Escape"], [TOP, TITLE, ("main menu", 6, 11, 38, 46)]),
    ("file-menu", ["Escape", "Enter"], [("main menu", 6, 11, 38, 46), ("submenu", 25, 13, 54, 39)]),
    ("playback-menu", ["Escape", "ArrowDown", "Enter"], [("main menu", 6, 11, 38, 46), ("submenu", 25, 13, 59, 45)]),
    ("sample-menu", ["Escape", "ArrowDown", "ArrowDown", "ArrowDown", "Enter"], [("main menu", 6, 11, 38, 46), ("submenu", 25, 20, 57, 31)]),
    ("instrument-menu", ["Escape", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", "Enter"], [("main menu", 6, 11, 38, 46), ("submenu", 20, 23, 56, 34)]),
    # the reference has no window manager, so its settings menu lacks "Toggle Fullscreen";
    # only the part of the main menu left of the submenu is comparable
    ("settings-menu", ["Escape", "End", "ArrowUp", "Enter"], [("main menu", 6, 11, 21, 46)]),
    ("new-song-dialog", ["Control+n"], [("dialog", 21, 20, 58, 38)]),
    ("new-song-keep", ["Control+n", "ArrowUp", "ArrowLeft", "Enter", "ArrowUp", "Enter"], [("dialog", 21, 20, 58, 38)]),
    ("exit-prompt", ["Control+q"], [("dialog", 26, 25, 54, 32)]),
    ("exit-prompt-cancel", ["Control+q", "ArrowRight"], [("dialog", 26, 25, 54, 32)]),
    ("timejump", ["Control+g", "1", "2", "Tab", "3"], [("dialog", 26, 24, 55, 31)]),
    ("octave-keys", ["Alt+End", "Alt+End", "Alt+Home", "Alt+End"], [TOP]),
    ("sample-list-frame", ["F3"], [TOP, TITLE]),
    ("load-module-frame", ["F9"], [TOP, TITLE]),
    # whole page bodies of the ported pages (empty song)
    ("pattern-editor", [], [TOP, BODY]),
    ("pattern-cursor", ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "Tab", "Tab"], [BODY]),
    ("pattern-notes", ["q", "w", "e", "ArrowRight", "4", "Tab", "z", "x"], [BODY]),
    ("sample-list", ["F3"], [TOP, BODY]),
    ("instrument-general", ["F4"], [BODY]),
    ("instrument-volume", ["F4", "F4"], [BODY]),
    ("instrument-panning", ["F4", "F4", "F4"], [BODY]),
    ("instrument-pitch", ["F4", "F4", "F4", "F4"], [BODY]),
    ("order-pan", ["F11"], [BODY]),
    ("order-vol", ["F11", "F11"], [BODY]),
    ("info-page", ["F5", "F8"], [BODY]),
    ("song-vars", ["F12"], [("song vars", 0, 10, 79, 40)]),  # directory rows differ by design (browser store)
    ("message", ["Shift+F9"], [BODY]),
    ("help", ["F1"], [BODY]),
    ("config", ["Control+F1"], [("config", 0, 10, 79, 26)]),
    ("pattern-options", ["F2"], [("dialog", 10, 18, 69, 43)]),
    ("font-editor", ["Shift+F12"], [("font editor", 0, 0, 79, 45)]),
    ("font-charmap", ["Shift+F12", "F3", "ArrowRight", "ArrowDown"], [("font editor", 0, 0, 79, 45)]),
    ("font-preview", ["Shift+F12", "F4", "Home", "ArrowRight"], [("font editor", 0, 0, 79, 45)]),
    ("font-edit", ["Shift+F12", "Alt+z", "Home", "Space", "Shift+ArrowRight", "BracketRight", "Alt+i"], [("font editor", 0, 0, 79, 45)]),
]

def serve(directory, port):
    p = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "-d", str(directory)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    return p

def grab_js(pg):
    data = pg.evaluate("document.getElementById('screen').toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(data.split(",")[1]))).convert("RGB")

def grab_ref(pg):
    return Image.open(io.BytesIO(pg.locator("#canvas").screenshot())).convert("RGB")

def main():
    servers = [serve(HERE, 8778), serve(REF, 8779)]
    failures = 0
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(headless=True, executable_path=CHROME)
            errors = []
            js = b.new_context(viewport={"width": 800, "height": 600}).new_page()
            js.on("pageerror", lambda e: errors.append(str(e)))
            js.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            # the reference canvas fills the area under its 29px toolbar: make that exactly 640x400
            ref = b.new_context(viewport={"width": 640, "height": 429}).new_page()

            only = [a for a in sys.argv[2:]]
            for name, keys, regions in CASES:
                if only and name not in only: continue
                js.goto("http://127.0.0.1:8778/")
                js.wait_for_function("window.schism && document.getElementById('screen').width === 640")
                js.wait_for_timeout(100)
                js.keyboard.press("Enter"); js.wait_for_timeout(150)     # dismiss the About box
                js.keyboard.press("F2"); js.wait_for_timeout(150)
                ref.goto("http://127.0.0.1:8779/"); ref.wait_for_timeout(2500)
                ref.mouse.move(639, 428)  # parks the reference cursor on the bottom-right border pixel
                ref.keyboard.press("Enter"); ref.wait_for_timeout(200)   # dismiss the About box
                ref.keyboard.press("F2"); ref.wait_for_timeout(200)
                for key in keys:
                    js.keyboard.press(key); ref.keyboard.press(key)
                    js.wait_for_timeout(80); ref.wait_for_timeout(150)
                js.wait_for_timeout(1300); ref.wait_for_timeout(1300)    # let flashed status text expire
                a, r = grab_js(js), grab_ref(ref)
                assert a.size == (640, 400), a.size
                if r.size != (640, 400):
                    print(f"{name}: reference frame is {r.size}, expected 640x400"); failures += 1; continue
                sheet = Image.new("RGB", (1280, 400)); sheet.paste(a, (0, 0)); sheet.paste(r, (640, 0))
                sheet.save(OUT / f"{name}.png")
                for rname, x1, y1, x2, y2 in regions:
                    box = (x1 * 8, y1 * 8, (x2 + 1) * 8, (y2 + 1) * 8)
                    diff = ImageChops.difference(a.crop(box), r.crop(box)).convert("L")
                    bad = sum(1 for v in diff.tobytes() if v)
                    total = (box[2] - box[0]) * (box[3] - box[1])
                    print(f"{name:20s} {rname:10s} {'OK  ' if not bad else 'DIFF'} {bad}/{total} px differ")
                    failures += bool(bad)
            if errors:
                print("JS errors:", *errors[:10], sep="\n  "); failures += 1
            print("unported calls hit:", js.evaluate("window.schism.missing_calls()"))
            b.close()
    finally:
        for s in servers: s.terminate()
    print("PARITY", "FAILED" if failures else "OK")
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
