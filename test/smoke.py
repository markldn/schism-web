#!/usr/bin/env python3
"""Headless smoke test: load the page, load a module, press keys, screenshot.
Usage: test/smoke.py out_dir [module] [keys...]   (server must run on :8778)"""
import sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
mod = sys.argv[2] if len(sys.argv) > 2 else 'test/data/tute.it'
keys = sys.argv[3:]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width': 1280, 'height': 960})
    errs = []
    pg.on('console', lambda m: errs.append(f'{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
    pg.goto('http://127.0.0.1:8778/?nocache=%d' % time.time())
    pg.wait_for_timeout(500)
    if mod != '-':
        ok = pg.evaluate("""async (u) => { const r = await fetch(u); const d = new Uint8Array(await r.arrayBuffer());
            return window.schism.song_load_data(u.split('/').pop(), d); }""", '/' + mod)
        print('load ->', ok)
    pg.wait_for_timeout(300)
    pg.locator('#screen').focus()
    for i, k in enumerate(keys):
        if k.startswith('wait'):
            pg.wait_for_timeout(int(k[4:])); continue
        if k.startswith('shot'):
            pg.locator('#screen').screenshot(path=str(out / f'{k[4:] or i}.png')); continue
        pg.keyboard.press(k)
        pg.wait_for_timeout(60)
    pg.wait_for_timeout(300)
    pg.locator('#screen').screenshot(path=str(out / 'final.png'))
    info = pg.evaluate("() => ({page: window.schism.status.current_page, missing: window.schism.missing_calls(), row: window.schism.song().row, order: window.schism.song().current_order})")
    print(info)
    for e in errs[:30]: print(e)
    b.close()
