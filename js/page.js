// Partial port of schism/page.c and schism/status.c (Schism Tracker, GPL-2.0-or-later).
//
// Ported: screen frame, set_page, status text line, the global key handler
// (handle_key_global / handle_key), new-song dialog, the top-row "minipop"
// sliders, exit / time-jump / song-length prompts.
// TODO(port): _handle_ime (digraphs, Ctrl-Shift Unicode, Alt-numpad entry; needs
// charset.c), the top-right visualiser, the clock, and the values in
// redraw_top_info, which wait for the song and player modules.

import { status, tracker, PAGE, HELP, NEED_UPDATE, INVERTED_PALETTE, CLASSIC_MODE, SONG_NEEDS_SAVE,
	DIALOG_MENU, DIALOG_BOX, DIALOG_NONE } from "./state.js";
import { draw_char, draw_text, draw_text_len, draw_text_bios_len, draw_fill_chars, draw_box, draw_vu_meter,
	vgamem_ovl_alloc, vgamem_ovl_clear, vgamem_ovl_apply, draw_sample_data_rect,
	DEFAULT_FG, BOX_THIN, BOX_INNER, BOX_INSET } from "./vgamem.js";
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK,
	kbd_get_current_octave, kbd_set_current_octave } from "./keyboard.js";
import { str_from_num99 } from "./widget.js";
import { ui_set, widget_draw_widget, widget_handle_key, widget_handle_text_input, widget_change_focus_to,
	widget_create_togglebutton, widget_create_button, widget_create_thumbbar, widget_create_numentry,
	widget_togglebutton_set, active_widget, ui } from "./widget.js";
import { dialog_draw, dialog_create, dialog_create_custom, dialog_destroy_all, dialog_handle_key,
	dialog_yes_NULL, dialog_cancel_NULL } from "./dialog.js";
import { font_reset } from "./vgamem.js";
import { VIS_SENTINEL, DISKWRITER_ACTIVE, STARTUP_FONTEDIT, DIALOG_OK, DIALOG_OK_CANCEL } from "./state.js";
import { menu_draw, menu_show, menu_hide, menu_handle_key } from "./menu.js";
import { app, provide, is_ported, optional } from "./app.js";

export const SCHISM_VERSION = "20261111"; // upstream commit date this port tracks

export function schism_banner(classic) {
	return classic ? "Impulse Tracker v2.14 Copyright (C) 1995-1998 Jeffrey Lim" : "Schism Tracker " + SCHISM_VERSION;
}

// ---------------------------------------------------------------------------
// pages

function make_page(title, help_index = HELP.GLOBAL) {
	return {
		title, help_index,
		draw_full: null, draw_const: null, song_changed_cb: null, predraw_hook: null,
		playback_update: null, pre_handle_key: null, handle_key: null, handle_text_input: null,
		set_page: null, song_mode_changed_cb: null, clipboard_paste: null,
		widgets: [], selected_widget: 0, total_widgets: 0,
		ported: false,
	};
}

// Titles as they appear in the C page_*.c files; the page bodies arrive as
// each file is ported (a page registers itself with pages[n] = {...}).
const TITLES = {
	BLANK: "", HELP: "Help", ABOUT: "", LOG: "Message Log Viewer (Ctrl-F11)",
	PATTERN_EDITOR: "Pattern Editor (F2)", SAMPLE_LIST: "Sample List (F3)", INFO: "Info Page (F5)",
	CONFIG: "System Configuration (Ctrl-F1)", PREFERENCES: "Preferences (Shift-F5)",
	MIDI: "MIDI Screen (Shift-F1)", MIDI_OUTPUT: "MIDI Output Configuration",
	LOAD_MODULE: "Load Module (F9)", SAVE_MODULE: "Save Module (F10)", EXPORT_MODULE: "Export Module (Shift-F10)",
	ORDERLIST_PANNING: "Order List and Panning (F11)", ORDERLIST_VOLUMES: "Order List and Channel Volume (F11)",
	SONG_VARIABLES: "Song Variables & Directory Configuration (F12)", MESSAGE: "Message Editor (Shift-F9)",
	TIME_INFORMATION: "Time Information",
	INSTRUMENT_LIST_GENERAL: "Instrument List (F4)", INSTRUMENT_LIST_VOLUME: "Instrument List (F4)",
	INSTRUMENT_LIST_PANNING: "Instrument List (F4)", INSTRUMENT_LIST_PITCH: "Instrument List (F4)",
	LOAD_SAMPLE: "Load Sample", LIBRARY_SAMPLE: "Sample Library (Ctrl-F3)",
	LOAD_INSTRUMENT: "Load Instrument", LIBRARY_INSTRUMENT: "Instrument Library (Ctrl-F4)",
	PALETTE_EDITOR: "Palette Configuration (Ctrl-F12)", FONT_EDIT: "", WATERFALL: "",
};

export const pages = [];
for (const [name, n] of Object.entries(PAGE)) if (name !== "MAX") pages[n] = make_page(TITLES[name]);

export const ilist = { subpage: PAGE.INSTRUMENT_LIST_GENERAL };
const active_page = () => pages[status.current_page];

// ---------------------------------------------------------------------------
// status text (status.c)

let status_text = null, status_bios = false, text_timeout = 0;

export function status_text_flash(text) {
	text_timeout = performance.now() + 1000;
	status_text = text;
	status_bios = false;
	status.flags |= NEED_UPDATE;
}

export function status_text_flash_bios(text) {
	status_text_flash(text);
	status_bios = true;
}

export function status_text_redraw() {
	if (status_text && performance.now() > text_timeout) status_text = null;

	if (status_text) {
		(status_bios ? draw_text_bios_len : draw_text_len)(status_text, 60, 2, 9, 0, 2);
	}
	else draw_playing_status();
}

