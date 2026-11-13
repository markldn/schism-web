// Port of schism/widget.c and schism/widget-keyhandler.c (Schism Tracker, GPL-2.0-or-later).
//
// Differences forced by the language:
//  - the C union `d` is one plain object here; numentry/thumbbar/panbar share
//    d.min/d.max/d.value exactly as the C code relies on them sharing layout.
//  - C pointers into caller-owned storage become refs: {value: ...}. A
//    textentry's d.text is a ref to a string, numentry/bitset d.cursor_pos is a
//    ref to a number (so lined-up numbers can share one cursor column).

import { status, NEED_UPDATE, CLASSIC_MODE, DISKWRITER_ACTIVE } from "./state.js";
import { draw_fill_chars, draw_text, draw_text_len, draw_char, draw_char_bios, draw_box, draw_thumb_bar,
	draw_half_width_chars, draw_text_utf8_len, DEFAULT_FG, BOX_THIN, BOX_INNER, BOX_INSET, BOX_OUTSET } from "./vgamem.js";
import { KEYSYM, KEYMOD, NO_MODIFIER, KEY_PRESS, KEY_RELEASE, KEY_DRAG,
	MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN,
	MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT, numeric_key_event } from "./keyboard.js";
import { app, provide } from "./app.js";

export const WIDGET_TOGGLE = 0, WIDGET_MENUTOGGLE = 1, WIDGET_BUTTON = 2, WIDGET_TOGGLEBUTTON = 3,
	WIDGET_TEXTENTRY = 4, WIDGET_NUMENTRY = 5, WIDGET_THUMBBAR = 6, WIDGET_BITSET = 7, WIDGET_PANBAR = 8,
	WIDGET_LISTBOX = 9, WIDGET_OTHER = 10;

export const MOUSE_SCROLL_LINES = 3;

const PANS_STEREO = 0, PANS_AMIGA = 1, PANS_LEFT = 2, PANS_RIGHT = 3, PANS_MONO = 4, PANS_SLASH = 5, PANS_BACKSLASH = 6;

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

// ---------------------------------------------------------------------------
// The widget set that currently has the keyboard: either the active page's or
// the top dialog's. `holder` is whatever object owns selected_widget and
// total_widgets (C keeps pointers to those two ints).

export const ui = { widgets: [], holder: { selected_widget: 0, total_widgets: 0 } };

export function ui_set(widgets, holder) {
	ui.widgets = widgets;
	ui.holder = holder;
}

export const active_widget = () => ui.widgets[ui.holder.selected_widget];

// ---------------------------------------------------------------------------
// number formatting (str.c)

export function str_from_num(digits, n) {
	n = n >>> 0;
	if (digits > 0) return String(n).padStart(digits, "0").slice(0, digits);
	return String(n);
}

export function str_from_num_signed(digits, n) {
	n |= 0;
	if (digits > 0) {
		// printf("%0Nd"): the sign counts towards the width
		const s = n < 0 ? "-" + String(-n).padStart(digits - 1, "0") : String(n).padStart(digits, "0");
		return s.slice(0, digits);
	}
	return String(n);
}

export function str_from_num99(n) {
	if (n < 0) return "";
	if (n < 100) return String(n).padStart(2, "0");
	if (n <= 256) {
		n -= 100;
		return "HIJKLMNOPQRSTUVWXYZ"[Math.trunc(n / 10)] + (n % 10);
	}
	return "";
}

// ---------------------------------------------------------------------------
// constructors

function base(type, x, y, width, next_up, next_down, next_left, next_right, next_tab, changed) {
	return {
		type, d: {}, x, y, width, height: 1, depressed: 0, clip_start: 0, clip_end: 0,
		next: { up: next_up, down: next_down, left: next_left, right: next_right, tab: next_tab, backtab: -1 },
		changed: changed || null, activate: null, clipboard_paste: null, accept_text: 0,
	};
}

export function widget_create_toggle(x, y, next_up, next_down, next_left, next_right, next_tab, changed) {
	const w = base(WIDGET_TOGGLE, x, y, 3, next_up, next_down, next_left, next_right, next_tab, changed);
	w.d.state = 0;
	return w;
}

export function widget_create_menutoggle(x, y, next_up, next_down, next_left, next_right, next_tab, changed, choices) {
	const width = choices.reduce((m, c) => Math.max(m, c.length), 0);
	const w = base(WIDGET_MENUTOGGLE, x, y, width, next_up, next_down, next_left, next_right, next_tab, changed);
	w.d.state = 0;
	w.d.choices = choices;
	w.d.num_choices = choices.length;
	w.d.activation_keys = null;
	return w;
}

export function widget_create_button(x, y, width, next_up, next_down, next_left, next_right, next_tab, changed, text, padding) {
	const w = base(WIDGET_BUTTON, x, y, width, next_up, next_down, next_left, next_right, next_tab, changed);
	w.d.text = text;
	w.d.padding = padding;
	return w;
}

export function widget_create_togglebutton(x, y, width, next_up, next_down, next_left, next_right, next_tab, changed, text, padding, group) {
	const w = base(WIDGET_TOGGLEBUTTON, x, y, width, next_up, next_down, next_left, next_right, next_tab, changed);
	w.d.text = text;
	w.d.padding = padding;
	w.d.state = 0;
	w.d.group = group || null;
	return w;
}

