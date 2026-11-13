// Port of schism/page_samples.c (Schism Tracker, GPL-2.0-or-later).
// Not ported: AdLib config/patch dialogs (no OPL emulator yet) and the text
// synth (Alt-Y). Saving samples goes through app.song_save_sample (download).
import { app, provide, optional } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, HELP, NEED_UPDATE, SONG_NEEDS_SAVE, CLASSIC_MODE, DIALOG_OK, DIALOG_OK_CANCEL, DIALOG_YES_NO } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, draw_fill_chars, vgamem_ovl_alloc, DEFAULT_FG,
	BOX_THICK, BOX_THIN, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_NONE, MOUSE_CLICK, MOUSE_DBLCLICK,
	MOUSE_SCROLL_UP, MOUSE_SCROLL_DOWN, MOUSE_BUTTON_MIDDLE, kbd_get_note } from './keyboard.js';
import { widget_create_other, widget_create_thumbbar, widget_create_toggle, widget_create_textentry,
	widget_create_numentry, widget_create_menutoggle, widget_create_togglebutton, widget_create_button,
	widget_togglebutton_set, widget_change_focus_to, text_add_char, text_delete_char, text_delete_next_char,
	MOUSE_SCROLL_LINES, str_from_num, str_from_num99 } from './widget.js';
import { dialog_create, dialog_create_custom, dialog_yes_NULL, dialog_cancel_NULL, smpprompt_create } from './dialog.js';
import { pages, set_page } from './page.js';
import { current_song, song_get_sample, song_get_instrument, song_get_playing_samples, song_swap_samples,
	song_exchange_samples, song_copy_sample, song_replace_sample, song_clear_sample, song_keydown, song_keyup,
	song_change_current_play_channel, song_toggle_multichannel_mode, song_insert_sample_slot,
	song_remove_sample_slot, song_update_playing_sample, KEYJAZZ_NOINST, KEYJAZZ_DEFAULTVOL, KEYJAZZ_CHAN_CURRENT } from './song.js';
import { csf_sample_is_empty, csf_stop_sample, csf_adjust_sample_loop } from './csndfile.js';
import { calc_halftone } from './effects.js';
import * as SE from './sample-edit.js';

const MAX_SAMPLES = 236;
const sample_image = vgamem_ovl_alloc({ x1: 55, y1: 26, x2: 76, y2: 29 });
let widgets = [];
const vibrato_waveforms = [15, 16, 17, 18, -1];
let top_sample = 1, current_sample = 1, _altswap_lastvis = 99;
const cursor = { cursor_pos: 25 };
const numentry_cursor = { value: 0 };
const loop_states = ['Off', 'On Forwards', 'On Ping Pong'];
let last_note = C.NOTE_MIDC;
const flash = t => app.status_text_flash(t);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const LAST_KEY_IS = (sym, mod) => ((mod === 0) ? !status.last_keymod : (status.last_keymod & mod)) && status.last_keysym === sym;
const cur = () => song_get_sample(current_sample);

function _is_magic_sample(no) {
	if (!current_song) return false;
	const s = song_get_sample(no);
	return s && s.name.charCodeAt(23) === 0xff && s.name.charCodeAt(24) < 200;
}
function _fix_accept_text() {
	widgets[0].accept_text = _is_magic_sample(current_sample) ? (cursor.cursor_pos === 23 ? 0 : 1) : (cursor.cursor_pos === 25 ? 0 : 1);
}
function _last_vis_sample() {
	let n = 99, j = 0;
	for (let i = 65; i < MAX_SAMPLES; i++) if (!csf_sample_is_empty(current_song.samples[i])) j = i;
	while (j + 34 > n) n += 34;
	return Math.min(n, MAX_SAMPLES - 1);
}
function sample_list_reposition() {
	if (current_sample < top_sample) top_sample = Math.max(1, current_sample);
	else if (current_sample > top_sample + 34) top_sample = current_sample - 34;
}
export const sample_get_current = () => current_sample;
export function sample_set(n) {
	const new_sample = status.current_page === PAGE.SAMPLE_LIST ? clamp(n, 1, _last_vis_sample()) : clamp(n, 0, _last_vis_sample());
	if (current_sample === new_sample) return;
	current_sample = new_sample;
	sample_list_reposition();
	status.flags |= NEED_UPDATE;
}