function draw_playing_status() {
	const mode = app.song_get_mode();
	if (mode !== 1 && mode !== 2) {
		if (mode === 4 && app.song_get_playing_channels() > 1) {
			let pos = 2;
			pos += draw_text("Playing, ", 2, 9, 0, 2);
			pos += draw_text(String(app.song_get_playing_channels()), pos, 9, 3, 2);
			draw_text(" Channels", pos, 9, 0, 2);
		}
		return;
	}
	const song = app.current_song();
	let pos = 2;
	const pattern = app.song_get_playing_pattern();
	if (song.repeat_count < 1 || (status.flags & CLASSIC_MODE)) pos += draw_text("Playing", pos, 9, 0, 2);
	else { pos += draw_text("Loop: ", pos, 9, 0, 2); pos += draw_text(String(song.repeat_count), pos, 9, 3, 2); }
	if (mode === 1) {
		pos += draw_text(", Order: ", pos, 9, 0, 2);
		pos += draw_text(String(app.song_get_current_order()), pos, 9, 3, 2);
		draw_char(47, pos++, 9, 0, 2);
		pos += draw_text(String(app.csf_last_order(song)), pos, 9, 3, 2);
	}
	pos += draw_text(", Pattern: ", pos, 9, 0, 2);
	pos += draw_text(String(pattern), pos, 9, 3, 2);
	pos += draw_text(", Row: ", pos, 9, 0, 2);
	pos += draw_text(String(app.song_get_current_row()), pos, 9, 3, 2);
	draw_char(47, pos++, 9, 0, 2);
	pos += draw_text(String(app.song_get_pattern(pattern)), pos, 9, 3, 2);
	draw_char(44, pos++, 9, 0, 2);
	draw_char(0, pos++, 9, 0, 2);
	pos += draw_text(String(app.song_get_playing_channels()), pos, 9, 3, 2);
	if (draw_text_len(" Channels", 62 - pos, pos, 9, 0, 2) < 9) draw_char(16, 61, 9, 1, 2);
}

/* whether a timed-out message still needs one more redraw to disappear */
export function status_text_pending() { return status_text !== null; }

// ---------------------------------------------------------------------------

function draw_page_title() {
	const title = active_page().title;
	const tlen = title.length;

	if (tlen > 0) {
		const tpos = 41 - ((tlen + 1) >> 1);
		for (let x = 1; x < tpos - 1; x++) draw_char(154, x, 11, 1, 2);
		draw_char(0, tpos - 1, 11, 1, 2);
		draw_text(title, tpos, 11, 0, 2);
		draw_char(0, tpos + tlen, 11, 1, 2);
		for (let x = tpos + tlen + 1; x < 79; x++) draw_char(154, x, 11, 1, 2);
	} else {
		for (let x = 1; x < 79; x++) draw_char(154, x, 11, 1, 2);
	}
}

function draw_page() {
	const page = active_page();

	if (page.draw_full) {
		page.draw_full();
	} else {
		draw_page_title();
		if (page.draw_const) page.draw_const();
		if (page.predraw_hook) page.predraw_hook();
		if (!page.ported && page.title)
			draw_text("This page has not been ported yet (see PORTING.md).", 14, 30, 1, 2);
	}

	// draws the page's widgets whether or not a dialog is active
	for (let n = page.total_widgets - 1; n >= 0; n--)
		widget_draw_widget(page.widgets[n], n === page.selected_widget);

	if (status.dialog_type & DIALOG_MENU) menu_draw();
	else if (status.dialog_type & DIALOG_BOX) dialog_draw();
}

function draw_top_info_const() {
	const inv = status.flags & INVERTED_PALETTE;
	const tl = inv ? 3 : 1, br = inv ? 1 : 3;
	const banner = schism_banner(status.flags & CLASSIC_MODE);
	let n;

	draw_text(banner, (80 - banner.length) >> 1, 1, 0, 2);
	draw_text("Song Name", 2, 3, 0, 2);
	draw_text("File Name", 2, 4, 0, 2);
	draw_text("Order", 6, 5, 0, 2);
	draw_text("Pattern", 4, 6, 0, 2);
	draw_text("Row", 8, 7, 0, 2);

	draw_text("Speed/Tempo", 38, 4, 0, 2);
	draw_text("Octave", 43, 5, 0, 2);

	draw_text("F1...Help       F9.....Load", 21, 6, 0, 2);
	draw_text("ESC..Main Menu  F5/F8..Play / Stop", 21, 7, 0, 2);

	/* the neat-looking (but incredibly ugly to draw) borders */
	draw_char(128, 30, 4, br, 2);
	draw_char(128, 57, 4, br, 2);
	draw_char(128, 19, 5, br, 2);
	draw_char(128, 51, 5, br, 2);
	draw_char(129, 36, 4, br, 2);
	draw_char(129, 50, 6, br, 2);
	draw_char(129, 17, 8, br, 2);
	draw_char(129, 18, 8, br, 2);
	draw_char(131, 37, 3, br, 2);
	draw_char(131, 78, 3, br, 2);
	draw_char(131, 19, 6, br, 2);
	draw_char(131, 19, 7, br, 2);
	draw_char(132, 49, 3, tl, 2);
	draw_char(132, 49, 4, tl, 2);
	draw_char(132, 49, 5, tl, 2);
	draw_char(134, 75, 2, tl, 2);
	draw_char(134, 76, 2, tl, 2);
	draw_char(134, 77, 2, tl, 2);
	draw_char(136, 37, 4, br, 2);
	draw_char(136, 78, 4, br, 2);
	draw_char(136, 30, 5, br, 2);
	draw_char(136, 57, 5, br, 2);
	draw_char(136, 51, 6, br, 2);
	draw_char(136, 19, 8, br, 2);
	draw_char(137, 49, 6, br, 2);
	draw_char(137, 11, 8, br, 2);
	draw_char(138, 37, 2, tl, 2);
	draw_char(138, 78, 2, tl, 2);
	draw_char(139, 11, 2, tl, 2);
	draw_char(139, 49, 2, tl, 2);

	for (n = 0; n < 5; n++) {
		draw_char(132, 11, 3 + n, tl, 2);
		draw_char(129, 12 + n, 8, br, 2);
		draw_char(134, 12 + n, 2, tl, 2);
		draw_char(129, 20 + n, 5, br, 2);
		draw_char(129, 31 + n, 4, br, 2);
		draw_char(134, 32 + n, 2, tl, 2);
		draw_char(134, 50 + n, 2, tl, 2);
		draw_char(129, 52 + n, 5, br, 2);
		draw_char(129, 58 + n, 4, br, 2);
		draw_char(134, 70 + n, 2, tl, 2);
	}
	for (; n < 10; n++) {
		draw_char(134, 12 + n, 2, tl, 2);
		draw_char(129, 20 + n, 5, br, 2);
		draw_char(134, 50 + n, 2, tl, 2);
		draw_char(129, 58 + n, 4, br, 2);
	}
	for (; n < 20; n++) {
		draw_char(134, 12 + n, 2, tl, 2);
		draw_char(134, 50 + n, 2, tl, 2);
		draw_char(129, 58 + n, 4, br, 2);
	}

	draw_text("Time", 63, 9, 0, 2);
	draw_char(47, 15, 5, 1, 0);
	draw_char(47, 15, 6, 1, 0);
	draw_char(47, 15, 7, 1, 0);
	draw_char(47, 53, 4, 1, 0);
	draw_char(58, 52, 3, 7, 0);
}

