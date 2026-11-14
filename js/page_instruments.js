// Port of schism/page_instruments.c (Schism Tracker, GPL-2.0-or-later).
// Instrument saving goes through app.song_save_instrument (a download).
import { app, provide, optional } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE, DIALOG_NONE, DIALOG_OK_CANCEL } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, draw_fill_chars, vgamem_ovl_alloc, vgamem_ovl_clear,
	vgamem_ovl_apply, vgamem_ovl_drawpixel, vgamem_ovl_drawline, DEFAULT_FG, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK,
	MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, MOUSE_BUTTON_MIDDLE, kbd_get_note, kbd_char_to_hex, kbd_char_to_99,
	numeric_key_event, get_note_string } from './keyboard.js';
import { widget_create_other, widget_create_thumbbar, widget_create_toggle, widget_create_textentry,
	widget_create_numentry, widget_create_menutoggle, widget_create_togglebutton, widget_create_button,
	widget_create_bitset, widget_togglebutton_set, widget_change_focus_to, text_add_char, text_delete_char,
	text_delete_next_char, MOUSE_SCROLL_LINES, str_from_num99 } from './widget.js';
import { dialog_create, dialog_create_custom, dialog_cancel_NULL, smpprompt_create } from './dialog.js';
import { pages, set_page, ilist } from './page.js';
import { current_song, song_get_instrument, song_get_playing_instruments, song_swap_instruments,
	song_exchange_instruments, song_copy_instrument, song_replace_instrument, song_keydown, song_keyup,
	song_change_current_play_channel, song_toggle_multichannel_mode, song_insert_instrument_slot,
	song_remove_instrument_slot, song_wipe_instrument, song_delete_instrument, song_is_instrument_mode,
	song_update_playing_instrument, KEYJAZZ_NOINST, KEYJAZZ_CHAN_CURRENT, KEYJAZZ_CHAN_AUTO } from './song.js';
import { csf_instrument_is_empty } from './csndfile.js';

const MAX_INSTRUMENTS = 236, MAX_SAMPLES = 236;
const env_overlay = vgamem_ovl_alloc({ x1: 32, y1: 18, x2: 65, y2: 25 });
let note_sample_mask = 1;
const widgets_general = [], widgets_volume = [], widgets_panning = [], widgets_pitch = [];
function get_page_widgets() {
	switch (ilist.subpage) {
	case PAGE.INSTRUMENT_LIST_VOLUME: return widgets_volume;
	case PAGE.INSTRUMENT_LIST_PANNING: return widgets_panning;
	case PAGE.INSTRUMENT_LIST_PITCH: return widgets_pitch;
	default: return widgets_general;
	}
}
const subpage_switches_group = [1, 2, 3, 4, -1], nna_group = [6, 7, 8, 9, -1], dct_group = [10, 11, 12, 13, -1], dca_group = [14, 15, 16, -1];
const pitch_envelope_states = ['Off', 'On Pitch', 'On Filter'];
let top_instrument = 1, current_instrument = 1, _altswap_lastvis = 99;
const icursor = { cursor_pos: 25 };
let note_trans_top_line = 0, note_trans_sel_line = 0, note_trans_cursor_pos = 0;
const numentry_cursor_pos = [{ value: 0 }, { value: 0 }, { value: 0 }];
const node = { vol: 0, pan: 0, pitch: 0 };
let envelope_edit_mode = 0, envelope_mouse_edit = 0, envelope_tick_limit = 0;
let last_note = 61;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const flash = t => app.status_text_flash(t);
const LAST_KEY_IS = (sym, mod) => ((mod === 0) ? !status.last_keymod : (status.last_keymod & mod)) && status.last_keysym === sym;
const cur = () => song_get_instrument(current_instrument);
const blank_env = () => ({ ticks: new Int32Array(32), values: new Uint8Array(32), nodes: 2, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0 });
const copy_env = (d, s) => { d.ticks.set(s.ticks); d.values.set(s.values); for (const k of ['nodes', 'loop_start', 'loop_end', 'sustain_start', 'sustain_end']) d[k] = s[k]; };

const saved_env = Array.from({ length: 10 }, () => { const e = blank_env(); e.ticks[1] = 100; e.values[0] = e.values[1] = 32; return e; });
const saved_flags = new Uint32Array(10);
function save_envelope(slot, e, sec) {
	slot = (slot >>> 0) % 10;
	const f = cur().flags;
	copy_env(saved_env[slot], e);
	switch (sec) {
	case C.ENV_VOLUME: saved_flags[slot] = f & (C.ENV_VOLUME | C.ENV_VOLSUSTAIN | C.ENV_VOLLOOP | C.ENV_VOLCARRY); break;
	case C.ENV_PANNING: saved_flags[slot] = (f & C.ENV_PANNING ? C.ENV_VOLUME : 0) | (f & C.ENV_PANSUSTAIN ? C.ENV_VOLSUSTAIN : 0)
		| (f & C.ENV_PANLOOP ? C.ENV_VOLLOOP : 0) | (f & C.ENV_PANCARRY ? C.ENV_VOLCARRY : 0) | (f & C.ENV_SETPANNING); break;
	case C.ENV_PITCH: saved_flags[slot] = (f & C.ENV_PITCH ? C.ENV_VOLUME : 0) | (f & C.ENV_PITCHSUSTAIN ? C.ENV_VOLSUSTAIN : 0)
		| (f & C.ENV_PITCHLOOP ? C.ENV_VOLLOOP : 0) | (f & C.ENV_PITCHCARRY ? C.ENV_VOLCARRY : 0) | (f & C.ENV_FILTER); break;
	}
}
function restore_envelope(slot, e, sec) {
	slot = (slot >>> 0) % 10;
	const ins = cur(), fl = saved_flags[slot];
	copy_env(e, saved_env[slot]);
	const map = (on, s, l, c, extra) => {
		ins.flags &= ~(on | s | l | c | extra);
		if (fl & C.ENV_VOLUME) ins.flags |= on;
		if (fl & C.ENV_VOLSUSTAIN) ins.flags |= s;
		if (fl & C.ENV_VOLLOOP) ins.flags |= l;
		if (fl & C.ENV_VOLCARRY) ins.flags |= c;
		ins.flags |= fl & extra;
	};
	if (sec === C.ENV_VOLUME) map(C.ENV_VOLUME, C.ENV_VOLSUSTAIN, C.ENV_VOLLOOP, C.ENV_VOLCARRY, 0);
	else if (sec === C.ENV_PANNING) map(C.ENV_PANNING, C.ENV_PANSUSTAIN, C.ENV_PANLOOP, C.ENV_PANCARRY, C.ENV_SETPANNING);
	else map(C.ENV_PITCH, C.ENV_PITCHSUSTAIN, C.ENV_PITCHLOOP, C.ENV_PITCHCARRY, C.ENV_FILTER);
	status.flags |= SONG_NEEDS_SAVE;
}

function _last_vis_inst() {
	let n = 99, j = 0;
	for (let i = 65; i < MAX_INSTRUMENTS; i++) if (!csf_instrument_is_empty(current_song.instruments[i])) j = i;
	while (j + 34 > n) n += 34;
	return Math.min(n, MAX_INSTRUMENTS - 1);
}
function instrument_list_reposition() {
	if (current_instrument < top_instrument) top_instrument = Math.max(1, current_instrument);
	else if (current_instrument > top_instrument + 34) top_instrument = current_instrument - 34;
}
export const instrument_get_current = () => current_instrument;
export function instrument_set(n) {
	const new_ins = app.page_is_instrument_list(status.current_page) ? clamp(n, 1, _last_vis_inst()) : clamp(n, 0, _last_vis_inst());
	if (current_instrument === new_ins) return;
	envelope_edit_mode = 0;
	current_instrument = new_ins;
	instrument_list_reposition();
	const ins = cur();
	node.vol = ins.vol_env.nodes ? clamp(node.vol, 0, ins.vol_env.nodes - 1) : 0;
	node.pan = ins.pan_env.nodes ? clamp(node.vol, 0, ins.pan_env.nodes - 1) : 0;
	node.pitch = ins.pitch_env.nodes ? clamp(node.vol, 0, ins.pan_env.nodes - 1) : 0;
	status.flags |= NEED_UPDATE;
}
export function instrument_synchronize_to_sample() {
	const sample = app.sample_get_current();
	let ins = song_get_instrument(sample);
	for (let pos = 0; pos < 120; pos++) if (ins.sample_map[pos] === sample) { instrument_set(sample); return; }
	for (let n = 1; n < MAX_INSTRUMENTS; n++) {
		if (n === sample) continue;
		ins = current_song.instruments[n];
		if (!ins) continue;
		for (let pos = 0; pos < 120; pos++) if (ins.sample_map[pos] === sample) { instrument_set(n); return; }
	}
	instrument_set(sample);
}