function sample_list_draw_list() {
	const is_playing = song_get_playing_samples();
	for (let pos = 0, n = top_sample; pos < 35; pos++, n++) {
		const sample = song_get_sample(n), is_selected = n === current_sample, has_data = !!sample.data;
		if (sample.played) draw_char(is_playing[n] > 1 ? 183 : 173, 1, 13 + pos, is_playing[n] ? 3 : 1, 2);
		draw_text(str_from_num99(n), 2, 13 + pos, sample.flags & C.CHN_MUTE ? 1 : 0, 2);
		let nl;
		const pn = sample.name.charCodeAt(24);
		if (sample.name.charCodeAt(23) === 0xff && pn < 200) {
			nl = 23;
			draw_text(str_from_num(3, pn), 32, 13 + pos, 0, 2);
			draw_text('Pat.', 28, 13 + pos, 3, 2);
		} else {
			nl = 25;
			draw_char(168, 30, 13 + pos, 2, is_selected ? 14 : 0);
			draw_text('Play', 31, 13 + pos, has_data ? 6 : 7, is_selected ? 14 : 0);
		}
		draw_text_len(sample.name, nl, 5, 13 + pos, 6, is_selected ? 14 : 0);
	}
	if (app.active_page().selected_widget === 0) {
		const pos = current_sample - top_sample, sample = cur(), has_data = !!sample.data;
		if (pos >= 0 && pos <= 34) {
			if (cursor.cursor_pos === 25) draw_text('Play', 31, 13 + pos, 0, has_data ? 3 : 6);
			else draw_char(cursor.cursor_pos >= sample.name.length ? 0 : sample.name.charCodeAt(cursor.cursor_pos), cursor.cursor_pos + 5, 13 + pos, 0, 3);
		}
	}
}

// the filename textentry edits the current sample's filename in place
const filename_ref = { get value() { return cur().filename; }, set value(v) { cur().filename = v; } };
const name_ref = { get value() { return cur().name; }, set value(v) { cur().name = v; } };

function sample_list_predraw_hook() {
	const sample = cur(), has_data = !!sample.data;
	widgets[1].d.value = sample.volume >> 2;
	widgets[2].d.value = sample.global_volume;
	widgets[2].d.text_at_min = sample.flags & C.CHN_MUTE ? '  Muted  ' : null;
	widgets[3].d.state = sample.flags & C.CHN_PANNING ? 1 : 0;
	widgets[4].d.value = sample.panning >> 2;
	widgets[5].d.value = sample.vib_speed;
	widgets[6].d.value = sample.vib_depth;
	widgets[8].d.value = sample.c5speed;
	widgets[9].d.state = sample.flags & C.CHN_LOOP ? (sample.flags & C.CHN_PINGPONGLOOP ? 2 : 1) : 0;
	widgets[10].d.value = sample.loop_start;
	widgets[11].d.value = sample.loop_end;
	widgets[12].d.state = sample.flags & C.CHN_SUSTAINLOOP ? (sample.flags & C.CHN_PINGPONGSUSTAIN ? 2 : 1) : 0;
	widgets[13].d.value = sample.sustain_start;
	widgets[14].d.value = sample.sustain_end;
	widget_togglebutton_set(widgets, [15, 16, 17, 18][sample.vib_type & 3], 0);
	widgets[19].d.value = sample.vib_rate;
	draw_text_len(has_data ? `${sample.flags & C.CHN_16BIT ? 16 : 8} bit${sample.flags & C.CHN_STEREO ? ' Stereo' : ''}` : 'No sample', 13, 64, 22, 2, 0);
	draw_text_len(String(sample.length), 13, 64, 23, 2, 0);
	SE.draw_sample_data(sample_image, sample);
}