const num3 = (n) => String(n).padStart(3, "0");

export function update_current_instrument() {
	let ins_mode, n, name = null;
	const cp = status.current_page;
	if (page_is_instrument_list(cp) || cp === PAGE.SAMPLE_LIST || cp === PAGE.LOAD_SAMPLE || cp === PAGE.LIBRARY_SAMPLE
		|| (!(status.flags & CLASSIC_MODE) && (cp === PAGE.ORDERLIST_PANNING || cp === PAGE.ORDERLIST_VOLUMES)))
		ins_mode = 0;
	else ins_mode = app.song_is_instrument_mode();
	if (ins_mode) {
		draw_text("Instrument", 39, 3, 0, 2);
		n = app.instrument_get_current();
		if (n > 0) name = app.song_get_instrument(n).name;
	} else {
		draw_text("    Sample", 39, 3, 0, 2);
		n = app.sample_get_current();
		if (n > 0) name = app.song_get_sample(n).name;
	}
	if (n > 0) {
		draw_text(str_from_num99(n), 50, 3, 5, 0);
		draw_text_len(name || "", 25, 53, 3, 5, 0);
	} else {
		draw_text("..", 50, 3, 5, 0);
		draw_text(".........................", 53, 3, 5, 0);
	}
}

function redraw_top_info() {
	update_current_instrument();
	draw_text_len(app.song_get_basename(), 18, 12, 4, 5, 0);
	draw_text_len(app.current_song().title, 25, 12, 3, 5, 0);
	if ((status.flags & (CLASSIC_MODE | SONG_NEEDS_SAVE)) === SONG_NEEDS_SAVE)
		draw_char(43, 29, 4, 4, 0);
	app.update_current_order();
	app.update_current_pattern();
	app.update_current_row();
	draw_text(num3(app.song_get_current_speed()), 50, 4, 5, 0);
	draw_text(num3(app.song_get_current_tempo()), 54, 4, 5, 0);
	draw_char(48 + kbd_get_current_octave(), 50, 5, 5, 0);
}

// clock (check_time / draw_time)
const current_time = { h: -1, m: -1, s: -1 };
const start_time = performance.now();
export function check_time() {
	let td = status.time_display;
	const playing = app.song_get_mode() & (1 | 2);
	if (td === 1) td = playing ? 7 : 4;
	else if (td === 2) td = playing ? 7 : 5;
	else if (td === 3) td = playing ? 7 : 0;
	let h = 0, m = 0, sec = 0;
	if (td === 7) sec = app.song_get_current_time();
	else if (td === 4) sec = Math.trunc((performance.now() - start_time) / 1000);
	else if (td === 5) { const d = new Date(); h = d.getHours(); m = d.getMinutes(); sec = d.getSeconds(); }
	if (td === 7 || td === 4) { m = Math.trunc(sec / 60); h = Math.trunc(m / 60); }
	if (h === current_time.h && m === current_time.m && sec === current_time.s) return 0;
	Object.assign(current_time, { h, m, s: sec });
	return 1;
}
function draw_time() {
	const playing = app.song_get_mode() & (1 | 2);
	if (status.time_display === 0 || (status.time_display === 3 && !playing)) return;
	draw_text(`${String(current_time.h % 1000).padStart(3, " ")}:${String(current_time.m % 60).padStart(2, "0")}:${String(current_time.s % 60).padStart(2, "0")}`, 69, 9, 0, 2);
}

