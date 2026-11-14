#!/usr/bin/env python3
"""Font editor behavior and file round trips; starts its own temporary server."""
from contextlib import ExitStack
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from playwright.sync_api import sync_playwright

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


with ExitStack() as stack, sync_playwright() as p, TemporaryDirectory(prefix='schism-fonts-') as tmp:
    handler = partial(QuietHandler, directory=str(Path(__file__).resolve().parent.parent))
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    stack.callback(server.server_close)
    stack.callback(server.shutdown)
    Thread(target=server.serve_forever, daemon=True).start()
    url = f'http://127.0.0.1:{server.server_port}/'
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    context = browser.new_context(viewport={'width': 640, 'height': 400}, accept_downloads=True)
    page = context.new_page()
    errors, warnings = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: (errors if m.type == 'error' else warnings).append(m.text)
            if m.type in ('error', 'warning') else None)
    page.on('requestfailed', lambda r: errors.append('request failed: ' + r.url))
    page.on('response', lambda r: errors.append(f'HTTP {r.status}: {r.url}') if r.status >= 400 else None)
    page.goto(url)
    page.wait_for_function('window.schism !== undefined')
    page.wait_for_timeout(300)
    page.keyboard.press('Enter')
    page.keyboard.press('F2')
    page.keyboard.press('Shift+F12')
    assert page.evaluate('window.schism.status.current_page === window.schism.PAGE.FONT_EDIT')

    def key(k):
        page.keyboard.press(k)
        page.wait_for_timeout(30)

    def glyph(ch=65):
        return page.evaluate('async ch => Array.from((await import("/js/vgamem.js")).font_normal.slice(ch*8,ch*8+8))', ch)

    def font():
        return page.evaluate('async () => Array.from((await import("/js/vgamem.js")).font_normal)')

    def point(x, y):
        box = page.locator('#screen').bounding_box()
        return box['x'] + (x*8+4)*box['width']/640, box['y'] + (y*8+4)*box['height']/400

    original = font()
    key('Control+m')
    assert page.locator('#screen').evaluate("el => el.style.cursor") == 'none'
    key('Control+m')
    assert page.locator('#screen').evaluate("el => el.style.cursor") == ''
    key('Alt+z'); key('Home'); key('Space')
    assert glyph() == [128, 0, 0, 0, 0, 0, 0, 0]
    key('Shift+ArrowRight')
    assert glyph() == [64, 0, 0, 0, 0, 0, 0, 0]
    key('Shift+ArrowDown')
    assert glyph() == [0, 64, 0, 0, 0, 0, 0, 0]
    key('BracketRight'); key('BracketLeft')
    assert glyph() == [0, 64, 0, 0, 0, 0, 0, 0]
    key('Alt+h'); key('Alt+v')
    assert glyph() == [0, 0, 0, 0, 0, 0, 2, 0]
    key('Alt+c'); key('Equal'); key('Alt+z'); key('Alt+p')
    assert glyph(66) == glyph(65)
    key('Alt+i'); key('Alt+m')
    assert glyph(66) == [255] * 8
    key('Alt+Backspace')
    assert glyph(66) == original[66*8:67*8]
    key('Minus'); key('Alt+Backspace')
    assert font() == original
    print('PASS pixel editing, wrapped shifts, rotations, flips, copy/paste/mix, invert, per-glyph reset')

    key('Alt+z'); key('Home'); key('Shift+Insert')
    assert glyph() == [128] * 8, 'Shift-Insert must fill a column in the font editor'
    key('Shift+Delete'); key('Insert')
    assert glyph() == [255, 0, 0, 0, 0, 0, 0, 0]
    key('Delete')
    assert glyph() == [0] * 8
    page.mouse.click(*point(4, 7))
    assert glyph() == [128, 0, 0, 0, 0, 0, 0, 0]
    page.mouse.move(*point(5, 8))
    page.mouse.down()
    page.mouse.move(*point(6, 9))
    page.mouse.up()
    assert glyph()[1:3] == [64, 32]
    page.mouse.click(*point(4, 7), button='right')
    assert glyph()[0] == 0
    key('Alt+Backspace')
    print('PASS row/column fill and clear, mouse drawing, dragging and right-button erase')

    key('F3'); key('Home'); key('ArrowLeft'); key('F2'); key('Alt+z')
    assert glyph(15) == [0] * 8
    key('Alt+Backspace'); key('F3'); key('End'); key('ArrowDown'); key('F2'); key('Alt+z')
    assert glyph(15) == [0] * 8
    key('Alt+Backspace'); key('F4'); key('Home'); key('F2'); key('Alt+z')
    assert glyph(128) == [0] * 8
    key('Backspace')
    assert glyph(128) == original[128*8:129*8]
    key('Control+Backspace')
    bios = page.evaluate('async () => Array.from((await import("/js/gen/fonts.js")).FONTS.default_upper_alt)')
    assert font()[1024:] == bios
    key('Backspace')
    assert font() == original
    print('PASS character-map wrapping, preview navigation, upper-font and BIOS resets')

    raw = bytes(original)
    fixtures = [(raw, 0), (raw + b'\x12\x02', 0), (raw + b'\x09\x02', 0),
                (raw + b'\x00\x02', -1), (raw[:-1], -1)]
    for data, expected in fixtures:
        result = page.evaluate('async data => (await import("/js/fonts.js")).font_load_data(Uint8Array.from(data))', list(data))
        assert result == expected
        assert font() == original
    tall = bytes(n for b in raw for n in (b, 0))
    result = page.evaluate('async data => (await import("/js/fonts.js")).font_load_data(Uint8Array.from(data))', list(tall))
    assert result == 0 and font() == original
    print('PASS raw 8x8, ITF signatures, 8x16 row merging and atomic malformed-file rejection')

    # Import through the real file picker, then save and verify the actual download.
    imported = bytearray(raw)
    imported[65*8:66*8] = bytes([129, 66, 36, 24, 24, 36, 66, 129])
    key('F9'); key('End')
    with page.expect_file_chooser() as picker:
        key('Enter')
    picker.value.set_files({'name': 'custom.itf', 'mimeType': 'application/octet-stream', 'buffer': bytes(imported) + b'\x12\x02'})
    page.wait_for_function('''async () => (await import('/js/vgamem.js')).font_normal[65*8] === 129''')
    assert font() == list(imported)
    key('F10')
    with page.expect_download() as download:
        key('Enter')
    assert download.value.suggested_filename == 'font.cfg'
    out = Path(tmp) / 'font.cfg'
    download.value.save_as(out)
    assert out.read_bytes() == bytes(imported) + b'\x12\x02'
    stored = page.evaluate('async () => Array.from((await import("/js/dmoz.js")).dmoz_read_file("/Fonts/font.cfg"))')
    assert bytes(stored) == out.read_bytes()
    print('PASS real file import, ITF download and virtual-disk save')

    # Overwriting a named font uses the existing Schism confirmation dialog.
    key('F10'); key('ArrowDown'); key('Enter')
    assert page.evaluate('window.schism.status.dialog_type !== 0')
    before = font()
    key('Alt+z')
    assert font() == before, 'font editor must not process shortcuts through a dialog'
    key('Escape')
    page.reload()
    page.wait_for_function('window.schism !== undefined')
    page.wait_for_function('''async () => (await import('/js/vgamem.js')).font_normal[65*8] === 129''')
    assert font() == list(imported)
    key('Enter'); key('F2'); key('Shift+F12'); key('Control+q')
    assert page.evaluate('window.schism.status.current_page === window.schism.PAGE.PATTERN_EDITOR')
    print('PASS overwrite dialog isolation, default font persistence and return to tracker')

    key('Shift+F12'); key('F3'); key('Home')
    for _ in range(4):
        key('ArrowDown')
    key('ArrowRight'); key('F2'); key('Alt+z')
    assert glyph() == [0] * 8
    key('F9'); key('ArrowDown'); key('Enter')
    assert font() == list(imported), 'font list must reload the named imported font'
    # Drop an 8x16 font through the same file handler used by drag/drop.
    page.evaluate('''async data => {
        await window.schism.app.load_file_object(new File([Uint8Array.from(data)], 'tall.fnt'));
    }''', list(tall))
    assert font() == original
    key('Control+e')
    assert font() == list(imported), 'Ctrl-E must reload the saved default font'
    replacement = bytearray(imported)
    replacement[65*8] = 85
    page.evaluate('''async data => {
        (await import('/js/dmoz.js')).dmoz_write_file('/Fonts/font.cfg', Uint8Array.from(data));
        window.schism.app.font_init();
    }''', list(bytes(replacement) + b'\x12\x02'))
    assert font() == list(replacement), 'a newer virtual-disk font.cfg must take priority over the cached default'
    page.evaluate("localStorage.removeItem('schism-font')")
    page.reload()
    page.wait_for_function('window.schism !== undefined')
    page.wait_for_function('''async () => (await import('/js/vgamem.js')).font_normal[65*8] === 85''')
    assert font() == list(replacement), 'IndexedDB must restore font.cfg without the localStorage cache'
    print('PASS named font loading, dropped 8x16 font, Ctrl-E and IndexedDB default restoration')

    assert not errors, errors
    assert page.evaluate('window.schism.missing_calls()') == []
    page.locator('#screen').screenshot(path='/tmp/schism-fonts-tested.png')
    print(f'Font checks passed; no browser errors; {len(warnings)} warnings', warnings)
    browser.close()
