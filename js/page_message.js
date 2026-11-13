// Port of schism/page_message.c (Schism Tracker, GPL-2.0-or-later).
// The message is held as a JS string with '\n' line ends (converted back to
// CR on IT save). Mouse drag selection / clipboard is not ported.
import { provide } from './app.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, DIALOG_OK, DIALOG_OK_CANCEL } from './state.js';
import { draw_char, draw_char_bios, draw_box, draw_fill_chars, DEFAULT_FG, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN } from './keyboard.js';
import { widget_create_other, MOUSE_SCROLL_LINES } from './widget.js';
import { dialog_create } from './dialog.js';
import { pages } from './page.js';
import { current_song } from './song.js';

const LINE_WRAP = 75, MAX_MESSAGE = 8000;
let top_line = 0, cursor_line = 0, cursor_char = 0, edit_mode = 0, message_extfont = 1;
let widget;
const msg = () => current_song.message || '';
const set_msg = s => { current_song.message = s; };
const lines = () => msg().split('\n');
const abs_pos = (line, ch) => { const L = lines(); let p = 0; for (let i = 0; i < line && i < L.length; i++) p += L[i].length + 1; return p + ch; };

function message_reposition() {
	if (cursor_line < top_line) top_line = cursor_line;
	else if (cursor_line > top_line + 34) top_line = cursor_line - 34;
}
function text(line, n) {
	const fg = message_extfont ? 12 : 6;
	for (let i = 0; i < line.length && i < LINE_WRAP; i++) {
		const ch = line.charCodeAt(i);
		if (ch === 32) draw_char(32, 2 + i, 13 + n, 3, 0);
		else (message_extfont ? draw_char_bios : draw_char)(ch, 2 + i, 13 + n, fg, 0);
	}
}
function message_draw() {
	const L = lines();
	draw_fill_chars(2, 13, 77, 47, DEFAULT_FG, 0);
	let n;
	for (n = 0; n < 35 && top_line + n < L.length; n++) {
		const line = L[top_line + n];
		text(line, n);
		if (edit_mode) draw_char(20, 2 + Math.min(line.length, LINE_WRAP), 13 + n, top_line + n === L.length - 1 ? 2 : 1, 0);
	}
	if (edit_mode) {
		const line = L[cursor_line] || '';
		const len = Math.min(line.length, LINE_WRAP);
		if (cursor_char > LINE_WRAP + 1) cursor_char = LINE_WRAP + 1;
		const y = 13 + cursor_line - top_line;
		if (cursor_char >= len) (message_extfont ? draw_char_bios : draw_char)(20, 2 + cursor_char, y, 0, 3);
		else (message_extfont ? draw_char_bios : draw_char)(line.charCodeAt(cursor_char), 2 + cursor_char, y, 8, 3);
	}
}
function set_editmode() {
	edit_mode = 1;
	widget.accept_text = 1;
	top_line = cursor_line = cursor_char = 0;
	widget.d.handle_key = handle_key_editmode;
	widget.d.handle_text_input = handle_text_input_editmode;
	status.flags |= NEED_UPDATE;
}
function set_viewmode() {
	edit_mode = 0;
	widget.accept_text = 0;
	widget.d.handle_key = handle_key_viewmode;
	widget.d.handle_text_input = null;
	status.flags |= NEED_UPDATE;
}
function wrap_line(line_no) {
	const L = lines();
	const line = L[line_no];
	if (line.length < LINE_WRAP) return;
	let cut = -1;
	for (let i = Math.min(LINE_WRAP, line.length - 1); i > 0; i--) if (line[i] === ' ' || line[i] === '\t') { cut = i; break; }
	if (cut > 0) L.splice(line_no, 1, line.slice(0, cut), line.slice(cut + 1));
	else L.splice(line_no, 1, line.slice(0, LINE_WRAP), line.slice(LINE_WRAP));
	set_msg(L.join('\n'));
}
function insert_char(c) {
	if (!edit_mode) return;
	if (c === '\t') {
		let n = 8 - cursor_char % 8;
		if (cursor_char + n > LINE_WRAP) { insert_char('\n'); return; }
		while (n--) insert_char(' ');
		return;
	}
	if (msg().length >= MAX_MESSAGE) { dialog_create(DIALOG_OK, '  Song message too long!  ', null, null, 0, null); return; }
	if (c.charCodeAt(0) < 32 && c !== '\n') return;
	const pos = abs_pos(cursor_line, cursor_char);
	set_msg(msg().slice(0, pos) + c + msg().slice(pos));
	if (c === '\n') { cursor_char = 0; cursor_line++; }
	else cursor_char++;
	if ((lines()[cursor_line] || '').length >= LINE_WRAP) wrap_line(cursor_line);
	if (cursor_char >= LINE_WRAP) { cursor_line++; cursor_char = (lines()[cursor_line] || '').length; }
	const L = lines();
	if (cursor_char > (L[cursor_line] || '').length) { cursor_char -= (L[cursor_line - 1] || '').length + 1; if (cursor_char < 0) cursor_char = 0; }
	message_reposition();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function delete_char() {
	const pos = abs_pos(cursor_line, cursor_char);
	if (pos === 0) return;
	if (cursor_char === 0) { cursor_line--; cursor_char = lines()[cursor_line].length; }
	else cursor_char--;
	set_msg(msg().slice(0, pos - 1) + msg().slice(pos));
	message_reposition();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function delete_next_char() {
	const pos = abs_pos(cursor_line, cursor_char);
	if (pos >= msg().length) return;
	set_msg(msg().slice(0, pos) + msg().slice(pos + 1));
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function delete_line() {
	const L = lines();
	if (cursor_line >= L.length) return;
	L.splice(cursor_line, 1);
	set_msg(L.join('\n'));
	cursor_char = Math.min(cursor_char, (lines()[cursor_line] || '').length);
	message_reposition();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function handle_key_viewmode(k) {
	if (k.state === KEY_PRESS) {
		if (k.mouse === MOUSE_SCROLL_UP) top_line -= MOUSE_SCROLL_LINES;
		else if (k.mouse === MOUSE_SCROLL_DOWN) top_line += MOUSE_SCROLL_LINES;
		else if (k.mouse === MOUSE_CLICK) { set_editmode(); return handle_key_editmode(k); }
	}
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.UP: if (rel) return 0; top_line--; break;
	case KEYSYM.DOWN: if (rel) return 0; top_line++; break;
	case KEYSYM.PAGEUP: if (rel) return 0; top_line -= 35; break;
	case KEYSYM.PAGEDOWN: if (rel) return 0; top_line += 35; break;
	case KEYSYM.HOME: if (rel) return 0; top_line = 0; break;
	case KEYSYM.END: if (rel) return 0; top_line = lines().length - 34; break;
	case KEYSYM.t: if (rel) return 0; if (k.mod & KEYMOD.CTRL) { message_extfont = !message_extfont; break; } return 1;
	case KEYSYM.RETURN: if (k.state === KEY_PRESS) return 0; set_editmode(); return 1;
	default: if (k.mouse === MOUSE_NONE) return 0;
	}
	if (top_line < 0) top_line = 0;
	status.flags |= NEED_UPDATE;
	return 1;
}
function handle_text_input_editmode(t) {
	for (const ch of t) { const c = ch.charCodeAt(0); if (c < 256) insert_char(ch); }
	return 1;
}
function handle_key_editmode(k) {
	let new_line = cursor_line, new_char = cursor_char;
	const L = lines(), num_lines = L.length - 1;
	if (k.mouse === MOUSE_SCROLL_UP) { if (k.state === KEY_RELEASE) return 0; new_line -= MOUSE_SCROLL_LINES; }
	else if (k.mouse === MOUSE_SCROLL_DOWN) { if (k.state === KEY_RELEASE) return 0; new_line += MOUSE_SCROLL_LINES; }
	else if (k.mouse === MOUSE_CLICK) {
		if (k.x >= 2 && k.x <= 77 && k.y >= 13 && k.y <= 47) { new_line = k.y - 13 + top_line; new_char = k.x - 2; }
	}
	const line_len = (L[cursor_line] || '').length, rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
	switch (k.sym) {
	case KEYSYM.UP: if (!nm) return 0; if (rel) return 1; new_line--; break;
	case KEYSYM.DOWN: if (!nm) return 0; if (rel) return 1; new_line++; break;
	case KEYSYM.LEFT: if (!nm) return 0; if (rel) return 1; new_char--; break;
	case KEYSYM.RIGHT: if (!nm) return 0; if (rel) return 1; new_char++; break;
	case KEYSYM.PAGEUP: if (!nm) return 0; if (rel) return 1; new_line -= 35; break;
	case KEYSYM.PAGEDOWN: if (!nm) return 0; if (rel) return 1; new_line += 35; break;
	case KEYSYM.HOME: if (rel) return 1; if (k.mod & KEYMOD.CTRL) new_line = 0; else new_char = 0; break;
	case KEYSYM.END: if (rel) return 1; if (k.mod & KEYMOD.CTRL) new_line = num_lines; else new_char = line_len; break;
	case KEYSYM.ESCAPE: if (!nm) return 0; if (rel) return 1; set_viewmode(); return 1;
	case KEYSYM.BACKSPACE: if (!nm) return 0; if (rel) return 1; delete_char(); return 1;
	case KEYSYM.DELETE: if (!nm) return 0; if (rel) return 1; delete_next_char(); return 1;
	case KEYSYM.RETURN: if (nm) { if (rel) return 1; insert_char('\n'); return 1; } return 0;
	case KEYSYM.TAB: if (nm) { if (rel) return 1; insert_char('\t'); return 1; } return 0;
	default:
		if (k.mod & KEYMOD.CTRL) {
			if (rel) return 1;
			if (k.sym === KEYSYM.t) { message_extfont = !message_extfont; break; }
			if (k.sym === KEYSYM.y) { delete_line(); break; }
		} else if (k.mod & KEYMOD.ALT) {
			if (rel) return 1;
			if (k.sym === KEYSYM.c) {
				dialog_create(DIALOG_OK_CANCEL, 'Clear song message?', () => { set_msg(''); set_viewmode(); status.flags |= SONG_NEEDS_SAVE; }, null, 1, null);
				return 1;
			}
		} else if (k.mouse === MOUSE_NONE) {
			if (k.text && k.state === KEY_PRESS) return handle_text_input_editmode(k.text);
			return 0;
		}
		if (k.mouse !== MOUSE_CLICK) return 0;
		if (rel) return 1;
	}
	const L2 = lines();
	if (new_line !== cursor_line) {
		new_line = Math.max(0, Math.min(new_line, L2.length - 1));
		new_char = Math.min(new_char, (L2[new_line] || '').length);
		cursor_line = new_line; cursor_char = Math.max(0, new_char);
	} else if (new_char !== cursor_char) {
		if (new_char < 0) {
			if (cursor_line === 0) new_char = cursor_char;
			else { cursor_line--; new_char = L2[cursor_line].length; }
		} else if (new_char > (L2[cursor_line] || '').length) {
			if (cursor_line >= L2.length - 1) new_char = cursor_char;
			else { cursor_line++; new_char = 0; }
		}
		cursor_char = new_char;
	}
	message_reposition();
	status.flags |= NEED_UPDATE;
	return 1;
}

widget = widget_create_other(0, handle_key_viewmode, null, message_draw);
widget.accept_text = 0;
Object.assign(pages[PAGE.MESSAGE], { title: 'Message Editor (Shift-F9)', ported: true, help_index: HELP.MESSAGE_EDITOR,
	draw_const: () => draw_box(1, 12, 78, 48, BOX_THICK | BOX_INNER | BOX_INSET),
	song_changed_cb: () => { set_viewmode(); top_line = 0; },
	widgets: [widget], total_widgets: 1 });
provide({});