const vis_overlay = vgamem_ovl_alloc({ x1: 63, y1: 6, x2: 77, y2: 7 });
function draw_vis_box() {
	draw_box(62, 5, 78, 8, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_fill_chars(63, 6, 77, 7, DEFAULT_FG, 0);
}
function draw_vis() {
	if (status.flags & CLASSIC_MODE) { draw_text("FreeMem 640k", 63, 6, 0, 2); draw_text("FreeEMS 65536k", 63, 7, 0, 2); return; }
	switch (status.vis_style) {
	case 1: draw_text("   Song    0k", 63, 6, 0, 2); draw_text("Samples    0k", 63, 7, 0, 2); break;
	case 2: case 4: case 5: {
		draw_vis_box();
		const buf = app.song_get_vis_buffer();
		draw_sample_data_rect(vis_overlay, buf, 16, buf.length, 2, status.vis_style === 4 ? 1 : 2);
		break;
	}
	case 3: {
		const [l, r] = app.song_get_vu_meter();
		draw_vis_box();
		draw_vu_meter(63, 6, 15, l >> 1, 5, 4);
		draw_vu_meter(63, 7, 15, r >> 1, 5, 4);
		break;
	}
	}
}

/* this completely redraws everything. */
export function redraw_screen() {
	const full = !!active_page().draw_full;

	if (!full) {
		draw_fill_chars(0, 0, 79, 49, DEFAULT_FG, 2);

		/* border around the whole screen */
		draw_char(128, 0, 0, 3, 2);
		let n;
		for (n = 79; n > 49; n--) draw_char(129, n, 0, 3, 2);
		do {
			draw_char(129, n, 0, 3, 2);
			draw_char(131, 0, n, 3, 2);
		} while (--n);

		draw_top_info_const();
		redraw_top_info();

		draw_vis();
		draw_time();
		status_text_redraw();
	}

	draw_page();
}

// ---------------------------------------------------------------------------

export function set_page(new_page) {
	const prev_page = status.current_page;

	if (new_page !== prev_page) status.previous_page = prev_page;
	status.current_page = new_page;

	if (new_page === PAGE.SAMPLE_LIST || new_page === PAGE.LOAD_SAMPLE || new_page === PAGE.LIBRARY_SAMPLE) {
		// _set_from_f4
		const pp = status.previous_page;
		if (!(pp === PAGE.SAMPLE_LIST || pp === PAGE.LOAD_SAMPLE || pp === PAGE.LIBRARY_SAMPLE
			|| (!(status.flags & CLASSIC_MODE) && (pp === PAGE.ORDERLIST_PANNING || pp === PAGE.ORDERLIST_VOLUMES)))
			&& app.song_is_instrument_mode()) optional("sample_synchronize_to_instrument");
	} else if (page_is_instrument_list(new_page)) {
		// _set_from_f3
		const pp = status.previous_page;
		if (pp === PAGE.SAMPLE_LIST || (!(status.flags & CLASSIC_MODE) && (pp === PAGE.ORDERLIST_PANNING || pp === PAGE.ORDERLIST_VOLUMES))) {
			if (app.song_is_instrument_mode()) optional("instrument_synchronize_to_sample");
			else app.instrument_set(app.sample_get_current());
		}
	}

	if (new_page !== PAGE.HELP) status.current_help_index = active_page().help_index;

	if (status.dialog_type & DIALOG_MENU) {
		menu_hide();
	} else if (status.dialog_type !== DIALOG_NONE) {
		return;
	}

	/* update the pointers */
	ui_set(active_page().widgets, active_page());

	if (active_page().set_page) active_page().set_page();
	status.flags |= NEED_UPDATE;
}

// ---------------------------------------------------------------------------
// new song dialog

const KEEP_PATTERNS = 1, KEEP_SAMPLES = 2, KEEP_INSTRUMENTS = 4, KEEP_ORDERLIST = 8;
const MODE_STOPPED = 0, MODE_PLAYING = 1, MODE_PATTERN_LOOP = 2, MODE_SINGLE_STEP = 4;

let new_song_widgets = null;
const new_song_groups = [[0, 1, -1], [2, 3, -1], [4, 5, -1], [6, 7, -1]];

function new_song_ok() {
	let flags = 0;
	if (new_song_widgets[0].d.state) flags |= KEEP_PATTERNS;
	if (new_song_widgets[2].d.state) flags |= KEEP_SAMPLES;
	if (new_song_widgets[4].d.state) flags |= KEEP_INSTRUMENTS;
	if (new_song_widgets[6].d.state) flags |= KEEP_ORDERLIST;
	app.song_new(flags);
}

function new_song_draw_const() {
	draw_text("New Song", 36, 21, 3, 2);
	draw_text("Patterns", 26, 24, 0, 2);
	draw_text("Samples", 27, 27, 0, 2);
	draw_text("Instruments", 23, 30, 0, 2);
	draw_text("Order List", 24, 33, 0, 2);
}

export function new_song_dialog() {
	/* only create everything if it hasn't been set up already */
	if (!new_song_widgets) {
		const g = new_song_groups;
		new_song_widgets = [
			widget_create_togglebutton(35, 24, 6, 0, 2, 1, 1, 1, null, "Keep", 2, g[0]),
			widget_create_togglebutton(45, 24, 7, 1, 3, 0, 0, 0, null, "Clear", 2, g[0]),
			widget_create_togglebutton(35, 27, 6, 0, 4, 3, 3, 3, null, "Keep", 2, g[1]),
			widget_create_togglebutton(45, 27, 7, 1, 5, 2, 2, 2, null, "Clear", 2, g[1]),
			widget_create_togglebutton(35, 30, 6, 2, 6, 5, 5, 5, null, "Keep", 2, g[2]),
			widget_create_togglebutton(45, 30, 7, 3, 7, 4, 4, 4, null, "Clear", 2, g[2]),
			widget_create_togglebutton(35, 33, 6, 4, 8, 7, 7, 7, null, "Keep", 2, g[3]),
			widget_create_togglebutton(45, 33, 7, 5, 9, 6, 6, 6, null, "Clear", 2, g[3]),
			widget_create_button(28, 36, 8, 6, 8, 9, 9, 9, dialog_yes_NULL, "OK", 4),
			widget_create_button(41, 36, 8, 6, 9, 8, 8, 8, dialog_cancel_NULL, "Cancel", 2),
		];
		widget_togglebutton_set(new_song_widgets, 1, 0);
		widget_togglebutton_set(new_song_widgets, 3, 0);
		widget_togglebutton_set(new_song_widgets, 5, 0);
		widget_togglebutton_set(new_song_widgets, 7, 0);
	}

	const dialog = dialog_create_custom(21, 20, 38, 19, new_song_widgets, 10, 8, new_song_draw_const, null);
	dialog.action_yes = new_song_ok;
}

// ---------------------------------------------------------------------------
// "minipop" sliders: click a number in the top info area to drag it

let mp_active = 0;
let mpw = [];
let mp_setv = null, mp_setv_noplay = null;
let mp_text = "", mp_text_x = 0, mp_text_y = 0;

function mp_draw() {
	let name;

	if (mp_text[0] === "!") {
		const n = app.instrument_get_current();
		name = n ? app.song_get_instrument(n).name : "(No Instrument)";
	} else if (mp_text[0] === "@") {
		const n = app.sample_get_current();
		name = n > 0 ? app.song_get_sample(n).name : "(No Sample)";
	} else {
		name = mp_text;
	}

	draw_fill_chars(mp_text_x, mp_text_y, mp_text_x + 17, mp_text_y, DEFAULT_FG, 2);
	draw_text_len(name, 17, mp_text_x, mp_text_y, 0, 2);
	if (name.length < 17 && name === mp_text) draw_char(58, mp_text_x + name.length, mp_text_y, 0, 2);
	draw_box(mp_text_x, mp_text_y + 1, mp_text_x + 14, mp_text_y + 3, BOX_THIN | BOX_INNER | BOX_INSET);
}

function mp_change() {
	if (mp_setv) mp_setv(mpw[0].d.value);
	if (!(app.song_get_mode() & (MODE_PLAYING | MODE_PATTERN_LOOP)) && mp_setv_noplay)
		mp_setv_noplay(mpw[0].d.value);
	mp_active = 2;
}

function mp_finish() {
	if (mp_active) {
		dialog_destroy_all();
		mp_active = 0;
	}
}

function minipop_slide(cv, name, min, max, setv, setv_noplay, midx, midy) {
	if (mp_active === 1) {
		mp_active = 2;
		return;
	}
	mp_text = name;
	mp_text_x = midx - 9;
	mp_text_y = midy - 2;
	mp_setv = setv;
	mp_setv_noplay = setv_noplay;
	mpw = [widget_create_thumbbar(midx - 8, midy, 13, 0, 0, 0, mp_change, min, max)];
	mpw[0].d.value = Math.min(Math.max(cv, min), max);
	mpw[0].depressed = 1;
	dialog_create_custom(midx - 10, midy - 3, 20, 6, mpw, 1, 0, mp_draw, null);
	// (C warps the mouse onto the slider knob here; a web page cannot move the pointer)
	mp_active = 1;
	status.flags |= NEED_UPDATE;
}

// ---------------------------------------------------------------------------
// text input

export function handle_text_input(text_input) {
	if (widget_handle_text_input(text_input)) return;

	if (!(status.dialog_type & DIALOG_BOX) && active_page().handle_text_input)
		active_page().handle_text_input(text_input);
}

// ---------------------------------------------------------------------------
// global keys. returns 1 if the key was handled

let fontedit_return_page = PAGE.PATTERN_EDITOR;

function handle_key_global(k) {
	const ctrl = k.mod & KEYMOD.CTRL, shift = k.mod & KEYMOD.SHIFT, alt = k.mod & KEYMOD.ALT;
	const pressed = k.state === KEY_PRESS;
	const no_dialog = status.dialog_type === DIALOG_NONE;
	const instrument_list = () => page_is_instrument_list(status.current_page);

	if (mp_active === 2 && k.mouse === MOUSE_CLICK && k.state === KEY_RELEASE) {
		status.flags |= NEED_UPDATE;
		dialog_destroy_all();
		mp_active = 0;
		return 1; // eat it...
	}

	if (!mp_active && pressed && k.mouse === MOUSE_CLICK) {
		if (k.x >= 63 && k.x <= 77 && k.y >= 6 && k.y <= 7) {
			status.vis_style = (status.vis_style + 1) % VIS_SENTINEL;
			status.flags |= NEED_UPDATE;
			return 1;
		} else if (k.y === 5 && k.x === 50) {
			minipop_slide(kbd_get_current_octave(), "Octave", 0, 8, kbd_set_current_octave, null, 50, 5);
			return 1;
		} else if (k.y === 4 && k.x >= 50 && k.x <= 52) {
			minipop_slide(app.song_get_current_speed(), "Speed", 1, 255,
				app.song_set_current_speed, app.song_set_initial_speed, 51, 4);
			return 1;
		} else if (k.y === 4 && k.x >= 54 && k.x <= 56) {
			minipop_slide(app.song_get_current_tempo(), "Tempo", 32, 255,
				app.song_set_current_tempo, app.song_set_initial_tempo, 55, 4);
			return 1;
		} else if (k.y === 3 && k.x >= 50 && k.x <= 77) {
			let ins_mode;
			if (instrument_list() || status.current_page === PAGE.SAMPLE_LIST
			    || (!(status.flags & CLASSIC_MODE)
			        && (status.current_page === PAGE.ORDERLIST_PANNING
			            || status.current_page === PAGE.ORDERLIST_VOLUMES)))
				ins_mode = 0;
			else
				ins_mode = app.song_is_instrument_mode();

			if (ins_mode) {
				minipop_slide(app.instrument_get_current(), "Instrument",
					status.current_page === ilist.subpage ? 1 : 0, 99, app.instrument_set, null, 58, 3);
			} else {
				minipop_slide(app.sample_get_current(), "Sample",
					status.current_page === PAGE.SAMPLE_LIST ? 1 : 0, 99, app.sample_set, null, 58, 3);
			}
		} else if (k.x >= 12 && k.x <= 18) {
			if (k.y === 7) {
				minipop_slide(app.get_current_row(), "Row", 0,
					app.song_get_max_row_number_in_pattern(app.get_current_pattern()),
					app.set_current_row, null, 14, 7);
				return 1;
			} else if (k.y === 6) {
				minipop_slide(app.get_current_pattern(), "Pattern", 0, app.csf_get_num_patterns(app.current_song()),
					app.set_current_pattern, null, 14, 6);
				return 1;
			} else if (k.y === 5) {
				minipop_slide(app.get_current_order(), "Order", 0, app.csf_get_num_orders(app.current_song()),
					app.set_current_order, null, 14, 5);
				return 1;
			}
		}
	} else if (!mp_active && k.mouse === MOUSE_DBLCLICK) {
		if (k.y === 4 && k.x >= 11 && k.x <= 28) {
			set_page(PAGE.SAVE_MODULE);
			return 1;
		} else if (k.y === 3 && k.x >= 11 && k.x <= 35) {
			set_page(PAGE.SONG_VARIABLES);
			return 1;
		}
	}

	/* shortcut */
	if (k.mouse !== MOUSE_NONE) return 0;

	/* first, the truly global keys (the ones that still work if a dialog's open) */
	switch (k.sym) {
	case KEYSYM.RETURN:
		if (ctrl && alt) {
			if (pressed) return 1;
			app.toggle_display_fullscreen();
			return 1;
		}
		break;
	case KEYSYM.m:
		if (ctrl) {
			if (!pressed) return 1;
			app.video_mousecursor_cycle();
			return 1;
		}
		break;
	case KEYSYM.d:
		if (ctrl) {
			if (!pressed) return 1;
			app.video_toggle_input_grab();
			return 1;
		}
		break;
	case KEYSYM.i:
		/* reset audio stuff? */
		if (ctrl) {
			if (!pressed) return 1;
			app.audio_reinit(null);
			return 1;
		}
		break;
	case KEYSYM.e:
		/* This should reset everything display-related. */
		if (ctrl) {
			if (!pressed) return 1;
			font_reset(); // TODO(port): font_init() also reloads the configured font file
			status.flags |= NEED_UPDATE;
			return 1;
		}
		break;
	case KEYSYM.HOME:
	case KEYSYM.END:
		if (!alt) break;
		if (status.flags & DISKWRITER_ACTIVE) break;
		if (!pressed) return 0;
		kbd_set_current_octave(kbd_get_current_octave() + (k.sym === KEYSYM.HOME ? -1 : 1));
		return 1;
	}

	/* next, if there's no dialog, check the rest of the keys */
	if (status.flags & DISKWRITER_ACTIVE) return 0;

	switch (k.sym) {
	case KEYSYM.q:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (pressed) {
				if (shift) { app.schism_exit(0); return 1; }
				show_exit_prompt();
			}
			return 1;
		}
		break;
	case KEYSYM.n:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (pressed) new_song_dialog();
			return 1;
		}
		break;
	case KEYSYM.g:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (pressed) show_song_timejump();
			return 1;
		}
		break;
	case KEYSYM.p:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (pressed) show_song_length();
			return 1;
		}
		break;
	case KEYSYM.F1:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (pressed) set_page(PAGE.CONFIG);
		} else if (shift) {
			mp_finish();
			if (pressed) set_page(status.current_page === PAGE.MIDI ? PAGE.MIDI_OUTPUT : PAGE.MIDI);
		} else if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) set_page(PAGE.HELP);
		} else {
			break;
		}
		return 1;
	case KEYSYM.F2:
		if (ctrl) {
			if (status.current_page === PAGE.PATTERN_EDITOR) {
				mp_finish();
				if (pressed && no_dialog) app.pattern_editor_length_edit();
				return 1;
			}
			if (!no_dialog) return 0;
		} else if (NO_MODIFIER(k.mod)) {
			if (status.current_page === PAGE.PATTERN_EDITOR) {
				if (pressed) {
					if (status.dialog_type & DIALOG_MENU) {
						return 0;
					} else if (!no_dialog) {
						dialog_yes_NULL();
						status.flags |= NEED_UPDATE;
					} else {
						mp_finish();
						app.pattern_editor_display_options();
					}
				}
			} else {
				if (!no_dialog) return 0;
				mp_finish();
				if (pressed) set_page(PAGE.PATTERN_EDITOR);
			}
			return 1;
		}
		break;
	case KEYSYM.F3:
		if (!no_dialog) return 0;
		if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) set_page(PAGE.SAMPLE_LIST);
		} else {
			mp_finish();
			if (ctrl) set_page(PAGE.LIBRARY_SAMPLE);
			break;
		}
		return 1;
	case KEYSYM.F4:
		if (!no_dialog) return 0;
		if (NO_MODIFIER(k.mod)) {
			if (status.current_page === ilist.subpage) return 0;
			mp_finish();
			if (pressed) set_page(ilist.subpage);
		} else {
			if (shift) return 0;
			mp_finish();
			if (ctrl) set_page(PAGE.LIBRARY_INSTRUMENT);
			break;
		}
		return 1;
	case KEYSYM.F5:
		if (ctrl) {
			mp_finish();
			if (pressed) app.song_start();
		} else if (shift) {
			if (!no_dialog) return 0;
			mp_finish();
			if (pressed) set_page(PAGE.PREFERENCES);
		} else if (NO_MODIFIER(k.mod)) {
			const mode = app.song_get_mode();
			if (mode === MODE_STOPPED || (mode === MODE_SINGLE_STEP && status.current_page === PAGE.INFO)) {
				mp_finish();
				if (pressed) app.song_start();
			}
			if (pressed) {
				if (!no_dialog) return 0;
				mp_finish();
				set_page(PAGE.INFO);
			}
		} else {
			break;
		}
		return 1;
	case KEYSYM.F6:
		if (shift) {
			mp_finish();
			if (pressed) app.song_start_at_order(app.get_current_order(), 0);
		} else if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) app.song_loop_pattern(app.get_current_pattern(), 0);
		} else {
			break;
		}
		return 1;
	case KEYSYM.F7:
		if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) app.play_song_from_mark();
		} else {
			break;
		}
		return 1;
	case KEYSYM.F8:
		if (shift) {
			if (pressed) app.song_pause();
		} else if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) app.song_stop();
			status.flags |= NEED_UPDATE;
		} else {
			break;
		}
		return 1;
	case KEYSYM.F9:
		if (!no_dialog) return 0;
		if (shift) {
			mp_finish();
			if (pressed) set_page(PAGE.MESSAGE);
		} else if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) set_page(PAGE.LOAD_MODULE);
		} else {
			break;
		}
		return 1;
	case KEYSYM.l:
	case KEYSYM.r:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (k.state === KEY_RELEASE) set_page(PAGE.LOAD_MODULE);
		} else {
			break;
		}
		return 1;
	case KEYSYM.s:
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (k.state === KEY_RELEASE) app.save_song_or_save_as();
		} else {
			break;
		}
		return 1;
	case KEYSYM.w:
		/* Ctrl-W _IS_ in IT, and hands don't leave home row :) */
		if (!no_dialog) return 0;
		if (ctrl) {
			mp_finish();
			if (k.state === KEY_RELEASE) set_page(PAGE.SAVE_MODULE);
		} else {
			break;
		}
		return 1;
	case KEYSYM.F10:
		if (!no_dialog) return 0;
		if (alt) break;
		if (ctrl) break;
		mp_finish();
		if (pressed) set_page(shift ? PAGE.EXPORT_MODULE : PAGE.SAVE_MODULE);
		return 1;
	case KEYSYM.F11:
		if (!no_dialog) return 0;
		if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed)
				set_page(status.current_page === PAGE.ORDERLIST_PANNING ? PAGE.ORDERLIST_VOLUMES : PAGE.ORDERLIST_PANNING);
		} else if (ctrl) {
			if (pressed) {
				mp_finish();
				if (status.current_page === PAGE.LOG) app.show_about();
				else set_page(PAGE.LOG);
			}
		} else if (pressed && alt) {
			mp_finish();
			app.status_text_flash(app.song_toggle_orderlist_locked() ? "Order list locked" : "Order list unlocked");
		} else {
			break;
		}
		return 1;
	case KEYSYM.F12:
		if (!no_dialog) return 0;
		if (alt && status.current_page === PAGE.INFO) {
			mp_finish();
			if (pressed) set_page(PAGE.WATERFALL);
		} else if (ctrl) {
			mp_finish();
			if (pressed) set_page(PAGE.PALETTE_EDITOR);
		} else if (shift) {
			mp_finish();
			if (pressed) {
				fontedit_return_page = status.current_page;
				set_page(PAGE.FONT_EDIT);
			}
		} else if (NO_MODIFIER(k.mod)) {
			mp_finish();
			if (pressed) set_page(PAGE.SONG_VARIABLES);
		} else {
			break;
		}
		return 1;
	/* hack alert */
	case KEYSYM.f:
		if (!ctrl) return 0;
		/* fall through */
	case KEYSYM.SCROLLLOCK:
		if (!no_dialog) return 0;
		mp_finish();
		if (alt) {
			if (pressed) app.midi_toggle_record(); // flashes "MIDI Input Disabled/Enabled"
		} else if (pressed) {
			tracker.playback_tracing = tracker.playback_tracing ? 0 : 1;
			status_text_flash("Playback tracing " + (tracker.playback_tracing ? "enabled" : "disabled"));
		}
		return 1;
	case KEYSYM.PAUSE:
		if ((k.mod & KEYMOD.LSHIFT) && (k.mod & KEYMOD.LALT) && (k.mod & KEYMOD.RALT) && (k.mod & KEYMOD.RCTRL)) {
			mp_finish();
			if (pressed) set_page(PAGE.TIME_INFORMATION);
			return 1;
		}
		return 0;
	case KEYSYM.t:
		if (ctrl && alt) {
			mp_finish();
			if (pressed) set_page(PAGE.TIME_INFORMATION);
			return 1;
		}
		return 0;
	default:
		if (!no_dialog) return 0;
		break;
	}

	/* got a bit ugly here, sorry */
	if (alt) {
		const i = [KEYSYM.F1, KEYSYM.F2, KEYSYM.F3, KEYSYM.F4, KEYSYM.F5, KEYSYM.F6, KEYSYM.F7, KEYSYM.F8].indexOf(k.sym);
		if (i < 0) return 0;
		if (k.state === KEY_RELEASE) return 1;

		app.song_toggle_channel_mute(i);
		status.flags |= NEED_UPDATE;
		return 1;
	}

	/* oh well */
	return 0;
}