/* `text` is a ref: {value: string} */
export function widget_create_textentry(x, y, width, next_up, next_down, next_tab, changed, text, max_length) {
	const w = base(WIDGET_TEXTENTRY, x, y, width, next_up, next_down, 0, -1, next_tab, changed);
	w.accept_text = 1;
	w.d.text = text;
	w.d.max_length = max_length;
	w.d.firstchar = 0;
	w.d.cursor_pos = 0;
	return w;
}

/* `cursor_pos` is a ref: {value: number} */
export function widget_create_numentry(x, y, width, next_up, next_down, next_tab, changed, min, max, cursor_pos) {
	const w = base(WIDGET_NUMENTRY, x, y, width, next_up, next_down, 0, -1, next_tab, changed);
	w.d.min = min;
	w.d.max = max;
	w.d.value = 0;
	w.d.cursor_pos = cursor_pos;
	w.d.handle_unknown_key = null;
	w.d.reverse = 0;
	return w;
}

export function widget_create_thumbbar(x, y, width, next_up, next_down, next_tab, changed, min, max) {
	const w = base(WIDGET_THUMBBAR, x, y, width, next_up, next_down, 0, -1, next_tab, changed);
	w.d.min = min;
	w.d.max = max;
	w.d.value = 0;
	w.d.text_at_min = null;
	w.d.text_at_max = null;
	return w;
}

export function widget_create_bitset(x, y, width, next_up, next_down, next_tab, changed, nbits, bits_on, bits_off, cursor_pos) {
	const w = base(WIDGET_BITSET, x, y, width, next_up, next_down, 0, -1, next_tab, changed);
	w.d.nbits = nbits;
	w.d.value = 0;
	w.d.bits_on = bits_on;
	w.d.bits_off = bits_off;
	w.d.cursor_pos = cursor_pos;
	w.d.activation_keys = null;
	return w;
}

export function widget_create_panbar(x, y, next_up, next_down, next_tab, changed, channel) {
	const w = base(WIDGET_PANBAR, x, y, 24, next_up, next_down, 0, -1, next_tab, changed);
	w.d.min = 0;
	w.d.max = 64;
	w.d.value = 0;
	w.d.channel = channel;
	w.d.muted = 0;
	w.d.surround = 0;
	return w;
}

export function widget_create_listbox(size, toggled, name, changed, activate, handle_key,
	focus_offsets_left, focus_offsets_right, next_up, next_down) {
	const w = base(WIDGET_LISTBOX, -1, -1, -1, next_up, next_down, 0, 0, -1, changed);
	w.activate = activate || null;
	w.d.size = size;
	w.d.toggled = toggled;
	w.d.name = name;
	w.d.handle_key = handle_key || null;
	w.d.focus_offsets = { left: focus_offsets_left, right: focus_offsets_right };
	w.d.top = 0;
	w.d.focus = 0;
	return w;
}

export function widget_create_other(next_tab, handle_key, handle_text_input, redraw) {
	const w = base(WIDGET_OTHER, -1, -1, -1, 0, 0, 0, 0, next_tab, null);
	w.d.handle_key = handle_key;
	w.d.handle_text_input = handle_text_input || null;
	w.d.redraw = redraw || null;
	return w;
}

// ---------------------------------------------------------------------------
// single-line text editing. These take a text ref and a cursor ref-like
// holder (any object with `cursor_pos`), mirroring the C in/out pointers.

export function text_add_char(text, c, holder, max_length) {
	let s = text.value.slice(0, max_length);
	if (holder.cursor_pos >= max_length) holder.cursor_pos = max_length - 1;
	while (s.length < holder.cursor_pos) s += " ";
	s = s.slice(0, holder.cursor_pos) + String.fromCharCode(c) + s.slice(holder.cursor_pos);
	text.value = s.slice(0, max_length);
	holder.cursor_pos++;
}

export function text_delete_char(text, holder) {
	if (holder.cursor_pos === 0) return;
	holder.cursor_pos--;
	text.value = text.value.slice(0, holder.cursor_pos) + text.value.slice(holder.cursor_pos + 1);
}

export function text_delete_next_char(text, holder) {
	text.value = text.value.slice(0, holder.cursor_pos) + text.value.slice(holder.cursor_pos + 1);
}

function textentry_reposition(w) {
	const d = w.d;
	if (d.text.value.length > d.max_length) d.text.value = d.text.value.slice(0, d.max_length);
	const len = d.text.value.length;

	if (d.cursor_pos < d.firstchar) {
		d.firstchar = d.cursor_pos;
	} else if (d.cursor_pos > len) {
		d.cursor_pos = len;
	} else if (d.cursor_pos > d.firstchar + w.width - 1) {
		d.firstchar = d.cursor_pos - w.width + 1;
		if (d.firstchar < 0) d.firstchar = 0;
	}
}

export function widget_textentry_add_char(w, c) {
	text_add_char(w.d.text, c, w.d, w.d.max_length);
	if (w.changed) w.changed();
	status.flags |= NEED_UPDATE;
	return 1;
}

/* `text` is typed (Unicode) text. TODO(port): charset.c UTF-8 -> ITF mapping;
 * for now only characters that exist unchanged in the ITF font (ASCII) pass. */
export function widget_textentry_add_text(w, text) {
	if (!text) return 0;
	for (const ch of text) {
		const c = ch.codePointAt(0);
		if (c < 32 || c > 126) return 0;
		if (!widget_textentry_add_char(w, c)) return 0;
	}
	return 1;
}