const name_ref = { get value() { return cur().name; }, set value(v) { cur().name = v; } };
const filename_ref = { get value() { return cur().filename; }, set value(v) { cur().filename = v; } };
const set_accept = () => { get_page_widgets()[0].accept_text = icursor.cursor_pos === 25 ? 0 : 1; };
function instrument_list_add_char(c) {
	if (c < 32) return 0;
	text_add_char(name_ref, c, icursor, 25);
	if (icursor.cursor_pos === 25) icursor.cursor_pos--;
	set_accept();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
	return 1;
}
function instrument_list_delete_char() { text_delete_char(name_ref, icursor); set_accept(); status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE; }
function instrument_list_delete_next_char() { text_delete_next_char(name_ref, icursor); set_accept(); status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE; }
function clear_instrument_text() {
	const ins = cur();
	ins.filename = ''; ins.name = '';
	if (icursor.cursor_pos !== 25) icursor.cursor_pos = 0;
	set_accept();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
const valid = n => n >= 1 && n <= _last_vis_inst();

function instrument_list_draw_list() {
	const selected = app.active_page().selected_widget === 0;
	const is_playing = song_get_playing_instruments();
	for (let pos = 0, n = top_instrument; pos < 35; pos++, n++) {
		const ins = current_song.instruments[n] || song_get_instrument(n);
		const is_current = n === current_instrument;
		if (ins.played) draw_char(is_playing[n] > 1 ? 183 : 173, 1, 13 + pos, is_playing[n] ? 3 : 1, 2);
		draw_text(str_from_num99(n), 2, 13 + pos, 0, 2);
		if (icursor.cursor_pos < 25) {
			if (is_current) {
				draw_text_len(ins.name, 25, 5, 13 + pos, 6, 14);
				if (selected) draw_char(ins.name.charCodeAt(icursor.cursor_pos) || 0, 5 + icursor.cursor_pos, 13 + pos, 0, 3);
			} else draw_text_len(ins.name, 25, 5, 13 + pos, 6, 0);
		} else {
			draw_text_len(ins.name, 25, 5, 13 + pos, is_current && selected ? 0 : 6, is_current ? (selected ? 3 : 14) : 0);
		}
	}
}
function instrument_list_handle_text_input_on_list(text) {
	if (icursor.cursor_pos >= 25) return 0;
	let success = 0;
	for (const ch of text) { const c = ch.charCodeAt(0); if (c < 256 && icursor.cursor_pos < 25 && instrument_list_add_char(c)) success = 1; }
	return success;
}
function instrument_list_handle_key_on_list(k) {
	let new_ins = current_instrument;
	if (k.state === KEY_PRESS && k.mouse !== MOUSE_NONE && k.y >= 13 && k.y <= 47 && k.x >= 5 && k.x <= 30) {
		if (k.mouse === MOUSE_CLICK) {
			new_ins = k.y - 13 + top_instrument;
			if (icursor.cursor_pos < 25) icursor.cursor_pos = Math.min(k.x - 5, 24);
			status.flags |= NEED_UPDATE;
		} else if (k.mouse === MOUSE_DBLCLICK) {
			if (icursor.cursor_pos < 25) { icursor.cursor_pos = 25; get_page_widgets()[0].accept_text = 0; }
			else set_page(PAGE.LOAD_INSTRUMENT);
			status.flags |= NEED_UPDATE;
			return 1;
		} else if (k.mouse === MOUSE_SCROLL_UP) { top_instrument = Math.max(1, top_instrument - MOUSE_SCROLL_LINES); status.flags |= NEED_UPDATE; return 1; }
		else if (k.mouse === MOUSE_SCROLL_DOWN) { top_instrument = Math.min(top_instrument + MOUSE_SCROLL_LINES, _last_vis_inst() - 34); status.flags |= NEED_UPDATE; return 1; }
	} else {
		const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
		switch (k.sym) {
		case KEYSYM.UP:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) { if (current_instrument > 1) { new_ins = current_instrument - 1; song_swap_instruments(current_instrument, new_ins); } }
			else if (!nm) return 0; else new_ins--;
			break;
		case KEYSYM.DOWN:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) {
				if (!LAST_KEY_IS(KEYSYM.DOWN, KEYMOD.ALT) && !k.is_repeat) _altswap_lastvis = _last_vis_inst();
				if (current_instrument < _altswap_lastvis) { new_ins = current_instrument + 1; song_swap_instruments(current_instrument, new_ins); }
			} else if (!nm) return 0; else new_ins++;
			break;
		case KEYSYM.PAGEUP: if (rel) return 0; new_ins = k.mod & KEYMOD.CTRL ? 1 : new_ins - 16; break;
		case KEYSYM.PAGEDOWN: if (rel) return 0; new_ins = k.mod & KEYMOD.CTRL ? _last_vis_inst() : new_ins + 16; break;
		case KEYSYM.HOME:
			if (rel || !nm) return 0;
			if (icursor.cursor_pos < 25) { icursor.cursor_pos = 0; get_page_widgets()[0].accept_text = 1; status.flags |= NEED_UPDATE; }
			return 1;
		case KEYSYM.END:
			if (rel || !nm) return 0;
			if (icursor.cursor_pos < 24) { icursor.cursor_pos = 24; get_page_widgets()[0].accept_text = 1; status.flags |= NEED_UPDATE; }
			return 1;
		case KEYSYM.LEFT:
			if (rel || !nm) return 0;
			if (icursor.cursor_pos < 25 && icursor.cursor_pos > 0) { icursor.cursor_pos--; get_page_widgets()[0].accept_text = 1; status.flags |= NEED_UPDATE; }
			return 1;
		case KEYSYM.RIGHT:
			if (rel || !nm) return 0;
			if (icursor.cursor_pos === 25) { get_page_widgets()[0].accept_text = 0; widget_change_focus_to(1); }
			else if (icursor.cursor_pos < 24) { get_page_widgets()[0].accept_text = 1; icursor.cursor_pos++; status.flags |= NEED_UPDATE; }
			return 1;
		case KEYSYM.RETURN:
			if (k.state === KEY_PRESS) return 0;
			if (icursor.cursor_pos < 25) { icursor.cursor_pos = 25; get_page_widgets()[0].accept_text = 0; status.flags |= NEED_UPDATE; }
			else { get_page_widgets()[0].accept_text = 1; set_page(PAGE.LOAD_INSTRUMENT); }
			return 1;
		case KEYSYM.ESCAPE:
			if ((k.mod & KEYMOD.SHIFT) || icursor.cursor_pos < 25) {
				if (rel) return 1;
				icursor.cursor_pos = 25; get_page_widgets()[0].accept_text = 0; status.flags |= NEED_UPDATE;
				return 1;
			}
			return 0;
		case KEYSYM.BACKSPACE:
			if (rel) return 0;
			if (icursor.cursor_pos === 25) return 0;
			if (!(k.mod & (KEYMOD.CTRL | KEYMOD.ALT))) instrument_list_delete_char();
			else if (k.mod & KEYMOD.CTRL) instrument_list_add_char(127);
			return 1;
		case KEYSYM.INSERT:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) { song_insert_instrument_slot(current_instrument); status.flags |= NEED_UPDATE; return 1; }
			return 0;
		case KEYSYM.DELETE:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) { song_remove_instrument_slot(current_instrument); status.flags |= NEED_UPDATE; return 1; }
			if (!(k.mod & KEYMOD.CTRL)) { if (icursor.cursor_pos === 25) return 0; instrument_list_delete_next_char(); return 1; }
			return 0;
		default:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) { if (k.sym === KEYSYM.c) { clear_instrument_text(); return 1; } }
			else if (!(k.mod & KEYMOD.CTRL)) {
				if (icursor.cursor_pos < 25) { if (k.text) return instrument_list_handle_text_input_on_list(k.text); }
				else if (k.sym === KEYSYM.SPACE) { icursor.cursor_pos = 0; get_page_widgets()[0].accept_text = 0; status.flags |= NEED_UPDATE; return 1; }
			}
			return 0;
		}
	}
	new_ins = clamp(new_ins, 1, _last_vis_inst());
	if (new_ins !== current_instrument) { instrument_set(new_ins); status.flags |= NEED_UPDATE; }
	return 1;
}