export function handle_key(k) {
	const page = active_page();
	const disko = status.flags & DISKWRITER_ACTIVE;

	// TODO(port): _handle_ime(k)

	if (!disko && page.pre_handle_key && page.pre_handle_key(k)) return;

	if (handle_key_global(k)) return;
	if (!disko && menu_handle_key(k)) return;
	if (ui.holder.total_widgets > 0 && widget_handle_key(k)) return;

	/* now check a couple other keys. */
	switch (k.sym) {
	case KEYSYM.LEFT:
	case KEYSYM.RIGHT:
		if (k.state === KEY_RELEASE) return;
		if (disko) return;
		if ((k.mod & KEYMOD.CTRL) && status.current_page !== PAGE.PATTERN_EDITOR) {
			mp_finish();
			if (app.song_get_mode() === MODE_PLAYING)
				app.song_set_current_order(app.song_get_current_order() + (k.sym === KEYSYM.LEFT ? -1 : 1));
			return;
		}
		break;
	case KEYSYM.ESCAPE:
		if (NO_MODIFIER(k.mod) && status.dialog_type === DIALOG_NONE
		    && status.current_page !== PAGE.LOAD_SAMPLE
		    && status.current_page !== PAGE.LOAD_INSTRUMENT) {
			if (k.state === KEY_RELEASE) return;
			if (mp_active) { mp_finish(); return; }
			menu_show();
			return;
		}
		break;
	case KEYSYM.SLASH:
		if (k.state === KEY_RELEASE) return;
		if (disko) return;
		kbd_set_current_octave(kbd_get_current_octave() - 1);
		break;
	case KEYSYM.ASTERISK:
		if (k.state === KEY_RELEASE) return;
		if (disko) return;
		kbd_set_current_octave(kbd_get_current_octave() + 1);
		break;
	case KEYSYM.LEFTBRACKET:
	case KEYSYM.RIGHTBRACKET: {
		/* FIXME (upstream): this assumes a US keyboard layout */
		const add = k.sym === KEYSYM.LEFTBRACKET ? -1 : 1;
		if (k.state === KEY_RELEASE) break;
		if (disko) return;
		const stopped = !(app.song_get_mode() & (MODE_PLAYING | MODE_PATTERN_LOOP));
		if (k.mod & KEYMOD.SHIFT) {
			app.song_set_current_speed(app.song_get_current_speed() + add);
			status_text_flash(`Speed set to ${app.song_get_current_speed()} frames per row`);
			if (stopped) app.song_set_initial_speed(app.song_get_current_speed());
		} else if ((k.mod & KEYMOD.CTRL) && !(status.flags & CLASSIC_MODE)) {
			app.song_set_current_tempo(app.song_get_current_tempo() + add);
			status_text_flash(`Tempo set to ${app.song_get_current_tempo()} beats per minute`);
			if (stopped) app.song_set_initial_tempo(app.song_get_current_tempo());
		} else if (NO_MODIFIER(k.mod)) {
			app.song_set_current_global_volume(app.song_get_current_global_volume() + add);
			status_text_flash(`Global volume set to ${app.song_get_current_global_volume()}`);
			if (stopped) app.song_set_initial_global_volume(app.song_get_current_global_volume());
		}
		return;
	}
	}

	/* and if we STILL didn't handle the key, pass it to the page.
	 * (or dialog, if one's active) */
	if (status.dialog_type & DIALOG_BOX) {
		dialog_handle_key(k);
	} else {
		if (disko) return;
		if (active_page().handle_key) active_page().handle_key(k);
	}
}

