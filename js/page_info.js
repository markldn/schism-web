// Port of schism/page_info.c (Schism Tracker, GPL-2.0-or-later).
// Window layout is not saved to a config file (cfg_save_info / cfg_load_info).
import { app, provide } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, HELP, NEED_UPDATE, CLASSIC_MODE } from './state.js';
import { draw_text, draw_text_len, draw_char, draw_box, draw_fill_chars, draw_vu_meter, draw_thumb_bar,
	draw_half_width_chars, DEFAULT_FG, BOX_THICK, BOX_INNER, BOX_INSET } from './vgamem.js';
import { KEYSYM, KEYMOD, KEY_PRESS, KEY_RELEASE, NO_MODIFIER, MOUSE_CLICK, MOUSE_DBLCLICK } from './keyboard.js';
import { widget_create_other, str_from_num, str_from_num99 } from './widget.js';
import { pages, set_page } from './page.js';
import * as PV from './pattern-view.js';
import { current_song, song_get_mode, MODE_STOPPED, MODE_PLAYING, MODE_PATTERN_LOOP, song_is_instrument_mode,
	song_is_stereo, song_get_current_row, song_get_current_order, song_get_playing_pattern, song_get_pattern,
	song_get_pattern_buf, song_get_playing_channels, song_get_max_channels, song_get_current_global_volume,
	song_get_instrument_number, song_flip_stereo, song_toggle_stereo, song_toggle_channel_mute,
	song_handle_channel_solo, song_find_last_channel, song_set_current_order } from './song.js';
import { csf_calculate_vu_meters } from './csndfile.js';

const MAX_CHANNELS = 64, MAX_VOICES = 256, MAX_SAMPLES = 236;
let velocity_mode = 0, instrument_names = 0;
let selected_window = 0, num_windows = 3, selected_channel = 1;
const MAX_WINDOWS = 5;
// cfg_load_info_old() fallback defaults: samples, active channels, 24-channel track view
const windows = [{ type: 0, height: 19, first_channel: 1 }, { type: 9, height: 3, first_channel: 1 }, { type: 6, height: 15, first_channel: 1 }];
const blank_note = { note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0 };
const flash = t => app.status_text_flash(t);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const has_data = v => (v.current_sample_data && v.length) || (v.flags & C.CHN_ADLIB);
const sample_index = s => s ? current_song.samples.indexOf(s) : -1;
function chan_fg(c, active, muted) { return c === selected_channel ? (muted ? 6 : 3) : (muted ? 2 : active ? 1 : 0); }