// note translation table
function note_trans_reposition() {
	if (note_trans_sel_line < note_trans_top_line) note_trans_top_line = note_trans_sel_line;
	else if (note_trans_sel_line > note_trans_top_line + 31) note_trans_top_line = note_trans_sel_line - 31;
}
function note_trans_draw() {
	const is_selected = app.active_page().selected_widget === 5, sel_bg = is_selected ? 14 : 0, ins = cur();
	for (let pos = 0, n = note_trans_top_line; pos < 32; pos++, n++) {
		const bg = n === note_trans_sel_line ? sel_bg : 0;
		if (ins.note_map[n] < 1 || ins.note_map[n] > 120) ins.note_map[n] = n + 1;
		draw_text(get_note_string(n + 1), 32, 16 + pos, 2, bg);
		draw_char(168, 35, 16 + pos, 2, bg);
		let buf = get_note_string(ins.note_map[n]);
		draw_text(buf, 36, 16 + pos, 2, bg);
		if (is_selected && n === note_trans_sel_line) {
			if (note_trans_cursor_pos === 0) draw_char(buf.charCodeAt(0), 36, 16 + pos, 0, 3);
			else if (note_trans_cursor_pos === 1) draw_char(buf.charCodeAt(2), 38, 16 + pos, 0, 3);
		}
		draw_char(0, 39, 16 + pos, 2, bg);
		buf = ins.sample_map[n] ? str_from_num99(ins.sample_map[n]) : '\xAD\xAD';
		draw_text(buf, 40, 16 + pos, 2, bg);
		if (is_selected && n === note_trans_sel_line) {
			if (note_trans_cursor_pos === 2) draw_char(buf.charCodeAt(0), 40, 16 + pos, 0, 3);
			else if (note_trans_cursor_pos === 3) draw_char(buf.charCodeAt(1), 41, 16 + pos, 0, 3);
		}
	}
	if (is_selected && !(status.flags & CLASSIC_MODE)) {
		switch (note_trans_cursor_pos) {
		case 0:
			draw_char(171, 36, 48, 3, 2); draw_char(171, 37, 48, 3, 2); draw_char(169, 38, 48, 3, 2);
			if (note_sample_mask) { draw_char(169, 40, 48, 3, 2); draw_char(169, 41, 48, 3, 2); }
			break;
		case 1:
			draw_char(169, 38, 48, 3, 2);
			if (note_sample_mask) { draw_char(170, 40, 48, 3, 2); draw_char(170, 41, 48, 3, 2); }
			break;
		case 2: case 3:
			draw_char(note_sample_mask ? 171 : 169, 40, 48, 3, 2);
			draw_char(note_sample_mask ? 171 : 169, 41, 48, 3, 2);
			break;
		}
	}
}
function note_trans_handle_key(k) {
	const prev_line = note_trans_sel_line;
	let new_line = prev_line, new_pos = note_trans_cursor_pos, c, n;
	const ins = cur();
	if (k.mouse === MOUSE_CLICK && k.mouse_button === MOUSE_BUTTON_MIDDLE) return 1;
	if (k.mouse === MOUSE_SCROLL_UP || k.mouse === MOUSE_SCROLL_DOWN) {
		if (k.state === KEY_PRESS) {
			note_trans_top_line = clamp(note_trans_top_line + (k.mouse === MOUSE_SCROLL_UP ? -3 : 3), 0, 119 - 31);
			status.flags |= NEED_UPDATE;
		}
		return 1;
	} else if (k.mouse !== MOUSE_NONE) {
		if (k.x >= 32 && k.x <= 41 && k.y >= 16 && k.y <= 47) {
			new_line = note_trans_top_line + k.y - 16;
			if (new_line === prev_line) new_pos = { 2: 1, 4: 2, 5: 3 }[k.x - 36] ?? 0;
		}
	} else if (k.mod & KEYMOD.ALT) {
		if (k.state === KEY_RELEASE) return 0;
		switch (k.sym) {
		case KEYSYM.UP: for (let i = 0; i < 120; i++) ins.note_map[i] = clamp(ins.note_map[i] + 1, 1, 120); break;
		case KEYSYM.DOWN: for (let i = 0; i < 120; i++) ins.note_map[i] = clamp(ins.note_map[i] - 1, 1, 120); break;
		case KEYSYM.INSERT: {
			const pos = note_trans_sel_line;
			for (let i = 119; i > pos; i--) { ins.note_map[i] = ins.note_map[i - 1]; ins.sample_map[i] = ins.sample_map[i - 1]; }
			ins.note_map[pos] = pos ? ins.note_map[pos - 1] + 1 : 1;
			break;
		}
		case KEYSYM.DELETE: {
			for (let i = note_trans_sel_line; i < 119; i++) { ins.note_map[i] = ins.note_map[i + 1]; ins.sample_map[i] = ins.sample_map[i + 1]; }
			ins.note_map[119] = ins.note_map[118] + 1;
			break;
		}
		case KEYSYM.n:
			n = note_trans_sel_line - 1;
			if (n < 0 || ins.note_map[n] === C.NOTE_LAST) break;
			ins.note_map[note_trans_sel_line] = ins.note_map[n] + 1;
			ins.sample_map[note_trans_sel_line] = ins.sample_map[n];
			new_line++;
			break;
		case KEYSYM.p:
			n = note_trans_sel_line + 1;
			if (n > 119 || ins.note_map[n] === C.NOTE_FIRST) break;
			ins.note_map[note_trans_sel_line] = ins.note_map[n] - 1;
			ins.sample_map[note_trans_sel_line] = ins.sample_map[n];
			new_line--;
			break;
		case KEYSYM.a:
			c = app.sample_get_current();
			for (n = 0; n < 120; n++) ins.sample_map[n] = c;
			if (k.mod & KEYMOD.SHIFT) ins.name = current_song.samples[c].name;
			break;
		default: return 0;
		}
	} else {
		const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
		switch (k.sym) {
		case KEYSYM.UP:
			if (rel) return 0;
			if (k.mod & KEYMOD.CTRL) app.sample_set(app.sample_get_current() - 1);
			if (!nm) return 0;
			if (--new_line < 0) { widget_change_focus_to(1); return 1; }
			break;
		case KEYSYM.DOWN:
			if (rel) return 0;
			if (k.mod & KEYMOD.CTRL) app.sample_set(app.sample_get_current() + 1);
			if (!nm) return 0;
			new_line++;
			break;
		case KEYSYM.PAGEUP: if (rel) return 0; if (k.mod & KEYMOD.CTRL) { instrument_set(current_instrument - 1); return 1; } new_line -= 16; break;
		case KEYSYM.PAGEDOWN: if (rel) return 0; if (k.mod & KEYMOD.CTRL) { instrument_set(current_instrument + 1); return 1; } new_line += 16; break;
		case KEYSYM.HOME: if (rel || !nm) return 0; new_line = 0; break;
		case KEYSYM.END: if (rel || !nm) return 0; new_line = 119; break;
		case KEYSYM.LEFT: if (rel || !nm) return 0; new_pos--; break;
		case KEYSYM.RIGHT: if (rel || !nm) return 0; new_pos++; break;
		case KEYSYM.RETURN:
			if (k.state === KEY_PRESS || !nm) return 0;
			app.sample_set(ins.sample_map[note_trans_sel_line]);
			set_accept();
			status.flags |= NEED_UPDATE;
			return 1;
		case KEYSYM.LESS: case KEYSYM.SEMICOLON: case KEYSYM.COLON:
			if (rel) return 0; app.sample_set(app.sample_get_current() - 1); return 1;
		case KEYSYM.GREATER: case KEYSYM.QUOTE: case KEYSYM.QUOTEDBL:
			if (rel) return 0; app.sample_set(app.sample_get_current() + 1); return 1;
		default:
			if (rel) return 0;
			switch (note_trans_cursor_pos) {
			case 0:
				n = kbd_get_note(k);
				if (!(n > 0 && n <= 120)) return 0;
				ins.note_map[note_trans_sel_line] = n;
				if (note_sample_mask || (status.flags & CLASSIC_MODE)) ins.sample_map[note_trans_sel_line] = app.sample_get_current();
				new_line++;
				break;
			case 1:
				c = kbd_char_to_hex(k);
				if (c < 0 || c > 9) return 0;
				n = ins.note_map[note_trans_sel_line];
				ins.note_map[note_trans_sel_line] = ((n - 1) % 12) + 12 * c + 1;
				new_line++;
				break;
			case 2: case 3:
				if (k.sym === KEYSYM.SPACE) { ins.sample_map[note_trans_sel_line] = app.sample_get_current(); new_line++; break; }
				if ((k.sym === KEYSYM.PERIOD && nm) || k.sym === KEYSYM.DELETE) {
					ins.sample_map[note_trans_sel_line] = 0;
					new_line += k.sym === KEYSYM.PERIOD ? 1 : 0;
					break;
				}
				if (k.sym === KEYSYM.COMMA && nm) { note_sample_mask = note_sample_mask ? 0 : 1; break; }
				n = ins.sample_map[note_trans_sel_line];
				if (note_trans_cursor_pos === 2) {
					c = kbd_char_to_99(k);
					if (c < 0) return 0;
					n = c * 10 + n % 10;
					new_pos++;
				} else {
					c = kbd_char_to_hex(k);
					if (c < 0 || c > 9) return 0;
					n = Math.trunc(n / 10) * 10 + c;
					new_pos--;
					new_line++;
				}
				n = Math.min(n, MAX_SAMPLES - 1);
				ins.sample_map[note_trans_sel_line] = n;
				app.sample_set(n);
				break;
			}
		}
	}
	new_line = clamp(new_line, 0, 119);
	note_trans_cursor_pos = clamp(new_pos, 0, 3);
	if (new_line !== prev_line) { note_trans_sel_line = new_line; note_trans_reposition(); }
	status.flags |= NEED_UPDATE;
	return 1;
}