// ---------------------------------------------------------------------------

export function page_is_instrument_list(page) {
	return page === PAGE.INSTRUMENT_LIST_GENERAL || page === PAGE.INSTRUMENT_LIST_VOLUME
		|| page === PAGE.INSTRUMENT_LIST_PANNING || page === PAGE.INSTRUMENT_LIST_PITCH;
}

/* HACK (upstream): ignore F5/F6 while the prompt is up, they made it unusable */
function savecheck_handle_key(k) {
	return (k.sym === KEYSYM.F5 || k.sym === KEYSYM.F6) ? 1 : 0;
}

export function savecheck(ok, cancel, data) {
	if (status.flags & SONG_NEEDS_SAVE) {
		const d = dialog_create(DIALOG_OK_CANCEL, "Current module not saved. Proceed?", ok, cancel, 1, data);
		d.handle_key = savecheck_handle_key;
	} else {
		ok(data);
	}
}

function exit_ok_confirm() { app.schism_exit(0); }
function exit_ok() { savecheck(exit_ok_confirm, null, null); }

export function show_exit_prompt() {
	if (status.current_page === PAGE.ABOUT) {
		/* haven't even started up yet; don't bother confirming */
		app.schism_exit(0);
	} else if (status.current_page === PAGE.FONT_EDIT) {
		if (status.flags & STARTUP_FONTEDIT) {
			dialog_create(DIALOG_OK_CANCEL, "Exit Font Editor?", exit_ok_confirm, null, 0, null);
		} else {
			/* don't ask, just go away */
			dialog_destroy_all();
			set_page(fontedit_return_page);
		}
	} else if (status.dialog_type !== DIALOG_OK_CANCEL) {
		/* don't draw an exit prompt on top of an existing one */
		dialog_create(DIALOG_OK_CANCEL,
			(status.flags & CLASSIC_MODE) ? "Exit Impulse Tracker?" : "Exit Schism Tracker?",
			exit_ok, null, 0, null);
	}
}

