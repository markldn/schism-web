#!/usr/bin/env python3
"""Browser clipboard regression checks. Serve the repository on :8778 first."""
from playwright.sync_api import sync_playwright

PATTERN = 'Pasted Pattern - IT\r\n|C-401v32A06|D#5:0p64Z7F\r\n|===........|^^^........\r\n'

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'])
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    def fresh():
        page.goto('http://127.0.0.1:8778/')
        page.wait_for_function('window.schism !== undefined')
        page.keyboard.press('Enter')
        page.keyboard.press('F2')
        page.locator('#screen').focus()

    def write(text):
        page.evaluate('(text) => navigator.clipboard.writeText(text)', text)

    def paste(text, key='Control+v'):
        write(text)
        page.keyboard.press(key)
        page.wait_for_timeout(100)

    def note(row=0, channel=0):
        return page.evaluate('([r,c]) => window.schism.song().patterns[0][r*64+c]', [row, channel])

    fresh()
    paste(PATTERN)
    assert note() == dict(note=49, instrument=1, voleffect=1, volparam=32, effect=16, param=6), note()
    assert note(0, 1)['instrument'] == 100
    assert note(0, 1)['note'] == 64
    assert note(1)['note'] == 255 and note(1, 1)['note'] == 254
    page.keyboard.press('Control+Backspace')
    page.keyboard.press('Enter')
    assert note()['note'] == 0, 'paste must be undoable'
    paste(PATTERN, 'Shift+Insert')
    assert note()['note'] == 49
    print('PASS trusted Ctrl-V / Shift-Insert, fields, controls, instrument 100 and undo')

    # Exercise the decoder with external MOD/XM data, ragged rows, no final newline,
    # malformed input and bounds, independently of paste placement.
    result = page.evaluate('''async () => {
        const {pattern_selection_system_paste_modplug: parse} = await import('/js/pattern-clipboard.js');
        return {
            mod: parse('ModPlug Tracker MOD\\n|Db401...F7F'),
            xm: parse('ModPlug Tracker  XM\\n|C-401...A0F'),
            ragged: parse('Pasted Pattern - IT\\n|C-401......|~~~........\\n|D-402......'),
            malformed: parse('Pasted Pattern - IT\\n|C-401..'),
            unknown: parse('Pasted Pattern - ABC\\n|C-401......'),
            bounded: parse('Pasted Pattern - IT\\n' + ('|' + 'C-401......|'.repeat(70) + '\\n').repeat(210))
        };
    }''')
    assert result['mod']['data'][0]['note'] == 50
    assert result['mod']['data'][0]['param'] == 127
    assert result['xm']['data'][0]['effect'] == 11
    assert result['ragged']['channels'] == 2 and result['ragged']['rows'] == 2
    assert result['ragged']['data'][1]['note'] == 246
    assert result['ragged']['data'][3]['note'] == 0
    assert result['malformed'] is None and result['unknown'] is None
    assert result['bounded']['channels'] == 64 and result['bounded']['rows'] == 200
    print('PASS MOD/XM effect mapping, flat notes, fade, padding, malformed data and bounds')

    fresh()
    paste(PATTERN, 'Alt+o')
    assert note()['note'] == 49
    paste('Pasted Pattern - IT\n|F-401......', 'Alt+p')
    assert note()['note'] == 54 and note(1)['note'] == 49
    # Denied read preserves the internal clipboard from the preceding paste.
    page.evaluate("Object.defineProperty(navigator.clipboard, 'readText', {configurable:true, value:async()=>{throw new Error('denied')}})")
    page.keyboard.press('ArrowDown')
    page.keyboard.press('Alt+o')
    page.wait_for_timeout(100)
    assert note(1)['note'] == 54
    print('PASS Alt-O overwrite, Alt-P insert and denied-read internal fallback')

    fresh()
    paste(PATTERN)
    page.keyboard.press('Alt+b')
    page.evaluate('window.schism.app.set_current_channel(2)')
    page.keyboard.press('Alt+e')
    page.keyboard.press('Alt+c')
    page.wait_for_timeout(100)
    copied = page.evaluate('navigator.clipboard.readText()')
    assert 'D#5:0p64Z7F' in copied, copied
    page.evaluate('window.schism.app.set_current_row(2)')
    page.evaluate('window.schism.app.set_current_channel(1)')
    page.keyboard.press('Control+v')
    page.wait_for_timeout(100)
    assert note(2, 1)['instrument'] == 100
    print('PASS copy to system clipboard and paste back, preserving instrument 100')

    fresh()
    paste('Pasted Pattern - IT\n|C-401......')
    paste('Pasted Pattern - IT\n|D-402v32A06', 'Alt+m')
    assert note()['note'] == 49, 'mix notes must preserve occupied notes'
    page.keyboard.press('Alt+m')
    page.wait_for_timeout(100)
    assert note()['note'] == 49 and note()['voleffect'] == 1
    print('PASS Alt-M mix notes and repeated Alt-M mix fields')

    fresh()
    page.evaluate('window.schism.app.set_current_row(63)')
    paste(PATTERN, 'Alt+o')
    page.keyboard.press('Alt+o')
    page.wait_for_timeout(100)
    assert note(64)['note'] == 255
    print('PASS repeated Alt-O grows the pattern')

    fresh()
    page.keyboard.press('Shift+F9')
    page.keyboard.press('Enter')
    paste('hello\r\nworld')
    assert page.evaluate('window.schism.song().message') == 'hello\nworld'
    print('PASS multiline song message paste with CRLF normalization')

    fresh()
    page.keyboard.press('F12')
    # Song title is the first text widget on this page.
    paste('Clipboard title')
    assert page.evaluate('window.schism.song().title') == 'Clipboard title'
    print('PASS text widget paste')

    fresh()
    page.keyboard.press('Control+n')
    paste(PATTERN)
    assert note()['note'] == 0, 'dialog paste must not reach the pattern underneath'
    print('PASS modal dialog isolates the pattern editor')

    fresh()
    page.evaluate('window.schism.app.set_current_channel(64)')
    paste(PATTERN)
    assert note(0, 63)['note'] == 49 and note(1)['note'] == 0
    print('PASS paste clips at channel 64 without spilling into the next row')

    fresh()
    page.evaluate("Object.defineProperty(navigator.clipboard, 'readText', {configurable:true, value:()=>new Promise(r=>window.resolvePaste=r)})")
    page.keyboard.press('Alt+o')
    page.keyboard.press('F3')
    page.evaluate('(text) => window.resolvePaste(text)', PATTERN)
    page.wait_for_timeout(100)
    assert note()['note'] == 0
    print('PASS navigation cancels pending permission/read')

    assert not errors, errors
    assert page.evaluate('window.schism.missing_calls()') == []
    browser.close()
    print('Clipboard checks passed; no browser errors or missing providers')