// envelopes
const R = env_overlay;
function _env_draw_axes(middle) {
	const y = middle ? 31 : 62;
	for (let n = 0; n < 64; n += 2) vgamem_ovl_drawpixel(R, 3, n, 12);
	for (let n = 0; n < 256; n += 2) vgamem_ovl_drawpixel(R, 1 + n, y, 12);
}
function _env_draw_node(x, y, on) {
	const c = (status.flags & CLASSIC_MODE) ? 12 : 5;
	for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) vgamem_ovl_drawpixel(R, x + dx, y + dy, c);
	if (on) for (let dy = -1; dy <= 1; dy++) { vgamem_ovl_drawpixel(R, x - 3, y + dy, c); vgamem_ovl_drawpixel(R, x + 3, y + dy, c); }
}
function _env_draw_loop(xs, xe, sustain) {
	const c = (status.flags & CLASSIC_MODE) ? 12 : 3;
	const [c1, c2] = sustain ? [c, 0] : [0, c];
	for (let y = 0; y < 62;) {
		for (const col of [c1, c2, c, 0]) { vgamem_ovl_drawpixel(R, xs, y, col); vgamem_ovl_drawpixel(R, xe, y, col); y++; }
	}
}
const muldiv = (a, b, c) => Math.trunc(a * b / c);
function _env_draw(env, middle, current_node, env_on, loop_on, sustain_on, env_num) {
	let max_ticks = 50, last_x = 0, last_y = 0;
	while (env.ticks[env.nodes - 1] >= max_ticks) max_ticks *= 2;
	vgamem_ovl_clear(R, 0);
	_env_draw_axes(middle);
	for (let n = 0; n < env.nodes; n++) {
		const x = 4 + muldiv(env.ticks[n], 256, max_ticks);
		let y = env.values[n];
		if (y > 63) y--;
		if (y > 42) y--;
		if (y > 21) y--;
		y = 62 - y;
		_env_draw_node(x, y, n === current_node);
		if (last_x) vgamem_ovl_drawline(R, last_x, last_y, x, y, 12);
		last_x = x; last_y = y;
	}
	if (sustain_on) _env_draw_loop(4 + muldiv(env.ticks[env.sustain_start], 256, max_ticks), 4 + muldiv(env.ticks[env.sustain_end], 256, max_ticks), 1);
	if (loop_on) _env_draw_loop(4 + muldiv(env.ticks[env.loop_start], 256, max_ticks), 4 + muldiv(env.ticks[env.loop_end], 256, max_ticks), 0);
	if (env_on) {
		max_ticks = env.ticks[env.nodes - 1];
		let m = max_ticks ? Math.min(current_song.num_voices, current_song.max_voices) : 0;
		while (m--) {
			const ch = current_song.voices[current_song.voice_mix[m]];
			if (ch.ptr_instrument !== cur()) continue;
			const envpos = [ch.vol_env_position, ch.pan_env_position, ch.pitch_env_position][env_num] | 0;
			let x = 4 + Math.trunc(envpos * (last_x - 4) / max_ticks);
			if (x > last_x) x = last_x;
			const c = (status.flags & CLASSIC_MODE) ? 12 : ((ch.flags & (C.CHN_KEYOFF | C.CHN_NOTEFADE)) ? 8 : 6);
			for (let y = 0; y < 62; y++) vgamem_ovl_drawpixel(R, x, y, c);
		}
	}
	draw_fill_chars(65, 18, 76, 25, DEFAULT_FG, 0);
	vgamem_ovl_apply(R);
	draw_text(`Node ${current_node}/${env.nodes}`, 66, 19, 2, 0);
	draw_text(`Tick ${env.ticks[current_node]}`, 66, 21, 2, 0);
	draw_text(`Value ${env.values[current_node] - (middle ? 32 : 0)}`, 66, 23, 2, 0);
}
function _env_node_add(env, current_node, override_tick, override_value) {
	status.flags |= SONG_NEEDS_SAVE;
	if (env.nodes > 24 || current_node === env.nodes - 1) return current_node;
	let newtick = (env.ticks[current_node] + env.ticks[current_node + 1]) >> 1;
	let newvalue = (env.values[current_node] + env.values[current_node + 1]) >> 1;
	if (override_tick > -1 && override_value > -1) { newtick = override_tick; newvalue = override_value; }
	else if (newtick === env.ticks[current_node] || newtick === env.ticks[current_node + 1]) return current_node;
	env.nodes++;
	env.ticks.copyWithin(current_node + 1, current_node, env.nodes - 1);
	env.values.copyWithin(current_node + 1, current_node, env.nodes - 1);
	env.ticks[current_node + 1] = newtick;
	env.values[current_node + 1] = newvalue;
	for (const k of ['loop_end', 'loop_start', 'sustain_end', 'sustain_start']) if (env[k] > current_node) env[k]++;
	return current_node;
}
function _env_node_remove(env, current_node) {
	status.flags |= SONG_NEEDS_SAVE;
	if (current_node === 0 || env.nodes < 3) return current_node;
	env.ticks.copyWithin(current_node, current_node + 1, env.nodes);
	env.values.copyWithin(current_node, current_node + 1, env.nodes);
	env.nodes--;
	for (const k of ['loop_start', 'loop_end', 'sustain_start', 'sustain_end']) {
		if (env[k] >= env.nodes) env[k] = env.nodes - 1;
		else if (env[k] > current_node) env[k]--;
	}
	if (current_node >= env.nodes) current_node = env.nodes - 1;
	return current_node;
}
function do_env_pre_loop_cut(env) {
	const bt = env.ticks[env.loop_start];
	for (let i = env.loop_start; i < 32; i++) {
		env.ticks[i - env.loop_start] = env.ticks[i] - bt;
		env.values[i - env.loop_start] = env.values[i];
	}
	env.nodes -= env.loop_start;
	for (const k of ['sustain_start', 'sustain_end', 'loop_end']) env[k] = env[k] > env.loop_start ? env[k] - env.loop_start : 0;
	env.loop_start = 0;
	if (env.loop_start > env.loop_end) env.loop_end = env.loop_start;
	if (env.sustain_start > env.sustain_end) env.sustain_end = env.sustain_start;
	status.flags |= NEED_UPDATE;
}
function env_resize(env, ticks) {
	const old = env.ticks[env.nodes - 1];
	if (ticks > 9999) ticks = 9999;
	for (let n = 1; n < env.nodes; n++) env.ticks[n] = Math.max(Math.trunc(env.ticks[n] * ticks / old), env.ticks[n - 1] + 1);
	status.flags |= NEED_UPDATE;
}
let dlg_widgets = null;
function env_resize_dialog(env) {
	dlg_widgets = [
		widget_create_numentry(42, 27, 7, 0, 1, 1, null, 0, 9999, { value: 0 }),
		widget_create_button(36, 30, 6, 0, 1, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
	dlg_widgets[0].d.value = env.ticks[env.nodes - 1];
	const d = dialog_create_custom(26, 22, 29, 11, dlg_widgets, 2, 0, () => {
		draw_text('Resize Envelope', 34, 24, 3, 2);
		draw_text('New Length', 31, 27, 0, 2);
		draw_box(41, 26, 49, 28, BOX_THICK | BOX_INNER | BOX_INSET);
	}, env);
	d.action_yes = () => env_resize(env, dlg_widgets[0].d.value);
}
function env_adsr_dialog() {
	const ins = cur();
	dlg_widgets = [
		widget_create_thumbbar(34, 24, 17, 4, 1, 4, null, 0, 128),
		widget_create_thumbbar(34, 25, 17, 0, 2, 4, null, 0, 128),
		widget_create_thumbbar(34, 26, 17, 1, 3, 4, null, 0, 128),
		widget_create_thumbbar(34, 27, 17, 2, 4, 4, null, 0, 128),
		widget_create_button(36, 30, 6, 3, 0, 4, 4, 0, dialog_cancel_NULL, 'Cancel', 1),
	];
	const d = dialog_create_custom(25, 21, 31, 12, dlg_widgets, 5, 0, () => {
		draw_text('Envelope Generator', 32, 22, 0, 2);
		draw_text('Attack', 27, 24, 0, 2);
		draw_text('Decay', 28, 25, 0, 2);
		draw_text('Sustain', 26, 26, 0, 2);
		draw_text('Release', 26, 27, 0, 2);
		draw_box(33, 23, 51, 28, BOX_THICK | BOX_INNER | BOX_INSET);
	}, ins);
	d.action_yes = () => {
		const env = ins.vol_env;
		const [a, dd, s, r] = dlg_widgets.slice(0, 4).map(w => w.d.value);
		const v1 = Math.max(a, Math.trunc(a * a / 16)), v2 = Math.max(v1 + Math.trunc(dd * dd / 16), v1 + dd), v3 = Math.max(v2 + Math.trunc(r * r / 4), v2 + r);
		let n = 0;
		if (a) { env.ticks[n] = 0; env.values[n++] = 0; }
		if (dd) { env.ticks[n] = v1; env.values[n++] = 64; }
		env.sustain_start = env.sustain_end = n;
		env.ticks[n] = v2; env.values[n++] = s >> 1;
		env.ticks[n] = v3; env.values[n++] = 0;
		env.nodes = n;
		for (n = 0; n < env.nodes - 1; n++) if (env.ticks[n] >= env.ticks[n + 1]) env.ticks[n + 1] = env.ticks[n] + 1;
		ins.flags |= C.ENV_VOLSUSTAIN | C.ENV_VOLUME;
	};
}

function _env_handle_key_viewmode(k, env, key, sec) {
	let new_node = node[key];
	const rel = k.state === KEY_RELEASE, press = k.state === KEY_PRESS, nm = NO_MODIFIER(k.mod), alt = k.mod & KEYMOD.ALT;
	switch (k.sym) {
	case KEYSYM.UP: if (rel) return 0; widget_change_focus_to(1); return 1;
	case KEYSYM.DOWN: if (rel) return 0; widget_change_focus_to(6); return 1;
	case KEYSYM.LEFT: if (rel || !nm) return 0; new_node--; break;
	case KEYSYM.RIGHT: if (rel || !nm) return 0; new_node++; break;
	case KEYSYM.INSERT: if (rel || !nm) return 0; node[key] = _env_node_add(env, node[key], -1, -1); status.flags |= NEED_UPDATE; return 3;
	case KEYSYM.DELETE: if (rel || !nm) return 0; node[key] = _env_node_remove(env, node[key]); status.flags |= NEED_UPDATE; return 3;
	case KEYSYM.SPACE:
		if (!nm) return 0;
		if (k.is_repeat) return 1;
		if (press) { song_keydown(KEYJAZZ_NOINST, current_instrument, last_note, 64, KEYJAZZ_CHAN_CURRENT); return 1; }
		if (rel) { song_keyup(KEYJAZZ_NOINST, current_instrument, last_note); return 1; }
		return 0;
	case KEYSYM.RETURN: if (press || !nm) return 0; envelope_edit_mode = 1; status.flags |= NEED_UPDATE; return 3;
	case KEYSYM.l:
		if (press || !alt) return 0;
		if (env.loop_end < env.nodes - 1) { dialog_create(DIALOG_OK_CANCEL, 'Cut envelope?', () => { env.nodes = env.loop_end + 1; }, null, 1, env); return 1; }
		return 0;
	case KEYSYM.b:
		if (press || !alt) return 0;
		if (env.loop_start > 0) { dialog_create(DIALOG_OK_CANCEL, 'Cut envelope?', () => do_env_pre_loop_cut(env), null, 1, env); return 1; }
		return 0;
	case KEYSYM.f: if (press || !alt) return 0; env_resize(env, env.ticks[env.nodes - 1] * 2); return 1;
	case KEYSYM.g: if (press || !alt) return 0; env_resize(env, env.ticks[env.nodes - 1] >> 1); return 1;
	case KEYSYM.e: if (press || !alt) return 0; env_resize_dialog(env); return 1;
	case KEYSYM.z: if (press || !alt) return 0; env_adsr_dialog(env); return 1;
	default: {
		if (press) return 0;
		const n = numeric_key_event(k, 0);
		if (n > -1) {
			if (k.mod & (KEYMOD.ALT | KEYMOD.CTRL)) { save_envelope(n, env, sec); flash(`Envelope copied into slot ${n}`); }
			else if (k.mod & KEYMOD.SHIFT) { restore_envelope(n, env, sec); if (!(status.flags & CLASSIC_MODE)) flash(`Pasted envelope from slot ${n}`); }
			return 1;
		}
		return 0;
	}
	}
	new_node = clamp(new_node, 0, env.nodes - 1);
	if (node[key] !== new_node) { node[key] = new_node; status.flags |= NEED_UPDATE; }
	return 1;
}
function _env_handle_mouse(k, env, key) {
	let max_ticks = 50, x, y;
	if (k.mouse !== MOUSE_CLICK) return 0;
	if (k.state === KEY_RELEASE) {
		if (envelope_mouse_edit) {
			if (node[key]) {
				for (let i = 0; i < env.nodes - 1; i++) {
					if (node[key] === i) continue;
					if (env.ticks[node[key]] === env.ticks[i] && env.values[node[key]] === env.values[i]) {
						flash(`Removed node ${node[key]}`);
						status.flags |= SONG_NEEDS_SAVE;
						node[key] = _env_node_remove(env, node[key]);
						break;
					}
				}
			}
			status.flags |= NEED_UPDATE;
		}
		envelope_mouse_edit = 0;
		return 1;
	}
	while (env.ticks[env.nodes - 1] >= max_ticks) max_ticks *= 2;
	const yconv = () => {
		y = 64 - (k.fy - 144);
		if (y > 63) y++;
		if (y > 42) y++;
		if (y > 21) y++;
		y = clamp(y, 0, 64);
	};
	if (envelope_mouse_edit) {
		x = k.fx < 259 ? 0 : Math.trunc((k.fx - 259) * max_ticks / 256);
		yconv();
		const cn = node[key];
		if (cn && env.ticks[cn - 1] >= x) x = env.ticks[cn - 1] + 1;
		if (cn < env.nodes - 1 && env.ticks[cn + 1] <= x) x = env.ticks[cn + 1] - 1;
		x = clamp(x, 0, Math.min(envelope_tick_limit, 9999));
		if (cn) env.ticks[cn] = x;
		env.values[cn] = y;
		status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE;
		return 1;
	}
	let best_dist = 0, best = -1;
	if (k.x < 32 || k.y < 18 || k.x > 32 + 45 || k.y > 18 + 8) return 0;
	for (let n = 0; n < env.nodes; n++) {
		x = 259 + Math.trunc(env.ticks[n] * 256 / max_ticks);
		y = env.values[n];
		if (y > 63) y--;
		if (y > 42) y--;
		if (y > 21) y--;
		y = 206 - y;
		const dist = Math.trunc(Math.hypot(x - k.fx, y - k.fy));
		if ((best === -1 || dist < best_dist) && dist <= 5) { best_dist = dist; best = n; }
	}
	if (best === -1) {
		x = Math.trunc((k.fx - 259) * max_ticks / 256);
		yconv();
		if (x > 0 && x < max_ticks) {
			node[key] = 0;
			for (let i = 1; i < env.nodes; i++) {
				if (env.ticks[i] <= x) node[key] = i;
				if (Math.abs(env.ticks[i] - x) < 2) return 0;
			}
			best = _env_node_add(env, node[key], x, y) + 1;
			flash(`Created node ${best}`);
		}
		if (best === -1) return 0;
	}
	envelope_tick_limit = env.ticks[env.nodes - 1] * 2;
	envelope_mouse_edit = 1;
	node[key] = best;
	status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE;
	return 1;
}
function _env_handle_key_editmode(k, env, key) {
	let new_node = node[key], new_tick = env.ticks[node[key]], new_value = env.values[node[key]];
	const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
	switch (k.sym) {
	case KEYSYM.UP: if (rel) return 0; new_value += k.mod & KEYMOD.ALT ? 16 : 1; break;
	case KEYSYM.DOWN: if (rel) return 0; new_value -= k.mod & KEYMOD.ALT ? 16 : 1; break;
	case KEYSYM.PAGEUP: if (rel || !nm) return 0; new_value += 16; break;
	case KEYSYM.PAGEDOWN: if (rel || !nm) return 0; new_value -= 16; break;
	case KEYSYM.LEFT:
		if (rel) return 1;
		if (k.mod & KEYMOD.CTRL) new_node--; else if (k.mod & KEYMOD.ALT) new_tick -= 16; else new_tick--;
		break;
	case KEYSYM.RIGHT:
		if (rel) return 1;
		if (k.mod & KEYMOD.CTRL) new_node++; else if (k.mod & KEYMOD.ALT) new_tick += 16; else new_tick++;
		break;
	case KEYSYM.TAB: if (rel) return 0; new_tick += k.mod & KEYMOD.SHIFT ? -16 : 16; break;
	case KEYSYM.HOME: if (rel || !nm) return 0; new_tick = 0; break;
	case KEYSYM.END: if (rel || !nm) return 0; new_tick = 10000; break;
	case KEYSYM.INSERT: if (rel || !nm) return 0; node[key] = _env_node_add(env, node[key], -1, -1); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.DELETE: if (rel || !nm) return 0; node[key] = _env_node_remove(env, node[key]); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.SPACE:
		if (rel || !nm) return 0;
		song_keyup(KEYJAZZ_NOINST, current_instrument, last_note);
		song_keydown(KEYJAZZ_NOINST, current_instrument, last_note, 64, KEYJAZZ_CHAN_CURRENT);
		return 1;
	case KEYSYM.RETURN: if (k.state === KEY_PRESS || !nm) return 0; envelope_edit_mode = 0; status.flags |= NEED_UPDATE; break;
	default: return 0;
	}
	new_node = clamp(new_node, 0, env.nodes - 1);
	if (new_node !== node[key]) { status.flags |= NEED_UPDATE; node[key] = new_node; return 1; }
	new_tick = new_node === 0 ? 0 : clamp(new_tick, env.ticks[new_node - 1] + 1, (new_node === env.nodes - 1 ? 10000 : env.ticks[new_node + 1]) - 1);
	if (new_tick !== env.ticks[new_node]) { env.ticks[node[key]] = new_tick; status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE; return 1; }
	new_value = clamp(new_value, 0, 64);
	if (new_value !== env.values[new_node]) { env.values[node[key]] = new_value; status.flags |= SONG_NEEDS_SAVE | NEED_UPDATE; return 1; }
	return 1;
}
function _draw_env_label(name, is_selected) {
	let pos = 33;
	pos += draw_text(name, pos, 16, is_selected ? 3 : 0, 2);
	pos += draw_text(' Envelope', pos, 16, is_selected ? 3 : 0, 2);
	if (envelope_edit_mode || envelope_mouse_edit) draw_text(' (Edit)', pos, 16, is_selected ? 3 : 0, 2);
}
function volume_envelope_draw() {
	const ins = cur();
	_draw_env_label('Volume', app.active_page().selected_widget === 5);
	_env_draw(ins.vol_env, 0, node.vol, ins.flags & C.ENV_VOLUME, ins.flags & C.ENV_VOLLOOP, ins.flags & C.ENV_VOLSUSTAIN, 0);
}
function panning_envelope_draw() {
	const ins = cur();
	_draw_env_label('Panning', app.active_page().selected_widget === 5);
	_env_draw(ins.pan_env, 1, node.pan, ins.flags & C.ENV_PANNING, ins.flags & C.ENV_PANLOOP, ins.flags & C.ENV_PANSUSTAIN, 1);
}
function pitch_envelope_draw() {
	const ins = cur();
	_draw_env_label('Frequency', app.active_page().selected_widget === 5);
	_env_draw(ins.pitch_env, ins.flags & C.ENV_FILTER ? 0 : 1, node.pitch, ins.flags & (C.ENV_PITCH | C.ENV_FILTER),
		ins.flags & C.ENV_PITCHLOOP, ins.flags & C.ENV_PITCHSUSTAIN, 2);
}
function env_key(envname, key, flag) {
	return k => {
		const ins = cur(), env = ins[envname];
		if (_env_handle_mouse(k, env, key)) { ins.flags |= flag; return 1; }
		let r = envelope_edit_mode ? _env_handle_key_editmode(k, env, key) : _env_handle_key_viewmode(k, env, key, flag);
		if (r & 2) { r ^= 2; ins.flags |= flag; }
		return r;
	};
}
const volume_envelope_handle_key = env_key('vol_env', 'vol', C.ENV_VOLUME);
const panning_envelope_handle_key = env_key('pan_env', 'pan', C.ENV_PANNING);
const pitch_envelope_handle_key = env_key('pitch_env', 'pitch', C.ENV_PITCH);

function pitch_pan_center_handle_key(k) {
	const ins = cur();
	let ppc = ins.pitch_pan_center;
	if (k.state === KEY_RELEASE) return 0;
	switch (k.sym) {
	case KEYSYM.LEFT: if (!NO_MODIFIER(k.mod)) return 0; ppc--; break;
	case KEYSYM.RIGHT: if (!NO_MODIFIER(k.mod)) return 0; ppc++; break;
	default:
		if (!(k.mod & (KEYMOD.CTRL | KEYMOD.ALT))) {
			ppc = kbd_get_note(k);
			if (ppc < 1 || ppc > 120) return 0;
			ppc--;
			break;
		}
		return 0;
	}
	if (ppc !== ins.pitch_pan_center && ppc >= 0 && ppc < 120) { ins.pitch_pan_center = ppc; status.flags |= NEED_UPDATE; }
	return 1;
}
function pitch_pan_center_draw() {
	draw_text(get_note_string(cur().pitch_pan_center + 1), 54, 45, app.active_page().selected_widget === 16 ? 3 : 2, 0);
}

function instrument_save(format) {
	const ins = cur();
	if (!ins.filename && !ins.name) { flash('Instrument NOT saved! (No Filename?)'); return; }
	app.song_save_instrument(null, format, ins, current_instrument);
}
function instrument_list_handle_alt_key(k) {
	if (k.state === KEY_RELEASE) return;
	switch (k.sym) {
	case KEYSYM.n: song_toggle_multichannel_mode(); return;
	case KEYSYM.o: instrument_save('ITI'); return;
	case KEYSYM.r: smpprompt_create('Replace instrument with:', 'Instrument', n => { if (valid(n)) song_replace_instrument(current_instrument, n); }); return;
	case KEYSYM.s: smpprompt_create('Swap instrument with: ', 'Instrument', n => { if (valid(n)) song_swap_instruments(current_instrument, n); }); return;
	case KEYSYM.x: smpprompt_create('Exchange instrument with:', 'Instrument', n => { if (valid(n)) song_exchange_instruments(current_instrument, n); }); return;
	case KEYSYM.p: smpprompt_create('Copy instrument:', 'Instrument', n => { if (valid(n)) song_copy_instrument(current_instrument, n); }); return;
	case KEYSYM.w: song_wipe_instrument(current_instrument); break;
	case KEYSYM.d:
		if (k.mod & KEYMOD.SHIFT) dialog_create(DIALOG_OK_CANCEL, 'Delete Instrument? (preserve shared samples)', () => song_delete_instrument(current_instrument, 1), null, 1, null);
		else dialog_create(DIALOG_OK_CANCEL, 'Delete Instrument?', () => song_delete_instrument(current_instrument, 0), null, 1, null);
		return;
	case KEYSYM.t: instrument_save('ITI'); break;
	default: return;
	}
	status.flags |= NEED_UPDATE;
}
function instrument_list_pre_handle_key(k) {
	if (status.dialog_type !== DIALOG_NONE || k.sym !== KEYSYM.F4 || (k.mod & (KEYMOD.CTRL | KEYMOD.ALT))) return 0;
	if (k.state === KEY_RELEASE) return 1;
	if (song_is_instrument_mode()) {
		const csamp = app.sample_get_current();
		app.sample_synchronize_to_instrument();
		if (csamp !== app.sample_get_current()) { status.flags |= NEED_UPDATE; return 0; }
	}
	const P = PAGE, cp = status.current_page;
	if (k.mod & KEYMOD.SHIFT)
		set_subpage({ [P.INSTRUMENT_LIST_PANNING]: P.INSTRUMENT_LIST_VOLUME, [P.INSTRUMENT_LIST_PITCH]: P.INSTRUMENT_LIST_PANNING, [P.INSTRUMENT_LIST_GENERAL]: P.INSTRUMENT_LIST_PITCH }[cp] ?? P.INSTRUMENT_LIST_GENERAL);
	else
		set_subpage({ [P.INSTRUMENT_LIST_GENERAL]: P.INSTRUMENT_LIST_VOLUME, [P.INSTRUMENT_LIST_VOLUME]: P.INSTRUMENT_LIST_PANNING, [P.INSTRUMENT_LIST_PANNING]: P.INSTRUMENT_LIST_PITCH }[cp] ?? P.INSTRUMENT_LIST_GENERAL);
	return 1;
}
function instrument_list_handle_key(k) {
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.COMMA:
		if (NO_MODIFIER(k.mod) && !(status.flags & CLASSIC_MODE) && app.active_page().selected_widget === 5) return;
		// fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.LESS: if (rel) return; song_change_current_play_channel(-1, 0); return;
	case KEYSYM.PERIOD:
		if (NO_MODIFIER(k.mod) && !(status.flags & CLASSIC_MODE) && app.active_page().selected_widget === 5) return;
		// fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.GREATER: if (rel) return; song_change_current_play_channel(1, 0); return;
	case KEYSYM.PAGEUP: if (rel) return; instrument_set(current_instrument - 1); break;
	case KEYSYM.PAGEDOWN: if (rel) return; instrument_set(current_instrument + 1); break;
	case KEYSYM.ESCAPE:
		if ((k.mod & KEYMOD.SHIFT) || icursor.cursor_pos < 25) {
			if (rel) return;
			icursor.cursor_pos = 25;
			get_page_widgets()[0].accept_text = 0;
			widget_change_focus_to(0);
			status.flags |= NEED_UPDATE;
		}
		return;
	default:
		if (k.mod & KEYMOD.ALT) instrument_list_handle_alt_key(k);
		else {
			let n, v = 64;
			if (k.midi_note > -1) { n = k.midi_note; if (k.midi_volume > -1) v = k.midi_volume >> 1; }
			else { n = kbd_get_note(k); if (n <= 0 || n > 120) return; }
			if (rel) { song_keyup(KEYJAZZ_NOINST, current_instrument, n); status.last_keysym = 0; }
			else if (!k.is_repeat) song_keydown(KEYJAZZ_NOINST, current_instrument, n, v, KEYJAZZ_CHAN_AUTO);
			last_note = n;
		}
	}
}

function set_subpage(page) {
	let widget = app.active_page().selected_widget;
	const b = { [PAGE.INSTRUMENT_LIST_GENERAL]: 1, [PAGE.INSTRUMENT_LIST_VOLUME]: 2, [PAGE.INSTRUMENT_LIST_PANNING]: 3, [PAGE.INSTRUMENT_LIST_PITCH]: 4 }[page];
	if (!b) return;
	widget_togglebutton_set(pages[page].widgets, b, 0);
	set_page(page);
	if (widget >= app.active_page().total_widgets) widget = app.active_page().total_widgets - 1;
	app.active_page().selected_widget = widget;
	ilist.subpage = page;
	status.flags |= NEED_UPDATE;
}
function change_subpage() {
	const widget = app.active_page().selected_widget;
	set_subpage([PAGE.INSTRUMENT_LIST_GENERAL, PAGE.INSTRUMENT_LIST_VOLUME, PAGE.INSTRUMENT_LIST_PANNING, PAGE.INSTRUMENT_LIST_PITCH][clamp(widget - 1, 0, 3)]);
}

function env_predraw(w, env, on, carry, loop, sus) {
	const ins = cur(), f = ins.flags;
	w[6].d.state = f & on ? 1 : 0; w[7].d.state = f & carry ? 1 : 0;
	w[8].d.state = f & loop ? 1 : 0; w[11].d.state = f & sus ? 1 : 0;
	if (env.loop_start > env.loop_end) env.loop_end = env.loop_start;
	if (env.sustain_start > env.sustain_end) env.sustain_end = env.sustain_start;
	for (const i of [9, 10, 12, 13]) w[i].d.max = env.nodes - 1;
	w[9].d.value = env.loop_start; w[10].d.value = env.loop_end;
	w[12].d.value = env.sustain_start; w[13].d.value = env.sustain_end;
}
function general_predraw() {
	const ins = cur();
	widget_togglebutton_set(widgets_general, 6 + ins.nna % 4, 0);
	widget_togglebutton_set(widgets_general, 10 + ins.dct % 4, 0);
	widget_togglebutton_set(widgets_general, 14 + ins.dca % 3, 0);
}
function volume_predraw() {
	const ins = cur();
	env_predraw(widgets_volume, ins.vol_env, C.ENV_VOLUME, C.ENV_VOLCARRY, C.ENV_VOLLOOP, C.ENV_VOLSUSTAIN);
	widgets_volume[14].d.value = ins.global_volume;
	widgets_volume[15].d.value = ins.fadeout >> 5;
	widgets_volume[16].d.value = ins.vol_swing;
}
function panning_predraw() {
	const ins = cur();
	env_predraw(widgets_panning, ins.pan_env, C.ENV_PANNING, C.ENV_PANCARRY, C.ENV_PANLOOP, C.ENV_PANSUSTAIN);
	widgets_panning[14].d.state = ins.flags & C.ENV_SETPANNING ? 1 : 0;
	widgets_panning[15].d.value = ins.panning >> 2;
	widgets_panning[17].d.value = ins.pitch_pan_separation;
	widgets_panning[18].d.value = ins.pan_swing;
}
const s8 = v => (v << 24) >> 24;
function pitch_predraw() {
	const ins = cur();
	env_predraw(widgets_pitch, ins.pitch_env, C.ENV_PITCH, C.ENV_PITCHCARRY, C.ENV_PITCHLOOP, C.ENV_PITCHSUSTAIN);
	widgets_pitch[6].d.state = ins.flags & C.ENV_PITCH ? (ins.flags & C.ENV_FILTER ? 2 : 1) : 0;
	widgets_pitch[14].d.value = ins.ifc & 0x80 ? ins.ifc & 0x7f : -1;
	widgets_pitch[15].d.value = ins.ifr & 0x80 ? ins.ifr & 0x7f : -1;
	widgets_pitch[16].d.value = ins.midi_channel_mask;
	widgets_pitch[17].d.value = s8(ins.midi_program);
	widgets_pitch[18].d.value = s8(ins.midi_bank & 0xff);
	widgets_pitch[19].d.value = s8(ins.midi_bank >> 8);
}

function general_update_values() {
	const ins = cur();
	status.flags |= SONG_NEEDS_SAVE;
	for (ins.nna = 4; ins.nna--;) if (widgets_general[ins.nna + 6].d.state) break;
	for (ins.dct = 4; ins.dct--;) if (widgets_general[ins.dct + 10].d.state) break;
	for (ins.dca = 3; ins.dca--;) if (widgets_general[ins.dca + 14].d.state) break;
	if (ins.nna < 0) ins.nna = 0;
	if (ins.dct < 0) ins.dct = 0;
	if (ins.dca < 0) ins.dca = 0;
}
function env_update(w, env, ins, on, carry, loop, sus, extra = 0) {
	ins.flags &= ~(on | carry | loop | sus | extra);
	if (w[6].d.state) ins.flags |= on;
	if (w[7].d.state) ins.flags |= carry;
	if (w[8].d.state) ins.flags |= loop;
	if (w[11].d.state) ins.flags |= sus;
	const cs = (k, i, f) => { if (env[k] !== w[i].d.value) { env[k] = w[i].d.value; ins.flags |= f; } };
	cs('loop_start', 9, loop); cs('loop_end', 10, loop); cs('sustain_start', 12, sus); cs('sustain_end', 13, sus);
}
function volume_update_values() {
	const ins = cur();
	status.flags |= SONG_NEEDS_SAVE;
	env_update(widgets_volume, ins.vol_env, ins, C.ENV_VOLUME, C.ENV_VOLCARRY, C.ENV_VOLLOOP, C.ENV_VOLSUSTAIN);
	ins.global_volume = widgets_volume[14].d.value;
	ins.fadeout = widgets_volume[15].d.value << 5;
	ins.vol_swing = widgets_volume[16].d.value;
	song_update_playing_instrument(current_instrument);
}
function panning_update_values() {
	const ins = cur();
	status.flags |= SONG_NEEDS_SAVE;
	env_update(widgets_panning, ins.pan_env, ins, C.ENV_PANNING, C.ENV_PANCARRY, C.ENV_PANLOOP, C.ENV_PANSUSTAIN, C.ENV_SETPANNING);
	if (widgets_panning[14].d.state) ins.flags |= C.ENV_SETPANNING;
	const n = widgets_panning[15].d.value << 2;
	if (ins.panning !== n) { ins.panning = n; ins.flags |= C.ENV_SETPANNING; }
	ins.pitch_pan_separation = widgets_panning[17].d.value;
	ins.pan_swing = widgets_panning[18].d.value;
	song_update_playing_instrument(current_instrument);
}
function pitch_update_values() {
	const ins = cur();
	status.flags |= SONG_NEEDS_SAVE;
	ins.flags &= ~C.ENV_FILTER;
	env_update(widgets_pitch, ins.pitch_env, ins, C.ENV_PITCH, C.ENV_PITCHCARRY, C.ENV_PITCHLOOP, C.ENV_PITCHSUSTAIN);
	ins.flags &= ~(C.ENV_PITCH | C.ENV_FILTER);
	switch (widgets_pitch[6].d.state) { case 2: ins.flags |= C.ENV_FILTER; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case 1: ins.flags |= C.ENV_PITCH; }
	ins.ifc = widgets_pitch[14].d.value > -1 ? widgets_pitch[14].d.value | 0x80 : 0x7f;
	ins.ifr = widgets_pitch[15].d.value > -1 ? widgets_pitch[15].d.value | 0x80 : 0x7f;
	ins.midi_channel_mask = widgets_pitch[16].d.value;
	ins.midi_program = widgets_pitch[17].d.value;
	ins.midi_bank = ((widgets_pitch[19].d.value << 8) | (widgets_pitch[18].d.value & 0xff));
	song_update_playing_instrument(current_instrument);
}

const draw_list_box = () => draw_box(4, 12, 30, 48, BOX_THICK | BOX_INNER | BOX_INSET);
function general_draw_const() {
	draw_list_box();
	draw_box(31, 15, 42, 48, BOX_THICK | BOX_INNER | BOX_INSET);
	if (status.flags & CLASSIC_MODE) { draw_box(55, 46, 73, 48, BOX_THICK | BOX_INNER | BOX_INSET); draw_text('    ', 69, 47, 1, 0); }
	else draw_box(55, 46, 69, 48, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_text('New Note Action', 54, 17, 0, 2);
	draw_text('Duplicate Check Type & Action', 47, 32, 0, 2);
	draw_text('Filename', 47, 47, 0, 2);
	for (let n = 0; n < 35; n++) { draw_char(134, 44 + n, 15, 0, 2); draw_char(134, 44 + n, 30, 0, 2); draw_char(154, 44 + n, 45, 0, 2); }
}
function env_page_boxes(last) {
	draw_list_box();
	draw_fill_chars(57, 28, 62, 29, DEFAULT_FG, 0);
	draw_fill_chars(57, 32, 62, 34, DEFAULT_FG, 0);
	draw_fill_chars(57, 37, 62, 39, DEFAULT_FG, 0);
	draw_box(31, 17, 77, 26, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(53, 27, 63, 30, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(53, 31, 63, 35, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(53, 36, 63, 40, BOX_THICK | BOX_INNER | BOX_INSET);
	last();
	draw_text('Carry', 48, 29, 0, 2);
	draw_text('Envelope Loop', 40, 32, 0, 2);
	draw_text('Loop Begin', 43, 33, 0, 2);
	draw_text('Loop End', 45, 34, 0, 2);
	draw_text('Sustain Loop', 41, 37, 0, 2);
	draw_text('SusLoop Begin', 40, 38, 0, 2);
	draw_text('SusLoop End', 42, 39, 0, 2);
}
function volume_draw_const() {
	env_page_boxes(() => {
		draw_box(53, 41, 71, 44, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_box(53, 45, 71, 47, BOX_THICK | BOX_INNER | BOX_INSET);
	});
	draw_text('Volume Envelope', 38, 28, 0, 2);
	draw_text('Global Volume', 40, 42, 0, 2);
	draw_text('Fadeout', 46, 43, 0, 2);
	draw_text('Volume Swing %', 39, 46, 0, 2);
}
function panning_draw_const() {
	env_page_boxes(() => {
		draw_fill_chars(57, 42, 62, 45, DEFAULT_FG, 0);
		draw_box(53, 41, 63, 48, BOX_THICK | BOX_INNER | BOX_INSET);
	});
	draw_text('Panning Envelope', 37, 28, 0, 2);
	draw_text('Default Pan', 42, 42, 0, 2);
	draw_text('Pan Value', 44, 43, 0, 2);
	draw_text('Pitch-Pan Center', 37, 45, 0, 2);
	draw_text('Pitch-Pan Separation', 33, 46, 0, 2);
	draw_text(status.flags & CLASSIC_MODE ? 'Pan swing' : 'Pan Swing', 44, 47, 0, 2);
	draw_text('\x9a'.repeat(9), 54, 44, 2, 0);
}
function pitch_draw_const() {
	env_page_boxes(() => draw_box(53, 41, 71, 48, BOX_THICK | BOX_INNER | BOX_INSET));
	draw_text('Frequency Envelope', 35, 28, 0, 2);
	draw_text('Default Cutoff', 36, 42, 0, 2);
	draw_text('Default Resonance', 36, 43, 0, 2);
	draw_text('MIDI Channels', 36, 44, 0, 2);
	draw_text('MIDI Program', 36, 45, 0, 2);
	draw_text('MIDI Bank Low', 36, 46, 0, 2);
	draw_text('MIDI Bank High', 36, 47, 0, 2);
}

function _load_page_common(page, w) {
	Object.assign(page, { title: 'Instrument List (F4)', pre_handle_key: instrument_list_pre_handle_key,
		handle_key: instrument_list_handle_key, widgets: w, help_index: HELP.INSTRUMENT_LIST,
		set_page: instrument_list_reposition, ported: true });
	w[0] = widget_create_other(1, instrument_list_handle_key_on_list, instrument_list_handle_text_input_on_list, instrument_list_draw_list);
	w[0].accept_text = icursor.cursor_pos === 25 ? 0 : 1;
	Object.assign(w[0], { x: 5, y: 13, width: 24, height: 34 });
	w[1] = widget_create_togglebutton(32, 13, 7, 1, 5, 0, 2, 2, change_subpage, 'General', 1, subpage_switches_group);
	w[2] = widget_create_togglebutton(44, 13, 7, 2, 5, 1, 3, 3, change_subpage, 'Volume', 1, subpage_switches_group);
	w[3] = widget_create_togglebutton(56, 13, 7, 3, 5, 2, 4, 4, change_subpage, 'Panning', 1, subpage_switches_group);
	w[4] = widget_create_togglebutton(68, 13, 7, 4, 5, 3, 0, 0, change_subpage, 'Pitch', 2, subpage_switches_group);
}
function env_widget(w, handle_key, draw) {
	w[5] = widget_create_other(0, handle_key, null, draw);
	Object.assign(w[5], { x: 32, y: 18, width: 45, height: 8 });
	w[5].next.down = 6;
}
function env_loop_widgets(w, upd, cursor, first) {
	w[6] = first || widget_create_toggle(54, 28, 5, 7, 0, 0, 0, upd);
	w[7] = widget_create_toggle(54, 29, 6, 8, 0, 0, 0, upd);
	w[8] = widget_create_toggle(54, 32, 7, 9, 0, 0, 0, upd);
	w[9] = widget_create_numentry(54, 33, 3, 8, 10, 0, upd, 0, 1, cursor);
	w[10] = widget_create_numentry(54, 34, 3, 9, 11, 0, upd, 0, 1, cursor);
	w[11] = widget_create_toggle(54, 37, 10, 12, 0, 0, 0, upd);
	w[12] = widget_create_numentry(54, 38, 3, 11, 13, 0, upd, 0, 1, cursor);
	w[13] = widget_create_numentry(54, 39, 3, 12, 14, 0, upd, 0, 1, cursor);
}
function fixup(envname, key, flag) {
	return k => {
		const ins = cur();
		if (envelope_mouse_edit && ins && _env_handle_mouse(k, ins[envname], key)) { ins.flags |= flag; return 1; }
		if ((k.sym === KEYSYM.l || k.sym === KEYSYM.b) && (k.mod & KEYMOD.ALT)) return _env_handle_key_viewmode(k, ins[envname], key, flag);
		return instrument_list_pre_handle_key(k);
	};
}

function load_general(page) {
	const w = widgets_general;
	_load_page_common(page, w);
	Object.assign(page, { draw_const: general_draw_const, predraw_hook: general_predraw, total_widgets: 18 });
	w[1].d.state = 1;
	w[2].next.down = w[3].next.down = w[4].next.down = 6;
	w[5] = widget_create_other(6, note_trans_handle_key, null, note_trans_draw);
	Object.assign(w[5], { x: 32, y: 16, width: 9, height: 31 });
	w[5].next.down = 6;
	const u = general_update_values;
	w[6] = widget_create_togglebutton(46, 19, 29, 2, 7, 5, 0, 0, u, 'Note Cut', 2, nna_group);
	w[7] = widget_create_togglebutton(46, 22, 29, 6, 8, 5, 0, 0, u, 'Continue', 2, nna_group);
	w[8] = widget_create_togglebutton(46, 25, 29, 7, 9, 5, 0, 0, u, 'Note Off', 2, nna_group);
	w[9] = widget_create_togglebutton(46, 28, 29, 8, 10, 5, 0, 0, u, 'Note Fade', 2, nna_group);
	w[10] = widget_create_togglebutton(46, 34, 12, 9, 11, 5, 14, 14, u, 'Disabled', 2, dct_group);
	w[11] = widget_create_togglebutton(46, 37, 12, 10, 12, 5, 15, 15, u, 'Note', 2, dct_group);
	w[12] = widget_create_togglebutton(46, 40, 12, 11, 13, 5, 16, 16, u, 'Sample', 2, dct_group);
	w[13] = widget_create_togglebutton(46, 43, 12, 12, 17, 5, 13, 13, u, 'Instrument', 2, dct_group);
	w[14] = widget_create_togglebutton(62, 34, 13, 9, 15, 10, 0, 0, u, 'Note Cut', 2, dca_group);
	w[15] = widget_create_togglebutton(62, 37, 13, 14, 16, 11, 0, 0, u, 'Note Off', 2, dca_group);
	w[16] = widget_create_togglebutton(62, 40, 13, 15, 17, 12, 0, 0, u, 'Note Fade', 2, dca_group);
	w[17] = widget_create_textentry(56, 47, 13, 13, 17, 0, () => { status.flags |= SONG_NEEDS_SAVE; }, filename_ref, 12);
}
function load_volume(page) {
	const w = widgets_volume;
	_load_page_common(page, w);
	Object.assign(page, { pre_handle_key: fixup('vol_env', 'vol', C.ENV_VOLUME), draw_const: volume_draw_const, predraw_hook: volume_predraw, total_widgets: 17 });
	env_widget(w, volume_envelope_handle_key, volume_envelope_draw);
	env_loop_widgets(w, volume_update_values, numentry_cursor_pos[0]);
	w[14] = widget_create_thumbbar(54, 42, 17, 13, 15, 0, volume_update_values, 0, 128);
	w[15] = widget_create_thumbbar(54, 43, 17, 14, 16, 0, volume_update_values, 0, 256);
	w[16] = widget_create_thumbbar(54, 46, 17, 15, 16, 0, volume_update_values, 0, 100);
}
function load_panning(page) {
	const w = widgets_panning;
	_load_page_common(page, w);
	Object.assign(page, { pre_handle_key: fixup('pan_env', 'pan', C.ENV_PANNING), draw_const: panning_draw_const, predraw_hook: panning_predraw, total_widgets: 19 });
	env_widget(w, panning_envelope_handle_key, panning_envelope_draw);
	env_loop_widgets(w, panning_update_values, numentry_cursor_pos[1]);
	w[14] = widget_create_toggle(54, 42, 13, 15, 0, 0, 0, panning_update_values);
	w[15] = widget_create_thumbbar(54, 43, 9, 14, 16, 0, panning_update_values, 0, 64);
	w[16] = widget_create_other(0, pitch_pan_center_handle_key, null, pitch_pan_center_draw);
	w[16].next.up = 15; w[16].next.down = 17;
	w[17] = widget_create_thumbbar(54, 46, 9, 16, 18, 0, panning_update_values, -32, 32);
	w[18] = widget_create_thumbbar(54, 47, 9, 17, 18, 0, panning_update_values, 0, 64);
}
function load_pitch(page) {
	const w = widgets_pitch;
	_load_page_common(page, w);
	Object.assign(page, { pre_handle_key: fixup('pitch_env', 'pitch', C.ENV_PITCH), draw_const: pitch_draw_const, predraw_hook: pitch_predraw, total_widgets: 20 });
	env_widget(w, pitch_envelope_handle_key, pitch_envelope_draw);
	env_loop_widgets(w, pitch_update_values, numentry_cursor_pos[2],
		widget_create_menutoggle(54, 28, 5, 7, 0, 0, 0, pitch_update_values, pitch_envelope_states));
	w[14] = widget_create_thumbbar(54, 42, 17, 13, 15, 0, pitch_update_values, -1, 127);
	w[15] = widget_create_thumbbar(54, 43, 17, 14, 16, 0, pitch_update_values, -1, 127);
	w[14].d.text_at_min = w[15].d.text_at_min = 'Off';
	w[16] = widget_create_bitset(54, 44, 17, 15, 17, 0, pitch_update_values, 17,
		' 1 2 3 4 5 6 7 8 9P\x00111213141516M\x00', '.\x00.\x00.\x00.\x00.\x00.\x00.\x00.\x00.\x00p\x00.\x00.\x00.\x00.\x00.\x00.\x00m\x00', { value: 0 });
	w[16].d.activation_keys = '123456789pabcdefm';
	w[17] = widget_create_thumbbar(54, 45, 17, 16, 18, 0, pitch_update_values, -1, 127);
	w[18] = widget_create_thumbbar(54, 46, 17, 17, 19, 0, pitch_update_values, -1, 127);
	w[19] = widget_create_thumbbar(54, 47, 17, 18, 19, 0, pitch_update_values, -1, 127);
	w[17].d.text_at_min = w[18].d.text_at_min = w[19].d.text_at_min = 'Off';
}
load_general(pages[PAGE.INSTRUMENT_LIST_GENERAL]);
load_volume(pages[PAGE.INSTRUMENT_LIST_VOLUME]);
load_panning(pages[PAGE.INSTRUMENT_LIST_PANNING]);
load_pitch(pages[PAGE.INSTRUMENT_LIST_PITCH]);
widgets_volume[2].d.state = 1; widgets_panning[3].d.state = 1; widgets_pitch[4].d.state = 1;
widgets_volume[1].d.state = widgets_panning[1].d.state = widgets_pitch[1].d.state = 0;

provide({ instrument_get_current, instrument_set, instrument_synchronize_to_sample });
void optional;