export function widget_numentry_change_value(w, new_value) {
	w.d.value = clamp(new_value, w.d.min, w.d.max);
	if (w.changed) w.changed();
	status.flags |= NEED_UPDATE;
}

export function widget_numentry_handle_text(w, text) {
	if (!text) return 0;
	const m = /^[0-9]+/.exec(text);
	if (!m) return 0;
	const digits = m[0];

	let value = w.d.value;
	if (w.d.reverse) {
		// sic: the C code appends text[0] once per digit typed
		for (let i = 0; i < digits.length; i++) value = value * 10 + (digits.charCodeAt(0) - 48);
	} else {
		let pos = w.d.cursor_pos.value;
		for (let n = 0; n < digits.length && pos < w.width; n++, pos++) {
			const p = 10 ** (w.width - 1 - pos);
			value -= Math.trunc(value % (p * 10) / p) * p;
			value += (digits.charCodeAt(n) - 48) * p;
		}
		w.d.cursor_pos.value = clamp(pos, 0, w.width - 1);
	}

	widget_numentry_change_value(w, value);
	return 1;
}

export function widget_togglebutton_set(p_widgets, widget, do_callback) {
	const group = p_widgets[widget].d.group;
	if (!group) return;

	for (let i = 0; i < group.length && group[i] >= 0; i++) p_widgets[group[i]].d.state = 0;
	p_widgets[widget].d.state = 1;

	if (do_callback && p_widgets[widget].changed) p_widgets[widget].changed();
	status.flags |= NEED_UPDATE;
}

// ---------------------------------------------------------------------------
// drawing

const BITSET_FG = [2, 3, 0, 0];
const BITSET_BG = [0, 0, 2, 3];

export function widget_draw_widget(w, selected) {
	const tfg = selected ? 0 : 2;
	const tbg = selected ? 3 : 0;
	const d = w.d;
	let n, buf;

	switch (w.type) {
	case WIDGET_TOGGLE:
		draw_fill_chars(w.x, w.y, w.x + w.width - 1, w.y, DEFAULT_FG, 0);
		draw_text(d.state ? "On" : "Off", w.x, w.y, tfg, tbg);
		break;
	case WIDGET_MENUTOGGLE: {
		draw_fill_chars(w.x, w.y, w.x + w.width - 1, w.y, DEFAULT_FG, 0);
		const s = d.choices[d.state];
		n = s.indexOf(" ");
		if (n >= 0) {
			draw_text_len(s, n, w.x, w.y, tfg, tbg);
			draw_text(s.slice(n + 1), w.x + n + 1, w.y, 2, 0);
		} else {
			draw_text(s, w.x, w.y, tfg, tbg);
		}
		break;
	}
	case WIDGET_BUTTON:
		draw_box(w.x - 1, w.y - 1, w.x + w.width + 2, w.y + 1,
			BOX_THIN | BOX_INNER | (w.depressed ? BOX_INSET : BOX_OUTSET));
		draw_text(d.text, w.x + d.padding, w.y, selected ? 3 : 0, 2);
		break;
	case WIDGET_TOGGLEBUTTON:
		draw_box(w.x - 1, w.y - 1, w.x + w.width + 2, w.y + 1,
			BOX_THIN | BOX_INNER | ((d.state || w.depressed) ? BOX_INSET : BOX_OUTSET));
		draw_text(d.text, w.x + d.padding, w.y, selected ? 3 : 0, 2);
		break;
	case WIDGET_TEXTENTRY: {
		textentry_reposition(w);
		const s = d.text.value;
		draw_text_len(s.slice(d.firstchar), w.width, w.x, w.y, 2, 0);
		if (selected) {
			n = d.cursor_pos - d.firstchar;
			draw_char(n < s.length ? s.charCodeAt(d.cursor_pos) : 32, w.x + n, w.y, 0, 3);
		}
		break;
	}
	case WIDGET_NUMENTRY:
		if (d.reverse) {
			let str = str_from_num(w.width, d.value).replace(/^0+/, "");
			draw_text_len("", w.width, w.x, w.y, 2, 0);
			if (str) draw_text(str, w.x + w.width - str.length, w.y, 2, 0);
			if (selected)
				draw_char(str ? str.charCodeAt(str.length - 1) : 32, w.x + w.width - 1, w.y, 0, 3);
		} else {
			buf = (d.min < 0 || d.max < 0) ? str_from_num_signed(w.width, d.value) : str_from_num(w.width, d.value);
			draw_text_len(buf, w.width, w.x, w.y, 2, 0);
			if (selected) {
				n = d.cursor_pos.value;
				draw_char(buf.charCodeAt(n), w.x + n, w.y, 0, 3);
			}
		}
		break;
	case WIDGET_BITSET:
		for (n = 0; n < d.nbits; ++n) {
			const set = (d.value & (1 << n)) ? 1 : 0;
			const src = set ? d.bits_on : d.bits_off;
			const c1 = src.charCodeAt(n * 2), c2 = src.charCodeAt(n * 2 + 1) || 0;
			const focused = (selected && n === d.cursor_pos.value) ? 1 : 0;
			const fg = BITSET_FG[set + focused * 2], bg = BITSET_BG[set + focused * 2];
			if (c2) draw_half_width_chars(c1, c2, w.x + n, w.y, fg, bg, fg, bg);
			else draw_char(c1, w.x + n, w.y, fg, bg);
		}
		break;
	case WIDGET_THUMBBAR:
		if (d.text_at_min && d.min === d.value) {
			draw_text_len(d.text_at_min, w.width, w.x, w.y, selected ? 3 : 2, 0);
		} else if (d.text_at_max && d.max === d.value) {
			const len = d.text_at_max.length;
			const pos = w.x + w.width - len;
			draw_fill_chars(w.x, w.y, pos - 1, w.y, DEFAULT_FG, 0);
			draw_text_len(d.text_at_max, len, pos, w.y, selected ? 3 : 2, 0);
		} else {
			draw_thumb_bar(w.x, w.y, w.width, d.min, d.max, d.value, selected);
		}
		buf = (d.min < 0 || d.max < 0) ? str_from_num_signed(3, d.value) : str_from_num(3, d.value);
		draw_text(buf, w.x + w.width + 1, w.y, 1, 2);
		break;
	case WIDGET_PANBAR:
		draw_text("Channel " + str_from_num(2, d.channel), w.x, w.y, selected ? 3 : 0, 2);
		if (d.muted) {
			draw_text("  Muted  ", w.x + 11, w.y, selected ? 3 : 5, 0);
		} else if (d.surround) {
			draw_text("Surround ", w.x + 11, w.y, selected ? 3 : 5, 0);
		} else {
			draw_thumb_bar(w.x + 11, w.y, 9, 0, 64, d.value, selected);
			draw_text(str_from_num(3, d.value), w.x + 21, w.y, 1, 2);
		}
		break;
	case WIDGET_LISTBOX: {
		const size = d.size();
		const colors = (o) => (o === d.focus ? (w === active_widget() ? [0, 3] : [6, 14]) : [6, 0]);

		draw_fill_chars(w.x, w.y, w.x + w.width - 1, w.y + w.height - 1, DEFAULT_FG, 0);
		if (d.top >= size) break;

		for (let o = d.top, i = 0; o < size && i < w.height; i++, o++) {
			const [fg, bg] = colors(o);
			draw_text_utf8_len(d.toggled(o) ? "*" : " ", 1, w.x, w.y + i, fg, bg);
			draw_text_utf8_len(d.name(o), w.width - 1, w.x + 1, w.y + i, fg, bg);
		}

		if (w.height >= 2) {
			if (d.top > 0) {
				const [fg, bg] = colors(d.top);
				draw_char_bios(30, w.x + w.width - 1, w.y, fg, bg);
			}
			if (d.top + w.height < size) {
				const [fg, bg] = colors(d.top + w.height - 1);
				draw_char_bios(31, w.x + w.width - 1, w.y + w.height - 1, fg, bg);
			}
		}
		break;
	}
	case WIDGET_OTHER:
		if (d.redraw) d.redraw();
		break;
	}
}