let timejump_widgets = [];
const tj_num1 = { value: 0 }, tj_num2 = { value: 0 };

function timejump_keyh(k) {
	if (k.sym === KEYSYM.BACKSPACE) {
		if (ui.holder.selected_widget === 1 && timejump_widgets[1].d.value === 0) {
			if (k.state === KEY_RELEASE) widget_change_focus_to(0);
			return 1;
		}
	}
	if (k.sym === KEYSYM.COLON || k.sym === KEYSYM.SEMICOLON) {
		if (k.state === KEY_RELEASE && ui.holder.selected_widget === 0) widget_change_focus_to(1);
		return 1;
	}
	return 0;
}

function timejump_draw() {
	draw_text("Jump to time:", 30, 26, 0, 2);
	draw_char(58, 46, 26, 3, 0);
	draw_box(43, 25, 49, 27, BOX_THIN | BOX_INNER | BOX_INSET);
}

function timejump_ok() {
	const sec = timejump_widgets[0].d.value * 60 + timejump_widgets[1].d.value;
	const [order, row] = app.song_get_at_time(sec);
	app.set_current_order(order);
	const pat = app.current_song().orderlist[order];
	if (pat < 200) app.set_current_pattern(pat);
	app.set_current_row(row);
	if (app.song_get_mode() & 1) app.song_start_at_order(order, row);
	set_page(PAGE.PATTERN_EDITOR);
}