function info_draw_technical(base, height, active, first_channel) {
	draw_fill_chars(5, base + 1, 29, base + height - 2, DEFAULT_FG, 0);
	draw_box(4, base, 30, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_text('Frequency', 6, base, 2, 1);
	draw_text('Position', 17, base, 2, 1);
	draw_text('Smp', 27, base, 2, 1);
	draw_fill_chars(32, base + 1, 56, base + height - 2, DEFAULT_FG, 0);
	draw_box(31, base, 57, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	[['FVl', 32], ['Vl', 36], ['CV', 39], ['SV', 42], ['VE', 45], ['Fde', 48], ['Pn', 52], ['PE', 55]].forEach(([t, x]) => draw_text(t, x, base, 2, 1));
	const insmode = song_is_instrument_mode();
	if (insmode) {
		draw_fill_chars(59, base + 1, 65, base + height - 2, DEFAULT_FG, 0);
		draw_box(58, base, 66, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
		draw_text('NNA', 59, base, 2, 1);
		draw_text('Tot', 63, base, 2, 1);
	}
	for (let pos = base + 1, c = first_channel; pos < base + height - 1; pos++, c++) {
		const channel = current_song.channels[c - 1], voice = current_song.voices[c - 1];
		draw_text(str_from_num99(c), 2, pos, chan_fg(c, active, channel.flags & C.CHN_MUTE), 2);
		for (const x of [15, 26, 35, 38, 41, 44, 47, 51, 54]) draw_char(168, x, pos, 2, 0);
		if (insmode) {
			draw_text('---\xa8', 59, pos, 2, 0);
			let tot = 0;
			for (let nv = 0; nv < MAX_VOICES; nv++) {
				const v = current_song.voices[nv];
				if (v.master_channel === c && has_data(v)) tot++;
			}
			if (has_data(voice)) tot++;
			draw_text(str_from_num(3, tot), 63, pos, 2, 0);
		}
		if (!(has_data(voice) && voice.ptr_sample)) continue;
		const smp = sample_index(voice.ptr_sample);
		if (smp <= 0 || smp >= MAX_SAMPLES) continue;
		draw_text(String(voice.sample_freq >>> 0).padStart(10), 5, pos, 2, 0);
		draw_text(String(Number(voice.position.v >> 32n)).padStart(10), 16, pos, 2, 0);
		draw_text(str_from_num(3, smp), 27, pos, 2, 0);
		draw_text(str_from_num(3, voice.final_volume >> 7), 32, pos, 2, 0);
		draw_text(str_from_num(2, voice.volume >> 2), 36, pos, 2, 0);
		draw_text(str_from_num(2, voice.global_volume), 39, pos, 2, 0);
		draw_text(str_from_num(2, voice.ptr_sample.global_volume), 42, pos, 2, 0);
		draw_text(str_from_num(2, voice.instrument_volume), 45, pos, 2, 0);
		draw_text(str_from_num(3, voice.fadeout_volume >> 7), 48, pos, 2, 0);
		if (voice.flags & C.CHN_SURROUND) draw_text('Su', 52, pos, 2, 0);
		else draw_text(str_from_num(2, voice.panning >> 2), 52, pos, 2, 0);
		draw_text(str_from_num(2, voice.final_panning >> 2), 55, pos, 2, 0);
		if (insmode) draw_text(['Cut', 'Con', 'Off', 'Fde'][voice.nna] || '???', 59, pos, 2, 0);
	}
}

function info_draw_samples(base, height, active, first_channel) {
	draw_fill_chars(5, base + 1, 28, base + height - 2, DEFAULT_FG, 0);
	draw_fill_chars(31, base + 1, 61, base + height - 2, DEFAULT_FG, 0);
	draw_box(4, base, 29, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	draw_box(30, base, 62, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	if (song_is_stereo()) {
		draw_fill_chars(64, base + 1, 72, base + height - 2, DEFAULT_FG, 0);
		draw_box(63, base, 73, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	} else draw_fill_chars(63, base, 73, base + height, DEFAULT_FG, 2);
	if (song_get_mode() === MODE_STOPPED) {
		for (let pos = base + 1, c = first_channel; pos < base + height - 1; pos++, c++) {
			const muted = current_song.channels[c - 1].flags & C.CHN_MUTE;
			if (c !== selected_channel && muted) continue;
			draw_text(str_from_num(2, c), 2, pos, chan_fg(c, active, muted), 2);
		}
		return;
	}
	const vus = csf_calculate_vu_meters(current_song, new Float32Array(MAX_CHANNELS));
	for (let pos = base + 1, c = first_channel; pos < base + height - 1; pos++, c++) {
		const voice = current_song.voices[c - 1];
		const muted = voice.flags & C.CHN_MUTE;
		if (c === selected_channel || !muted) draw_text(str_from_num(2, c), 2, pos, chan_fg(c, active, muted), 2);
		if (!has_data(voice)) continue;
		const vu = velocity_mode ? voice.final_volume >> 8 : Math.trunc(vus[c - 1] * 64);
		draw_vu_meter(5, pos, 24, vu, muted ? 1 : 5, muted ? 2 : 4);
		let ins = song_get_instrument_number(voice.ptr_instrument);
		let smp = voice.ptr_sample ? sample_index(voice.ptr_sample) : 0;
		if (!voice.ptr_sample) ins = 0;
		if (smp < 0 || smp >= MAX_SAMPLES) smp = ins = 0;
		const fgc = voice.volume === 0 ? 4 : (voice.flags & (C.CHN_KEYOFF | C.CHN_NOTEFADE)) ? 7 : 6;
		if (smp) {
			draw_text(str_from_num99(smp), 31, pos, 6, 0);
			let n = 33;
			if (ins) { draw_char(47, 33, pos, 6, 0); draw_text(str_from_num99(ins), 34, pos, 6, 0); n = 36; }
			draw_char(58, n++, pos, fgc, 0);
			const name = instrument_names && voice.ptr_instrument ? voice.ptr_instrument.name : current_song.samples[smp].name;
			draw_text_len(name, 25, n, pos, 6, 0);
		} else continue;
		if (song_is_stereo() && voice.ptr_sample) {
			if (voice.flags & C.CHN_SURROUND) draw_text('Surround', 64, pos, 2, 0);
			else if (voice.final_panning >> 2 === 0) draw_text('Left', 64, pos, 2, 0);
			else if ((voice.final_panning + 3) >> 2 === 64) draw_text('Right', 68, pos, 2, 0);
			else draw_thumb_bar(64, pos, 9, 0, 256, voice.final_panning, 0);
		}
	}
}

function _draw_fill_notes(col, first_row, height, num_channels, channel_width, separator, draw_note, bg) {
	for (let row_pos = first_row; row_pos < first_row + height; row_pos++) {
		let chan_pos;
		for (chan_pos = 0; chan_pos < num_channels - 1; chan_pos++) {
			draw_note(col + channel_width * chan_pos, row_pos, blank_note, -1, 6, bg);
			if (separator) draw_char(168, col - 1 + channel_width * (chan_pos + 1), row_pos, 2, bg);
		}
		draw_note(col + channel_width * chan_pos, row_pos, blank_note, -1, 6, bg);
	}
}
function _draw_track_view(base, height, first_channel, num_channels, channel_width, separator, draw_note) {
	const current_row = song_get_current_row(), current_order = song_get_current_order(), ol = current_song.orderlist;
	let cur_pattern, prev_pattern = null, next_pattern = null, cur_rows = 0, prev_rows = 0, next_rows = 0;
	if (separator) channel_width++;
	const mode = song_get_mode();
	if (mode === MODE_PATTERN_LOOP) {
		const p = song_get_playing_pattern();
		cur_pattern = prev_pattern = next_pattern = song_get_pattern_buf(p);
		cur_rows = prev_rows = next_rows = song_get_pattern(p);
	} else if (mode === MODE_PLAYING && ol[current_order] < 200) {
		cur_pattern = song_get_pattern_buf(ol[current_order]); cur_rows = song_get_pattern(ol[current_order]);
		if (current_order > 0 && ol[current_order - 1] < 200) { prev_pattern = song_get_pattern_buf(ol[current_order - 1]); prev_rows = song_get_pattern(ol[current_order - 1]); }
		if (current_order < 255 && ol[current_order + 1] < 200) { next_pattern = song_get_pattern_buf(ol[current_order + 1]); next_rows = song_get_pattern(ol[current_order + 1]); }
	} else {
		draw_fill_chars(5, base + 1, 4 + num_channels * channel_width - (separator ? 1 : 0), base + height - 2, DEFAULT_FG, 0);
		return;
	}
	const rows_before = (height - 3) >> 1;
	if (num_channels > 64) {
		_draw_fill_notes(5 + 64, base + 1, height - 2, num_channels - 64, channel_width, separator, draw_note, 0);
		_draw_fill_notes(5 + 64, base + 1 + rows_before, 1, num_channels - 64, channel_width, separator, draw_note, 14);
		num_channels = 64;
	}
	const draw_row = (pattern, row, row_pos, bg) => {
		draw_text(str_from_num(3, row), 1, row_pos, 0, 2);
		let chan_pos;
		for (chan_pos = 0; chan_pos < num_channels - 1; chan_pos++) {
			draw_note(5 + channel_width * chan_pos, row_pos, pattern[64 * row + first_channel - 1 + chan_pos], -1, 6, bg);
			if (separator) draw_char(168, 4 + channel_width * (chan_pos + 1), row_pos, 2, bg);
		}
		draw_note(5 + channel_width * chan_pos, row_pos, pattern[64 * row + first_channel - 1 + chan_pos], -1, 6, bg);
	};
	let pattern = cur_pattern, total = cur_rows, row = current_row - 1, row_pos = base + rows_before;
	while (row_pos > base) {
		if (row < 0) {
			if (!prev_pattern) { _draw_fill_notes(5, base + 1, row_pos - base, num_channels, channel_width, separator, draw_note, 0); break; }
			pattern = prev_pattern; total = prev_rows; row = total - 1;
		}
		draw_row(pattern, row, row_pos, 0);
		row--; row_pos--;
	}
	row_pos = base + rows_before + 1;
	if (current_row < cur_rows) draw_row(cur_pattern, current_row, row_pos, 14);
	pattern = cur_pattern; total = cur_rows; row = current_row + 1; row_pos++;
	while (row_pos < base + height - 1) {
		if (row >= total) {
			if (!next_pattern) { _draw_fill_notes(5, row_pos, base + height - row_pos - 1, num_channels, channel_width, separator, draw_note, 0); break; }
			pattern = next_pattern; total = next_rows; row = 0;
		}
		draw_row(pattern, row, row_pos, 0);
		row++; row_pos++;
	}
}
function track_fg(chan, active, sel_mute = 6, mute = 1, sel = 3, act = 2, idle = 0) {
	return current_song.channels[chan - 1].flags & C.CHN_MUTE ? (chan === selected_channel ? sel_mute : mute) : (chan === selected_channel ? sel : active ? act : idle);
}
function track_view(n) {
	return (base, height, active, first_channel) => {
		switch (n) {
		case 5:
			draw_box(4, base, 74, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
			for (let c = first_channel, p = 0; p < 5; c++, p++) PV.draw_channel_header_13(c, 5 + 14 * p, base, track_fg(c, active));
			_draw_track_view(base, height, first_channel, 5, 13, 1, PV.draw_note_13);
			break;
		case 8: case 10: {
			const [right, step, start, cw, sep, dn] = n === 8 ? [76, 9, 6, 8, 1, PV.draw_note_8] : [75, 7, 5, 7, 0, PV.draw_note_7];
			draw_box(4, base, right, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
			for (let c = first_channel, p = 0; p < n; c++, p++) {
				const x = start + step * p;
				draw_char(0, x, base, 1, 1); draw_char(0, x + 1, base, 1, 1);
				draw_text(str_from_num(2, c), x + 2, base, track_fg(c, active), 1);
				draw_char(0, x + 4, base, 1, 1); draw_char(0, x + 5, base, 1, 1);
			}
			_draw_track_view(base, height, first_channel, n, cw, sep, dn);
			break;
		}
		case 12:
			draw_box(4, base, 77, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
			for (let c = first_channel, p = 0; p < 12; c++, p++) {
				draw_char(0, 5 + 6 * p + 1, base, 1, 1);
				draw_text(str_from_num(2, c), 5 + 6 * p + 2, base, track_fg(c, active), 1);
				draw_char(0, 5 + 6 * p + 4, base, 1, 1);
			}
			_draw_track_view(base, height, first_channel, 12, 6, 0, PV.draw_note_6);
			break;
		case 18: case 24: case 36: {
			const [right, step, off, cw, sep, dn] = n === 18 ? [76, 4, 1, 3, 1, PV.draw_note_3] : n === 24 ? [77, 3, 1, 3, 0, PV.draw_note_3] : [77, 2, 0, 2, 0, PV.draw_note_2];
			draw_box(4, base, right, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
			for (let c = first_channel, p = 0; p < n; c++, p++) draw_text(str_from_num(2, c), 5 + step * p + off, base, track_fg(c, active), 1);
			_draw_track_view(base, height, first_channel, n, cw, sep, dn);
			break;
		}
		case 64: {
			const nchan = status.flags & CLASSIC_MODE ? 73 : 64;
			draw_box(4, base, nchan + 5, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
			let p = 0;
			for (let c = 1; p < 64; c++, p++) {
				const fg = track_fg(c, active, 14, 9, 3, 10, 8);
				draw_half_width_chars(48 + Math.trunc(c / 10), 48 + c % 10, 5 + p, base, fg, 1, fg, 1);
			}
			for (; p < nchan; p++) draw_char(0, 5 + p, base, 1, 1);
			_draw_track_view(base, height, 1, nchan, 1, 0, PV.draw_note_1);
			break;
		}
		}
	};
}
function info_draw_channels(base, height, active) {
	const fg = active ? 3 : 0;
	draw_text(`Active Channels: ${song_get_playing_channels()} (${song_get_max_channels()})`, 2, base, fg, 2);
	draw_text(`Global Volume: ${song_get_current_global_volume()}`, 4, base + 1, fg, 2);
}
function info_draw_note_dots(base, height, active, first_channel) {
	const dot = Array.from({ length: 73 }, () => new Uint8Array(36));
	draw_fill_chars(5, base + 1, 77, base + height - 2, DEFAULT_FG, 0);
	draw_box(4, base, 78, base + height - 1, BOX_THICK | BOX_INNER | BOX_INSET);
	for (let n = 0; n < MAX_VOICES; n++) {
		const voice = current_song.voices[n];
		if (!(voice.ptr_sample && voice.note >= 31 && voice.note <= 103)) continue;
		let pos = voice.master_channel ? voice.master_channel : 1 + n;
		if (pos < first_channel) continue;
		pos -= first_channel;
		if (pos > height - 1 || pos >= 36) continue;
		const fg = voice.flags & C.CHN_MUTE ? 1 : (sample_index(voice.ptr_sample) % 4 + 2);
		const v = velocity_mode || (status.flags & CLASSIC_MODE) ? (voice.final_volume + 2047) >> 11 : (voice.vu_meter + 31) >> 5;
		const dn = ((Math.min(v, 15)) << 4) | fg;
		if (dn > dot[voice.note - 31][pos]) dot[voice.note - 31][pos] = dn;
	}
	for (let c = first_channel, pos = 0; pos < height - 2; pos++, c++) {
		for (let n = 0; n < 73; n++) {
			const d = (pos < 36 && dot[n][pos]) || 0x06;
			draw_char((d >> 4) + 193, n + 5, pos + base + 1, d & 15, 0);
		}
		const muted = current_song.channels[c - 1] && current_song.channels[c - 1].flags & C.CHN_MUTE;
		if (c !== selected_channel && muted) continue;
		if (c <= 64) draw_text(str_from_num(2, c), 2, pos + base + 1, chan_fg(c, active, muted), 2);
	}
}

function click_chn_x(x, w, skip, fc) {
	while (x > 0 && fc <= 64) {
		if (x < w) { selected_channel = clamp(fc, 1, 64); return; }
		fc++; x -= w + skip;
	}
}
function click_chn_is_x(x, y, nc, fc) {
	if (x < 5) return;
	x -= 4;
	const t = { 5: [13, 1], 10: [7, 0], 12: [6, 0], 18: [3, 1], 24: [3, 0], 36: [2, 0], 64: [1, 0] }[nc];
	if (t) click_chn_x(x, t[0], t[1], fc);
}
const click_chn_is_y_nohead = (x, y, nc, fc) => { selected_channel = clamp(y + fc, 1, 64); };
const click_chn_is_y = (x, y, nc, fc) => { if (y) selected_channel = clamp(y + fc - 1, 1, 64); };
const click_chn_nil = () => {};

const window_types = [
	{ draw: info_draw_samples, click: click_chn_is_y_nohead, first_row: 0, channels: -2 },
	...[5, 8, 10, 12, 18, 24, 36, 64].map(n => ({ draw: track_view(n), click: click_chn_is_x, first_row: 1, channels: n })),
	{ draw: info_draw_channels, click: click_chn_nil, first_row: 1, channels: 0 },
	{ draw: info_draw_note_dots, click: click_chn_is_y_nohead, first_row: 0, channels: -2 },
	{ draw: info_draw_technical, click: click_chn_is_y, first_row: 1, channels: -2 },
];

function _fix_channels(n) {
	const w = windows[n];
	let channels = window_types[w.type].channels;
	if (channels === 0) return;
	if (channels < 0) {
		channels += w.height;
		if (n === 0 && !window_types[w.type].first_row) channels++;
	}
	if (selected_channel < w.first_channel) w.first_channel = selected_channel;
	else if (selected_channel >= w.first_channel + channels) w.first_channel = selected_channel - channels + 1;
	w.first_channel = clamp(w.first_channel, 1, MAX_CHANNELS - channels + 1);
}
function info_handle_click(x, y) {
	if (y < 13) return 0;
	y -= 13;
	for (let n = 0; n < num_windows; n++) {
		if (y < windows[n].height) {
			window_types[windows[n].type].click(x, y, window_types[windows[n].type].channels, windows[n].first_channel);
			return 1;
		}
		y -= windows[n].height;
	}
	return 0;
}
function recalculate_windows() {
	let pos = 13, n;
	for (n = 0; n < num_windows - 1; n++) {
		_fix_channels(n);
		pos += windows[n].height;
		if (pos > 50) num_windows = n;
	}
	windows[n].height = 50 - pos;
	_fix_channels(n);
}
function info_page_redraw() {
	let pos = window_types[windows[0].type].first_row ? 13 : 12, n;
	for (n = 0; n < num_windows - 1; n++) {
		let height = windows[n].height;
		if (pos === 12) height++;
		window_types[windows[n].type].draw(pos, height, n === selected_window, windows[n].first_channel);
		pos += height;
	}
	window_types[windows[n].type].draw(pos, 50 - pos, n === selected_window, windows[n].first_channel);
}

function goto_pattern() {
	app.set_current_channel(selected_channel);
	const order = song_get_current_order();
	const n = song_get_mode() === MODE_PLAYING ? current_song.orderlist[order] : song_get_playing_pattern();
	if (n < 200) {
		app.set_current_order(order);
		app.set_current_pattern(n);
		app.set_current_row(song_get_current_row());
		set_page(PAGE.PATTERN_EDITOR);
	}
}
function info_page_handle_key(k) {
	let n;
	if (k.mouse === MOUSE_CLICK || k.mouse === MOUSE_DBLCLICK) {
		const p = selected_channel;
		n = info_handle_click(k.x, k.y);
		if (k.mouse === MOUSE_DBLCLICK && p === selected_channel) { goto_pattern(); return 1; }
		status.flags |= NEED_UPDATE;
		return n;
	}
	if (k.sym === KEYSYM.KP_9) k.sym = KEYSYM.F9;
	else if (k.sym === KEYSYM.KP_0) k.sym = KEYSYM.F10;
	const rel = k.state === KEY_RELEASE, nm = NO_MODIFIER(k.mod);
	const recheck = () => app.orderpan_recheck_muted_channels();
	switch (k.sym) {
	case KEYSYM.g: if (k.state === KEY_PRESS) return 1; goto_pattern(); return 1;
	case KEYSYM.v: if (rel) return 1; velocity_mode = !velocity_mode; flash(`Using ${velocity_mode ? 'velocity' : 'volume'} bars`); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.i: if (rel) return 1; instrument_names = !instrument_names; flash(`Using ${instrument_names ? 'instrument' : 'sample'} names`); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.r:
		if (k.mod & KEYMOD.ALT) { if (rel) return 1; song_flip_stereo(); flash('Left/right outputs reversed'); return 1; }
		return 0;
	case KEYSYM.EQUALS: if (!(k.mod & KEYMOD.SHIFT)) return 0; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case KEYSYM.PLUS: if (rel) return 1; if (song_get_mode() === MODE_PLAYING) song_set_current_order(song_get_current_order() + 1); return 1;
	case KEYSYM.MINUS: if (rel) return 1; if (song_get_mode() === MODE_PLAYING) song_set_current_order(song_get_current_order() - 1); return 1;
	case KEYSYM.q: if (rel) return 1; song_toggle_channel_mute(selected_channel - 1); recheck(); status.flags |= NEED_UPDATE; return 1;
	case KEYSYM.s:
		if (rel) return 1;
		if (k.mod & KEYMOD.ALT) { song_toggle_stereo(); flash(`Stereo ${song_is_stereo() ? 'Enabled' : 'Disabled'}`); }
		else { song_handle_channel_solo(selected_channel - 1); recheck(); }
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.SPACE:
		if (!nm) return 0; if (rel) return 1;
		song_toggle_channel_mute(selected_channel - 1);
		if (selected_channel < MAX_CHANNELS) selected_channel++;
		recheck();
		break;
	case KEYSYM.UP:
		if (rel) return 1;
		if (k.mod & KEYMOD.ALT) {
			if (selected_window === num_windows - 1 || windows[selected_window].height === 3) return 1;
			windows[selected_window].height--; windows[selected_window + 1].height++;
			break;
		}
		if (selected_channel > 1) selected_channel--;
		break;
	case KEYSYM.LEFT: if (!nm && !(k.mod & KEYMOD.ALT)) return 0; if (rel) return 1; if (selected_channel > 1) selected_channel--; break;
	case KEYSYM.DOWN:
		if (rel) return 1;
		if (k.mod & KEYMOD.ALT) {
			if (selected_window === num_windows - 1 || windows[selected_window + 1].height === 3) return 1;
			windows[selected_window].height++; windows[selected_window + 1].height--;
			break;
		}
		if (selected_channel < MAX_CHANNELS) selected_channel++;
		break;
	case KEYSYM.RIGHT: if (!nm && !(k.mod & KEYMOD.ALT)) return 0; if (rel) return 1; if (selected_channel < MAX_CHANNELS) selected_channel++; break;
	case KEYSYM.HOME: if (!nm) return 0; if (rel) return 1; selected_channel = 1; break;
	case KEYSYM.END: if (!nm) return 0; if (rel) return 1; selected_channel = song_find_last_channel() + 1; break;
	case KEYSYM.INSERT: {
		if (!nm) return 0; if (rel) return 1;
		if (num_windows === MAX_WINDOWS || windows[selected_window].height < 6) return 1;
		num_windows++;
		windows.splice(selected_window + 1, 0, { ...windows[selected_window] });
		n = windows[selected_window].height;
		windows[selected_window].height = windows[selected_window + 1].height = n >> 1;
		if ((n & 1) && num_windows !== 2) windows[selected_window + 1].height++;
		break;
	}
	case KEYSYM.DELETE:
		if (!nm) return 0; if (rel) return 1;
		if (num_windows === 1) return 1;
		n = windows[selected_window].height + (windows[selected_window + 1] ? windows[selected_window + 1].height : 0);
		windows.splice(selected_window, 1);
		windows[Math.min(selected_window, windows.length - 1)].height = n;
		num_windows--;
		if (selected_window === num_windows) selected_window--;
		break;
	case KEYSYM.PAGEUP: if (!nm) return 0; if (rel) return 1; n = windows[selected_window].type; windows[selected_window].type = (n === 0 ? window_types.length : n) - 1; break;
	case KEYSYM.PAGEDOWN: if (!nm) return 0; if (rel) return 1; windows[selected_window].type = (windows[selected_window].type + 1) % window_types.length; break;
	case KEYSYM.TAB:
		if (rel) return 1;
		if (k.mod & KEYMOD.SHIFT) { if (selected_window === 0) selected_window = num_windows; selected_window--; }
		else selected_window = (selected_window + 1) % num_windows;
		status.flags |= NEED_UPDATE;
		return 1;
	case KEYSYM.F9:
		if (rel) return 1;
		if (k.mod & KEYMOD.ALT) { song_toggle_channel_mute(selected_channel - 1); recheck(); return 1; }
		return 0;
	case KEYSYM.F10:
		if (k.mod & KEYMOD.ALT) { if (rel) return 1; song_handle_channel_solo(selected_channel - 1); recheck(); return 1; }
		return 0;
	default: return 0;
	}
	recalculate_windows();
	status.flags |= NEED_UPDATE;
	return 1;
}

Object.assign(pages[PAGE.INFO], { title: 'Info Page (F5)', ported: true, help_index: HELP.INFO_PAGE,
	playback_update: () => { if (song_get_mode() !== MODE_STOPPED) status.flags |= NEED_UPDATE; },
	widgets: [widget_create_other(0, info_page_handle_key, null, info_page_redraw)], total_widgets: 1 });
provide({});
