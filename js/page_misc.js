// Ports of schism/page_help.c, schism/page_log.c and schism/page_about.c
// (Schism Tracker, GPL-2.0-or-later).
import { app, provide } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, CLASSIC_MODE, DIALOG_NONE, DIR_MODULES_CHANGED } from './state.js';
import { draw_text, draw_text_len, draw_text_bios_len, draw_char, draw_box, draw_fill_chars, vgamem_ovl_alloc,
	vgamem_ovl_clear, vgamem_ovl_apply, vgamem_ovl_drawpixel, DEFAULT_FG, BOX_THICK, BOX_THIN, BOX_INNER, BOX_INSET,
	BOX_OUTER, BOX_FLAT_DARK } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_RELEASE, MOUSE_NONE, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, KEY_PRESS } from './keyboard.js';
import { widget_create_other, widget_create_button, widget_change_focus_to, MOUSE_SCROLL_LINES } from './widget.js';
import { dialog_create_custom, dialog_yes_NULL, dialog_destroy } from './dialog.js';
import { pages, set_page, schism_banner } from './page.js';
import { HELP_TEXT } from './gen/helptext.js';
import { logo_schism, logo_it } from './gen/logos.js';

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

// ------------------------------------------------------------------ help
const help_cache = {};
let lines = [], num_lines = 0, top_line = 0;
const help_text_lastpos = {};
const LINE_SCHISM_HIDDEN = l => l[0] === '!';
const LINE_CLASSIC_HIDDEN = l => l[0] === ':' || l[0] === ';';
const LINE_BIOS = l => l[0] === '+' || l[0] === ';';
function help_redraw() {
	const graphic = [0, 0x89, 0x8f, 0x96, 0x84, 0, 0x91, 0x8b, 0x86, 0x8a];
	draw_fill_chars(2, 13, 77, 44, DEFAULT_FG, 0);
	for (let pos = 13, n = top_line; pos < 45 && n < lines.length; pos++, n++) {
		const l = lines[n];
		switch (l[0]) {
		case '=':
			for (let x = 1; x < l.length; x++) {
				let ch = l.charCodeAt(x);
				if (ch >= 49 && ch <= 57) ch = graphic[ch - 48];
				draw_char(ch, x + 1, pos, 6, 0);
			}
			break;
		case '%': for (let x = 2; x < 78; x++) draw_char(154, x, pos, 6, 0); break;
		default:
			if (LINE_BIOS(l)) draw_text_bios_len(l.slice(1), l.length - 1, 2, pos, 6, 0);
			else draw_text_len(l.slice(1), l.length - 1, 2, pos, l[0] === '#' ? 7 : 6, 0);
		}
	}
}
function help_handle_key(k) {
	let new_line = top_line;
	if (status.dialog_type !== DIALOG_NONE) return 0;
	if (k.mouse === MOUSE_SCROLL_UP) new_line -= MOUSE_SCROLL_LINES;
	else if (k.mouse === MOUSE_SCROLL_DOWN) new_line += MOUSE_SCROLL_LINES;
	else if (k.mouse !== MOUSE_NONE) return 0;
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.ESCAPE: if (rel) return 1; set_page(status.previous_page); return 1;
	case KEYSYM.UP: if (rel) return 1; new_line--; break;
	case KEYSYM.DOWN: if (rel) return 1; new_line++; break;
	case KEYSYM.PAGEUP: if (rel) return 1; new_line -= 32; break;
	case KEYSYM.PAGEDOWN: if (rel) return 1; new_line += 32; break;
	case KEYSYM.HOME: if (rel) return 1; new_line = 0; break;
	case KEYSYM.END: if (rel) return 1; new_line = num_lines - 32; break;
	default:
		if (k.mouse !== MOUSE_NONE) { if (rel) return 1; } else return 0;
	}
	new_line = Math.max(0, Math.min(new_line, num_lines - 32));
	if (new_line !== top_line) { top_line = new_line; help_text_lastpos[status.current_help_index] = top_line; status.flags |= NEED_UPDATE; }
	return 1;
}
function split(text) {
	const classic = status.flags & CLASSIC_MODE;
	return text.split(/\r\n|\r|\n/).filter((l, i, a) => !(i === a.length - 1 && l === '')).filter(l => classic ? !LINE_CLASSIC_HIDDEN(l) : !LINE_SCHISM_HIDDEN(l));
}
function help_set_page() {
	widget_change_focus_to(1);
	const idx = status.current_help_index, key = idx + ':' + (status.flags & CLASSIC_MODE ? 1 : 0);
	top_line = help_text_lastpos[idx] || 0;
	if (!help_cache[key]) {
		const out = [];
		if (idx !== HELP.GLOBAL) { out.push(...split(HELP_TEXT[idx] || '')); out.push('|', '%'); }
		out.push('|');
		out.push(...split(HELP_TEXT[HELP.GLOBAL]));
		out.push('|');
		if (idx !== HELP.GLOBAL) out.push('%');
		help_cache[key] = out;
	}
	lines = help_cache[key];
	num_lines = lines.length;
}
Object.assign(pages[PAGE.HELP], { title: 'Help', ported: true, set_page: help_set_page, pre_handle_key: help_handle_key,
	draw_const: () => {
		draw_box(1, 12, 78, 45, BOX_THICK | BOX_INNER | BOX_INSET);
		if (status.dialog_type === DIALOG_NONE) widget_change_focus_to(1);
	},
	widgets: [widget_create_other(0, help_handle_key, null, help_redraw),
		widget_create_button(35, 47, 8, 0, 1, 1, 1, 0, () => set_page(status.previous_page), 'Done', 3)],
	total_widgets: 2 });

