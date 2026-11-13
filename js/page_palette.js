// Port of schism/page_palette.c (Schism Tracker, GPL-2.0-or-later).
// Copy/paste uses the browser clipboard with Schism's 48-character palette string.
import { app, provide, optional } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, CLASSIC_MODE } from './state.js';
import { draw_text, draw_box, draw_fill_chars, DEFAULT_FG, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_RELEASE, NO_MODIFIER } from './keyboard.js';
import { ui, widget_create_thumbbar, widget_create_listbox, widget_create_button, widget_change_focus_to } from './widget.js';
import { pages } from './page.js';
import * as P from './palettes.js';

const w = [];
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._';
const palette_to_string = idx => (idx === P.current_palette_index ? P.current_palette : P.palettes[idx].colors)
	.flat().map(v => CHARS[v & 63]).join('');
function set_palette_from_string(s) {
	s = s.trim();
	if (s.length !== 48) return 0;
	const vals = [...s].map(c => CHARS.indexOf(c));
	if (vals.some(v => v < 0)) return 0;
	for (let n = 0; n < 16; n++) P.palettes[0].colors[n] = vals.slice(n * 3, n * 3 + 3);
	return 1;
}
function palette_draw_const() {
	draw_text('Predefined Palettes', 56, 24, 0, 2);
	for (let n = 0; n < 7; n++) {
		draw_box(2, 13 + 5 * n, 8, 17 + 5 * n, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(9, 13 + 5 * n, 19, 17 + 5 * n, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(29, 13 + 5 * n, 35, 17 + 5 * n, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(36, 13 + 5 * n, 46, 17 + 5 * n, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_fill_chars(3, 14 + 5 * n, 7, 16 + 5 * n, DEFAULT_FG, n);
		draw_fill_chars(30, 14 + 5 * n, 34, 16 + 5 * n, DEFAULT_FG, n + 7);
	}
	draw_box(56, 13, 62, 17, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(63, 13, 73, 17, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(56, 18, 62, 22, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(63, 18, 73, 22, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(54, 25, 77, 41, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_fill_chars(57, 14, 61, 16, DEFAULT_FG, 14);
	draw_fill_chars(57, 19, 61, 21, DEFAULT_FG, 15);
}
function update_thumbbars() {
	for (let n = 0; n < 16; n++) for (let c = 0; c < 3; c++) w[3 * n + c].d.value = P.current_palette[n][c];
}
function copy(idx) {
	try { navigator.clipboard?.writeText(palette_to_string(idx)); app.status_text_flash('Palette copied'); } catch { /* ignore */ }
}
async function paste() {
	let text = '';
	try { text = await navigator.clipboard.readText(); } catch { app.status_text_flash('Clipboard not readable'); return; }
	if (!set_palette_from_string(text)) { app.status_text_flash('Bad character or wrong length'); return; }
	w[48].d.focus = 0;
	P.palette_load_preset(0);
	P.palette_apply();
	update_thumbbars();
	status.flags |= NEED_UPDATE;
	app.status_text_flash('Palette pasted');
}
function update_palette() {
	for (let n = 0; n < 16; n++) for (let c = 0; c < 3; c++) P.current_palette[n][c] = w[3 * n + c].d.value;
	w[48].d.focus = 0;
	P.palettes[0].colors = P.current_palette.map(c => c.slice());
	P.set_current_palette_index(0);
	P.palette_apply();
	optional('cfg_save', true);
	status.flags |= NEED_UPDATE;
}
function palette_list_handle_key(k) {
	let n = ui.holder.selected_widget;
	if (k.state === KEY_RELEASE) return;
	switch (k.sym) {
	case KEYSYM.PAGEUP: if (!NO_MODIFIER(k.mod)) n -= 3; break;
	case KEYSYM.PAGEDOWN: if (!NO_MODIFIER(k.mod)) n += 3; break;
	case KEYSYM.c: if (k.mod & KEYMOD.CTRL) { copy(P.current_palette_index); return; } break;
	case KEYSYM.v: if (k.mod & KEYMOD.CTRL) { paste(); return; } break;
	default: return;
	}
	if (status.flags & CLASSIC_MODE) { if (n < 0) return; if (n > 48) n = 48; }
	else n = Math.max(0, Math.min(n, 48));
	if (n !== ui.holder.selected_widget) widget_change_focus_to(n);
}

for (let n = 0; n < 16; n++) {
	let tabs = [0, 1, 2].map(x => 3 * n + 21 + x);
	if (n >= 9 && n <= 13) tabs = [48, 48, 48];
	else if (n > 13) tabs = [3 * n - 42, 3 * n - 41, 3 * n - 40];
	const x = 10 + 27 * Math.trunc(n / 7), y = 5 * (n % 7) + 14;
	w[3 * n] = widget_create_thumbbar(x, y, 9, n ? 3 * n - 1 : 0, 3 * n + 1, tabs[0], update_palette, 0, 63);
	w[3 * n + 1] = widget_create_thumbbar(x, y + 1, 9, 3 * n, 3 * n + 2, tabs[1], update_palette, 0, 63);
	w[3 * n + 2] = widget_create_thumbbar(x, y + 2, 9, 3 * n + 1, 3 * n + 3, tabs[2], update_palette, 0, 63);
}
w[48] = widget_create_listbox(() => P.palettes.length, i => i === P.current_palette_index, i => P.palettes[i].name, null,
	() => { P.palette_load_preset(w[48].d.focus); P.palette_apply(); update_thumbbars(); status.flags |= NEED_UPDATE; },
	k => { if (k.sym === KEYSYM.c && (k.mod & KEYMOD.CTRL)) { copy(w[48].d.focus); return 1; } return 0; },
	[29, 30, 30, 31, 32, 32, 33, 33, 34, 35, 35, 36, 36, 37, 38, 39, 40, 40, 41, 42],
	[8, 9, 9, 10, 11, 11, 12, 12, 13, 14, 14, 15, 15, 16, 17, 18, 19, 19, 20, 21], 47, 49);
Object.assign(w[48], { x: 55, y: 26, width: 22, height: 15 });
w[48].d.focus = P.current_palette_index;
for (let n = 6; n < 18; n++) w[n].next.backtab = 48;
w[49] = widget_create_button(55, 43, 20, 48, 50, 39, 18, 18, () => copy(P.current_palette_index), 'Copy To Clipboard', 3);
w[50] = widget_create_button(55, 46, 20, 49, 0, 39, 18, 18, paste, 'Paste From Clipboard', 1);
w[0].next.up = 50;
w[39].next.tab = w[40].next.tab = w[41].next.tab = 49;
update_thumbbars();
Object.assign(pages[PAGE.PALETTE_EDITOR], { title: 'Palette Configuration (Ctrl-F12)', draw_const: palette_draw_const,
	handle_key: palette_list_handle_key, total_widgets: 51, selected_widget: 48, widgets: w, help_index: HELP.PALETTES,
	set_page: update_thumbbars, ported: true });
provide({});
