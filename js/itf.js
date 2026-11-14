// Port of schism/itf.c (Schism Tracker, GPL-2.0-or-later).
import { app, provide } from './app.js';
import { status, PAGE, NEED_UPDATE, DIALOG_NONE, DIALOG_OK_CANCEL, INVERTED_PALETTE } from './state.js';
import { draw_char, draw_text, draw_text_len, draw_box, draw_fill_chars, DEFAULT_FG,
	BOX_THIN, BOX_CORNER, BOX_OUTSET, BOX_INNER, BOX_INSET, font_normal,
	font_reset_bios, font_reset_upper, font_reset_char, make_half_width_middot } from './vgamem.js';
import { font_load, font_save, font_load_data } from './fonts.js';
import { itfmap_chars, helptext_gen, helptext_editbox, helptext_charmap, helptext_fontlist } from './gen/itf.js';
import { KEYSYM as K, KEYMOD, KEY_PRESS, KEY_RELEASE, MOUSE_CLICK, MOUSE_DBLCLICK,
	MOUSE_BUTTON_LEFT, MOUSE_BUTTON_MIDDLE } from './keyboard.js';
import { widget_create_other } from './widget.js';
import { pages } from './page.js';
import { dialog_create } from './dialog.js';
import { palette_load_preset, palette_apply } from './palettes.js';
import { dmoz_read_directory, dmoz_import_files, dmoz_read_file, dmoz_remove } from './dmoz.js';

const EDITBOX = 0, CHARMAP = 1, ITFMAP = 2, FONTLIST = 3;
const MODE_OFF = 0, MODE_LOAD = 1, MODE_SAVE = 2, VISIBLE_FONTS = 22;
let edit_x = 3, edit_y = 3, current_char = 65, itfmap_pos = -1;
let selected_item = EDITBOX, fontlist_mode = MODE_OFF, top_font = 0, cur_font = 0;
let flist = [];
const clipboard = new Uint8Array(8);
const glyph = () => font_normal.subarray(current_char * 8, current_char * 8 + 8);
const update = () => { make_half_width_middot(); status.flags |= NEED_UPDATE; };
const incr = n => (n & 0xf0) | ((n + 1) & 15);
const decr = n => (n & 0xf0) | ((n - 1) & 15);

function fontlist_reposition() {
	cur_font = Math.max(0, Math.min(flist.length - 1, cur_font));
	if (cur_font < top_font) top_font = cur_font;
	else if (cur_font > top_font + VISIBLE_FONTS - 1) top_font = cur_font - VISIBLE_FONTS + 1;
}
export function fontedit_refresh_list() {
	const entries = dmoz_read_directory('/Fonts');
	flist = ['font.cfg', ...entries.files.map(f => f.base).filter(n => /\.(itf|fnt)$/i.test(n))
		.sort((a, b) => a.localeCompare(b)), '[Import]'];
	fontlist_reposition();
	status.flags |= NEED_UPDATE;
}
function load_fontlist() { cur_font = top_font = 0; fontedit_refresh_list(); }