// ------------------------------------------------------------------ log
const NUM_LINES = 1000;
const log_lines = [];
let log_top = 0;
export function log_append(color, text, bios = false) {
	if (log_lines.length >= NUM_LINES) log_lines.shift();
	log_lines.push({ color, text, bios });
	log_top = clamp(log_lines.length - 1 - 32, 0, NUM_LINES - 32);
	if (status.current_page === PAGE.LOG) status.flags |= NEED_UPDATE;
}
export const log_appendf = (color, text) => log_append(color, text);
export const log_nl = () => log_append(DEFAULT_FG, '');
export function log_underline() {
	const last = log_lines[log_lines.length - 1];
	log_append(2, '\x81'.repeat(last ? last.text.length : 0));
}
function log_handle_key(k) {
	const last = log_lines.length - 1, press = k.state !== KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.UP: if (!press) return 1; log_top--; break;
	case KEYSYM.PAGEUP: if (!press) return 1; log_top -= 15; break;
	case KEYSYM.DOWN: if (!press) return 1; log_top++; break;
	case KEYSYM.PAGEDOWN: if (!press) return 1; log_top += 15; break;
	case KEYSYM.HOME: if (!press) return 1; log_top = 0; break;
	case KEYSYM.END: if (!press) return 1; log_top = last; break;
	default:
		if (k.state === KEY_PRESS && k.mouse === MOUSE_SCROLL_UP) { log_top -= MOUSE_SCROLL_LINES; break; }
		if (k.state === KEY_PRESS && k.mouse === MOUSE_SCROLL_DOWN) { log_top += MOUSE_SCROLL_LINES; break; }
		return 0;
	}
	log_top = Math.max(0, Math.min(log_top, last - 32));
	status.flags |= NEED_UPDATE;
	return 1;
}
function log_redraw() {
	for (let n = 0, i = log_top; i < log_lines.length && n < 33; n++, i++) {
		const l = log_lines[i];
		(l.bios ? draw_text_bios_len : draw_text_len)(l.text, 74, 3, 14 + n, l.color, 0);
	}
}
Object.assign(pages[PAGE.LOG], { title: 'Message Log Viewer (Ctrl-F11)', ported: true, help_index: HELP.COPYRIGHT,
	draw_const: () => { draw_box(1, 12, 78, 48, BOX_THICK | BOX_INNER | BOX_INSET); draw_fill_chars(2, 13, 77, 47, DEFAULT_FG, 0); },
	widgets: [widget_create_other(0, log_handle_key, null, log_redraw)], total_widgets: 1 });