// ---------------------------------------------------------------------------
// focus

export function widget_change_focus_to(new_widget_index) {
	const h = ui.holder;
	if (new_widget_index === h.selected_widget || new_widget_index < 0 || new_widget_index >= h.total_widgets)
		return;

	active_widget().depressed = 0;
	h.selected_widget = new_widget_index;

	const w = active_widget();
	w.depressed = 0;
	if (w.type === WIDGET_TEXTENTRY) w.d.cursor_pos = w.d.text.value.length;

	status.flags |= NEED_UPDATE;
}

export function widget_find_xy(x, y) {
	for (let i = 0; i < ui.holder.total_widgets; i++) {
		const w = ui.widgets[i];
		const pad = (w.type === WIDGET_BUTTON || w.type === WIDGET_TOGGLEBUTTON) ? 2 : 0;
		if (x >= w.x && x < w.x + w.width + pad && y >= w.y && y < w.y + w.height) return i;
	}
	return -1;
}

export function widget_change_focus_to_xy(x, y) {
	const n = widget_find_xy(x, y);
	if (n >= 0) {
		widget_change_focus_to(n);
		return 1;
	}
	return 0;
}

// ---------------------------------------------------------------------------
// key handling (widget-keyhandler.c)

function numentry_move_cursor(w, n) {
	if (w.d.reverse) return;
	n = clamp(n + w.d.cursor_pos.value, 0, w.width - 1);
	if (w.d.cursor_pos.value === n) return;
	w.d.cursor_pos.value = n;
	status.flags |= NEED_UPDATE;
}

function textentry_move_cursor(w, n) {
	n = clamp(n + w.d.cursor_pos, 0, w.d.max_length);
	if (w.d.cursor_pos === n) return;
	w.d.cursor_pos = n;
	status.flags |= NEED_UPDATE;
}

function bitset_move_cursor(w, n) {
	n = clamp(n + w.d.cursor_pos.value, 0, w.d.nbits - 1);
	if (w.d.cursor_pos.value === n) return;
	w.d.cursor_pos.value = n;
	status.flags |= NEED_UPDATE;
}

function thumbbar_prompt_finish(n) {
	const w = active_widget();
	if (n >= w.d.min && n <= w.d.max) {
		w.d.value = n;
		if (w.changed) w.changed();
	}
	status.flags |= NEED_UPDATE;
}

function thumbbar_prompt_value(w, k) {
	let c;

	if (!NO_MODIFIER(k.mod)) return 0;

	if (k.sym === KEYSYM.MINUS) {
		if (w.d.min >= 0) return 0;
		c = 45;
	} else {
		c = numeric_key_event(k, 0);
		if (c < 0) return 0;
		c += 48;
	}

	app.numprompt_create("Enter Value", thumbbar_prompt_finish, c);
	return 1;
}