function draw_frame(name, x, y, w, h, active) {
	const len = Math.min(name.length, w + 2), c = status.flags & INVERTED_PALETTE ? 1 : 3;
	draw_box(x, y + 1, x + w + 5, y + h + 6, BOX_THIN | BOX_CORNER | BOX_OUTSET);
	draw_box(x + 1, y + 2, x + w + 4, y + h + 5, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_char(128, x, y, c, 2);
	for (let n = 0; n < len + 1; n++) draw_char(129, x + n + 1, y, c, 2);
	draw_char(130, x + len + 1, y, c, 2);
	draw_char(131, x, y + 1, c, 2);
	draw_char(137, x + len + 1, y + 1, c, 2);
	draw_text_len(name, len, x + 1, y + 1, active === -1 ? 1 : active ? 3 : 0, 2);
}
function draw_editbox() {
	const ptr = glyph();
	for (let i = 0; i < 8; i++) {
		draw_char(49 + i, 4 + i, 6, i === edit_x ? 3 : 1, 0);
		draw_char(49 + i, 3, 7 + i, i === edit_y ? 3 : 1, 0);
		for (let j = 0; j < 8; j++) {
			const bit = ptr[j] & (128 >> i), selected = selected_item === EDITBOX && i === edit_x && j === edit_y;
			draw_char(bit ? 15 : 173, 4 + i, 7 + j, selected ? 0 : bit ? 6 : 1, selected ? 3 : 0);
		}
	}
	draw_char(current_char, 3, 4, 5, 0);
	draw_text(String(current_char).padStart(3) + ' $' + current_char.toString(16).toUpperCase().padStart(2, '0'), 5, 4, 5, 0);
}
function draw_charmap() {
	for (let n = 255; n >= 0; n--) {
		const selected = n === current_char;
		draw_char(n, 20 + n % 16, 4 + (n >> 4), selected ? selected_item === CHARMAP ? 0 : 3 : 1,
			selected && selected_item === CHARMAP ? 3 : 0);
	}
}
function draw_itfmap() {
	if (itfmap_pos < 0 || itfmap_chars[itfmap_pos] !== current_char) itfmap_pos = itfmap_chars.indexOf(current_char);
	const highlight = itfmap_pos >= 0 && selected_item !== ITFMAP ? current_char : 255;
	for (let n = 0; n < 240; n++) {
		const selected = n === itfmap_pos || itfmap_chars[n] === highlight;
		draw_char(itfmap_chars[n], 44 + n % 16, 4 + (n >> 4), selected ? selected_item === ITFMAP ? 0 : 3 : 1,
			selected && selected_item === ITFMAP ? 3 : 0);
	}
}
function draw_fontlist() {
	for (let i = 0; i < VISIBLE_FONTS && top_font + i < flist.length; i++) {
		const n = top_font + i, selected = n === cur_font;
		const fg = selected ? selected_item === FONTLIST ? 0 : 3 : 5;
		const bg = selected && selected_item === FONTLIST ? 3 : 0;
		draw_char(selected ? 183 : 173, 68, 4 + i, selected ? fg : 2, bg);
		const name = (n === 0 ? flist[n] : flist[n].split('.')[0]).slice(0, 8);
		for (let x = 0; x < 8; x++) draw_char(x < name.length ? name.charCodeAt(x) : 0, 69 + x, 4 + i, fg, bg);
	}
}
function draw_helptext() {
	const draw_lines = (text, x) => text.split('\n').slice(0, -1).forEach((line, y) => {
		for (let i = 0; i < line.length; i++) draw_char(line.charCodeAt(i), x + i, 35 + y, 12, 0);
	});
	draw_lines(helptext_gen, 3);
	for (let n = 0; n < 10; n++) draw_char(168, 46, 35 + n, 12, 0);
	draw_lines(selected_item === EDITBOX ? helptext_editbox : selected_item === FONTLIST ? helptext_fontlist : helptext_charmap, 48);
	const copyright = 'Copyright (c) 2003-2026 Storlek, Mrs. Brisby et al.';
	draw_text(copyright, 77 - copyright.length, 46, 1, 0);
}
function draw_screen() {
	draw_fill_chars(0, 0, 79, 49, DEFAULT_FG, 0);
	draw_frame('Edit Box', 0, 0, 9, 11, selected_item === EDITBOX); draw_editbox();
	draw_frame('Current Font', 17, 0, 16, 16, selected_item === CHARMAP); draw_charmap();
	draw_frame('Preview', 41, 0, 16, 15, selected_item === ITFMAP); draw_itfmap();
	if (fontlist_mode) {
		draw_frame(fontlist_mode === MODE_LOAD ? 'Load/Browse' : 'Save As...', 65, 0, 9, VISIBLE_FONTS, selected_item === FONTLIST);
		draw_fontlist();
	}
	draw_frame('Quick Help', 0, 31, 74, 12, -1); draw_helptext();
	const now = new Date();
	draw_text([now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'), 3, 46, 1, 0);
}

function handle_key_editbox(k) {
	const ptr = glyph(), shift = k.mod & KEYMOD.SHIFT;
	switch (k.sym) {
	case K.UP: if (shift) { const s = ptr[0]; ptr.copyWithin(0, 1); ptr[7] = s; } else edit_y = (edit_y + 7) & 7; break;
	case K.DOWN: if (shift) { const s = ptr[7]; ptr.copyWithin(1, 0, 7); ptr[0] = s; } else edit_y = (edit_y + 1) & 7; break;
	case K.LEFT: if (shift) ptr.forEach((b, i) => { ptr[i] = (b >> 7) | (b << 1); }); else edit_x = (edit_x + 7) & 7; break;
	case K.RIGHT: if (shift) ptr.forEach((b, i) => { ptr[i] = (b << 7) | (b >> 1); }); else edit_x = (edit_x + 1) & 7; break;
	case K.HOME: edit_x = edit_y = 0; break;
	case K.END: edit_x = edit_y = 7; break;
	case K.SPACE: ptr[edit_y] ^= 128 >> edit_x; break;
	case K.INSERT: if (shift) ptr.forEach((b, i) => { ptr[i] = b | (128 >> edit_x); }); else ptr[edit_y] = 255; break;
	case K.DELETE: if (shift) ptr.forEach((b, i) => { ptr[i] = b & ~(128 >> edit_x); }); else ptr[edit_y] = 0; break;
	case K.LEFTBRACKET: case K.RIGHTBRACKET: {
		const tmp = new Uint8Array(8);
		for (let n = 0; n < 8; n++) for (let bit = 0; bit < 8; bit++) if (ptr[n] & (1 << bit)) {
			if (k.sym === K.LEFTBRACKET) tmp[bit] |= 1 << (7 - n); else tmp[7 - bit] |= 1 << n;
		}
		ptr.set(tmp); break;
	}
	case K.PLUS: case K.EQUALS: current_char++; break;
	case K.MINUS: case K.UNDERSCORE: current_char--; break;
	case K.PAGEUP: current_char -= 16; break;
	case K.PAGEDOWN: current_char += 16; break;
	default: return;
	}
	current_char &= 255; update();
}
function handle_key_charmap(k) {
	switch (k.sym) {
	case K.UP: current_char -= 16; break;
	case K.DOWN: current_char += 16; break;
	case K.LEFT: current_char = decr(current_char); break;
	case K.RIGHT: current_char = incr(current_char); break;
	case K.HOME: current_char = 0; break;
	case K.END: current_char = 255; break;
	default: return;
	}
	current_char &= 255; update();
}
function handle_key_itfmap(k) {
	switch (k.sym) {
	case K.UP: itfmap_pos = itfmap_pos < 0 ? 224 : (itfmap_pos + 224) % 240; break;
	case K.DOWN: itfmap_pos = itfmap_pos < 0 ? 16 : (itfmap_pos + 16) % 240; break;
	case K.LEFT: itfmap_pos = itfmap_pos < 0 ? 15 : decr(itfmap_pos); break;
	case K.RIGHT: itfmap_pos = itfmap_pos < 0 ? 0 : incr(itfmap_pos); break;
	case K.HOME: itfmap_pos = 0; break;
	case K.END: itfmap_pos = 239; break;
	default: return;
	}
	current_char = itfmap_chars[itfmap_pos]; update();
}
function confirm_font_save_ok(name) { font_save(name); selected_item = EDITBOX; update(); }
function handle_key_fontlist(k) {
	switch (k.sym) {
	case K.HOME: cur_font = 0; break;
	case K.END: cur_font = flist.length - 1; break;
	case K.UP: cur_font--; break;
	case K.DOWN: cur_font++; break;
	case K.PAGEUP: cur_font -= VISIBLE_FONTS; break;
	case K.PAGEDOWN: cur_font += VISIBLE_FONTS; break;
	case K.ESCAPE: selected_item = EDITBOX; fontlist_mode = MODE_OFF; break;
	case K.RETURN: {
		if (k.state !== KEY_RELEASE) return;
		const name = flist[cur_font];
		if (name === '[Import]') {
			dmoz_import_files('/Fonts', names => {
				let loaded = false;
				for (const name of names) {
					const data = dmoz_read_file('/Fonts/' + name);
					if (font_load_data(data) === 0) loaded = true;
					else { dmoz_remove('/Fonts/' + name); app.status_text_flash('Invalid font: ' + name); }
				}
				fontedit_refresh_list();
				if (loaded) selected_item = EDITBOX;
			});
		} else if (name && fontlist_mode === MODE_LOAD) {
			if (font_load(name) !== 0) app.status_text_flash('Could not load ' + name);
		} else if (name && fontlist_mode === MODE_SAVE) {
			if (cur_font) dialog_create(DIALOG_OK_CANCEL, 'Overwrite font file?', confirm_font_save_ok, null, 1, name);
			else confirm_font_save_ok(name);
		}
		break;
	}
	default: return;
	}
	fontlist_reposition(); update();
}

function handle_mouse(k) {
	const x = k.x, y = k.y;
	const inside = (x1, y1, w, h) => x >= x1 && x < x1 + w && y >= y1 && y < y1 + h;
	if (inside(0, 0, 15, 18)) {
		selected_item = EDITBOX;
		if (inside(3, 4, 9, 11)) {
			const xr = x - 3, yr = y - 4, ptr = glyph();
			if (xr > 0) edit_x = xr - 1;
			if (yr > 2) edit_y = yr - 3;
			if (yr >= 2 && !(k.mouse_button === MOUSE_BUTTON_MIDDLE && k.state !== KEY_PRESS)) {
				const mask = xr === 0 ? 255 : 128 >> edit_x;
				for (let n = 0; n < 8; n++) if (yr === 2 || n === edit_y) {
					if (k.mouse_button === MOUSE_BUTTON_LEFT) ptr[n] |= mask;
					else if (k.mouse_button === MOUSE_BUTTON_MIDDLE) ptr[n] ^= mask;
					else ptr[n] &= ~mask;
				}
			}
		}
	} else if (inside(17, 0, 22, 23)) {
		selected_item = CHARMAP;
		if (inside(20, 4, 16, 16)) current_char = 16 * (y - 4) + x - 20;
	} else if (inside(41, 0, 22, 22)) {
		selected_item = ITFMAP;
		if (inside(44, 4, 16, 15)) { itfmap_pos = 16 * (y - 4) + x - 44; current_char = itfmap_chars[itfmap_pos]; }
	} else if (fontlist_mode && inside(68, 4, 9, VISIBLE_FONTS)) {
		selected_item = FONTLIST; cur_font = Math.min(flist.length - 1, top_font + y - 4);
		if (k.mouse === MOUSE_DBLCLICK) handle_key_fontlist({ sym: K.RETURN, state: KEY_RELEASE });
	}
	update();
}
function fontedit_handle_key(k) {
	if (k.mouse === MOUSE_CLICK || k.mouse === MOUSE_DBLCLICK) { handle_mouse(k); return 1; }
	if (k.mouse) return 0;
	const ctrl = k.mod & KEYMOD.CTRL, alt = k.mod & KEYMOD.ALT, shift = k.mod & KEYMOD.SHIFT;
	if (k.sym === K.RETURN && selected_item === FONTLIST) { handle_key_fontlist(k); return 1; }
	if (k.state === KEY_RELEASE) return k.sym === K.q && ctrl ? 0 : 1;
	const ptr = glyph();
	if (ctrl && k.sym === K.m) {
		const canvas = document.getElementById('screen');
		canvas.style.cursor = canvas.style.cursor === 'none' ? '' : 'none';
		return 1;
	}
	if (k.sym >= 48 && k.sym <= 57 || k.sym >= K.KP_1 && k.sym <= K.KP_0) {
		let n = k.sym >= 48 && k.sym <= 57 ? (k.sym - 49 + 10) % 10 : k.sym - K.KP_1;
		if (shift) n += 10;
		palette_load_preset(n); palette_apply(); update(); return 1;
	}
	if (alt) {
		switch (k.sym) {
		case K.c: clipboard.set(ptr); return 1;
		case K.p: ptr.set(clipboard); update(); return 1;
		case K.m: ptr.forEach((b, i) => { ptr[i] = b | clipboard[i]; }); update(); return 1;
		case K.z: ptr.fill(0); update(); return 1;
		case K.h: ptr.forEach((b, i) => { ptr[i] = parseInt(b.toString(2).padStart(8, '0').split('').reverse().join(''), 2); }); update(); return 1;
		case K.v: ptr.reverse(); update(); return 1;
		case K.i: ptr.forEach((b, i) => { ptr[i] = b ^ 255; }); update(); return 1;
		}
	}
	switch (k.sym) {
	case K.F2: selected_item = EDITBOX; break;
	case K.F3: selected_item = CHARMAP; break;
	case K.F4: selected_item = ITFMAP; break;
	case K.TAB: selected_item = (selected_item + (shift ? (fontlist_mode ? 3 : 2) : 1)) % (fontlist_mode ? 4 : 3); break;
	case K.l: case K.r: if (!ctrl) return 0;
		// fall through
	case K.F9: load_fontlist(); fontlist_mode = MODE_LOAD; selected_item = FONTLIST; break;
	case K.s: if (!ctrl) return 0;
		// fall through
	case K.F10: if (fontlist_mode !== MODE_SAVE) load_fontlist(); fontlist_mode = MODE_SAVE; selected_item = FONTLIST; break;
	case K.BACKSPACE: if (ctrl) font_reset_bios(); else if (alt) font_reset_char(current_char); else font_reset_upper(); break;
	case K.q: if (ctrl) return 0; break;
	default:
		if (selected_item === EDITBOX) handle_key_editbox(k);
		else if (selected_item === CHARMAP) handle_key_charmap(k);
		else if (selected_item === ITFMAP) handle_key_itfmap(k);
		else handle_key_fontlist(k);
	}
	update(); return 1;
}
function fontedit_key_hack(k) {
	if (status.dialog_type !== DIALOG_NONE) return 0;
	if ([K.r, K.l, K.s, K.c, K.p, K.m, K.z, K.v, K.h, K.i, K.q, K.w,
		K.F1, K.F2, K.F3, K.F4, K.F5, K.F6, K.F7, K.F8, K.F9, K.F10, K.F11, K.F12].includes(k.sym)
		|| k.sym === K.RETURN && selected_item === FONTLIST) return fontedit_handle_key(k);
	return 0;
}

Object.assign(pages[PAGE.FONT_EDIT], { title: '', draw_full: draw_screen, ported: true,
	pre_handle_key: fontedit_key_hack,
	widgets: [widget_create_other(0, fontedit_handle_key, null, () => {})], total_widgets: 1 });
provide({ fontedit_refresh_list });