// ------------------------------------------------------------------ about
const logo_image = vgamem_ovl_alloc({ x1: 23, y1: 17, x2: 58, y2: 24 });
function about_close() {
	if (status.current_page === PAGE.ABOUT) set_page(PAGE.LOAD_MODULE);
	status.flags |= NEED_UPDATE;
}
function about_draw_const() {
	if (status.current_page === PAGE.ABOUT) draw_box(11, 16, 68, 34, BOX_THIN | BOX_OUTER | BOX_FLAT_DARK);
	if (status.flags & CLASSIC_MODE) {
		draw_box(25, 25, 56, 30, BOX_THIN | BOX_OUTER | BOX_FLAT_DARK);
		draw_text('Sound Card Setup', 32, 26, 0, 2);
		draw_text('Sound Blaster 16 detected', 26, 28, 0, 2);
		draw_text('Port 220h, IRQ 7, DMA 5', 26, 29, 0, 2);
	} else {
		const buf = 'Using Web Audio on HTML5 canvas';
		draw_text(buf, (80 - buf.length) >> 1, 25, 0, 2);
		draw_text('Copyright (C) 2003-2026 Storlek, Mrs. Brisby et al.', 15, 27, 1, 2);
		draw_text('Based on Impulse Tracker by Jeffrey Lim aka Pulse', 15, 28, 1, 2);
		draw_text('Press F1 for copyright and full credits', 15, 29, 1, 2);
	}
	vgamem_ovl_apply(logo_image);
}
export function show_about() {
	const logo = status.flags & CLASSIC_MODE ? logo_it : logo_schism;
	vgamem_ovl_clear(logo_image, 2);
	const c = status.flags & CLASSIC_MODE ? 11 : 0;
	for (let y = 0; y < logo.height; y++) {
		const row = logo.rows[y];
		for (let x = 0; x < logo.width; x++) {
			const col = logo.colors[row[x]];
			if (col !== 'None') vgamem_ovl_drawpixel(logo_image, x + 2, y + 6, c);
		}
	}
	const w = [widget_create_button(33, 32, 12, 0, 0, 0, 0, 0, dialog_yes_NULL, 'Continue', 3)];
	const d = dialog_create_custom(11, 16, 58, 19, w, 1, 0, about_draw_const, null);
	d.action_yes = d.action_no = d.action_cancel = about_close;
	status.flags |= DIR_MODULES_CHANGED;
}
function about_pre_key(k) {
	if (k.mouse && k.y > 20) return 0;
	switch (k.sym) {
	case KEYSYM.LEFT: case KEYSYM.RIGHT: case KEYSYM.DOWN: case KEYSYM.UP: case KEYSYM.TAB: case KEYSYM.RETURN: case KEYSYM.ESCAPE:
		return 0;
	case KEYSYM.F2: case KEYSYM.F5: case KEYSYM.F9: case KEYSYM.F10:
		if (k.mod & KEYMOD.CTRL) break;
		// fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.F1: case KEYSYM.F3: case KEYSYM.F4: case KEYSYM.F11: case KEYSYM.F12:
		if (k.mod & (KEYMOD.ALT | KEYMOD.SHIFT)) break;
		dialog_destroy();
		return 0;
	}
	return 1;
}
Object.assign(pages[PAGE.ABOUT], { title: '', ported: true, total_widgets: 0, widgets: [], pre_handle_key: about_pre_key,
	help_index: HELP.COPYRIGHT, draw_full: () => draw_fill_chars(0, 0, 79, 49, DEFAULT_FG, 0), set_page: show_about });

provide({ log_append, log_appendf, log_nl, log_underline, show_about, startup_page: () => PAGE.ABOUT });
void schism_banner; void app; void BOX_INSET;
