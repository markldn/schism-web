// Port of schism/page_patedit.c (Schism Tracker, GPL-2.0-or-later).
// Not ported: pattern-to-sample (Ctrl-O/Ctrl-B), config load/save.
import { clippy_copy, clippy_paste } from './clippy.js';
import { pattern_selection_system_paste_modplug } from './pattern-clipboard.js';
import { app, provide } from './app.js';
import * as C from './sndconst.js';
import { status, tracker, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE, CRAYOLA_MODE,
	INVERTED_PALETTE, DIALOG_OK } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, BOX_THIN, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, SCANCODE, KEY_PRESS, KEY_RELEASE, KEY_DRAG, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK,
	MOUSE_DBLCLICK, MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, numeric_key_event, kbd_get_note, kbd_char_to_hex,
	kbd_char_to_99, kbd_get_effect_number, kbd_get_current_octave, kbd_set_current_octave,
	get_note_string, get_effect_char } from './keyboard.js';
import { ui, widget_create_other, widget_create_thumbbar, widget_create_togglebutton, widget_create_button,
	widget_create_toggle, widget_togglebutton_set, widget_change_focus_to, MOUSE_SCROLL_LINES, str_from_num } from './widget.js';
import { dialog_create, dialog_create_custom, dialog_yes, dialog_cancel, dialog_yes_NULL, dialog_cancel_NULL } from './dialog.js';
import { pages } from './page.js';
import * as PV from './pattern-view.js';
import { MASK_NOTE, MASK_INSTRUMENT, MASK_VOLUME, MASK_EFFECT } from './pattern-view.js';
import { current_song, song_get_pattern, song_get_pattern_buf, song_get_mode, MODE_PLAYING, MODE_PATTERN_LOOP,
	song_get_max_row_number_in_pattern, song_pattern_resize, song_get_channel, song_get_sample,
	song_is_instrument_mode, song_get_current_instrument, song_keydown, song_keyup, song_keyrecord,
	song_single_step, song_start_at_order, song_start_at_pattern, song_loop_pattern, song_toggle_channel_mute,
	song_handle_channel_solo, song_find_last_channel, song_set_current_order, song_get_current_order,
	song_get_current_row, song_get_playing_pattern, KEYJAZZ_NOINST, KEYJAZZ_DEFAULTVOL,
	song_get_current_speed, song_get_current_tick, song_get_pattern_offset } from './song.js';
import { midi, MIDI_TICK_QUANTIZE, MIDI_RECORD_NOTEOFF, MIDI_RECORD_VELOCITY, MIDI_PITCHBEND } from './midi.js';
import { csf_get_num_patterns } from './csndfile.js';

const MAX_CHANNELS = 64;
const ROW_IS_MAJOR = r => current_song.row_highlight_major !== 0 && r % current_song.row_highlight_major === 0;
const ROW_IS_MINOR = r => current_song.row_highlight_minor !== 0 && r % current_song.row_highlight_minor === 0;
const ROW_IS_HIGHLIGHT = r => ROW_IS_MINOR(r) || ROW_IS_MAJOR(r);
const SONG_PLAYING = () => song_get_mode() & (MODE_PLAYING | MODE_PATTERN_LOOP);
const NOTE_IS_NOTE = n => n > 0 && n <= 120;
const NOTE_IS_CONTROL = n => n > 120;
const LAST_KEY_IS = (sym, mod) => ((mod === 0) ? !status.last_keymod : (status.last_keymod & mod)) && status.last_keysym === sym;
const blank = () => ({ note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 });
const blank_note = blank();
const copy_note = (d, s) => { d.note = s.note; d.instrument = s.instrument; d.voleffect = s.voleffect; d.volparam = s.volparam; d.effect = s.effect; d.param = s.param; };
const clear_note = d => copy_note(d, blank_note);
const note_eq = (a, b) => a.note === b.note && a.instrument === b.instrument && a.voleffect === b.voleffect && a.volparam === b.volparam && a.effect === b.effect && a.param === b.param;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const flash = t => app.status_text_flash(t);

const TEMPLATE_OFF = 0, TEMPLATE_OVERWRITE = 1, TEMPLATE_MIX_PATTERN_PRECEDENCE = 2,
	TEMPLATE_MIX_CLIPBOARD_PRECEDENCE = 3, TEMPLATE_NOTES_ONLY = 4, TEMPLATE_MODE_MAX = 5;
let template_mode = TEMPLATE_OFF;
const template_mode_names = ['', 'Template, Overwrite', 'Template, Mix - Pattern data precedence',
	'Template, Mix - Clipboard data precedence', 'Template, Notes only'];

let top_display_channel = 1, top_display_row = 0;
let current_channel = 1, current_position = 0, current_row = 0;
let keyjazz_noteoff = 0, keyjazz_write_noteoff = 0, keyjazz_repeat = 1, keyjazz_capslock = 0;
let current_pattern = 0, skip_value = 1, link_effect_column = 0, draw_divisions = 1;
let shift_chord_channels = 0, centralise_cursor = 0, highlight_current_row = 0, panning_mode = 0;
let playing_row = -1, playing_pattern = -1;
let edit_copy_mask = MASK_NOTE | MASK_INSTRUMENT | MASK_VOLUME;
let mask_note = { note: 61, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 };
let marked_pattern = -1, marked_row = 0;
let volume_percent = 100, vary_depth = 10, fast_volume_percent = 67, fast_volume_mode = 0;
const COPY_INST_OFF = 0, COPY_INST_UP_THEN_DOWN = 2;
let mask_copy_search_mode = COPY_INST_OFF, invert_home_end = 0;

// pattern snaps (undo + clipboard)
const make_snap = op => ({ data: null, channels: 0, rows: 0, snap_op: op, x: 0, y: 0, patternno: -1 });
let fast_save = make_snap('Fast Pattern Save');
let clipboard = make_snap('Clipboard');
const undo_history = Array.from({ length: 10 }, () => make_snap('Empty'));
let undo_history_top = 0;

const selection = { first_channel: 0, last_channel: 0, first_row: 0, last_row: 0 };
const shift_selection = { in_progress: 0, first_channel: 0, first_row: 0 };
let block_double_size = 0;
const SELECTION_EXISTS = () => selection.first_channel;
function CHECK_FOR_SELECTION() {
	if (!SELECTION_EXISTS()) {
		dialog_create(DIALOG_OK, '    No block is marked    ', null, null, 0, null);
		return false;
	}
	return true;
}

const track_views = [13, 10, 7, 6, 3, 2, 1].map(n => ({ width: n,
	draw_channel_header: PV['draw_channel_header_' + n], draw_note: PV['draw_note_' + n], draw_mask: PV['draw_mask_' + n] }));
const NUM_TRACK_VIEWS = track_views.length;
const track_view_scheme = new Uint8Array(MAX_CHANNELS);
let channel_multi_enabled = 0;
const channel_multi = new Int32Array(MAX_CHANNELS);
let visible_channels = 0, visible_width = 0;

const pattern = () => song_get_pattern_buf(current_pattern);
const at = (p, row, chan) => p[MAX_CHANNELS * row + chan - 1];

// ------------------------------------------------------------------------
// options dialog