export function show_song_timejump() {
	tj_num1.value = tj_num2.value = 0;
	timejump_widgets = [
		widget_create_numentry(44, 26, 2, 0, 2, 1, null, 0, 21, tj_num1),
		widget_create_numentry(47, 26, 2, 1, 2, 2, null, 0, 59, tj_num2),
		widget_create_button(30, 29, 8, 0, 2, 2, 3, 3, timejump_ok, "OK", 4),
		widget_create_button(42, 29, 8, 1, 3, 3, 3, 0, dialog_cancel_NULL, "Cancel", 2),
	];
	timejump_widgets[0].d.handle_unknown_key = timejump_keyh;
	timejump_widgets[0].d.reverse = 1;
	timejump_widgets[1].d.reverse = 1;
	const d = dialog_create_custom(26, 24, 30, 8, timejump_widgets, 4, 0, timejump_draw, null);
	d.handle_key = timejump_keyh;
	d.action_yes = timejump_ok;
}

export function show_length_dialog(label, length) {
	const pad = (n, w, c) => String(n).padStart(w, c);
	const text = `${label}: ${pad(Math.trunc(length / 3600), 3, " ")}:${pad(Math.trunc(length / 60) % 60, 2, "0")}:${pad(length % 60, 2, "0")}`;
	dialog_create(DIALOG_OK, text, null, null, 0, null);
}

export function show_song_length() {
	show_length_dialog("Total song time", app.song_get_length());
}

export function set_previous_instrument() {
	if (app.song_is_instrument_mode()) app.instrument_set(app.instrument_get_current() - 1);
	else app.sample_set(app.sample_get_current() - 1);
}
export function set_next_instrument() {
	if (app.song_is_instrument_mode()) app.instrument_set(app.instrument_get_current() + 1);
	else app.sample_set(app.sample_get_current() + 1);
}
export function playback_update() {
	if (check_time() || app.song_get_mode()) status.flags |= NEED_UPDATE;
	if (active_page().playback_update) active_page().playback_update();
}
export function main_song_changed_cb() {
	app.set_current_order(0);
	let n = app.current_song().orderlist[0];
	if (n > 199) n = 0;
	app.set_current_pattern(n);
	app.set_current_row(0);
	app.song_save_channel_states();
	for (let i = pages.length - 1; i >= 0; i--) if (pages[i].song_changed_cb) pages[i].song_changed_cb();
	status.flags |= NEED_UPDATE;
}
export function main_song_mode_changed_cb() {
	for (const p of pages) if (p.song_mode_changed_cb) p.song_mode_changed_cb();
}

provide({
	set_previous_instrument, set_next_instrument, playback_update, main_song_changed_cb,
	main_song_mode_changed_cb, update_current_instrument, check_time,
	set_page, redraw_screen, status_text_flash, status_text_flash_bios, handle_key, handle_text_input,
	new_song_dialog, show_exit_prompt, show_song_timejump, show_song_length, show_length_dialog, savecheck,
	page_is_instrument_list,
	active_page: () => pages[status.current_page],
	instrument_list_page: () => ilist.subpage,
	toggle_display_fullscreen: () => {
		if (document.fullscreenElement) document.exitFullscreen();
		else document.documentElement.requestFullscreen().catch(() => {});
	},
	// A web page cannot quit the browser; closing the tab is the user's call.
	schism_exit: () => status_text_flash("Close the browser tab to exit"),
});