function sample_list_add_char(c) {
	if (c < 32) return 0;
	text_add_char(name_ref, c, cursor, _is_magic_sample(current_sample) ? 22 : 25);
	_fix_accept_text();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
	return 1;
}
function sample_list_delete_char() {
	text_delete_char(name_ref, cursor); _fix_accept_text();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function sample_list_delete_next_char() {
	text_delete_next_char(name_ref, cursor); _fix_accept_text();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function clear_sample_text() {
	const s = cur();
	s.filename = '';
	s.name = _is_magic_sample(current_sample) ? '\0'.repeat(23) + s.name.slice(23, 25) : '';
	cursor.cursor_pos = 0;
	_fix_accept_text();
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
const valid = n => n >= 1 && n <= _last_vis_sample();
const do_swap_sample = n => { if (valid(n)) song_swap_samples(current_sample, n); };
const do_exchange_sample = n => { if (valid(n)) song_exchange_samples(current_sample, n); };
function do_copy_sample(n) {
	if (valid(n)) { song_copy_sample(current_sample, { ...song_get_sample(n) }); optional('sample_host_dialog', -1); }
	status.flags |= SONG_NEEDS_SAVE;
}
function do_replace_sample(n) { if (valid(n)) song_replace_sample(current_sample, n); status.flags |= SONG_NEEDS_SAVE; }

function sample_list_handle_text_input_on_list(text) {
	if (cursor.cursor_pos >= 25) return 0;
	let success = 0;
	for (const ch of text) { const c = ch.charCodeAt(0); if (c < 256 && sample_list_add_char(c)) success = 1; }
	return success;
}
function sample_list_handle_key_on_list(k) {
	let new_sample = current_sample, new_cursor_pos = cursor.cursor_pos;
	if (k.mouse === MOUSE_CLICK && k.mouse_button === MOUSE_BUTTON_MIDDLE) return 1;
	if (k.state === KEY_PRESS && k.mouse !== MOUSE_NONE && k.x >= 5 && k.y >= 13 && k.y <= 47 && k.x <= 34) {
		if (k.mouse === MOUSE_SCROLL_UP) { top_sample = Math.max(1, top_sample - MOUSE_SCROLL_LINES); status.flags |= NEED_UPDATE; return 1; }
		if (k.mouse === MOUSE_SCROLL_DOWN) { top_sample = Math.min(top_sample + MOUSE_SCROLL_LINES, _last_vis_sample() - 34); status.flags |= NEED_UPDATE; return 1; }
		new_sample = k.y - 13 + top_sample;
		new_cursor_pos = k.x - 5;
		if (k.x <= 29 && k.mouse === MOUSE_DBLCLICK) { set_page(PAGE.LOAD_SAMPLE); return 1; }
	} else {
		const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
		switch (k.sym) {
		case KEYSYM.LEFT: if (rel || !nm) return 0; new_cursor_pos--; break;
		case KEYSYM.RIGHT: if (rel || !nm) return 0; new_cursor_pos++; break;
		case KEYSYM.HOME: if (rel || !nm) return 0; new_cursor_pos = 0; break;
		case KEYSYM.END: if (rel || !nm) return 0; new_cursor_pos = 25; break;
		case KEYSYM.UP:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) { if (current_sample > 1) { new_sample = current_sample - 1; song_swap_samples(current_sample, new_sample); } }
			else if (!nm) return 0;
			else new_sample--;
			break;
		case KEYSYM.DOWN:
			if (rel) return 0;
			if (k.mod & KEYMOD.ALT) {
				if (!LAST_KEY_IS(KEYSYM.DOWN, KEYMOD.ALT) && !k.is_repeat) _altswap_lastvis = _last_vis_sample();
				if (current_sample < _altswap_lastvis) { new_sample = current_sample + 1; song_swap_samples(current_sample, new_sample); }
			} else if (!nm) return 0;
			else new_sample++;
			break;
		case KEYSYM.PAGEUP: if (rel) return 0; new_sample = k.mod & KEYMOD.CTRL ? 1 : new_sample - 16; break;
		case KEYSYM.PAGEDOWN: if (rel) return 0; new_sample = k.mod & KEYMOD.CTRL ? _last_vis_sample() : new_sample + 16; break;
		case KEYSYM.RETURN: if (k.state === KEY_PRESS) return 0; set_page(PAGE.LOAD_SAMPLE); break;
		case KEYSYM.BACKSPACE:
			if (rel) return 0;
			if (!(k.mod & (KEYMOD.CTRL | KEYMOD.ALT))) { if (cursor.cursor_pos < 25) sample_list_delete_char(); return 1; }
			if (k.mod & KEYMOD.CTRL) { if (cursor.cursor_pos < 25) sample_list_add_char(127); return 1; }
			return 0;
		case KEYSYM.DELETE:
			if (rel) return 0;
			if (!(k.mod & (KEYMOD.CTRL | KEYMOD.ALT))) { if (cursor.cursor_pos < 25) sample_list_delete_next_char(); return 1; }
			return 0;
		case KEYSYM.ESCAPE:
			if (k.mod & KEYMOD.SHIFT) { if (rel) return 1; new_cursor_pos = 25; break; }
			return 0;
		default:
			if (k.mod & KEYMOD.ALT) {
				if (k.sym === KEYSYM.c) { clear_sample_text(); return 1; }
				return 0;
			} else if (!(k.mod & KEYMOD.CTRL) && cursor.cursor_pos < 25) {
				if (rel) return 1;
				if (k.text) return sample_list_handle_text_input_on_list(k.text);
				return 0;
			}
			return 0;
		}
	}
	new_sample = clamp(new_sample, 1, _last_vis_sample());
	new_cursor_pos = clamp(new_cursor_pos, 0, 25);
	if (new_sample !== current_sample) { sample_set(new_sample); sample_list_reposition(); }
	if (new_cursor_pos !== cursor.cursor_pos) { cursor.cursor_pos = new_cursor_pos; _fix_accept_text(); }
	status.flags |= NEED_UPDATE;
	return 1;
}

// alt-key dialog callbacks
function do_delete_sample() { song_clear_sample(current_sample); status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE; }
function do_post_loop_cut() {
	const s = cur();
	const pos = s.flags & C.CHN_SUSTAINLOOP ? Math.max(s.loop_end, s.sustain_end) : s.loop_end;
	if (pos === 0 || pos >= s.length) return;
	status.flags |= SONG_NEEDS_SAVE;
	csf_stop_sample(current_song, s);
	if (s.loop_end > pos) s.loop_end = pos;
	if (s.sustain_end > pos) s.sustain_end = pos;
	s.length = pos;
	csf_adjust_sample_loop(s);
}
function do_pre_loop_cut() {
	const s = cur();
	const pos = s.flags & C.CHN_SUSTAINLOOP ? Math.min(s.loop_start, s.sustain_start) : s.loop_start;
	if (pos === 0 || pos > s.length) return;
	status.flags |= SONG_NEEDS_SAVE;
	csf_stop_sample(current_song, s);
	const ch = s.flags & C.CHN_STEREO ? 2 : 1;
	s.data = s.data.slice(pos * ch, s.length * ch);
	s.length -= pos;
	for (const k of ['loop_start', 'sustain_start', 'loop_end', 'sustain_end']) s[k] = s[k] > pos ? s[k] - pos : 0;
	csf_adjust_sample_loop(s);
}

let dlg_widgets = null;
function sample_amplify_dialog() {
	const percent = Math.min(SE.sample_get_amplify_amount(cur()), 400);
	dlg_widgets = [
		widget_create_thumbbar(13, 30, 51, 0, 1, 1, null, 0, 400),
		widget_create_button(31, 33, 6, 0, 1, 2, 2, 2, dialog_yes_NULL, 'OK', 3),
		widget_create_button(41, 33, 6, 0, 2, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
	dlg_widgets[0].d.value = percent;
	const d = dialog_create_custom(9, 25, 61, 11, dlg_widgets, 3, 0, () => {
		draw_text('Sample Amplification %', 29, 27, 0, 2);
		draw_box(12, 29, 64, 31, BOX_THIN | BOX_INNER | BOX_INSET);
	}, null);
	d.action_yes = () => SE.sample_amplify(cur(), dlg_widgets[0].d.value);
}
function resize_sample_dialog(aa) {
	const c = { value: 0 };
	dlg_widgets = [
		widget_create_numentry(42, 27, 7, 0, 1, 1, null, 0, 9999999, c),
		widget_create_button(36, 30, 6, 0, 1, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
	dlg_widgets[0].d.value = cur().length;
	const d = dialog_create_custom(26, 22, 29, 11, dlg_widgets, 2, 0, () => {
		draw_text('Resize Sample', 34, 24, 3, 2);
		draw_text('New Length', 31, 27, 0, 2);
		draw_box(41, 26, 49, 28, BOX_THICK | BOX_INNER | BOX_INSET);
	}, null);
	d.action_yes = () => SE.sample_resize(cur(), dlg_widgets[0].d.value, aa);
}
function resample_sample_dialog(aa) {
	const c = { value: 0 };
	dlg_widgets = [
		widget_create_numentry(44, 27, 7, 0, 1, 1, null, 0, 9999999, c),
		widget_create_button(37, 30, 6, 0, 1, 1, 1, 1, dialog_cancel_NULL, 'Cancel', 1),
	];
	dlg_widgets[0].d.value = cur().c5speed;
	const d = dialog_create_custom(26, 22, 28, 11, dlg_widgets, 2, 0, () => {
		draw_text('Resample Sample', 33, 24, 3, 2);
		draw_text('New Sample Rate', 28, 27, 0, 2);
		draw_box(43, 26, 51, 28, BOX_THICK | BOX_INNER | BOX_INSET);
	}, null);
	d.action_yes = () => {
		const s = cur(), nc = dlg_widgets[0].d.value;
		SE.sample_resize(s, Math.trunc(s.length * nc / s.c5speed), aa);
		s.c5speed = nc;
	};
}
function crossfade_sample_dialog() {
	const smp = cur(), c = { value: 0 };
	const changed = () => {
		const sustain = dlg_widgets[1].d.state;
		const ls = sustain ? smp.sustain_start : smp.loop_start, le = sustain ? smp.sustain_end : smp.loop_end;
		const max = Math.min(le - ls, ls);
		dlg_widgets[2].d.max = max; dlg_widgets[2].d.value = max;
	};
	const group = [0, 1, -1];
	dlg_widgets = [
		widget_create_togglebutton(31, 24, 6, 0, 2, 1, 1, 1, changed, 'Loop', 2, group),
		widget_create_togglebutton(41, 24, 7, 2, 2, 0, 0, 2, changed, 'Sustain', 1, group),
		widget_create_numentry(45, 27, 7, 0, 3, 3, null, 0, 1, c),
		widget_create_thumbbar(28, 31, 20, 2, 4, 4, null, -50, 50),
		widget_create_button(31, 34, 6, 3, 4, 5, 5, 5, dialog_cancel_NULL, 'Cancel', 1),
		widget_create_button(41, 34, 6, 3, 5, 4, 4, 0, dialog_yes_NULL, 'OK', 3),
	];
	dlg_widgets[((smp.flags & C.CHN_SUSTAINLOOP) && !((smp.flags & C.CHN_LOOP) && smp.loop_start && smp.loop_end)) ? 1 : 0].d.state = 1;
	changed();
	dlg_widgets[3].d.value = 0;
	const d = dialog_create_custom(26, 20, 28, 17, dlg_widgets, 6, 0, () => {
		draw_text('Crossfade Sample', 32, 22, 3, 2);
		draw_text('Samples To Fade', 28, 27, 0, 2);
		draw_text('Volume', 28, 29, 0, 2);
		draw_text('Power', 47, 29, 0, 2);
		draw_box(27, 30, 48, 32, BOX_THIN | BOX_INNER | BOX_INSET);
		draw_box(44, 26, 52, 28, BOX_THICK | BOX_INNER | BOX_INSET);
	}, null);
	d.action_yes = () => SE.sample_crossfade(smp, dlg_widgets[2].d.value, dlg_widgets[3].d.value + 50, 0, dlg_widgets[1].d.state);
}

function sample_set_mute(n, mute) {
	const smp = song_get_sample(n);
	if (mute) {
		if (smp.flags & C.CHN_MUTE) return;
		smp.globalvol_saved = smp.global_volume; smp.global_volume = 0; smp.flags |= C.CHN_MUTE;
	} else {
		if (!(smp.flags & C.CHN_MUTE)) return;
		smp.global_volume = smp.globalvol_saved; smp.flags &= ~C.CHN_MUTE;
	}
}
const sample_toggle_mute = n => sample_set_mute(n, !(song_get_sample(n).flags & C.CHN_MUTE));
function sample_toggle_solo(n) {
	let solo = 0;
	if (song_get_sample(n).flags & C.CHN_MUTE) solo = 1;
	else for (let i = 1; i < MAX_SAMPLES; i++) if (i !== n && !(song_get_sample(i).flags & C.CHN_MUTE)) { solo = 1; break; }
	for (let i = 1; i < MAX_SAMPLES; i++) sample_set_mute(i, solo && i !== n);
}

function sample_save(format) {
	const s = cur();
	if (!s.filename && !s.name) { flash('Sample NOT saved! (No Filename?)'); return; }
	app.song_save_sample(null, format, s, current_sample);
}

function sample_list_handle_alt_key(k) {
	const sample = cur(), canmod = sample.data && !(sample.flags & C.CHN_ADLIB);
	if (k.state === KEY_RELEASE) return;
	const shift = (k.mod & KEYMOD.SHIFT) && !(status.flags & CLASSIC_MODE);
	switch (k.sym) {
	case KEYSYM.a: if (canmod) dialog_create(DIALOG_OK_CANCEL, 'Convert sample?', () => SE.sample_sign_convert(cur()), null, 0, null); return;
	case KEYSYM.b:
		if (canmod && (sample.loop_start > 0 || ((sample.flags & C.CHN_SUSTAINLOOP) && sample.sustain_start > 0)))
			dialog_create(DIALOG_OK_CANCEL, 'Cut sample?', do_pre_loop_cut, null, 1, null);
		return;
	case KEYSYM.d:
		if (shift) { if (canmod && (sample.flags & C.CHN_STEREO)) dialog_create(DIALOG_OK_CANCEL, 'Downmix sample to mono?', () => SE.sample_downmix(cur()), null, 0, null); }
		else dialog_create(DIALOG_OK_CANCEL, 'Delete sample?', do_delete_sample, null, 1, null);
		return;
	case KEYSYM.e: if (canmod) { if (shift) resample_sample_dialog(1); else resize_sample_dialog(1); } break;
	case KEYSYM.f: if (canmod) { if (shift) resample_sample_dialog(0); else resize_sample_dialog(0); } break;
	case KEYSYM.g: if (canmod) SE.sample_reverse(sample); break;
	case KEYSYM.h: if (canmod) dialog_create(DIALOG_YES_NO, 'Centralise sample?', () => SE.sample_centralise(cur()), null, 0, null); return;
	case KEYSYM.i: if (canmod) SE.sample_invert(sample); break;
	case KEYSYM.l:
		if (canmod && (sample.loop_end > 0 || ((sample.flags & C.CHN_SUSTAINLOOP) && sample.sustain_end > 0)))
			dialog_create(DIALOG_OK_CANCEL, 'Cut sample?', do_post_loop_cut, null, 1, null);
		return;
	case KEYSYM.m: if (canmod) sample_amplify_dialog(); return;
	case KEYSYM.n: song_toggle_multichannel_mode(); return;
	case KEYSYM.o: sample_save('ITS'); return;
	case KEYSYM.p: smpprompt_create('Copy sample:', 'Sample', do_copy_sample); return;
	case KEYSYM.q:
		if (canmod) dialog_create(DIALOG_YES_NO, 'Convert sample?', () => SE.sample_toggle_quality(cur(), 1), () => {
			if (cur().flags & C.CHN_STEREO) flash("Can't toggle quality for stereo samples");
			else SE.sample_toggle_quality(cur(), 0);
		}, 0, null);
		return;
	case KEYSYM.r: smpprompt_create('Replace sample with:', 'Sample', do_replace_sample); return;
	case KEYSYM.s: smpprompt_create('Swap sample with:', 'Sample', do_swap_sample); return;
	case KEYSYM.t: sample_save('WAV'); return;
	case KEYSYM.v:
		if (!canmod || (status.flags & CLASSIC_MODE)) return;
		if (!(sample.flags & (C.CHN_LOOP | C.CHN_SUSTAINLOOP))) { dialog_create(DIALOG_OK, 'Crossfade requires a sample loop to work.', null, null, 0, null); return; }
		if (!sample.loop_start && !sample.sustain_start) { dialog_create(DIALOG_OK, 'Crossfade requires data before the sample loop.', null, null, 0, null); return; }
		crossfade_sample_dialog();
		return;
	case KEYSYM.w: sample_save('RAW'); return;
	case KEYSYM.x: smpprompt_create('Exchange sample with:', 'Sample', do_exchange_sample); return;
	case KEYSYM.y: flash('Text synth is not available in this port'); return;
	case KEYSYM.z: flash('AdLib samples are not available in this port'); return;
	case KEYSYM.INSERT: song_insert_sample_slot(current_sample); break;
	case KEYSYM.DELETE: song_remove_sample_slot(current_sample); break;
	case KEYSYM.F9: sample_toggle_mute(current_sample); break;
	case KEYSYM.F10: sample_toggle_solo(current_sample); break;
	default: return;
	}
	status.flags |= NEED_UPDATE;
}

function sample_list_handle_key(k) {
	let new_sample = current_sample;
	const sample = cur(), rel = k.state === KEY_RELEASE;
	switch (k.sym) {
	case KEYSYM.SPACE: if (rel) return; if (app.active_page().selected_widget === 0) status.flags |= NEED_UPDATE; return;
	case KEYSYM.EQUALS: if (!(k.mod & KEYMOD.SHIFT)) return; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.PLUS:
		if (rel) return;
		if (k.mod & KEYMOD.ALT) { sample.c5speed *= 2; status.flags |= SONG_NEEDS_SAVE; }
		else if (k.mod & KEYMOD.CTRL) { sample.c5speed = calc_halftone(sample.c5speed, 1); status.flags |= SONG_NEEDS_SAVE; }
		status.flags |= NEED_UPDATE;
		return;
	case KEYSYM.MINUS:
		if (rel) return;
		if (k.mod & KEYMOD.ALT) { sample.c5speed = Math.trunc(sample.c5speed / 2); status.flags |= SONG_NEEDS_SAVE; }
		else if (k.mod & KEYMOD.CTRL) { sample.c5speed = calc_halftone(sample.c5speed, -1); status.flags |= SONG_NEEDS_SAVE; }
		status.flags |= NEED_UPDATE;
		return;
	case KEYSYM.COMMA: case KEYSYM.LESS: if (rel) return; song_change_current_play_channel(-1, 0); return;
	case KEYSYM.PERIOD: case KEYSYM.GREATER: if (rel) return; song_change_current_play_channel(1, 0); return;
	case KEYSYM.PAGEUP: if (rel) return; new_sample--; break;
	case KEYSYM.PAGEDOWN: if (rel) return; new_sample++; break;
	case KEYSYM.ESCAPE:
		if (k.mod & KEYMOD.SHIFT) {
			if (rel) return;
			cursor.cursor_pos = 25; _fix_accept_text();
			widget_change_focus_to(0);
			status.flags |= NEED_UPDATE;
		}
		return;
	default:
		if (k.mod & KEYMOD.ALT) { if (!rel) sample_list_handle_alt_key(k); }
		else if (!k.is_repeat) {
			const n = k.sym === KEYSYM.SPACE ? last_note : kbd_get_note(k);
			if (n <= 0 || n > 120) return;
			if (rel) song_keyup(current_sample, KEYJAZZ_NOINST, n);
			else { song_keydown(current_sample, KEYJAZZ_NOINST, n, KEYJAZZ_DEFAULTVOL, KEYJAZZ_CHAN_CURRENT); last_note = n; }
		}
		return;
	}
	new_sample = clamp(new_sample, 1, _last_vis_sample());
	if (new_sample !== current_sample) { sample_set(new_sample); sample_list_reposition(); status.flags |= NEED_UPDATE; }
}

function sample_list_draw_const() {
	draw_box(4, 12, 35, 48, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(63, 12, 77, 24, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(36, 12, 53, 18, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(37, 15, 47, 17, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(36, 19, 53, 25, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(37, 22, 47, 24, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(36, 26, 53, 33, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(37, 29, 47, 32, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(36, 35, 53, 41, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(37, 38, 47, 40, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(36, 42, 53, 48, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(37, 45, 47, 47, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(54, 25, 77, 30, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(54, 31, 77, 41, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(54, 42, 77, 48, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_box(55, 45, 72, 47, BOX_THIN | BOX_INNER | BOX_INSET);
	draw_fill_chars(41, 30, 46, 30, DEFAULT_FG, 0);
	draw_fill_chars(64, 13, 76, 23, DEFAULT_FG, 0);
	draw_text('Default Volume', 38, 14, 0, 2);
	draw_text('Global Volume', 38, 21, 0, 2);
	draw_text('Default Pan', 39, 28, 0, 2);
	draw_text('Vibrato Speed', 38, 37, 0, 2);
	draw_text('Vibrato Depth', 38, 44, 0, 2);
	draw_text('Filename', 55, 13, 0, 2);
	draw_text('Speed', 58, 14, 0, 2);
	draw_text('Loop', 59, 15, 0, 2);
	draw_text('LoopBeg', 56, 16, 0, 2);
	draw_text('LoopEnd', 56, 17, 0, 2);
	draw_text('SusLoop', 56, 18, 0, 2);
	draw_text('SusLBeg', 56, 19, 0, 2);
	draw_text('SusLEnd', 56, 20, 0, 2);
	draw_text('Quality', 56, 22, 0, 2);
	draw_text('Length', 57, 23, 0, 2);
	draw_text('Vibrato Waveform', 58, 33, 0, 2);
	draw_text('Vibrato Rate', 60, 44, 0, 2);
	for (let n = 0; n < 13; n++) draw_char(154, 64 + n, 21, 3, 0);
}

function update_sample_loop_flags() {
	const s = cur();
	s.flags &= ~(C.CHN_LOOP | C.CHN_PINGPONGLOOP | C.CHN_SUSTAINLOOP | C.CHN_PINGPONGSUSTAIN);
	switch (widgets[9].d.state) { case 2: s.flags |= C.CHN_PINGPONGLOOP; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case 1: s.flags |= C.CHN_LOOP; }
	switch (widgets[12].d.state) { case 2: s.flags |= C.CHN_PINGPONGSUSTAIN; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case 1: s.flags |= C.CHN_SUSTAINLOOP; }
	if (s.flags & C.CHN_LOOP) {
		if (s.loop_start === s.length) s.loop_start = 0;
		if (s.loop_end <= s.loop_start) s.loop_end = s.length;
	}
	if (s.flags & C.CHN_SUSTAINLOOP) {
		if (s.sustain_start === s.length) s.sustain_start = 0;
		if (s.sustain_end <= s.sustain_start) s.sustain_end = s.length;
	}
	csf_adjust_sample_loop(s);
	song_update_playing_sample(current_sample);
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function update_sample_loop_points() {
	const s = cur();
	let changed = 0;
	const impl = (ks, ke, toggle, ws, we) => {
		if (widgets[ws].d.value > s.length - 1) widgets[ws].d.value = Math.max(0, s.length - 1);
		if (widgets[we].d.value <= widgets[ws].d.value) { widgets[toggle].d.state = 0; changed = 1; }
		else if (widgets[we].d.value > s.length) widgets[we].d.value = s.length;
		if (s[ks] !== widgets[ws].d.value || s[ke] !== widgets[we].d.value) changed = 1;
		s[ks] = widgets[ws].d.value; s[ke] = widgets[we].d.value;
	};
	impl('loop_start', 'loop_end', 9, 10, 11);
	impl('sustain_start', 'sustain_end', 12, 13, 14);
	if (changed) update_sample_loop_flags();
	csf_adjust_sample_loop(s);
	status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE;
}
function update_values_in_song() {
	const s = cur();
	s.volume = widgets[1].d.value * 4;
	s.global_volume = widgets[2].d.value;
	if (widgets[3].d.state) s.flags |= C.CHN_PANNING; else s.flags &= ~C.CHN_PANNING;
	s.vib_speed = widgets[5].d.value;
	s.vib_depth = widgets[6].d.value;
	s.vib_type = widgets[15].d.state ? C.VIB_SINE : widgets[16].d.state ? C.VIB_RAMP_DOWN : widgets[17].d.state ? C.VIB_SQUARE : C.VIB_RANDOM;
	s.vib_rate = widgets[19].d.value;
	status.flags |= SONG_NEEDS_SAVE;
}
function update_sample_speed() { cur().c5speed = widgets[8].d.value; status.flags |= NEED_UPDATE | SONG_NEEDS_SAVE; }
function update_panning() {
	const s = cur();
	s.flags |= C.CHN_PANNING;
	s.panning = widgets[4].d.value * 4;
	widgets[3].d.state = 1;
	status.flags |= SONG_NEEDS_SAVE;
}

export function sample_is_used_by_instrument(samp) {
	if (samp < 1) return 0;
	for (const ins of current_song.instruments) if (ins) for (let j = 0; j < 120; j++) if (ins.sample_map[j] === samp) return 1;
	return 0;
}
export function sample_synchronize_to_instrument() {
	const instnum = app.instrument_get_current(), ins = song_get_instrument(instnum);
	let first = 0;
	for (let pos = 0; pos < 120; pos++) {
		if (first === 0) first = ins.sample_map[pos];
		if (ins.sample_map[pos] === instnum) { sample_set(instnum); return; }
	}
	sample_set(first > 0 ? first : instnum);
}

function sample_list_load_page(page) {
	widgets = [
		widget_create_other(1, sample_list_handle_key_on_list, sample_list_handle_text_input_on_list, sample_list_draw_list),
		widget_create_thumbbar(38, 16, 9, 1, 2, 7, update_values_in_song, 0, 64),
		widget_create_thumbbar(38, 23, 9, 1, 3, 7, update_values_in_song, 0, 64),
		widget_create_toggle(38, 30, 2, 4, 0, 7, 7, update_values_in_song),
		widget_create_thumbbar(38, 31, 9, 3, 5, 7, update_panning, 0, 64),
		widget_create_thumbbar(38, 39, 9, 4, 6, 15, update_values_in_song, 0, 64),
		widget_create_thumbbar(38, 46, 9, 5, 6, 19, update_values_in_song, 0, 32),
		widget_create_textentry(64, 13, 13, 7, 8, 0, () => { status.flags |= SONG_NEEDS_SAVE; }, filename_ref, 12),
		widget_create_numentry(64, 14, 7, 7, 9, 0, update_sample_speed, 0, 9999999, numentry_cursor),
		widget_create_menutoggle(64, 15, 8, 10, 1, 0, 0, update_sample_loop_flags, loop_states),
		widget_create_numentry(64, 16, 7, 9, 11, 0, update_sample_loop_points, 0, 9999999, numentry_cursor),
		widget_create_numentry(64, 17, 7, 10, 12, 0, update_sample_loop_points, 0, 9999999, numentry_cursor),
		widget_create_menutoggle(64, 18, 11, 13, 1, 0, 0, update_sample_loop_flags, loop_states),
		widget_create_numentry(64, 19, 7, 12, 14, 0, update_sample_loop_points, 0, 9999999, numentry_cursor),
		widget_create_numentry(64, 20, 7, 13, 15, 0, update_sample_loop_points, 0, 9999999, numentry_cursor),
		widget_create_togglebutton(57, 36, 6, 14, 17, 5, 16, 16, update_values_in_song, '\xb9\xba', 3, vibrato_waveforms),
		widget_create_togglebutton(67, 36, 6, 14, 18, 15, 0, 0, update_values_in_song, '\xbd\xbe', 3, vibrato_waveforms),
		widget_create_togglebutton(57, 39, 6, 15, 19, 5, 18, 18, update_values_in_song, '\xbb\xbc', 3, vibrato_waveforms),
		widget_create_togglebutton(67, 39, 6, 16, 19, 17, 0, 0, update_values_in_song, 'Random', 1, vibrato_waveforms),
		widget_create_thumbbar(56, 46, 16, 17, 19, 0, update_values_in_song, 0, 255),
	];
	Object.assign(widgets[0], { x: 5, y: 13, width: 30, height: 35 });
	_fix_accept_text();
	Object.assign(page, { title: 'Sample List (F3)', draw_const: sample_list_draw_const, predraw_hook: sample_list_predraw_hook,
		handle_key: sample_list_handle_key, set_page: sample_list_reposition, total_widgets: 20, widgets,
		help_index: HELP.SAMPLE_LIST, ported: true });
}
sample_list_load_page(pages[PAGE.SAMPLE_LIST]);

provide({ sample_get_current, sample_set, sample_is_used_by_instrument, sample_synchronize_to_instrument });