function find_next(field, target) {
	for (let i = 0; i < ui.holder.total_widgets; i++)
		if (ui.widgets[i].next[field] === target && i !== target) return i;
	return -1;
}

function find_right_or_down_to(target, check_not_equal) {
	const order = (status.flags & CLASSIC_MODE) ? ["right", "down"] : ["down", "right"];
	for (const field of order) {
		const n = find_next(field, target);
		if (n > -1 && n !== check_not_equal) return n;
	}
	return -1;
}

function find_tab_to_recursive(target) {
	let current = target;
	for (let i = 0; i < ui.holder.total_widgets; i++) {
		const backtab = ui.widgets[current].next.backtab;
		if (backtab > -1) return backtab;

		const tab_to = find_next("tab", current);
		if (tab_to > -1) return tab_to;

		const rd = find_right_or_down_to(current, target);
		if (rd > -1) { current = rd; continue; }

		return -1;
	}
	return -1;
}

function backtab() {
	/* hunt for a widget that leads back to this one */
	const selected = ui.holder.selected_widget;
	const bt = find_tab_to_recursive(selected);
	if (bt > -1) { widget_change_focus_to(bt); return; }

	const rd = find_right_or_down_to(selected, selected);
	if (rd > -1) widget_change_focus_to(rd);
}

export function widget_handle_text_input(text_input) {
	const w = active_widget();
	if (!w) return 0;

	switch (w.type) {
	case WIDGET_OTHER:
		if (w.accept_text && w.d.handle_text_input && w.d.handle_text_input(text_input)) return 1;
		break;
	case WIDGET_NUMENTRY:
		if (widget_numentry_handle_text(w, text_input)) return 1;
		break;
	case WIDGET_TEXTENTRY:
		if (widget_textentry_add_text(w, text_input)) return 1;
		break;
	}
	return 0;
}

const NO_CAG = (mod) => (mod & (KEYMOD.CTRL | KEYMOD.ALT | KEYMOD.GUI)) === 0;

function activation_index(keys, k) {
	if (!NO_CAG(k.mod) || !keys || k.sym <= 0 || k.sym > 255) return -1;
	return keys.indexOf(String.fromCharCode(k.sym));
}

function widget_menutoggle_handle_key(w, k) {
	const i = activation_index(w.d.activation_keys, k);
	if (i < 0) return 0;
	w.d.state = i;
	if (w.changed) w.changed();
	status.flags |= NEED_UPDATE;
	return 1;
}

function widget_bitset_handle_key(w, k) {
	const i = activation_index(w.d.activation_keys, k);
	if (i < 0) return 0;
	w.d.value ^= 1 << i;
	if (w.changed) w.changed();
	status.flags |= NEED_UPDATE;
	return 1;
}

function widget_listbox_handle_key(w, k) {
	const d = w.d;
	let new_focus = d.focus;
	const size = d.size();
	let raise_activate_event = 0;

	switch (k.mouse) {
	case MOUSE_DBLCLICK:
	case MOUSE_CLICK:
		if (k.state !== KEY_PRESS) return 0;
		if (k.x < w.x || k.y < w.y || k.y > w.y + w.height - 1 || k.x > w.x + w.width - 1) return 0;
		new_focus = d.top + k.y - w.y;
		if (k.mouse === MOUSE_DBLCLICK || new_focus === d.focus) raise_activate_event = 1;
		break;
	case MOUSE_SCROLL_UP:
		new_focus -= MOUSE_SCROLL_LINES;
		break;
	case MOUSE_SCROLL_DOWN:
		new_focus += MOUSE_SCROLL_LINES;
		break;
	default:
		if (k.state === KEY_RELEASE) return 0;
	}

	switch (k.sym) {
	case KEYSYM.UP:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (--new_focus < 0) return 0;
		break;
	case KEYSYM.DOWN:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (++new_focus >= size) return 0;
		break;
	case KEYSYM.HOME:
		if (!NO_MODIFIER(k.mod)) return 0;
		new_focus = 0;
		break;
	case KEYSYM.PAGEUP:
		if (!NO_MODIFIER(k.mod)) return 0;
		if (new_focus === 0) return 1;
		new_focus -= 16;
		break;
	case KEYSYM.END:
		if (!NO_MODIFIER(k.mod)) return 0;
		new_focus = size;
		break;
	case KEYSYM.PAGEDOWN:
		if (!NO_MODIFIER(k.mod)) return 0;
		new_focus += 16;
		break;
	case KEYSYM.RETURN:
		if (!NO_MODIFIER(k.mod)) return 0;
		raise_activate_event = 1;
		break;
	case KEYSYM.TAB: {
		let f;
		if (k.mod & KEYMOD.SHIFT) f = d.focus_offsets.left;
		else if (NO_MODIFIER(k.mod)) f = d.focus_offsets.right;
		else return 0;
		widget_change_focus_to(f[d.focus]);
		return 1;
	}
	case KEYSYM.LEFT:
		if (!NO_MODIFIER(k.mod)) return 0;
		widget_change_focus_to(d.focus_offsets.left[d.focus]);
		return 1;
	case KEYSYM.RIGHT:
		if (!NO_MODIFIER(k.mod)) return 0;
		widget_change_focus_to(d.focus_offsets.right[d.focus]);
		return 1;
	default:
		if (d.handle_key && d.handle_key(k)) return 1;
		if (k.mouse === MOUSE_NONE) return 0;
	}

	new_focus = clamp(new_focus, 0, size - 1);

	if (new_focus !== d.focus) {
		let top = d.top;

		d.focus = new_focus;
		status.flags |= NEED_UPDATE;

		/* done separately (not as a clamp): these aren't guaranteed to be ranges */
		top = Math.min(top, d.focus);
		top = Math.max(top, d.focus - w.height + 1);
		top = Math.min(top, size - w.height + 1);
		top = Math.max(top, 0);
		d.top = top;

		if (w.changed) w.changed();
	}

	if (raise_activate_event && w.activate) w.activate();

	return 1;
}