let options_widgets = null, options_selected_widget = 0, options_last_octave = 0;
const options_link_split = [5, 6, -1];
function options_close_cancel() { kbd_set_current_octave(options_last_octave); }
function options_close(data) {
	options_selected_widget = data.selected_widget;
	skip_value = options_widgets[1].d.value;
	current_song.row_highlight_minor = options_widgets[2].d.value;
	current_song.row_highlight_major = options_widgets[3].d.value;
	link_effect_column = options_widgets[5].d.state ? 1 : 0;
	status.flags |= SONG_NEEDS_SAVE;
	const old_size = song_get_pattern(current_pattern), new_size = options_widgets[4].d.value;
	if (old_size !== new_size) {
		song_pattern_resize(current_pattern, new_size);
		current_row = Math.min(current_row, new_size - 1);
		pattern_editor_reposition();
	}
}
function options_draw_const() {
	draw_text('Pattern Editor Options', 28, 19, 0, 2);
	draw_text('Base octave', 28, 23, 0, 2);
	draw_text('Cursor step', 28, 26, 0, 2);
	draw_text('Row hilight minor', 22, 29, 0, 2);
	draw_text('Row hilight major', 22, 32, 0, 2);
	draw_text('Number of rows in pattern', 14, 35, 0, 2);
	draw_text('Command/Value columns', 18, 38, 0, 2);
	draw_box(39, 22, 42, 24, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(39, 25, 43, 27, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(39, 28, 45, 30, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(39, 31, 57, 33, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(39, 34, 62, 36, BOX_THIN | BOX_INNER | BOX_INSET);
}
export function pattern_editor_display_options() {
	if (!options_widgets) {
		options_widgets = [
			widget_create_thumbbar(40, 23, 2, 7, 1, 1, () => kbd_set_current_octave(options_widgets[0].d.value), 0, 8),
			widget_create_thumbbar(40, 26, 3, 0, 2, 2, null, 0, 16),
			widget_create_thumbbar(40, 29, 5, 1, 3, 3, null, 0, 32),
			widget_create_thumbbar(40, 32, 17, 2, 4, 4, null, 0, 128),
			widget_create_thumbbar(40, 35, 22, 3, 5, 5, null, 32, 200),
			widget_create_togglebutton(40, 38, 8, 4, 7, 6, 6, 6, null, 'Link', 3, options_link_split),
			widget_create_togglebutton(52, 38, 9, 4, 7, 5, 5, 5, null, 'Split', 3, options_link_split),
			widget_create_button(35, 41, 8, 5, 0, 7, 7, 7, dialog_yes_NULL, 'Done', 3),
		];
	}
	options_last_octave = kbd_get_current_octave();
	options_widgets[0].d.value = options_last_octave;
	options_widgets[1].d.value = skip_value;
	options_widgets[2].d.value = current_song.row_highlight_minor;
	options_widgets[3].d.value = current_song.row_highlight_major;
	options_widgets[4].d.value = song_get_pattern(current_pattern);
	widget_togglebutton_set(options_widgets, link_effect_column ? 5 : 6, 0);
	const dialog = dialog_create_custom(10, 18, 60, 26, options_widgets, 8, options_selected_widget, options_draw_const, null);
	dialog.action_yes = options_close;
	dialog.action_cancel = (status.flags & CLASSIC_MODE) ? options_close : options_close_cancel;
	dialog.data = dialog;
}

function template_error_draw() {
	draw_text('Template Error', 33, 25, 0, 2);
	draw_text('No note in the top left position', 23, 27, 0, 2);
	draw_text('of the clipboard on which to', 25, 28, 0, 2);
	draw_text('base translations.', 31, 29, 0, 2);
}

// pattern length dialog
let length_edit_widgets = null;
function length_edit_draw_const() {
	draw_box(33, 23, 56, 25, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(33, 26, 60, 29, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_text('Set Pattern Length', 31, 21, 0, 2);
	draw_text('Pattern Length', 19, 24, 0, 2);
	draw_text('Start Pattern', 20, 27, 0, 2);
	draw_text('End Pattern', 22, 28, 0, 2);
}
function length_edit_close() {
	const nl = length_edit_widgets[0].d.value;
	status.flags |= SONG_NEEDS_SAVE;
	for (let i = length_edit_widgets[1].d.value; i <= length_edit_widgets[2].d.value; i++) {
		if (song_get_pattern(i) !== nl) {
			song_pattern_resize(i, nl);
			if (i === current_pattern) {
				status.flags |= NEED_UPDATE;
				current_row = Math.min(current_row, nl - 1);
				pattern_editor_reposition();
			}
		}
	}
}
export function pattern_editor_length_edit() {
	length_edit_widgets = [
		widget_create_thumbbar(34, 24, 22, 0, 1, 1, null, 32, 200),
		widget_create_thumbbar(34, 27, 26, 0, 2, 2, null, 0, 199),
		widget_create_thumbbar(34, 28, 26, 1, 3, 3, null, 0, 199),
		widget_create_button(35, 31, 8, 2, 3, 3, 3, 0, dialog_yes_NULL, 'OK', 4),
	];
	length_edit_widgets[0].d.value = song_get_pattern(current_pattern);
	length_edit_widgets[1].d.value = length_edit_widgets[2].d.value = current_pattern;
	const dialog = dialog_create_custom(15, 19, 51, 15, length_edit_widgets, 4, 0, length_edit_draw_const, null);
	dialog.action_yes = length_edit_close;
	dialog.action_cancel = () => {};
}

// multichannel dialog
let multichannel_widgets = null;
function multichannel_close() {
	let m = 0;
	for (let i = 0; i < MAX_CHANNELS; i++) {
		channel_multi[i] = multichannel_widgets[i].d.state ? 1 : 0;
		if (channel_multi[i]) m = 1;
	}
	if (m) channel_multi_enabled = 1;
}
function multichannel_handle_key(k) {
	if (k.sym === KEYSYM.n) {
		if ((k.mod & KEYMOD.ALT) && k.state === KEY_PRESS) dialog_yes(null);
		else if (NO_MODIFIER(k.mod) && k.state === KEY_RELEASE) dialog_cancel(null);
		return 1;
	}
	return 0;
}
function multichannel_draw_const() {
	for (let i = 0; i < MAX_CHANNELS; i++)
		draw_text(`Channel ${String(i + 1).padStart(2, '0')}`, 9 + Math.trunc(i / 16) * 16, 22 + i % 16, 0, 2);
	for (let i = 0; i < 64; i += 16)
		draw_box(19 + (i / 16) * 16, 21, 23 + (i / 16) * 16, 38, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_text('Multichannel Selection', 29, 19, 3, 2);
}
function pattern_editor_display_multichannel() {
	multichannel_widgets = [];
	for (let i = 0; i < MAX_CHANNELS; i++) {
		const w = widget_create_toggle(20 + Math.trunc(i / 16) * 16, 22 + i % 16,
			i % 16 === 0 ? 64 : i - 1, i % 16 === 15 ? 64 : i + 1,
			i < 16 ? i + 48 : i - 16, (i + 16) % 64, (i + 16) % 64,
			() => widget_change_focus_to(ui.holder.selected_widget + 1));
		w.d.state = channel_multi[i] ? 1 : 0;
		multichannel_widgets.push(w);
	}
	multichannel_widgets.push(widget_create_button(36, 40, 6, 15, 0, 64, 64, 64, dialog_yes_NULL, 'OK', 3));
	const dialog = dialog_create_custom(7, 18, 66, 25, multichannel_widgets, MAX_CHANNELS + 1, 0, multichannel_draw_const, null);
	dialog.action_yes = multichannel_close;
	dialog.action_cancel = multichannel_close;
	dialog.handle_key = multichannel_handle_key;
}
function multichannel_get_next(cur) {
	cur--;
	let i = cur;
	if (channel_multi[cur]) {
		do { i = (i + 1) % MAX_CHANNELS; if (channel_multi[i]) break; } while (i !== cur);
	}
	return i + 1;
}
function multichannel_get_previous(cur) {
	cur--;
	let i = cur;
	if (channel_multi[cur]) {
		do { i = i ? i - 1 : MAX_CHANNELS - 1; if (channel_multi[i]) break; } while (i !== cur);
	}
	return i + 1;
}

// ------------------------------------------------------------------------
// system clipboard (ModPlug text format)

function modplug_encode_8bit(x) {
	return String.fromCharCode(48 + Math.trunc(x / 10)) + String(x % 10);
}
function pattern_selection_system_copyout() {
	if (!SELECTION_EXISTS()) return;
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	let s = 'Pasted Pattern - IT\r\n';
	for (let y = selection.first_row; y <= selection.last_row && y < total_rows; y++) {
		for (let x = selection.first_channel; x <= selection.last_channel; x++) {
			const n = at(p, y, x);
			s += '|';
			if (n.note === 0) s += '...';
			else if (n.note === C.NOTE_CUT) s += '^^^';
			else if (n.note === C.NOTE_OFF) s += '===';
			else if (n.note === C.NOTE_FADE) s += '~~~';
			else s += get_note_string(n.note);
			s += n.instrument ? modplug_encode_8bit(n.instrument) : '..';
			const vc = { 1: 'v', 2: 'p', 3: 'c', 4: 'd', 5: 'a', 6: 'b', 7: 'u', 8: 'h', 9: 'l', 10: 'r', 11: 'g', 12: 'f', 13: 'e' }[n.voleffect];
			s += vc ? vc + String(n.volparam % 100).padStart(2, '0') : '...';
			let e = get_effect_char(n.effect) + n.param.toString(16).toUpperCase().padStart(2, '0');
			if (e[0] === '.' || e[0] === '?') e = '.' + (n.param ? e.slice(1) : '..');
			s += e;
		}
		s += '\r\n';
	}
	last_copyout = s;
}
let last_copyout = '';
function clippy_yank() {
	if (!last_copyout) return;
	clippy_copy(last_copyout.replace(/[\x80-\xff]/g, '.'));
}

// ------------------------------------------------------------------------
// volume dialogs

let volume_setup_widgets = null;
function vol_widgets(max) {
	volume_setup_widgets = [
		widget_create_thumbbar(26, 30, 26, 0, 1, 1, null, 0, max),
		widget_create_button(31, 33, 6, 0, 1, 2, 2, 2, dialog_yes_NULL, 'OK', 3),
		widget_create_button(41, 33, 6, 0, 2, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
}
function fast_volume_toggle() {
	if (fast_volume_mode) {
		fast_volume_mode = 0;
		flash('Alt-I / Alt-J fast volume changes disabled');
		return;
	}
	volume_setup_widgets = [
		widget_create_thumbbar(33, 30, 11, 0, 1, 1, null, 10, 90),
		widget_create_button(31, 33, 6, 0, 1, 2, 2, 2, dialog_yes_NULL, 'OK', 3),
		widget_create_button(41, 33, 6, 0, 2, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
	volume_setup_widgets[0].d.value = fast_volume_percent;
	const dialog = dialog_create_custom(22, 25, 36, 11, volume_setup_widgets, 3, 0, () => {
		draw_text('Volume Amplification %', 29, 27, 0, 2);
		draw_box(32, 29, 44, 31, BOX_THIN | BOX_INNER | BOX_INSET);
	}, null);
	dialog.action_yes = () => {
		fast_volume_percent = volume_setup_widgets[0].d.value;
		fast_volume_mode = 1;
		flash('Alt-I / Alt-J fast volume changes enabled');
	};
	dialog.action_cancel = () => flash('Alt-I / Alt-J fast volume changes not enabled');
}
const fast_volume_amplify = () => selection_amplify(Math.trunc(100 * 100 / fast_volume_percent));
const fast_volume_attenuate = () => selection_amplify(fast_volume_percent);
function volume_amplify() {
	if (!CHECK_FOR_SELECTION()) return;
	vol_widgets(200);
	volume_setup_widgets[0].d.value = volume_percent;
	const dialog = dialog_create_custom(22, 25, 36, 11, volume_setup_widgets, 3, 0, () => {
		draw_text('Volume Amplification %', 29, 27, 0, 2);
		draw_box(25, 29, 52, 31, BOX_THIN | BOX_INNER | BOX_INSET);
	}, null);
	dialog.handle_key = k => {
		if (k.state === KEY_PRESS && (k.mod & KEYMOD.ALT) && k.sym === KEYSYM.j) { dialog_yes(null); return 1; }
		return 0;
	};
	dialog.action_yes = () => { volume_percent = volume_setup_widgets[0].d.value; selection_amplify(volume_percent); };
}
let current_vary = -1;
function vary_command(how) {
	vol_widgets(50);
	volume_setup_widgets[0].d.value = vary_depth;
	const dialog = dialog_create_custom(22, 25, 36, 11, volume_setup_widgets, 3, 0, () => {
		draw_text('Vary depth limit %', 31, 27, 0, 2);
		draw_box(25, 29, 52, 31, BOX_THIN | BOX_INNER | BOX_INSET);
	}, null);
	dialog.action_yes = () => { vary_depth = volume_setup_widgets[0].d.value; selection_vary(0, vary_depth, current_vary); };
	current_vary = how;
}
function current_effect() { return at(pattern(), current_row, current_channel).effect; }

// ------------------------------------------------------------------------
// selection

const is_in_selection = (chan, row) => SELECTION_EXISTS() && chan >= selection.first_channel
	&& chan <= selection.last_channel && row >= selection.first_row && row <= selection.last_row;
function normalise_block_selection() {
	if (!SELECTION_EXISTS()) return;
	if (selection.first_channel > selection.last_channel) [selection.first_channel, selection.last_channel] = [selection.last_channel, selection.first_channel];
	if (selection.first_row < 0) selection.first_row = 0;
	if (selection.last_row < 0) selection.last_row = 0;
	if (selection.first_channel < 1) selection.first_channel = 1;
	if (selection.last_channel < 1) selection.last_channel = 1;
	if (selection.first_row > selection.last_row) [selection.first_row, selection.last_row] = [selection.last_row, selection.first_row];
	pattern_selection_system_copyout();
}
function shift_selection_begin() {
	shift_selection.in_progress = 1;
	shift_selection.first_channel = current_channel;
	shift_selection.first_row = current_row;
}
function shift_selection_update() {
	if (shift_selection.in_progress) {
		selection.first_channel = shift_selection.first_channel;
		selection.last_channel = current_channel;
		selection.first_row = shift_selection.first_row;
		selection.last_row = current_row;
		normalise_block_selection();
	}
}
function shift_selection_end() { shift_selection.in_progress = 0; pattern_selection_system_copyout(); }
function selection_clear() { selection.first_channel = 0; pattern_selection_system_copyout(); }
function clip_selection(total_rows) {
	if (selection.last_row >= total_rows) selection.last_row = total_rows - 1;
	if (selection.first_row > selection.last_row) selection.first_row = selection.last_row;
}
const sel_hist = descr => pated_history_add(descr, selection.first_channel - 1, selection.first_row,
	selection.last_channel - selection.first_channel + 1, selection.last_row - selection.first_row + 1);
function for_selection(fn) {
	const p = pattern();
	for (let row = selection.first_row; row <= selection.last_row; row++)
		for (let chan = selection.first_channel; chan <= selection.last_channel; chan++) fn(at(p, row, chan), row, chan);
}

function block_length_double() {
	if (!SELECTION_EXISTS()) return;
	status.flags |= SONG_NEEDS_SAVE;
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	clip_selection(total_rows);
	const sel_rows = selection.last_row - selection.first_row + 1;
	const offset = selection.first_channel - 1, width = selection.last_channel - offset;
	const dest_end = Math.min(selection.first_row + 2 * sel_rows, total_rows);
	const height = dest_end - selection.first_row;
	const src_end = selection.first_row + Math.trunc(height / 2);
	let src = src_end - 1, dest = dest_end - 1;
	pated_history_add('Undo block length double       (Alt-F)', offset, selection.first_row, width, height);
	while (dest > src) {
		for (let c = 0; c < width; c++) clear_note(p[dest * 64 + offset + c]);
		dest--;
		for (let c = 0; c < width; c++) copy_note(p[dest * 64 + offset + c], p[src * 64 + offset + c]);
		dest--; src--;
	}
	pattern_selection_system_copyout();
}
function block_length_halve() {
	if (!SELECTION_EXISTS()) return;
	status.flags |= SONG_NEEDS_SAVE;
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	clip_selection(total_rows);
	const sel_rows = selection.last_row - selection.first_row + 1;
	const offset = selection.first_channel - 1, width = selection.last_channel - offset;
	const src_end = Math.min(selection.first_row + 2 * sel_rows, total_rows);
	const height = src_end - selection.first_row;
	let src = selection.first_row, dest = selection.first_row;
	pated_history_add('Undo block length halve        (Alt-G)', offset, selection.first_row, width, height);
	for (let row = 0; row < Math.trunc(height / 2); row++) {
		for (let c = 0; c < width; c++) copy_note(p[dest * 64 + offset + c], p[src * 64 + offset + c]);
		src += 2; dest++;
	}
	pattern_selection_system_copyout();
}
function selection_erase() {
	if (!SELECTION_EXISTS()) return;
	status.flags |= SONG_NEEDS_SAVE;
	clip_selection(song_get_pattern(current_pattern));
	sel_hist('Undo block cut                 (Alt-Z)');
	for_selection(n => clear_note(n));
	pattern_selection_system_copyout();
}
function selection_set_sample() {
	clip_selection(song_get_pattern(current_pattern));
	status.flags |= SONG_NEEDS_SAVE;
	sel_hist('Undo set sample/instrument     (Alt-S)');
	if (SELECTION_EXISTS()) for_selection(n => { if (n.instrument) n.instrument = song_get_current_instrument(); });
	else { const n = at(pattern(), current_row, current_channel); if (n.instrument) n.instrument = song_get_current_instrument(); }
	pattern_selection_system_copyout();
}
function selection_swap() {
	if (!CHECK_FOR_SELECTION()) return;
	status.flags |= SONG_NEEDS_SAVE;
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	clip_selection(total_rows);
	const sel_rows = selection.last_row - selection.first_row + 1;
	const sel_chans = selection.last_channel - selection.first_channel + 1;
	const affected_width = Math.max(selection.last_channel, current_channel + sel_chans - 1) - Math.min(selection.first_channel, current_channel) + 1;
	const affected_height = Math.max(selection.last_row, current_row + sel_rows - 1) - Math.min(selection.first_row, current_row) + 1;
	if (affected_width < 2 * sel_chans && affected_height < 2 * sel_rows) {
		dialog_create(DIALOG_OK, '   Swap blocks overlap    ', null, null, 0, null); return;
	}
	if (current_row + sel_rows > total_rows || current_channel + sel_chans - 1 > MAX_CHANNELS) {
		dialog_create(DIALOG_OK, '   Out of pattern range   ', null, null, 0, null); return;
	}
	pated_history_add('Undo swap block                (Alt-Y)', Math.min(selection.first_channel, current_channel) - 1,
		Math.min(selection.first_row, current_row), affected_width, affected_height);
	for (let row = 0; row < sel_rows; row++)
		for (let chan = 0; chan < sel_chans; chan++) {
			const s = at(p, selection.first_row + row, selection.first_channel + chan);
			const q = at(p, current_row + row, current_channel + chan);
			const t = { ...s }; copy_note(s, q); copy_note(q, t);
		}
	pattern_selection_system_copyout();
}
function selection_set_volume() {
	if (!CHECK_FOR_SELECTION()) return;
	status.flags |= SONG_NEEDS_SAVE;
	clip_selection(song_get_pattern(current_pattern));
	sel_hist('Undo set volume/panning        (Alt-V)');
	for_selection(n => { n.volparam = mask_note.volparam; n.voleffect = mask_note.voleffect; });
	pattern_selection_system_copyout();
}
function selection_slide_volume() {
	if (!CHECK_FOR_SELECTION()) return;
	const p = pattern();
	clip_selection(song_get_pattern(current_pattern));
	if (selection.first_row === selection.last_row) return;
	status.flags |= SONG_NEEDS_SAVE;
	sel_hist('Undo volume or panning slide   (Alt-K)');
	for (let chan = selection.first_channel; chan <= selection.last_channel; chan++) {
		const note = at(p, selection.first_row, chan), last_note = at(p, selection.last_row, chan);
		let ve = note.voleffect, lve = last_note.voleffect, first = note.volparam, last = last_note.volparam;
		if (ve === C.VOLFX_NONE) {
			if (note.instrument === 0) continue;
			ve = C.VOLFX_VOLUME; first = song_get_sample(note.instrument).volume >> 2;
		}
		if (lve === C.VOLFX_NONE) {
			if (last_note.instrument === 0) continue;
			lve = C.VOLFX_VOLUME; last = song_get_sample(last_note.instrument).volume >> 2;
		}
		if (!(ve === lve && (ve === C.VOLFX_VOLUME || ve === C.VOLFX_PANNING))) continue;
		for (let row = selection.first_row; row <= selection.last_row; row++) {
			const n = at(p, row, chan);
			n.voleffect = ve;
			n.volparam = Math.trunc((last - first) * (row - selection.first_row) / (selection.last_row - selection.first_row)) + first;
		}
	}
	pattern_selection_system_copyout();
}
function selection_wipe_volume(reckless) {
	if (!CHECK_FOR_SELECTION()) return;
	clip_selection(song_get_pattern(current_pattern));
	status.flags |= SONG_NEEDS_SAVE;
	sel_hist(reckless ? 'Recover volumes/pannings     (2*Alt-K)' : 'Replace extra volumes/pannings (Alt-W)');
	for_selection(n => { if (reckless || (n.instrument === 0 && !NOTE_IS_NOTE(n.note))) { n.volparam = 0; n.voleffect = C.VOLFX_NONE; } });
	pattern_selection_system_copyout();
}
function vary_value(ov, limit, depth) {
	let j = Math.trunc(limit * Math.random());
	j = (limit >> 1) - j;
	j = ov + Math.trunc((j * depth) / 100);
	return clamp(j, 0, limit);
}
function common_variable_group(ch) {
	switch (ch) {
	case C.FX_PORTAMENTODOWN: case C.FX_PORTAMENTOUP: case C.FX_TONEPORTAMENTO: return C.FX_TONEPORTAMENTO;
	case C.FX_VOLUMESLIDE: case C.FX_TONEPORTAVOL: case C.FX_VIBRATOVOL: return C.FX_VOLUMESLIDE;
	case C.FX_PANNING: case C.FX_PANNINGSLIDE: case C.FX_PANBRELLO: return C.FX_PANNING;
	default: return ch;
	}
}
const FX_IS_EFFECT = v => v > 0 && v < C.FX_MAX;
function selection_vary(fast, depth, how) {
	switch (how) {
	case C.FX_NONE: case C.FX_SPECIAL: case C.FX_SPEED: case C.FX_POSITIONJUMP: case C.FX_PATTERNBREAK:
	case C.FX_KEYOFF: case C.FX_SETENVPOSITION: case C.FX_VOLUME: case C.FX_NOTESLIDEUP: case C.FX_NOTESLIDEDOWN:
		return;
	default: if (!FX_IS_EFFECT(how)) return;
	}
	if (!CHECK_FOR_SELECTION()) return;
	status.flags |= SONG_NEEDS_SAVE;
	let vary_how;
	switch (how) {
	case C.FX_CHANNELVOLUME: case C.FX_CHANNELVOLSLIDE:
		vary_how = 'Undo volume-channel vary      (Ctrl-U)'; if (fast) flash('Fast volume vary'); break;
	case C.FX_PANNING: case C.FX_PANNINGSLIDE: case C.FX_PANBRELLO:
		vary_how = 'Undo panning vary             (Ctrl-Y)'; if (fast) flash('Fast panning vary'); break;
	default: {
		const s = 'Undo Xxx effect-value vary'.padEnd(28) + '  (Ctrl-K)';
		vary_how = s.slice(0, 5) + get_effect_char(common_variable_group(how)) + s.slice(6);
		if (fast) flash('Fast ' + vary_how.slice(5, 26));
	}
	}
	clip_selection(song_get_pattern(current_pattern));
	pated_history_add(vary_how, selection.first_channel - 1, selection.first_row,
		selection.last_channel - selection.first_channel + 1, selection.last_row - selection.first_row + 1);
	for_selection(note => {
		if ((how === C.FX_CHANNELVOLUME || how === C.FX_CHANNELVOLSLIDE) && note.voleffect === C.VOLFX_VOLUME)
			note.volparam = vary_value(note.volparam, 64, depth);
		if ((how === C.FX_PANNINGSLIDE || how === C.FX_PANNING || how === C.FX_PANBRELLO) && note.voleffect === C.VOLFX_PANNING)
			note.volparam = vary_value(note.volparam, 64, depth);
		const ch = note.effect;
		if (!FX_IS_EFFECT(ch)) return;
		if (common_variable_group(ch) !== common_variable_group(how)) return;
		const P = note.param;
		switch (ch) {
		case C.FX_VOLUMESLIDE: case C.FX_CHANNELVOLSLIDE: case C.FX_PANNINGSLIDE: case C.FX_GLOBALVOLSLIDE:
		case C.FX_VIBRATOVOL: case C.FX_TONEPORTAVOL:
			if ((P & 15) === 15 || (P & 0xf0) === 0xf0) return;
			if ((P & 15) === 0) note.param = ((1 + vary_value(P >> 4, 15, depth)) << 4) & 0xff;
			else note.param = (1 + vary_value(P & 15, 15, depth)) & 0xff;
			break;
		case C.FX_TEMPO:
			if ((P & 15) === 15 || (P & 0xf0) === 0xf0) return;
			note.param = (1 + vary_value(P, 255, depth)) & 0xff;
			break;
		case C.FX_PORTAMENTODOWN: case C.FX_PORTAMENTOUP:
			if ((P & 15) === 15 || (P & 15) === 14 || (P & 0xf0) === 0xf0 || (P & 0xf0) === 0xe0) return;
			note.param = (16 + vary_value(P - 16, 224, depth)) & 0xff;
			break;
		case C.FX_TONEPORTAMENTO: case C.FX_CHANNELVOLUME: case C.FX_OFFSET: case C.FX_GLOBALVOLUME: case C.FX_PANNING:
			note.param = (1 + vary_value(P, 255, depth)) & 0xff;
			break;
		case C.FX_VIBRATO: case C.FX_TREMOR: case C.FX_ARPEGGIO: case C.FX_RETRIG: case C.FX_TREMOLO:
		case C.FX_PANBRELLO: case C.FX_FINEVIBRATO:
			note.param = ((1 + vary_value(P & 15, 15, depth)) | ((1 + vary_value((P >> 4) & 15, 15, depth)) << 4)) & 0xff;
			break;
		}
	});
	pattern_selection_system_copyout();
}
function selection_amplify(percentage) {
	if (!SELECTION_EXISTS()) return;
	status.flags |= SONG_NEEDS_SAVE;
	clip_selection(song_get_pattern(current_pattern));
	sel_hist('Undo volume amplification      (Alt-J)');
	for_selection(note => {
		let volume;
		if (note.voleffect === C.VOLFX_NONE && note.instrument !== 0)
			volume = song_is_instrument_mode() ? 64 : song_get_sample(note.instrument).volume >> 2;
		else if (note.voleffect === C.VOLFX_VOLUME) volume = note.volparam;
		else return;
		volume = clamp(Math.trunc(volume * percentage / 100), 0, 64);
		note.volparam = volume;
		note.voleffect = C.VOLFX_VOLUME;
	});
	pattern_selection_system_copyout();
}
function selection_slide_effect() {
	if (!CHECK_FOR_SELECTION()) return;
	const p = pattern();
	clip_selection(song_get_pattern(current_pattern));
	if (selection.first_row === selection.last_row) return;
	status.flags |= SONG_NEEDS_SAVE;
	sel_hist('Undo effect data slide         (Alt-X)');
	for (let chan = selection.first_channel; chan <= selection.last_channel; chan++) {
		const first = at(p, selection.first_row, chan).param, last = at(p, selection.last_row, chan).param;
		for (let row = selection.first_row; row <= selection.last_row; row++)
			at(p, row, chan).param = (Math.trunc((last - first) * (row - selection.first_row) / (selection.last_row - selection.first_row)) + first) & 0xff;
	}
	pattern_selection_system_copyout();
}
function selection_wipe_effect() {
	if (!CHECK_FOR_SELECTION()) return;
	clip_selection(song_get_pattern(current_pattern));
	status.flags |= SONG_NEEDS_SAVE;
	sel_hist('Recover effects/effect data  (2*Alt-X)');
	for_selection(n => { n.effect = 0; n.param = 0; });
	pattern_selection_system_copyout();
}
const ROLL_DOWN = -1, ROLL_UP = 1;
function selection_roll(direction) {
	if (!SELECTION_EXISTS()) return;
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	if (selection.last_row >= total_rows) selection.last_row = total_rows - 1;
	selection.first_row = Math.min(selection.first_row, selection.last_row);
	const sel_rows = selection.last_row - selection.first_row + 1;
	const sel_chans = selection.last_channel - selection.first_channel + 1;
	if (sel_rows < 2) return;
	const base = r => MAX_CHANNELS * (selection.first_row + r) + selection.first_channel - 1;
	let row = direction === ROLL_DOWN ? sel_rows - 1 : 0;
	const temp = [];
	for (let c = 0; c < sel_chans; c++) temp.push({ ...p[base(row) + c] });
	for (let n = 1; n < sel_rows; n++, row += direction)
		for (let c = 0; c < sel_chans; c++) copy_note(p[base(row) + c], p[base(row + direction) + c]);
	for (let c = 0; c < sel_chans; c++) copy_note(p[base(row) + c], temp[c]);
	status.flags |= SONG_NEEDS_SAVE;
}

// row shifting
function pattern_insert_rows(what_row, num_rows, first_channel, chan_width) {
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	status.flags |= SONG_NEEDS_SAVE;
	if (first_channel < 1) first_channel = 1;
	if (chan_width + first_channel - 1 > MAX_CHANNELS) chan_width = MAX_CHANNELS - first_channel + 1;
	if (num_rows + what_row > total_rows) num_rows = total_rows - what_row;
	for (let row = total_rows - num_rows - 1; row >= what_row; row--)
		for (let c = 0; c < chan_width; c++) copy_note(p[MAX_CHANNELS * (row + num_rows) + first_channel - 1 + c], p[MAX_CHANNELS * row + first_channel - 1 + c]);
	for (let row = what_row; row < what_row + num_rows; row++)
		for (let c = 0; c < chan_width; c++) clear_note(p[MAX_CHANNELS * row + first_channel - 1 + c]);
	pattern_selection_system_copyout();
}
function pattern_delete_rows(what_row, num_rows, first_channel, chan_width) {
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	status.flags |= SONG_NEEDS_SAVE;
	if (first_channel < 1) first_channel = 1;
	if (chan_width + first_channel - 1 > MAX_CHANNELS) chan_width = MAX_CHANNELS - first_channel + 1;
	if (num_rows + what_row > total_rows) num_rows = total_rows - what_row;
	for (let row = what_row; row <= total_rows - num_rows - 1; row++)
		for (let c = 0; c < chan_width; c++) copy_note(p[MAX_CHANNELS * row + first_channel - 1 + c], p[MAX_CHANNELS * (row + num_rows) + first_channel - 1 + c]);
	for (let row = total_rows - num_rows; row < total_rows; row++)
		for (let c = 0; c < chan_width; c++) clear_note(p[MAX_CHANNELS * row + first_channel - 1 + c]);
	pattern_selection_system_copyout();
}

// ------------------------------------------------------------------------
// history / undo

function pated_history_clear() {
	for (let i = 0; i < 10; i++) Object.assign(undo_history[i], make_snap('Empty'));
}
function set_note_note(n, a, b) {
	if (a > 0 && a < 250) { a += b; if (a <= 0 || a >= 250) a = 0; }
	n.note = a;
}
function snap_paste(s, x, y, xlate) {
	status.flags |= SONG_NEEDS_SAVE;
	if (x < 0) x = s.x;
	if (y < 0) y = s.y;
	const p = pattern();
	let num_rows = song_get_pattern(current_pattern) - y;
	if (s.rows < num_rows) num_rows = s.rows;
	if (num_rows <= 0) return;
	let chan_width = s.channels;
	if (chan_width + x >= MAX_CHANNELS) chan_width = MAX_CHANNELS - x;
	for (let row = 0; row < num_rows; row++) {
		for (let chan = 0; chan < chan_width; chan++) {
			const d = p[MAX_CHANNELS * (y + row) + x + chan];
			copy_note(d, s.data[s.channels * row + chan]);
			if (xlate) set_note_note(d, d.note, xlate);
		}
	}
	pattern_selection_system_copyout();
}
function snap_copy(s, x, y, width, height) {
	const p = pattern(), total_rows = song_get_pattern(current_pattern);
	s.channels = width; s.rows = height;
	s.data = Array.from({ length: width * height }, blank);
	s.x = x; s.y = y;
	for (let row = 0; row < s.rows && row + y < total_rows; row++)
		for (let c = 0; c < width; c++) copy_note(s.data[width * row + c], p[MAX_CHANNELS * (row + y) + x + c]);
}
function snap_honor_mute(s, base_channel) {
	let did_any = 0;
	for (let i = 0; i < s.channels; i++) {
		if (!(song_get_channel(i + base_channel).flags & C.CHN_MUTE)) continue;
		for (let j = 0; j < s.rows; j++) { clear_note(s.data[j * s.channels + i]); did_any = 1; }
	}
	return did_any;
}
function pated_history_restore(n) { if (n >= 0 && n <= 9) snap_paste(undo_history[n], -1, -1, 0); }
function pated_save(descr) { pated_history_add(descr, 0, 0, MAX_CHANNELS, song_get_pattern(current_pattern)); }
function pated_history_add(descr, x, y, w, h) { pated_history_add2(0, descr, x, y, w, h); }
function pated_history_add_grouped(descr, x, y, w, h) { pated_history_add2(1, descr, x, y, w, h); }
function pated_history_add2(groupedf, descr, x, y, width, height) {
	let j = undo_history_top;
	const u = undo_history[j];
	if (groupedf && u.patternno === current_pattern && u.x === x && u.y === y && u.channels === width
		&& u.rows === height && u.snap_op === descr) return;
	j = (undo_history_top + 1) % 10;
	snap_copy(undo_history[j], x, y, width, height);
	undo_history[j].snap_op = descr;
	undo_history[j].patternno = current_pattern;
	undo_history_top = j;
}
function fast_save_update() { snap_copy(fast_save, 0, 0, MAX_CHANNELS, song_get_pattern(current_pattern)); }

// clipboard
function clipboard_free() { clipboard.data = null; }
function clipboard_copy(honor_mute) {
	if (!CHECK_FOR_SELECTION()) return;
	clipboard_free();
	snap_copy(clipboard, selection.first_channel - 1, selection.first_row,
		selection.last_channel - selection.first_channel + 1, selection.last_row - selection.first_row + 1);
	const flag = honor_mute ? snap_honor_mute(clipboard, selection.first_channel - 1) : 0;
	pattern_selection_system_copyout();
	clippy_yank();
	if (flag) flash('Selection honors current mute settings');
}
function no_clipboard() {
	if (clipboard.data) return false;
	dialog_create(DIALOG_OK, 'No data in clipboard', null, null, 0, null);
	return true;
}
function clipboard_paste_overwrite(suppress, grow) {
	if (no_clipboard()) return;
	let num_rows = song_get_pattern(current_pattern) - current_row;
	if (clipboard.rows < num_rows) num_rows = clipboard.rows;
	if (clipboard.rows > num_rows && grow) {
		if (current_row + clipboard.rows > 200) {
			flash(`Resized pattern ${current_pattern}, but clipped to 200 rows`);
			song_pattern_resize(current_pattern, 200);
		} else {
			flash(`Resized pattern ${current_pattern} to ${current_row + clipboard.rows} rows`);
			song_pattern_resize(current_pattern, current_row + clipboard.rows);
		}
	}
	let chan_width = clipboard.channels;
	if (chan_width + current_channel > MAX_CHANNELS) chan_width = MAX_CHANNELS - current_channel + 1;
	if (!suppress) pated_history_add_grouped('Replace overwritten data       (Alt-O)', current_channel - 1, current_row, chan_width, num_rows);
	snap_paste(clipboard, current_channel - 1, current_row, 0);
}
function clipboard_paste_insert() {
	if (no_clipboard()) return;
	pated_save('Undo paste data                (Alt-P)');
	let chan_width = clipboard.channels;
	if (chan_width + current_channel > MAX_CHANNELS) chan_width = MAX_CHANNELS - current_channel + 1;
	pattern_insert_rows(current_row, clipboard.rows, current_channel, chan_width);
	clipboard_paste_overwrite(1, 0);
	pattern_selection_system_copyout();
}
function clipboard_paste_mix_notes(clip, xlate) {
	if (no_clipboard()) return;
	status.flags |= SONG_NEEDS_SAVE;
	const p = pattern();
	let num_rows = song_get_pattern(current_pattern) - current_row;
	if (clipboard.rows < num_rows) num_rows = clipboard.rows;
	let chan_width = clipboard.channels;
	if (chan_width + current_channel > MAX_CHANNELS) chan_width = MAX_CHANNELS - current_channel + 1;
	pated_history_add_grouped('Replace mixed data             (Alt-M)', current_channel - 1, current_row, chan_width, num_rows);
	for (let row = 0; row < num_rows; row++) {
		for (let chan = 0; chan < chan_width; chan++) {
			const pn = at(p, current_row + row, current_channel + chan), cn = clipboard.data[row * clipboard.channels + chan];
			if (!note_eq(pn, blank_note)) continue;
			copy_note(pn, cn);
			set_note_note(pn, cn.note, xlate);
			if (clip) {
				pn.instrument = song_get_current_instrument();
				if (edit_copy_mask & MASK_VOLUME) { pn.voleffect = mask_note.voleffect; pn.volparam = mask_note.volparam; }
				else { pn.voleffect = 0; pn.volparam = 0; }
				if (edit_copy_mask & MASK_EFFECT) { pn.effect = mask_note.effect; pn.param = mask_note.param; }
			}
		}
	}
}
function clipboard_paste_mix_fields(prec, xlate) {
	if (no_clipboard()) return;
	status.flags |= SONG_NEEDS_SAVE;
	const p = pattern();
	let num_rows = song_get_pattern(current_pattern) - current_row;
	if (clipboard.rows < num_rows) num_rows = clipboard.rows;
	let chan_width = clipboard.channels;
	if (chan_width + current_channel > MAX_CHANNELS) chan_width = MAX_CHANNELS - current_channel + 1;
	for (let row = 0; row < num_rows; row++) {
		for (let chan = 0; chan < chan_width; chan++) {
			const pn = at(p, current_row + row, current_channel + chan), cn = clipboard.data[row * clipboard.channels + chan];
			if (prec) {
				if (cn.note !== 0) set_note_note(pn, cn.note, xlate);
				if (cn.instrument !== 0) pn.instrument = cn.instrument;
				if (cn.voleffect !== C.VOLFX_NONE) { pn.voleffect = cn.voleffect; pn.volparam = cn.volparam; }
				if (cn.effect !== 0) pn.effect = cn.effect;
				if (cn.param !== 0) pn.param = cn.param;
			} else {
				if (pn.note === 0) set_note_note(pn, cn.note, xlate);
				if (pn.instrument === 0) pn.instrument = cn.instrument;
				if (pn.voleffect === C.VOLFX_NONE) { pn.voleffect = cn.voleffect; pn.volparam = cn.volparam; }
				if (pn.effect === 0) pn.effect = cn.effect;
				if (pn.param === 0) pn.param = cn.param;
			}
		}
	}
}

// ------------------------------------------------------------------------

function pattern_editor_reposition() {
	const max_row_number = song_get_max_row_number_in_pattern(current_pattern);
	if (current_channel < top_display_channel) top_display_channel = current_channel;
	else if (current_channel >= top_display_channel + visible_channels) top_display_channel = current_channel - visible_channels + 1;
	if (centralise_cursor) {
		if (current_row <= 16) top_display_row = 0;
		else if (current_row + 15 > max_row_number) top_display_row = max_row_number - 31;
		else top_display_row = current_row - 16;
	} else {
		if (current_row < top_display_row) top_display_row = current_row;
		else if (current_row > top_display_row + 31) top_display_row = current_row - 31;
		if (top_display_row + 31 > max_row_number) top_display_row = max_row_number - 31;
	}
	if (top_display_row < 0) top_display_row = 0;
}
function advance_cursor(next_row, multichannel) {
	if (next_row && !(SONG_PLAYING() && tracker.playback_tracing)) {
		const max_row_number = song_get_max_row_number_in_pattern(current_pattern);
		if (skip_value) {
			if (current_row + skip_value <= max_row_number) { current_row += skip_value; pattern_editor_reposition(); }
		} else if (!(multichannel && channel_multi[current_channel - 1])) {
			if (current_channel < MAX_CHANNELS) current_channel++;
			else { current_channel = 1; if (current_row < max_row_number) current_row++; }
			pattern_editor_reposition();
		}
	}
	if (multichannel) current_channel = multichannel_get_next(current_channel);
}

export function update_current_row() {
	draw_text(str_from_num(3, current_row), 12, 7, 5, 0);
	draw_text(str_from_num(3, song_get_max_row_number_in_pattern(current_pattern)), 16, 7, 5, 0);
}
export const get_current_channel = () => current_channel;
export function set_current_channel(channel) { current_channel = clamp(channel, 0, MAX_CHANNELS); }
export const get_current_row = () => current_row;
export function set_current_row(row) {
	current_row = clamp(row, 0, song_get_max_row_number_in_pattern(current_pattern));
	if (current_row < 0) current_row = 0;
	pattern_editor_reposition();
	status.flags |= NEED_UPDATE;
}
export function update_current_pattern() {
	draw_text(str_from_num(3, current_pattern), 12, 6, 5, 0);
	draw_text(str_from_num(3, csf_get_num_patterns(current_song) - 1), 16, 6, 5, 0);
}
export const get_current_pattern = () => current_pattern;
export function set_current_pattern(n) {
	current_pattern = clamp(n, 0, 199);
	const max_row_number = song_get_max_row_number_in_pattern(current_pattern);
	if (current_row > max_row_number) current_row = max_row_number;
	if (SELECTION_EXISTS()) {
		if (selection.first_row > max_row_number) selection.first_row = selection.last_row = max_row_number;
		else if (selection.last_row > max_row_number) selection.last_row = max_row_number;
	}
	pated_save(`Pattern ${current_pattern}`);
	fast_save_update();
	pattern_editor_reposition();
	pattern_selection_system_copyout();
	status.flags |= NEED_UPDATE;
}

function set_playback_mark() {
	if (marked_pattern === current_pattern && marked_row === current_row) marked_pattern = -1;
	else { marked_pattern = current_pattern; marked_row = current_row; }
}
export function play_song_from_mark_orderpan() {
	if (marked_pattern === -1) song_start_at_order(app.get_current_order(), current_row);
	else song_start_at_pattern(marked_pattern, marked_row);
}
export function play_song_from_mark() {
	if (marked_pattern !== -1) { song_start_at_pattern(marked_pattern, marked_row); return; }
	let new_order = app.get_current_order();
	for (const start of [new_order, 0]) {
		for (new_order = start; new_order < 255; new_order++) {
			if (current_song.orderlist[new_order] === current_pattern) {
				app.set_current_order(new_order);
				song_start_at_order(new_order, current_row);
				return;
			}
		}
	}
	song_start_at_pattern(current_pattern, current_row);
}

function recalculate_visible_area() {
	let n, last = 0;
	visible_width = 0;
	for (n = 0; n < MAX_CHANNELS; n++) {
		if (track_view_scheme[n] >= NUM_TRACK_VIEWS) track_view_scheme[n] = last;
		else last = track_view_scheme[n];
		const new_width = visible_width + track_views[track_view_scheme[n]].width;
		if (new_width > 72) break;
		visible_width = new_width;
		if (draw_divisions) visible_width++;
	}
	if (draw_divisions) visible_width--;
	visible_channels = n;
	if (top_display_channel > MAX_CHANNELS - visible_channels + 1) top_display_channel = MAX_CHANNELS - visible_channels + 1;
}
function set_view_scheme(scheme) {
	if (scheme >= NUM_TRACK_VIEWS) scheme = 0;
	track_view_scheme.fill(scheme);
	recalculate_visible_area();
}

function pattern_editor_redraw() {
	let chan_drawpos = 5;
	const mc = (status.flags & INVERTED_PALETTE) ? 1 : 3;
	const pattern_is_playing = SONG_PLAYING() && current_pattern === playing_pattern;
	if (template_mode) draw_text_len(template_mode_names[template_mode], 60, 2, 12, 3, 2);
	draw_box(4, 14, 5 + visible_width, 47, BOX_THICK | BOX_INNER | BOX_INSET);
	const total_rows = song_get_pattern(current_pattern), p = pattern();
	for (let chan = top_display_channel, chan_pos = 0; chan_pos < visible_channels; chan++, chan_pos++) {
		const tv = track_views[track_view_scheme[chan_pos]];
		tv.draw_channel_header(chan, chan_drawpos, 14, (song_get_channel(chan - 1).flags & C.CHN_MUTE) ? 0 : 3);
		let row, row_pos, fg, bg;
		for (row = top_display_row, row_pos = 0; row_pos < 32 && row < total_rows; row++, row_pos++) {
			const note = at(p, row, chan);
			if (chan_pos === 0) {
				fg = pattern_is_playing && row === playing_row ? 3 : 0;
				bg = (current_pattern === marked_pattern && row === marked_row) ? 11 : 2;
				draw_text(str_from_num(3, row), 1, 15 + row_pos, fg, bg);
			}
			if (is_in_selection(chan, row)) {
				fg = 3; bg = ROW_IS_HIGHLIGHT(row) ? 9 : 8;
			} else {
				fg = ((status.flags & (CRAYOLA_MODE | CLASSIC_MODE)) === CRAYOLA_MODE) ? ((note.instrument + 3) % 4 + 3) : 6;
				if (highlight_current_row && row === current_row) bg = 1;
				else if (ROW_IS_MAJOR(row)) bg = 14;
				else if (ROW_IS_MINOR(row)) bg = 15;
				else bg = 0;
			}
			let cpos;
			if (row === current_row && ((current_position > 0 || template_mode === TEMPLATE_OFF || (status.keymod & KEYMOD.SHIFT))
				? chan === current_channel
				: (chan >= current_channel && chan < current_channel + (clipboard.data ? clipboard.channels : 1)))) {
				cpos = current_position;
				if (cpos === 6 && link_effect_column && !(status.flags & CLASSIC_MODE)) cpos = 9;
			} else cpos = -1;
			tv.draw_note(chan_drawpos, 15 + row_pos, note, cpos, fg, bg);
			if (draw_divisions && chan_pos < visible_channels - 1) {
				if (is_in_selection(chan, row)) bg = 0;
				draw_char(168, chan_drawpos + tv.width, 15 + row_pos, 2, bg);
			}
		}
		for (; row_pos < 32; row++, row_pos++) {
			bg = ROW_IS_MAJOR(row) ? 14 : ROW_IS_MINOR(row) ? 15 : 0;
			tv.draw_note(chan_drawpos, 15 + row_pos, blank_note, -1, 6, bg);
			if (draw_divisions && chan_pos < visible_channels - 1) draw_char(168, chan_drawpos + tv.width, 15 + row_pos, 2, bg);
		}
		if (chan === current_channel) tv.draw_mask(chan_drawpos, 47, edit_copy_mask, current_position, mc, 2);
		if (channel_multi[chan - 1]) {
			const sch = track_view_scheme[chan_pos];
			if (sch === 0) draw_char(172, chan_drawpos + 3, 47, mc, 2);
			else if (sch < 3) draw_char(172, chan_drawpos + 2, 47, mc, 2);
			else if (sch === 3) draw_char(172, chan_drawpos + 1, 47, mc, 2);
			else if (current_position < 2) draw_char(172, chan_drawpos, 47, mc, 2);
		}
		chan_drawpos += tv.width + (draw_divisions ? 1 : 0);
	}
}

// ------------------------------------------------------------------------

function transpose_notes(amount) {
	status.flags |= SONG_NEEDS_SAVE;
	pated_history_add_grouped(amount > 0 ? 'Undo transposition up          (Alt-Q)' : 'Undo transposition down        (Alt-A)',
		selection.first_channel - 1, selection.first_row,
		selection.last_channel - selection.first_channel + 1, selection.last_row - selection.first_row + 1);
	const t = n => { if (n.note > 0 && n.note < 121) n.note = clamp(n.note + amount, 1, 120); };
	if (SELECTION_EXISTS()) for_selection(t);
	else t(at(pattern(), current_row, current_channel));
	pattern_selection_system_copyout();
}
function copy_note_to_mask() {
	const p = pattern(), num_rows = song_get_pattern(current_pattern);
	let row = current_row, note = at(p, row, current_channel);
	mask_note = { ...note };
	if (mask_copy_search_mode !== COPY_INST_OFF) {
		while (!note.instrument && row > 0) { row--; note = at(p, row, current_channel); }
		if (mask_copy_search_mode === COPY_INST_UP_THEN_DOWN && !note.instrument) {
			row = current_row; note = at(p, row, current_channel);
			while (!note.instrument && row < num_rows - 1) { row++; note = at(p, row, current_channel); }
		}
	}
	if (note.instrument) {
		if (song_is_instrument_mode()) app.instrument_set(note.instrument);
		else app.sample_set(note.instrument);
	}
}

function handle_volume(note, k, pos) {
	let vol = note.volparam, fx = note.voleffect;
	const vp = panning_mode ? C.VOLFX_PANNING : C.VOLFX_VOLUME;
	const q = kbd_char_to_hex(k);
	if (pos === 0) {
		const letters = { [KEYSYM.a]: C.VOLFX_FINEVOLUP, [KEYSYM.b]: C.VOLFX_FINEVOLDOWN, [KEYSYM.c]: C.VOLFX_VOLSLIDEUP,
			[KEYSYM.d]: C.VOLFX_VOLSLIDEDOWN, [KEYSYM.e]: C.VOLFX_PORTADOWN, [KEYSYM.f]: C.VOLFX_PORTAUP,
			[KEYSYM.g]: C.VOLFX_TONEPORTAMENTO, [KEYSYM.h]: C.VOLFX_VIBRATODEPTH };
		const extra = { [KEYSYM.DOLLAR]: C.VOLFX_VIBRATOSPEED, [KEYSYM.LESS]: C.VOLFX_PANSLIDELEFT, [KEYSYM.GREATER]: C.VOLFX_PANSLIDERIGHT };
		if (q >= 0 && q <= 9) { vol = q * 10 + vol % 10; fx = vp; }
		else if (k.sym in letters) { fx = letters[k.sym]; vol %= 10; }
		else if (status.flags & CLASSIC_MODE) return 0;
		else if (k.sym in extra) { fx = extra[k.sym]; vol %= 10; }
		else return 0;
	} else {
		if (q >= 0 && q <= 9) {
			vol = Math.trunc(vol / 10) * 10 + q;
			if (fx === C.VOLFX_NONE || fx === C.VOLFX_VOLUME || fx === C.VOLFX_PANNING) fx = vp;
		} else return 0;
	}
	note.voleffect = fx;
	note.volparam = (fx === C.VOLFX_VOLUME || fx === C.VOLFX_PANNING) ? clamp(vol, 0, 64) : clamp(vol, 0, 9);
	return 1;
}
function seek_done() {
	const note = at(pattern(), current_row, current_channel);
	switch (current_position) {
	case 0: case 1: return note.note !== 0;
	case 2: case 3: return note.instrument !== 0;
	case 4: case 5: return note.voleffect || note.volparam;
	case 6: case 7: case 8: return note.effect !== 0;
	}
	return 1;
}

let template_error_widgets = null;
function patedit_record_note(cur_note, channel, row, note, force) {
	let r = 1;
	status.flags |= SONG_NEEDS_SAVE;
	if (NOTE_IS_NOTE(note)) {
		if (template_mode) {
			const q = clipboard.data && clipboard.data[0];
			if (clipboard.channels < 1 || clipboard.rows < 1 || !clipboard.data) {
				dialog_create(DIALOG_OK, 'No data in clipboard', null, null, 0, null);
				r = 0;
			} else if (!q.note) {
				template_error_widgets = [widget_create_button(36, 32, 6, 0, 0, 0, 0, 0, dialog_yes_NULL, 'OK', 3)];
				dialog_create_custom(20, 23, 40, 12, template_error_widgets, 1, 0, template_error_draw, null);
				r = 0;
			} else {
				const i = note - q.note;
				switch (template_mode) {
				case TEMPLATE_OVERWRITE: snap_paste(clipboard, current_channel - 1, current_row, i); break;
				case TEMPLATE_MIX_PATTERN_PRECEDENCE: clipboard_paste_mix_fields(0, i); break;
				case TEMPLATE_MIX_CLIPBOARD_PRECEDENCE: clipboard_paste_mix_fields(1, i); break;
				case TEMPLATE_NOTES_ONLY: clipboard_paste_mix_notes(1, i); break;
				}
			}
		} else cur_note.note = note;
	} else {
		const channels = (template_mode && clipboard.data && clipboard.rows === 1) ? clipboard.channels : 1;
		const p = pattern();
		for (let i = 0; i < channels && i + channel <= MAX_CHANNELS; i++) {
			const n = i ? p[MAX_CHANNELS * row + channel - 1 + i] : cur_note;
			if (!force && n.note) continue;
			n.note = note;
			if (edit_copy_mask & MASK_INSTRUMENT) n.instrument = 0;
			if (edit_copy_mask & MASK_VOLUME) { n.voleffect = 0; n.volparam = 0; }
			if (edit_copy_mask & MASK_EFFECT) { n.effect = 0; n.param = 0; }
		}
	}
	pattern_selection_system_copyout();
	return r;
}

// page_patedit.c: pattern_editor_insert_midi
let midi_start_record = 0;
export const midi_last_bend_hit = new Int32Array(MAX_CHANNELS);
function pattern_editor_insert_midi(k) {
	let cur_note = null, n, v = 0, pd, offset = 0, quantize_next_row = 0;
	let r = current_row, c = current_channel;
	const p0 = current_pattern;
	let ins = KEYJAZZ_NOINST, smp = KEYJAZZ_NOINST;
	const song_was_playing = SONG_PLAYING();
	if (song_is_instrument_mode()) ins = app.instrument_get_current();
	else smp = app.sample_get_current();
	status.flags |= SONG_NEEDS_SAVE;
	const speed = song_get_current_speed();
	let tick = song_get_current_tick();
	if (midi_start_record && !SONG_PLAYING()) {
		if (midi_start_record === 1) song_loop_pattern(p0, r);
		else song_start_at_pattern(p0, r);
		tracker.midi_playback_tracing = tracker.playback_tracing;
		tracker.playback_tracing = 1;
	}
	if ((midi.flags & MIDI_TICK_QUANTIZE) && song_was_playing && tracker.playback_tracing && tick > 0 && tick <= Math.trunc(speed / 2) + 1) {
		offset++;
		quantize_next_row = 1;
	}
	const off = song_get_pattern_offset(p0, r, offset); // [length, pattern number, row]
	if (!off[0]) return 0;
	const pattern = song_get_pattern_buf(off[1]);
	r = off[2];
	if (!pattern) return 0;
	if (k.midi_note === -1) {
		/* nada */
	} else if (k.state === KEY_RELEASE) {
		c = song_keyup(KEYJAZZ_NOINST, KEYJAZZ_NOINST, k.midi_note);
		if (c <= 0) return 0;
		if (!((midi.flags & MIDI_RECORD_NOTEOFF) && (song_get_mode() & (MODE_PLAYING | MODE_PATTERN_LOOP)) && tracker.playback_tracing)) return 0;
		cur_note = pattern[MAX_CHANNELS * r + (c - 1)];
		patedit_record_note(cur_note, c, r, C.NOTE_OFF, 0);
	} else {
		v = k.midi_volume > -1 ? k.midi_volume >> 1 : 0;
		if (!((song_get_mode() & (MODE_PLAYING | MODE_PATTERN_LOOP)) && tracker.playback_tracing)) tick = 0;
		n = k.midi_note;
		if (!quantize_next_row) c = song_keydown(smp, ins, n, v, c);
		cur_note = pattern[MAX_CHANNELS * r + (c - 1)];
		patedit_record_note(cur_note, c, r, n, 0);
		if (!template_mode) {
			cur_note.instrument = song_get_current_instrument();
			if (midi.flags & MIDI_RECORD_VELOCITY) { cur_note.voleffect = C.VOLFX_VOLUME; cur_note.volparam = v; }
			tick %= speed;
			if (!(midi.flags & MIDI_TICK_QUANTIZE) && !cur_note.effect && tick !== 0) {
				cur_note.effect = C.FX_SPECIAL;
				cur_note.param = 0xd0 | Math.min(tick, 15);
			}
		}
	}
	if (!(midi.flags & MIDI_PITCHBEND) || midi.pitch_depth === 0 || k.midi_bend === 0) {
		if (k.state === KEY_RELEASE && k.midi_note > -1 && cur_note && cur_note.instrument > 0) {
			song_keyrecord(cur_note.instrument, cur_note.instrument, cur_note.note, v, c + 1, cur_note.effect, cur_note.param);
			pattern_selection_system_copyout();
		}
		return -1;
	}
	for (c = 0; c < MAX_CHANNELS; c++) {
		if ((channel_multi[c] & 1) && (channel_multi[c] & ~1)) {
			cur_note = pattern[MAX_CHANNELS * r + c];
			if (cur_note.effect) {
				if (cur_note.effect !== C.FX_PORTAMENTOUP && cur_note.effect !== C.FX_PORTAMENTODOWN) continue;
				pd = midi_last_bend_hit[c];
			} else {
				pd = midi_last_bend_hit[c];
				midi_last_bend_hit[c] = k.midi_bend;
			}
			pd = Math.trunc(Math.trunc((k.midi_bend - pd) * midi.pitch_depth / 8192) * speed / 2);
			pd = Math.max(-0x7f, Math.min(0x7f, pd));
			if (pd < 0) { cur_note.effect = C.FX_PORTAMENTODOWN; cur_note.param = -pd; }
			else if (pd > 0) { cur_note.effect = C.FX_PORTAMENTOUP; cur_note.param = pd; }
			if (k.midi_note === -1 || k.state === KEY_RELEASE) continue;
			if (cur_note.instrument < 1) continue;
			v = cur_note.voleffect === C.VOLFX_VOLUME ? cur_note.volparam : -1;
			song_keyrecord(cur_note.instrument, cur_note.instrument, cur_note.note, v, c + 1, cur_note.effect, cur_note.param);
		}
	}
	pattern_selection_system_copyout();
	return -1;
}

function pattern_editor_insert(k) {
	const p = pattern();
	let ins, smp, j, n, vol;
	if (k.state === KEY_RELEASE && current_position) return 0;
	let cur_note = at(p, current_row, current_channel);
	switch (current_position) {
	case 0: {
		smp = ins = cur_note.instrument;
		if (song_is_instrument_mode()) smp = KEYJAZZ_NOINST; else ins = KEYJAZZ_NOINST;
		if (k.sym === KEYSYM['4']) {
			if (k.state === KEY_RELEASE) return 0;
			vol = cur_note.voleffect === C.VOLFX_VOLUME ? cur_note.volparam : KEYJAZZ_DEFAULTVOL;
			song_keyrecord(smp, ins, cur_note.note, vol, current_channel, cur_note.effect, cur_note.param);
			advance_cursor(!(k.mod & KEYMOD.SHIFT), 1);
			return 1;
		} else if (k.sym === KEYSYM['8']) {
			if (k.state === KEY_RELEASE) return 0;
			song_single_step(current_pattern, current_row);
			advance_cursor(!(k.mod & KEYMOD.SHIFT), 0);
			return 1;
		}
		if (song_is_instrument_mode()) { if (edit_copy_mask & MASK_INSTRUMENT) ins = app.instrument_get_current(); }
		else if (edit_copy_mask & MASK_INSTRUMENT) smp = app.sample_get_current();
		if (k.sym === KEYSYM.SPACE) {
			n = mask_note.note;
			vol = ((edit_copy_mask & MASK_VOLUME) && cur_note.voleffect === C.VOLFX_VOLUME) ? mask_note.volparam : KEYJAZZ_DEFAULTVOL;
		} else {
			n = kbd_get_note(k);
			if (n < 0) return 0;
			if ((edit_copy_mask & MASK_VOLUME) && mask_note.voleffect === C.VOLFX_VOLUME) vol = mask_note.volparam;
			else if (cur_note.voleffect === C.VOLFX_VOLUME) vol = cur_note.volparam;
			else vol = KEYJAZZ_DEFAULTVOL;
		}
		if (k.state === KEY_RELEASE) {
			if (keyjazz_noteoff && NOTE_IS_NOTE(n)) song_keyup(smp, ins, n);
			if (keyjazz_write_noteoff && tracker.playback_tracing && NOTE_IS_NOTE(n)) {
				if (cur_note.note) {
					if (++current_row > song_get_max_row_number_in_pattern(current_pattern)) return 1;
					cur_note = at(p, current_row, current_channel);
					if (cur_note.note) return 1;
				}
				n = C.NOTE_OFF;
			} else return 1;
		}
		if (k.is_repeat && !keyjazz_repeat) return 1;
		let writenote = keyjazz_capslock ? !(k.mod & KEYMOD.CAPS) : !(k.mod & KEYMOD.CAPS_PRESSED);
		if (writenote && !patedit_record_note(cur_note, current_channel, current_row, n, 1)) { writenote = 0; n = C.NOTE_NONE; }
		if (NOTE_IS_NOTE(n) && !(template_mode && writenote)) song_keydown(smp, ins, n, vol, current_channel);
		if (!writenote) break;
		if (!(NOTE_IS_CONTROL(n) || (k.sym !== KEYSYM.SPACE && n === C.NOTE_NONE)) && !template_mode) {
			if (edit_copy_mask & MASK_INSTRUMENT)
				cur_note.instrument = song_is_instrument_mode() ? app.instrument_get_current() : app.sample_get_current();
			if (edit_copy_mask & MASK_VOLUME) { cur_note.voleffect = mask_note.voleffect; cur_note.volparam = mask_note.volparam; }
			if (edit_copy_mask & MASK_EFFECT) { cur_note.effect = mask_note.effect; cur_note.param = mask_note.param; }
		}
		if (NOTE_IS_NOTE(n) && !template_mode) song_keyrecord(smp, ins, n, vol, current_channel, cur_note.effect, cur_note.param);
		mask_note.note = n;
		pattern_selection_system_copyout();
		if (k.mod & KEYMOD.SHIFT) {
			if (current_channel < MAX_CHANNELS) { shift_chord_channels++; current_channel++; pattern_editor_reposition(); }
		} else advance_cursor(1, 1);
		break;
	}
	case 1:
		j = kbd_char_to_hex(k);
		if (j < 0 || j > 9) return 0;
		n = cur_note.note;
		if (n > 0 && n <= 120) cur_note.note = ((n - 1) % 12) + 12 * j + 1;
		advance_cursor(1, 0);
		status.flags |= SONG_NEEDS_SAVE;
		pattern_selection_system_copyout();
		break;
	case 2: case 3:
		if (k.sym === KEYSYM.SPACE) {
			n = song_is_instrument_mode() ? app.instrument_get_current() : app.sample_get_current();
			if (n && !(status.flags & CLASSIC_MODE)) current_song.voices[current_channel - 1].last_instrument = n;
			cur_note.instrument = n;
			advance_cursor(1, 0);
			status.flags |= SONG_NEEDS_SAVE;
			break;
		}
		if (kbd_get_note(k) === 0) {
			cur_note.instrument = 0;
			if (song_is_instrument_mode()) app.instrument_set(0); else app.sample_set(0);
			advance_cursor(1, 0);
			status.flags |= SONG_NEEDS_SAVE;
			break;
		}
		if (current_position === 2) {
			j = kbd_char_to_99(k);
			if (j < 0) return 0;
			n = j * 10 + cur_note.instrument % 10;
			current_position++;
		} else {
			j = kbd_char_to_hex(k);
			if (j < 0 || j > 9) return 0;
			n = Math.trunc(cur_note.instrument / 10) * 10 + j;
			current_position--;
			advance_cursor(1, 0);
		}
		{
			const get = song_is_instrument_mode() ? app.instrument_get_current : app.sample_get_current;
			const set = song_is_instrument_mode() ? app.instrument_set : app.sample_set;
			j = get(); set(n);
			if (n !== get()) n = j;
			set(j);
			if (n && !(status.flags & CLASSIC_MODE)) current_song.voices[current_channel - 1].last_instrument = n;
			cur_note.instrument = n;
			set(n);
		}
		status.flags |= SONG_NEEDS_SAVE;
		pattern_selection_system_copyout();
		break;
	case 4: case 5:
		if (k.sym === KEYSYM.SPACE) {
			cur_note.volparam = mask_note.volparam; cur_note.voleffect = mask_note.voleffect;
			advance_cursor(1, 0); status.flags |= SONG_NEEDS_SAVE; break;
		}
		if (kbd_get_note(k) === 0) {
			cur_note.volparam = mask_note.volparam = 0;
			cur_note.voleffect = mask_note.voleffect = C.VOLFX_NONE;
			advance_cursor(1, 0); status.flags |= SONG_NEEDS_SAVE; break;
		}
		if (k.scancode === SCANCODE.GRAVE) {
			panning_mode = !panning_mode;
			flash(`${panning_mode ? 'Panning' : 'Volume'} control set`);
			return 0;
		}
		if (!handle_volume(cur_note, k, current_position - 4)) return 0;
		mask_note.volparam = cur_note.volparam; mask_note.voleffect = cur_note.voleffect;
		if (current_position === 4) current_position++;
		else { current_position = 4; advance_cursor(1, 0); }
		status.flags |= SONG_NEEDS_SAVE;
		pattern_selection_system_copyout();
		break;
	case 6:
		if (k.sym === KEYSYM.SPACE) cur_note.effect = mask_note.effect;
		else {
			n = kbd_get_effect_number(k);
			if (n < 0) return 0;
			cur_note.effect = mask_note.effect = n;
		}
		status.flags |= SONG_NEEDS_SAVE;
		if (link_effect_column) current_position++; else advance_cursor(1, 0);
		pattern_selection_system_copyout();
		break;
	case 7: case 8:
		if (k.sym === KEYSYM.SPACE || kbd_get_note(k) === 0) {
			if (k.sym === KEYSYM.SPACE) cur_note.param = mask_note.param;
			else cur_note.param = mask_note.param = 0;
			current_position = link_effect_column ? 6 : 7;
			advance_cursor(1, 0);
			status.flags |= SONG_NEEDS_SAVE;
			pattern_selection_system_copyout();
			break;
		}
		n = kbd_char_to_hex(k);
		if (n < 0) return 0;
		if (current_position === 7) { cur_note.param = (n << 4) | (cur_note.param & 0xf); current_position++; }
		else { cur_note.param = (cur_note.param & 0xf0) | n; current_position = link_effect_column ? 6 : 7; advance_cursor(1, 0); }
		status.flags |= SONG_NEEDS_SAVE;
		mask_note.param = cur_note.param;
		pattern_selection_system_copyout();
		break;
	}
	return 1;
}

// ------------------------------------------------------------------------
// key handling

const PATTERN_COPYIN_INSERT = 1, PATTERN_COPYIN_OVERWRITE = 2, PATTERN_COPYIN_OVERWRITE_GROW = 3,
	PATTERN_COPYIN_MIX_NOTES = 4, PATTERN_COPYIN_MIX_FIELDS = 5;
function do_paste(behavior) {
	const song = current_song, pattern = current_pattern, row = current_row, channel = current_channel;
	clippy_paste(text => {
		if (song !== current_song || pattern !== current_pattern || row !== current_row || channel !== current_channel) return;
		pattern_selection_system_paste(0, text, behavior);
	});
}
function pattern_selection_system_paste(cb, text, behavior = PATTERN_COPYIN_OVERWRITE) {
	const parsed = text ? pattern_selection_system_paste_modplug(text) : null;
	if (parsed) Object.assign(clipboard, parsed);
	switch (behavior) {
	case PATTERN_COPYIN_INSERT: clipboard_paste_insert(); break;
	case PATTERN_COPYIN_OVERWRITE: clipboard_paste_overwrite(0, 0); break;
	case PATTERN_COPYIN_OVERWRITE_GROW: clipboard_paste_overwrite(0, 1); break;
	case PATTERN_COPYIN_MIX_NOTES: clipboard_paste_mix_notes(0, 0); break;
	case PATTERN_COPYIN_MIX_FIELDS: clipboard_paste_mix_fields(0, 0); break;
	}
	status.flags |= NEED_UPDATE;
	return 1;
}

function pattern_editor_handle_alt_key(k) {
	let n;
	let max_row_number = Math.max(0, song_get_max_row_number_in_pattern(current_pattern));
	if (k.orig_sym === KEYSYM.KP_9) k.sym = KEYSYM.F9;
	else if (k.orig_sym === KEYSYM.KP_0) k.sym = KEYSYM.F10;
	n = numeric_key_event(k, 0);
	if (n > -1 && n <= 9) {
		if (k.state === KEY_RELEASE) return 1;
		skip_value = n === 9 ? 16 : n;
		flash(`Cursor step set to ${skip_value}`);
		return 1;
	}
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.RETURN: if (k.state === KEY_PRESS) return 1; fast_save_update(); return 1;
	case KEYSYM.BACKSPACE:
		if (k.state === KEY_PRESS) return 1;
		pated_save('Undo revert pattern data (Alt-BkSpace)');
		snap_paste(fast_save, 0, 0, 0);
		return 1;
	case KEYSYM.b:
		if (rel) return 1;
		if (!SELECTION_EXISTS()) { selection.last_channel = current_channel; selection.last_row = current_row; }
		selection.first_channel = current_channel; selection.first_row = current_row;
		normalise_block_selection();
		break;
	case KEYSYM.e:
		if (rel) return 1;
		if (!SELECTION_EXISTS()) { selection.first_channel = current_channel; selection.first_row = current_row; }
		selection.last_channel = current_channel; selection.last_row = current_row;
		normalise_block_selection();
		break;
	case KEYSYM.d:
		if (rel) return 1;
		if (LAST_KEY_IS(KEYSYM.d, KEYMOD.ALT)) {
			if (max_row_number - (current_row - 1) > block_double_size) block_double_size <<= 1;
		} else {
			block_double_size = current_song.row_highlight_major ? current_song.row_highlight_major : (current_row ? 0 : 65536);
			selection.first_channel = selection.last_channel = current_channel;
			selection.first_row = current_row;
		}
		selection.last_row = Math.min(block_double_size + current_row - 1, max_row_number);
		pattern_selection_system_copyout();
		break;
	case KEYSYM.l:
		if (rel) return 1;
		if (LAST_KEY_IS(KEYSYM.l, KEYMOD.ALT)) {
			if (selection.first_channel === selection.last_channel) { selection.first_channel = 1; selection.last_channel = MAX_CHANNELS; }
			else selection.first_channel = selection.last_channel = current_channel;
		} else {
			selection.first_channel = selection.last_channel = current_channel;
			selection.first_row = 0; selection.last_row = max_row_number;
		}
		pattern_selection_system_copyout();
		break;
	case KEYSYM.r: if (rel) return 1; draw_divisions = 1; set_view_scheme(0); break;
	case KEYSYM.s: if (rel) return 1; selection_set_sample(); break;
	case KEYSYM.u:
		if (rel) return 1;
		if (SELECTION_EXISTS()) selection_clear();
		else if (clipboard.data) clipboard_free();
		else dialog_create(DIALOG_OK, 'No data in clipboard', null, null, 0, null);
		break;
	case KEYSYM.c: if (rel) return 1; clipboard_copy(0); break;
	case KEYSYM.o: if (rel) return 1; do_paste(LAST_KEY_IS(KEYSYM.o, KEYMOD.ALT) ? PATTERN_COPYIN_OVERWRITE_GROW : PATTERN_COPYIN_OVERWRITE); break;
	case KEYSYM.p: if (rel) return 1; do_paste(PATTERN_COPYIN_INSERT); break;
	case KEYSYM.m: if (rel) return 1; do_paste(LAST_KEY_IS(KEYSYM.m, KEYMOD.ALT) ? PATTERN_COPYIN_MIX_FIELDS : PATTERN_COPYIN_MIX_NOTES); break;
	case KEYSYM.f: if (rel) return 1; block_length_double(); break;
	case KEYSYM.g: if (rel) return 1; block_length_halve(); break;
	case KEYSYM.n:
		if (rel) return 1;
		channel_multi[current_channel - 1] ^= 1;
		channel_multi_enabled = channel_multi.some(v => v) ? 1 : 0;
		if (LAST_KEY_IS(KEYSYM.n, KEYMOD.ALT)) pattern_editor_display_multichannel();
		break;
	case KEYSYM.z: if (rel) return 1; clipboard_copy(0); selection_erase(); break;
	case KEYSYM.y: if (rel) return 1; selection_swap(); break;
	case KEYSYM.v: if (rel) return 1; selection_set_volume(); break;
	case KEYSYM.w: if (rel) return 1; selection_wipe_volume(0); break;
	case KEYSYM.k: if (rel) return 1; if (LAST_KEY_IS(KEYSYM.k, KEYMOD.ALT)) selection_wipe_volume(1); else selection_slide_volume(); break;
	case KEYSYM.x: if (rel) return 1; if (LAST_KEY_IS(KEYSYM.x, KEYMOD.ALT)) selection_wipe_effect(); else selection_slide_effect(); break;
	case KEYSYM.h: if (rel) return 1; draw_divisions = !draw_divisions; recalculate_visible_area(); pattern_editor_reposition(); break;
	case KEYSYM.q: if (rel) return 1; transpose_notes(k.mod & KEYMOD.SHIFT ? 12 : 1); break;
	case KEYSYM.a: if (rel) return 1; transpose_notes(k.mod & KEYMOD.SHIFT ? -12 : -1); break;
	case KEYSYM.i:
		if (rel) return 1;
		if (k.mod & KEYMOD.SHIFT) template_mode = TEMPLATE_OFF;
		else if (fast_volume_mode) fast_volume_amplify();
		else template_mode = (template_mode + 1) % TEMPLATE_MODE_MAX;
		break;
	case KEYSYM.j: if (rel) return 1; if (fast_volume_mode) fast_volume_attenuate(); else volume_amplify(); break;
	case KEYSYM.t:
		if (rel) return 1;
		n = current_channel - top_display_channel;
		track_view_scheme[n] = (track_view_scheme[n] + 1) % NUM_TRACK_VIEWS;
		recalculate_visible_area();
		pattern_editor_reposition();
		break;
	case KEYSYM.UP:
		if (rel) return 1;
		if (top_display_row > 0) {
			top_display_row--;
			if (current_row > top_display_row + 31) current_row = top_display_row + 31;
			return -1;
		}
		return 1;
	case KEYSYM.DOWN:
		if (rel) return 1;
		if (top_display_row + 31 < max_row_number) {
			top_display_row++;
			if (current_row < top_display_row) current_row = top_display_row;
			return -1;
		}
		return 1;
	case KEYSYM.LEFT: if (rel) return 1; current_channel--; return -1;
	case KEYSYM.RIGHT: if (rel) return 1; current_channel++; return -1;
	case KEYSYM.INSERT: if (rel) return 1; pated_save('Remove inserted row(s)    (Alt-Insert)'); pattern_insert_rows(current_row, 1, 1, MAX_CHANNELS); break;
	case KEYSYM.DELETE: if (rel) return 1; pated_save('Replace deleted row(s)    (Alt-Delete)'); pattern_delete_rows(current_row, 1, 1, MAX_CHANNELS); break;
	case KEYSYM.F9: if (rel) return 1; song_toggle_channel_mute(current_channel - 1); break;
	case KEYSYM.F10: if (rel) return 1; song_handle_channel_solo(current_channel - 1); break;
	default: return 0;
	}
	status.flags |= NEED_UPDATE;
	return 1;
}

function pattern_editor_handle_ctrl_key(k) {
	const max_row_number = Math.max(0, song_get_max_row_number_in_pattern(current_pattern));
	const n = numeric_key_event(k, 0);
	if (n > -1) {
		if (n >= NUM_TRACK_VIEWS) return 0;
		if (k.state === KEY_RELEASE) return 1;
		if (k.mod & KEYMOD.SHIFT) set_view_scheme(n);
		else { track_view_scheme[current_channel - top_display_channel] = n; recalculate_visible_area(); }
		pattern_editor_reposition();
		status.flags |= NEED_UPDATE;
		return 1;
	}
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.LEFT: if (rel) return 1; if (current_channel > top_display_channel) current_channel--; return -1;
	case KEYSYM.RIGHT: if (rel) return 1; if (current_channel < top_display_channel + visible_channels - 1) current_channel++; return -1;
	case KEYSYM.F6: if (rel) return 1; song_loop_pattern(current_pattern, current_row); return 1;
	case KEYSYM.F7: if (rel) return 1; set_playback_mark(); return -1;
	case KEYSYM.UP: if (rel) return 1; app.set_previous_instrument(); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.DOWN: if (rel) return 1; app.set_next_instrument(); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.PAGEUP: if (rel) return 1; current_row = 0; return -1;
	case KEYSYM.PAGEDOWN: if (rel) return 1; current_row = max_row_number; return -1;
	case KEYSYM.HOME: if (rel) return 1; current_row--; return -1;
	case KEYSYM.END: if (rel) return 1; current_row++; return -1;
	case KEYSYM.INSERT: if (rel) return 1; selection_roll(ROLL_DOWN); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.DELETE: if (rel) return 1; selection_roll(ROLL_UP); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.MINUS:
		if (rel) return 1;
		if (SONG_PLAYING() && tracker.playback_tracing) return 1;
		app.prev_order_pattern();
		return 1;
	case KEYSYM.EQUALS: if (!(k.mod & KEYMOD.SHIFT)) return 0; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.PLUS:
		if (rel) return 1;
		if (SONG_PLAYING() && tracker.playback_tracing) return 1;
		app.next_order_pattern();
		return 1;
	case KEYSYM.c:
		if (rel) return 1;
		centralise_cursor = !centralise_cursor;
		flash(`Centralise cursor ${centralise_cursor ? 'enabled' : 'disabled'}`);
		return -1;
	case KEYSYM.h:
		if (rel) return 1;
		highlight_current_row = !highlight_current_row;
		flash(`Row hilight ${highlight_current_row ? 'enabled' : 'disabled'}`);
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.j: if (rel) return 1; fast_volume_toggle(); return 1;
	case KEYSYM.u:
		if (rel) return 1;
		if (fast_volume_mode) selection_vary(1, 100 - fast_volume_percent, C.FX_CHANNELVOLUME); else vary_command(C.FX_CHANNELVOLUME);
		status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.y:
		if (rel) return 1;
		if (fast_volume_mode) selection_vary(1, 100 - fast_volume_percent, C.FX_PANBRELLO); else vary_command(C.FX_PANBRELLO);
		status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.k:
		if (rel) return 1;
		if (fast_volume_mode) selection_vary(1, 100 - fast_volume_percent, current_effect()); else vary_command(current_effect());
		status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.b: if (k.mod & KEYMOD.SHIFT) return 0; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.o:
		if (rel) return 1;
		app.song_pattern_to_sample(current_pattern, !!(k.mod & KEYMOD.SHIFT), k.sym === KEYSYM.b);
		return 1;
	case KEYSYM.v:
		if (rel) return 1;
		PV.view.show_default_volumes = !PV.view.show_default_volumes;
		flash(`Default volumes ${PV.view.show_default_volumes ? 'enabled' : 'disabled'}`);
		return 1;
	case KEYSYM.x: case KEYSYM.z:
		if (rel) return 1;
		midi_start_record++;
		if (midi_start_record > 2) midi_start_record = 0;
		flash(['No MIDI Trigger', 'Pattern MIDI Trigger', 'Song MIDI Trigger'][midi_start_record]);
		return 1;
	case KEYSYM.BACKSPACE: if (rel) return 1; pattern_editor_display_history(); return 1;
	default: return 0;
	}
}

function pattern_editor_handle_key_default(k) {
	const n = kbd_get_note(k);
	if (n < 0 || current_position > 0) {
		if (k.sym === KEYSYM.LESS || k.sym === KEYSYM.COLON || k.sym === KEYSYM.SEMICOLON) {
			if (k.state === KEY_RELEASE) return 0;
			if ((status.flags & CLASSIC_MODE) || current_position !== 4) {
				app.set_previous_instrument(); status.flags |= NEED_UPDATE; return 1;
			}
		} else if (k.sym === KEYSYM.GREATER || k.sym === KEYSYM.QUOTE || k.sym === KEYSYM.QUOTEDBL) {
			if (k.state === KEY_RELEASE) return 0;
			if ((status.flags & CLASSIC_MODE) || current_position !== 4) {
				app.set_next_instrument(); status.flags |= NEED_UPDATE; return 1;
			}
		} else if (k.sym === KEYSYM.COMMA) {
			if (k.state === KEY_RELEASE) return 0;
			switch (current_position) {
			case 2: case 3: edit_copy_mask ^= MASK_INSTRUMENT; break;
			case 4: case 5: edit_copy_mask ^= MASK_VOLUME; break;
			case 6: case 7: case 8: edit_copy_mask ^= MASK_EFFECT; break;
			}
			status.flags |= NEED_UPDATE;
			return 1;
		}
	}
	if (SONG_PLAYING() && tracker.playback_tracing && k.is_repeat) return 0;
	if (!pattern_editor_insert(k)) return 0;
	return -1;
}

function pattern_editor_handle_key(k) {
	let n, nx, v;
	const max_row_number = Math.max(0, song_get_max_row_number_in_pattern(current_pattern));
	if (k.mouse !== MOUSE_NONE) {
		if ((k.mouse === MOUSE_CLICK || k.mouse === MOUSE_DBLCLICK) && k.state === KEY_RELEASE) shift_selection_end();
		if (k.y < 13 && !shift_selection.in_progress) return 0;
		if (k.y >= 15 && k.mouse !== MOUSE_CLICK && k.mouse !== MOUSE_DBLCLICK) {
			if (k.state === KEY_RELEASE) return 0;
			if (k.mouse === MOUSE_SCROLL_UP) {
				if (top_display_row > 0) {
					top_display_row = Math.max(top_display_row - MOUSE_SCROLL_LINES, 0);
					if (current_row > top_display_row + 31) current_row = top_display_row + 31;
					if (current_row < 0) current_row = 0;
					return -1;
				}
			} else if (k.mouse === MOUSE_SCROLL_DOWN) {
				if (top_display_row + 31 < max_row_number) {
					top_display_row = Math.min(top_display_row + MOUSE_SCROLL_LINES, max_row_number);
					if (current_row < top_display_row) current_row = top_display_row;
					return -1;
				}
			}
			return 1;
		}
		if (k.mouse !== MOUSE_CLICK && k.mouse !== MOUSE_DBLCLICK) return 1;
		let basex = 5;
		if (current_row < 0) current_row = 0;
		if (current_row >= max_row_number) current_row = max_row_number;
		let np = current_position, nc = current_channel, nr = current_row;
		const hx = k.hx & 1;
		for (n = top_display_channel, nx = 0; nx <= visible_channels; n++, nx++) {
			const tv = track_views[track_view_scheme[nx]];
			if (((n === top_display_channel && shift_selection.in_progress) || k.x >= basex)
				&& ((n === visible_channels && shift_selection.in_progress) || k.x < basex + tv.width)) {
				if (!shift_selection.in_progress && (k.y === 14 || k.y === 13)) {
					if (k.state === KEY_PRESS) { song_toggle_channel_mute(n - 1); status.flags |= NEED_UPDATE; }
					break;
				}
				nc = n;
				nr = (k.y - 15) + top_display_row;
				if (k.y < 15 && top_display_row > 0) top_display_row--;
				if (shift_selection.in_progress) break;
				v = k.x - basex;
				switch (track_view_scheme[nx]) {
				case 0: np = { 0: 0, 2: 1, 4: 2, 5: 3, 7: 4, 8: 5, 10: 6, 11: 7, 12: 8 }[v] ?? np; break;
				case 1: np = { 0: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8 }[v] ?? np; break;
				case 2: np = { 0: 0, 2: 1, 3: 2 + hx, 4: 4 + hx, 5: 6, 6: 7 + hx }[v] ?? np; break;
				case 3: np = { 0: 0, 1: 1, 2: 2 + hx, 3: 4 + hx, 4: 6, 5: 7 + hx }[v] ?? np; break;
				default: np = 0;
				}
				break;
			}
			basex += tv.width;
			if (draw_divisions) basex++;
		}
		if (np === current_position && nc === current_channel && nr === current_row) return 1;
		if (nr >= max_row_number) nr = max_row_number;
		if (nr < 0) nr = 0;
		current_position = np; current_channel = nc; current_row = nr;
		if ((k.state === KEY_PRESS || k.state === KEY_DRAG) && k.sy > 14) {
			if (!shift_selection.in_progress) shift_selection_begin();
			else shift_selection_update();
		}
		return -1;
	}
	if (k.midi_note > -1 || k.midi_bend !== 0) return pattern_editor_insert_midi(k);
	const rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.UP:
		if (rel) return 0;
		if (skip_value) { if (current_row - skip_value >= 0) current_row -= skip_value; } else current_row--;
		return -1;
	case KEYSYM.DOWN:
		if (rel) return 0;
		if (skip_value) { if (current_row + skip_value <= max_row_number) current_row += skip_value; } else current_row++;
		return -1;
	case KEYSYM.LEFT:
		if (rel) return 0;
		if (k.mod & KEYMOD.SHIFT) current_channel--;
		else if (link_effect_column && current_position === 0 && current_channel > 1) { current_channel--; current_position = current_effect() ? 8 : 6; }
		else current_position--;
		return -1;
	case KEYSYM.RIGHT:
		if (rel) return 0;
		if (k.mod & KEYMOD.SHIFT) current_channel++;
		else if (link_effect_column && current_position === 6 && current_channel < MAX_CHANNELS) current_position = current_effect() ? 7 : 10;
		else current_position++;
		return -1;
	case KEYSYM.TAB:
		if (rel) return 0;
		if (!(k.mod & KEYMOD.SHIFT)) current_channel++;
		else if (current_position === 0) current_channel--;
		current_position = 0;
		return -1;
	case KEYSYM.PAGEUP: {
		if (rel) return 0;
		const rh = current_song.row_highlight_major || 16;
		if (current_row === max_row_number) current_row -= (current_row % rh) ? (current_row % rh) : rh;
		else current_row -= rh;
		return -1;
	}
	case KEYSYM.PAGEDOWN: if (rel) return 0; current_row += current_song.row_highlight_major || 16; return -1;
	case KEYSYM.HOME:
		if (rel) return 0;
		if (current_position === 0) {
			if (invert_home_end ? current_row !== 0 : current_channel === 1) current_row = 0;
			else current_channel = 1;
		} else current_position = 0;
		return -1;
	case KEYSYM.END:
		if (rel) return 0;
		n = song_find_last_channel() + 1;
		if (current_position === 8) {
			if (invert_home_end ? current_row !== max_row_number : current_channel === n) current_row = max_row_number;
			else current_channel = n;
		} else current_position = 8;
		return -1;
	case KEYSYM.INSERT:
		if (rel) return 0;
		if (template_mode && clipboard.rows === 1) {
			n = clipboard.channels;
			if (n + current_channel > MAX_CHANNELS) n = MAX_CHANNELS - current_channel;
			pattern_insert_rows(current_row, 1, current_channel, n);
		} else pattern_insert_rows(current_row, 1, current_channel, 1);
		break;
	case KEYSYM.DELETE:
		if (rel) return 0;
		if (template_mode && clipboard.rows === 1) {
			n = clipboard.channels;
			if (n + current_channel > MAX_CHANNELS) n = MAX_CHANNELS - current_channel;
			pattern_delete_rows(current_row, 1, current_channel, n);
		} else pattern_delete_rows(current_row, 1, current_channel, 1);
		break;
	case KEYSYM.MINUS: case KEYSYM.KP_MINUS:
		if (rel) return 0;
		if (tracker.playback_tracing) {
			const mode = song_get_mode();
			if (mode === MODE_PATTERN_LOOP) return 1;
			if (mode === MODE_PLAYING) { song_set_current_order(song_get_current_order() - 1); return 1; }
		}
		set_current_pattern(current_pattern - (k.mod & KEYMOD.SHIFT ? 4 : 1));
		return 1;
	case KEYSYM.EQUALS: if (!(k.mod & KEYMOD.SHIFT)) return 0; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.PLUS: case KEYSYM.KP_PLUS:
		if (rel) return 0;
		if (tracker.playback_tracing) {
			const mode = song_get_mode();
			if (mode === MODE_PATTERN_LOOP) return 1;
			if (mode === MODE_PLAYING) { song_set_current_order(song_get_current_order() + 1); return 1; }
		}
		set_current_pattern(current_pattern + ((k.mod & KEYMOD.SHIFT) && k.sym === KEYSYM.KP_PLUS ? 4 : 1));
		return 1;
	case KEYSYM.BACKSPACE:
		if (rel) return 0;
		current_channel = multichannel_get_previous(current_channel);
		if (skip_value) current_row -= skip_value; else current_row--;
		return -1;
	case KEYSYM.RETURN:
		if (rel) return 0;
		copy_note_to_mask();
		if (template_mode !== TEMPLATE_NOTES_ONLY) template_mode = TEMPLATE_OFF;
		return 1;
	case KEYSYM.l:
		if (k.mod & KEYMOD.SHIFT) {
			if (status.flags & CLASSIC_MODE) return 0;
			if (rel) return 1;
			clipboard_copy(1);
			break;
		}
		return pattern_editor_handle_key_default(k);
	case KEYSYM.a:
		if ((k.mod & KEYMOD.SHIFT) && !(status.flags & CLASSIC_MODE)) {
			if (rel) return 0;
			if (current_row === 0) return 1;
			do current_row--; while (!seek_done() && current_row !== 0);
			return -1;
		}
		return pattern_editor_handle_key_default(k);
	case KEYSYM.f:
		if ((k.mod & KEYMOD.SHIFT) && !(status.flags & CLASSIC_MODE)) {
			if (rel) return 0;
			if (current_row === max_row_number) return 1;
			do current_row++; while (!seek_done() && current_row !== max_row_number);
			return -1;
		}
		return pattern_editor_handle_key_default(k);
	case KEYSYM.LSHIFT: case KEYSYM.RSHIFT:
		if (rel) {
			if (shift_selection.in_progress) shift_selection_end();
			if (shift_chord_channels) {
				current_channel -= shift_chord_channels;
				while (current_channel < 1) current_channel += MAX_CHANNELS;
				advance_cursor(1, 1);
				shift_chord_channels = 0;
			}
		}
		return 1;
	default:
		return pattern_editor_handle_key_default(k);
	}
	status.flags |= NEED_UPDATE;
	return 1;
}

function pattern_editor_handle_key_cb(k) {
	const max_row_number = Math.max(0, song_get_max_row_number_in_pattern(current_pattern));
	if (k.mod & KEYMOD.SHIFT) {
		switch (k.sym) {
		case KEYSYM.LEFT: case KEYSYM.RIGHT: case KEYSYM.UP: case KEYSYM.DOWN:
		case KEYSYM.HOME: case KEYSYM.END: case KEYSYM.PAGEUP: case KEYSYM.PAGEDOWN:
			if (k.state === KEY_RELEASE) return 0;
			if (!shift_selection.in_progress) shift_selection_begin();
		}
	}
	let ret;
	if (k.mod & KEYMOD.ALT) ret = pattern_editor_handle_alt_key(k);
	else if (k.mod & KEYMOD.CTRL) ret = pattern_editor_handle_ctrl_key(k);
	else ret = pattern_editor_handle_key(k);
	if (ret !== -1) return ret;
	current_row = clamp(current_row, 0, max_row_number);
	if (current_position > 8) {
		if (current_channel < MAX_CHANNELS) { current_position = 0; current_channel++; }
		else current_position = 8;
	} else if (current_position < 0) {
		if (current_channel > 1) { current_position = 8; current_channel--; }
		else current_position = 0;
	}
	current_channel = clamp(current_channel, 1, MAX_CHANNELS);
	pattern_editor_reposition();
	if ((k.mod & KEYMOD.SHIFT) && k.sym !== KEYSYM.TAB) shift_selection_update();
	status.flags |= NEED_UPDATE;
	return 1;
}

// undo dialog
let undo_selection = 0;
function history_draw_const() {
	draw_text('Undo', 38, 22, 3, 2);
	draw_box(19, 23, 60, 34, BOX_THIN | BOX_INNER | BOX_INSET);
	let j = undo_history_top;
	for (let i = 0; i < 10; i++) {
		const [fg, bg] = i === undo_selection ? [0, 3] : [2, 0];
		draw_char(32, 20, 24 + i, fg, bg);
		draw_text_len(undo_history[j].snap_op, 39, 21, 24 + i, fg, bg);
		if (--j < 0) j += 10;
	}
}
function history_handle_key(k) {
	if (!NO_MODIFIER(k.mod)) return 0;
	switch (k.sym) {
	case KEYSYM.ESCAPE: if (k.state === KEY_PRESS) return 0; dialog_cancel(null); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.UP: if (k.state === KEY_RELEASE) return 0; undo_selection = Math.max(0, undo_selection - 1); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.DOWN: if (k.state === KEY_RELEASE) return 0; undo_selection = Math.min(9, undo_selection + 1); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.RETURN: {
		if (k.state === KEY_RELEASE) return 0;
		let j = undo_history_top;
		for (let i = 0; i < 10; i++) {
			if (i === undo_selection) { pated_history_restore(j); break; }
			if (--j < 0) j += 10;
		}
		dialog_cancel(null);
		status.flags |= NEED_UPDATE;
		return 1;
	}
	}
	return 0;
}
function pattern_editor_display_history() {
	const w = [widget_create_other(0, history_handle_key, null, null)];
	const dialog = dialog_create_custom(17, 21, 47, 16, w, 1, 0, history_draw_const, null);
	dialog.action_yes = dialog.action_cancel = () => {};
	dialog.handle_key = history_handle_key;
}

// ------------------------------------------------------------------------

let prev_row = -1, prev_pattern = -1;
function pattern_editor_playback_update() {
	playing_row = song_get_current_row();
	playing_pattern = song_get_playing_pattern();
	if (SONG_PLAYING() && (playing_row !== prev_row || playing_pattern !== prev_pattern)) {
		prev_row = playing_row; prev_pattern = playing_pattern;
		if (tracker.playback_tracing) {
			app.set_current_order(song_get_current_order());
			set_current_pattern(playing_pattern);
			current_row = playing_row;
			pattern_editor_reposition();
			status.flags |= NEED_UPDATE;
		} else if (current_pattern === playing_pattern) status.flags |= NEED_UPDATE;
	}
}
function pated_song_changed() {
	pated_history_clear();
	marked_pattern = -1; marked_row = 0;
	current_row = Math.min(current_row, song_get_max_row_number_in_pattern(current_pattern));
}

export function pattern_editor_load_page(page) {
	pated_history_clear();
	Object.assign(page, {
		title: 'Pattern Editor (F2)', playback_update: pattern_editor_playback_update,
		song_changed_cb: pated_song_changed, help_index: HELP.PATTERN_EDITOR, ported: true,
		clipboard_paste: pattern_selection_system_paste,
		pre_handle_key: k => {
			if (k.sym === KEYSYM.F7) {
				if (!NO_MODIFIER(k.mod)) return 0;
				if (k.state === KEY_RELEASE) return 1;
				play_song_from_mark();
				return 1;
			}
			return 0;
		},
		set_page: () => shift_selection_end(),
		widgets: [widget_create_other(0, pattern_editor_handle_key_cb, null, pattern_editor_redraw)],
		total_widgets: 1,
	});
	recalculate_visible_area();
}
pattern_editor_load_page(pages[PAGE.PATTERN_EDITOR]);

provide({ pattern_editor_display_options, pattern_editor_length_edit, update_current_row, get_current_channel,
	set_current_channel, get_current_row, set_current_row, update_current_pattern, get_current_pattern,
	set_current_pattern, play_song_from_mark, play_song_from_mark_orderpan, pattern_editor_reposition });