function panbar_unmute(w) {
	w.d.muted = 0;
	w.d.surround = 0;
}

function thumb_step(k) {
	let n = 1;
	if (k.mod & (KEYMOD.ALT | KEYMOD.GUI)) n *= 8;
	if (k.mod & KEYMOD.SHIFT) n *= 4;
	if (k.mod & KEYMOD.CTRL) n *= 2;
	return n;
}

export function widget_handle_key(k) {
	const widget = active_widget();
	if (!widget) return 0;

	const d = widget.d;
	const current_type = widget.type;
	const disko = status.flags & DISKWRITER_ACTIVE;
	let n, onw, wx, changed;

	if (!disko
	    && ((current_type === WIDGET_OTHER && d.handle_key(k))
	        || (current_type === WIDGET_LISTBOX && widget_listbox_handle_key(widget, k))))
		return 1;

	if (!disko && k.mouse && (status.flags & CLASSIC_MODE) && current_type === WIDGET_NUMENTRY) {
		if (k.mouse_button === MOUSE_BUTTON_LEFT) {
			k.sym = KEYSYM.MINUS;
			k.mouse = MOUSE_NONE;
		} else if (k.mouse_button === MOUSE_BUTTON_RIGHT) {
			k.sym = KEYSYM.PLUS;
			k.mouse = MOUSE_NONE;
		}
	}

	if (k.mouse === MOUSE_NONE) {
		onw = 0;
	} else {
		const pad = (current_type === WIDGET_BUTTON || current_type === WIDGET_TOGGLEBUTTON) ? 2 : 0;
		onw = (k.x < widget.x || k.x >= widget.x + widget.width + pad || k.y !== widget.y) ? 0 : 1;
	}

	if (k.mouse === MOUSE_CLICK) {
		if (disko) return 0;
		if (onw) {
			switch (current_type) {
			case WIDGET_TOGGLE:
				if (!NO_MODIFIER(k.mod)) return 0;
				if (k.state !== KEY_PRESS) return 1;
				d.state = d.state ? 0 : 1;
				if (widget.changed) widget.changed();
				status.flags |= NEED_UPDATE;
				return 1;
			case WIDGET_MENUTOGGLE:
				if (!NO_MODIFIER(k.mod)) return 0;
				if (k.state !== KEY_PRESS) return 1;
				d.state = (d.state + 1) % d.num_choices;
				if (widget.changed) widget.changed();
				status.flags |= NEED_UPDATE;
				return 1;
			}
		}
	} else if (k.mouse === MOUSE_DBLCLICK) {
		if (disko) return 0;
		if (onw && current_type === WIDGET_PANBAR) {
			if (!NO_MODIFIER(k.mod)) return 0;
			d.muted = d.muted ? 0 : 1;
			if (widget.changed) widget.changed();
			return 1;
		}
	}

	if (k.mouse === MOUSE_CLICK || (k.mouse === MOUSE_NONE && k.sym === KEYSYM.RETURN)) {
		if (k.mouse && (current_type === WIDGET_THUMBBAR || current_type === WIDGET_PANBAR)) {
			if (disko) return 0;

			/* swallow it */
			if (!k.on_target && k.state !== KEY_DRAG) return 0;

			const fmin = d.min, fmax = d.max;
			if (current_type === WIDGET_PANBAR) {
				n = k.fx - (widget.x + 11) * k.rx;
				wx = (widget.width - 16) * k.rx;
			} else {
				n = k.fx - widget.x * k.rx;
				wx = (widget.width - 1) * k.rx;
			}
			n = clamp(n, 0, wx);
			n = fmin + Math.trunc(n * (fmax - fmin) / wx);
			n = clamp(n, fmin, fmax);

			if (current_type === WIDGET_PANBAR) {
				panbar_unmute(widget);
				if (k.x - widget.x < 11) return 1;
				if (k.x - widget.x > 19) return 1;
			}

			widget_numentry_change_value(widget, n);
			return 1;
		}

		if (k.mouse) {
			n = (k.state === KEY_PRESS && onw) ? 1 : 0;
			if (widget.depressed !== n) status.flags |= NEED_UPDATE;
			else if (k.state === KEY_RELEASE) return 1; // swallow
			widget.depressed = n;
			if (current_type !== WIDGET_TEXTENTRY && current_type !== WIDGET_NUMENTRY) {
				if (k.state === KEY_PRESS || !onw) return 1;
			} else if (!onw) {
				return 1;
			}
		} else {
			n = (k.state === KEY_PRESS) ? 1 : 0;
			if (widget.depressed !== n) status.flags |= NEED_UPDATE;
			else if (k.state === KEY_RELEASE) return 1; // swallow
			widget.depressed = n;
			if (k.state === KEY_PRESS) return 1;
		}

		if (k.mouse) {
			switch (current_type) {
			case WIDGET_MENUTOGGLE:
			case WIDGET_BUTTON:
			case WIDGET_TOGGLEBUTTON:
				if (k.on_target && widget.activate) widget.activate();
			}
		} else if (current_type !== WIDGET_OTHER) {
			if (widget.activate) widget.activate();
		}

		switch (current_type) {
		case WIDGET_OTHER:
			break;
		case WIDGET_TEXTENTRY:
			if (disko) return 0;
			if (k.mouse === MOUSE_CLICK && k.on_target) {
				/* position cursor */
				n = clamp(k.x - widget.x, 0, widget.width - 1);
				d.cursor_pos = Math.min(n + d.firstchar, d.text.value.length);
				status.flags |= NEED_UPDATE;
			}
			/* for a text entry, the only thing enter does is run the activate callback.
			thus, if no activate callback is defined, the key wasn't handled */
			return widget.activate ? 1 : 0;
		case WIDGET_NUMENTRY:
			if (disko) return 0;
			if (k.mouse === MOUSE_CLICK && k.on_target) {
				d.cursor_pos.value = clamp(k.x - widget.x, 0, widget.width - 1);
				status.flags |= NEED_UPDATE;
			}
			break;
		case WIDGET_TOGGLEBUTTON:
			if (disko) return 0;
			if (d.group) {
				/* this also runs the changed callback and redraws the button(s) */
				if (k.state === KEY_DRAG) widget.depressed = k.on_target;
				else widget_togglebutton_set(ui.widgets, ui.holder.selected_widget, 1);
				return 1;
			}
			d.state = d.state ? 0 : 1;
			/* fall through */
		case WIDGET_BUTTON:
			if (k.state === KEY_DRAG) {
				widget.depressed = k.on_target;
			} else {
				if (widget.changed) widget.changed();
				status.flags |= NEED_UPDATE;
				return 1;
			}
		}
		return 0;
	}

	/* a WIDGET_OTHER that *didn't* handle the key itself needs to get run through the switch
	statement to account for stuff like the tab key */
	if (k.state === KEY_RELEASE) return 0;

	if (k.mouse === MOUSE_SCROLL_UP && current_type === WIDGET_NUMENTRY) k.sym = KEYSYM.MINUS;
	else if (k.mouse === MOUSE_SCROLL_DOWN && current_type === WIDGET_NUMENTRY) k.sym = KEYSYM.PLUS;

	switch (k.sym) {
	case KEYSYM.ESCAPE:
		/* keeps text entries from taking the key hostage instead of showing the menu */
		return 0;
	case KEYSYM.UP:
		if (disko) return 0;
		if (!NO_MODIFIER(k.mod)) return 0;
		widget_change_focus_to(widget.next.up);
		return 1;
	case KEYSYM.DOWN:
		if (disko) return 0;
		if (!NO_MODIFIER(k.mod)) return 0;
		widget_change_focus_to(widget.next.down);
		return 1;
	case KEYSYM.TAB:
		if (disko) return 0;
		if (k.mod & KEYMOD.SHIFT) { backtab(); return 1; }
		if (!NO_MODIFIER(k.mod)) return 0;
		widget_change_focus_to(widget.next.tab);
		return 1;
	case KEYSYM.LEFT:
	case KEYSYM.RIGHT: {
		if (disko) return 0;
		const dir = k.sym === KEYSYM.LEFT ? -1 : 1;
		switch (current_type) {
		case WIDGET_BITSET:
			if (NO_MODIFIER(k.mod)) bitset_move_cursor(widget, dir);
			break;
		case WIDGET_NUMENTRY:
			if (!NO_MODIFIER(k.mod)) return 0;
			numentry_move_cursor(widget, dir);
			return 1;
		case WIDGET_TEXTENTRY:
			if (!NO_MODIFIER(k.mod)) return 0;
			textentry_move_cursor(widget, dir);
			return 1;
		case WIDGET_PANBAR:
			panbar_unmute(widget);
			/* fall through */
		case WIDGET_THUMBBAR:
			/* modifiers handled differently than Impulse Tracker, on purpose (see C source) */
			widget_numentry_change_value(widget, d.value + dir * thumb_step(k));
			return 1;
		default:
			if (!NO_MODIFIER(k.mod)) return 0;
			widget_change_focus_to(dir < 0 ? widget.next.left : widget.next.right);
			return 1;
		}
		break;
	}
	case KEYSYM.HOME:
	case KEYSYM.END: {
		if (disko) return 0;
		const home = k.sym === KEYSYM.HOME;
		switch (current_type) {
		case WIDGET_NUMENTRY:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.cursor_pos.value = home ? 0 : widget.width - 1;
			status.flags |= NEED_UPDATE;
			return 1;
		case WIDGET_TEXTENTRY:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.cursor_pos = home ? 0 : d.text.value.length;
			status.flags |= NEED_UPDATE;
			return 1;
		case WIDGET_PANBAR:
			panbar_unmute(widget);
			/* fall through */
		case WIDGET_THUMBBAR:
			widget_numentry_change_value(widget, home ? d.min : d.max);
			return 1;
		}
		break;
	}
	case KEYSYM.SPACE:
		if (disko) return 0;
		switch (current_type) {
		case WIDGET_BITSET:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.value ^= 1 << d.cursor_pos.value;
			if (widget.changed) widget.changed();
			status.flags |= NEED_UPDATE;
			return 1;
		case WIDGET_TOGGLE:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.state = d.state ? 0 : 1;
			if (widget.changed) widget.changed();
			status.flags |= NEED_UPDATE;
			return 1;
		case WIDGET_MENUTOGGLE:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.state = (d.state + 1) % d.num_choices;
			if (widget.changed) widget.changed();
			status.flags |= NEED_UPDATE;
			return 1;
		case WIDGET_PANBAR:
			if (!NO_MODIFIER(k.mod)) return 0;
			d.muted = d.muted ? 0 : 1;
			changed = widget.changed;
			widget_change_focus_to(widget.next.down);
			if (changed) changed();
			return 1;
		}
		break;
	case KEYSYM.BACKSPACE:
		if (disko) return 0;
		if (current_type === WIDGET_NUMENTRY && d.reverse) {
			d.value = Math.trunc(d.value / 10);
			if (widget.changed) widget.changed();
			status.flags |= NEED_UPDATE;
			return 1;
		}
		if (current_type !== WIDGET_TEXTENTRY) break;
		if (!d.text.value) return 1; /* nothing to do */
		if (k.mod & KEYMOD.CTRL) {
			/* clear the whole field */
			d.text.value = "";
			d.cursor_pos = 0;
		} else if (d.cursor_pos === 0) {
			/* act like ST3 */
			text_delete_next_char(d.text, d);
		} else {
			text_delete_char(d.text, d);
		}
		if (widget.changed) widget.changed();
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.DELETE:
		if (disko) return 0;
		if (current_type !== WIDGET_TEXTENTRY) break;
		if (!d.text.value) return 1;
		text_delete_next_char(d.text, d);
		if (widget.changed) widget.changed();
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.PLUS:
		if (disko) return 0;
		if (current_type === WIDGET_NUMENTRY) {
			widget_numentry_change_value(widget, d.value + 1);
			return 1;
		}
		break;
	case KEYSYM.MINUS:
		if (disko) return 0;
		if (current_type === WIDGET_NUMENTRY && NO_MODIFIER(k.mod)) {
			widget_numentry_change_value(widget, d.value - 1);
			return 1;
		}
		break;
	case KEYSYM.l:
	case KEYSYM.m:
	case KEYSYM.r:
		if (disko) return 0;
		if (current_type === WIDGET_PANBAR) {
			const i = k.sym === KEYSYM.l ? 0 : k.sym === KEYSYM.m ? 1 : 2;
			if (k.mod & KEYMOD.ALT) {
				app.song_set_pan_scheme([PANS_LEFT, PANS_MONO, PANS_RIGHT][i]);
				return 1;
			} else if (NO_MODIFIER(k.mod)) {
				panbar_unmute(widget);
				widget_numentry_change_value(widget, [0, 32, 64][i]);
				return 1;
			}
		}
		break;
	case KEYSYM.s:
		if (disko) return 0;
		if (current_type === WIDGET_PANBAR) {
			if (k.mod & KEYMOD.ALT) {
				app.song_set_pan_scheme(PANS_STEREO);
				return 1;
			} else if (NO_MODIFIER(k.mod)) {
				d.muted = 0;
				d.surround = 1;
				if (widget.changed) widget.changed();
				status.flags |= NEED_UPDATE;
				return 1;
			}
		}
		break;
	case KEYSYM.a:
		if (disko) return 0;
		if (current_type === WIDGET_PANBAR && (k.mod & KEYMOD.ALT)) {
			app.song_set_pan_scheme(PANS_AMIGA);
			return 1;
		}
		break;
	case KEYSYM.SLASH:
	case KEYSYM.KP_DIVIDE:
		if (disko) return 0;
		if (current_type === WIDGET_PANBAR && (k.mod & KEYMOD.ALT)) {
			app.song_set_pan_scheme(PANS_SLASH);
			return 1;
		}
		break;
	case KEYSYM.BACKSLASH:
		if (disko) return 0;
		if (current_type === WIDGET_PANBAR && (k.mod & KEYMOD.ALT)) {
			app.song_set_pan_scheme(PANS_BACKSLASH);
			return 1;
		}
		break;
	}

	if (disko) return 0;

	/* if we're here, that mess didn't completely handle the key, so now here's another mess. */
	switch (current_type) {
	case WIDGET_MENUTOGGLE:
		if (widget_menutoggle_handle_key(widget, k)) return 1;
		break;
	case WIDGET_BITSET:
		if (widget_bitset_handle_key(widget, k)) return 1;
		break;
	case WIDGET_THUMBBAR:
	case WIDGET_PANBAR:
		if (thumbbar_prompt_value(widget, k)) return 1;
		break;
	case WIDGET_TEXTENTRY:
		if (NO_CAG(k.mod) && k.text && widget_textentry_add_text(widget, k.text)) return 1;
		break;
	case WIDGET_NUMENTRY:
		if (NO_CAG(k.mod) && k.text && widget_numentry_handle_text(widget, k.text)) return 1;
		/* weird hack ? */
		if (d.handle_unknown_key) return d.handle_unknown_key(k);
		break;
	}

	/* if we got down here the key wasn't handled */
	return 0;
}

provide({ widget_draw_widget, widget_handle_key, widget_handle_text_input, widget_change_focus_to });
