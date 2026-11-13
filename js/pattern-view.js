// Port of schism/pattern-view.c (Schism Tracker, GPL-2.0-or-later).
import { draw_char as draw_char_n, draw_text, draw_half_width_chars as dhw } from './vgamem.js';
import { get_note_string, get_note_string_short, get_volume_string, get_effect_char, hexdigits } from './keyboard.js';
import { str_from_num99 } from './widget.js';
import * as C from './sndconst.js';
import { app } from './app.js';

export const MASK_NOTE = 1, MASK_INSTRUMENT = 2, MASK_VOLUME = 4, MASK_EFFECT = 8;
export const view = { show_default_volumes: 0 };

const code = c => typeof c === 'number' ? c : c ? c.charCodeAt(0) : 0;
const draw_char = (c, x, y, fg, bg) => draw_char_n(code(c), x, y, fg, bg);
const draw_half_width_chars = (c1, c2, x, y, fg1, bg1, fg2, bg2) => dhw(code(c1), code(c2), x, y, fg1, bg1, fg2, bg2);
const pad2 = n => n.toString(16).toUpperCase().padStart(2, '0');
const insstr = n => n ? str_from_num99(n) : '\xAD\xAD';
const effstr = note => get_effect_char(note.effect) + pad2(note.param);

const mask_chars = ['\x8F', '\x8F', '\xA9', '\xA9', '\xAA', '\xA9', '\xAB', '\xAB'];
function MASK_CHAR(mask, cursor_pos, field, pos, pos2) {
	return mask_chars[(cursor_pos === 0 ? 1 : 0) | (cursor_pos === pos ? 2 : 0)
		| (pos2 && cursor_pos === pos2 ? 2 : 0) | (mask & field ? 4 : 0)];
}
const MC = (mask, cp) => (f, p, p2) => MASK_CHAR(mask, cp, f, p, p2);

// 13-column
export function draw_channel_header_13(chan, x, y, fg) { draw_text(` Channel ${String(chan).padStart(2, '0')} `, x, y, fg, 1); }
export function draw_note_13(x, y, note, cursor_pos, fg, bg) {
	const map = [0, 2, 4, 5, 7, 8, 10, 11, 12];
	const vol_buf = get_volume_string(note.volparam, note.voleffect);
	let t = get_note_string(note.note) + ' ' + insstr(note.instrument) + ' ' + vol_buf + ' ' + effstr(note);
	if (view.show_default_volumes && note.voleffect === C.VOLFX_NONE && note.instrument > 0 && note.note > 0 && note.note <= 120) {
		const smp = app.song_is_instrument_mode()
			? app.csf_translate_keyboard(app.current_song(), app.song_get_instrument(note.instrument), note.note, null)
			: app.song_get_sample(note.instrument);
		if (smp) {
			const n = smp.volume >> 2;
			t = t.slice(0, 6) + '\xBF' + String.fromCharCode(48 + Math.trunc(n / 10) % 10, 48 + n % 10) + '\xC0' + t.slice(10);
		}
	}
	draw_text(t, x, y, fg, bg);
	if (note.voleffect === C.VOLFX_PANNING) draw_text(vol_buf, x + 7, y, 2, bg);
	if (cursor_pos === 9) draw_text(t.slice(10), x + 10, y, 0, 3);
	else if (cursor_pos >= 0) { const p = map[cursor_pos]; draw_char(t[p], x + p, y, 0, 3); }
}
export function draw_mask_13(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	draw_text(m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 1) + '\x8F'
		+ m(MASK_INSTRUMENT, 2, 0) + m(MASK_INSTRUMENT, 3, 0) + '\x8F'
		+ m(MASK_VOLUME, 4, 0) + m(MASK_VOLUME, 5, 0) + '\x8F'
		+ m(MASK_EFFECT, 6, 0) + m(MASK_EFFECT, 7, 0) + m(MASK_EFFECT, 8, 0), x, y, fg, bg);
}

// 10-column
export function draw_channel_header_10(chan, x, y, fg) { draw_text(`Channel ${String(chan).padStart(2, '0')}`, x, y, fg, 1); }
export function draw_note_10(x, y, note, cursor_pos, fg, bg) {
	const note_buf = get_note_string(note.note), ins_buf = insstr(note.instrument);
	const vol_buf = get_volume_string(note.volparam, note.voleffect), effect_buf = effstr(note);
	draw_text(note_buf, x, y, 6, bg);
	draw_text(ins_buf, x + 3, y, note.instrument ? 10 : 2, bg);
	draw_text(vol_buf, x + 5, y, note.voleffect === C.VOLFX_PANNING ? 2 : 6, bg);
	draw_text(effect_buf, x + 7, y, 2, bg);
	if (cursor_pos < 0) return;
	if (cursor_pos > 0) cursor_pos++;
	if (cursor_pos === 10) { draw_text(effect_buf, x + 7, y, 0, 3); return; }
	let c;
	switch (cursor_pos) {
	case 0: c = note_buf[0]; break;
	case 2: c = note_buf[2]; break;
	case 3: c = ins_buf[0]; break;
	case 4: c = ins_buf[1]; break;
	case 5: c = vol_buf[0]; break;
	case 6: c = vol_buf[1]; break;
	default: c = effect_buf[cursor_pos - 7];
	}
	draw_char(c, x + cursor_pos, y, 0, 3);
}
export function draw_mask_10(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	draw_text(m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 1)
		+ m(MASK_INSTRUMENT, 2, 0) + m(MASK_INSTRUMENT, 3, 0)
		+ m(MASK_VOLUME, 4, 0) + m(MASK_VOLUME, 5, 0)
		+ m(MASK_EFFECT, 6, 0) + m(MASK_EFFECT, 7, 0) + m(MASK_EFFECT, 8, 0), x, y, fg, bg);
}

// 8-column (no editing)
export function draw_channel_header_8(chan, x, y, fg) { draw_text(`  ${String(chan).padStart(2, '0')}  `, x, y, fg, 1); }
export function draw_note_8(x, y, note, cursor_pos, fg, bg) {
	draw_text(get_note_string(note.note), x, y, fg, bg);
	if (note.volparam || note.voleffect)
		draw_text(get_volume_string(note.volparam, note.voleffect), x + 3, y, note.voleffect === C.VOLFX_PANNING ? 1 : 2, bg);
	else { draw_char(0, x + 3, y, fg, bg); draw_char(0, x + 4, y, fg, bg); }
	draw_text(effstr(note), x + 5, y, fg, bg);
}

function vol_fg(note) {
	switch (note.voleffect) {
	case C.VOLFX_NONE: return 6;
	case C.VOLFX_PANNING: return 10;
	case C.VOLFX_TONEPORTAMENTO: case C.VOLFX_VIBRATOSPEED: case C.VOLFX_VIBRATODEPTH: return 6;
	default: return 12;
	}
}

// 7-column
export function draw_channel_header_7(chan, x, y, fg) { draw_text(`Chnl ${String(chan).padStart(2, '0')}`, x, y, fg, 1); }
export function draw_note_7(x, y, note, cursor_pos, fg, bg) {
	const note_buf = get_note_string(note.note), ins_buf = insstr(note.instrument);
	const vol_buf = get_volume_string(note.volparam, note.voleffect);
	draw_text(note_buf, x, y, 6, bg);
	let fg1, fg2, bg1, bg2;
	fg1 = fg2 = note.instrument ? 10 : 2; bg1 = bg2 = bg;
	switch (cursor_pos) {
	case 0: draw_char(note_buf[0], x, y, 0, 3); break;
	case 1: draw_char(note_buf[2], x + 2, y, 0, 3); break;
	case 2: fg1 = 0; bg1 = 3; break;
	case 3: fg2 = 0; bg2 = 3; break;
	}
	draw_half_width_chars(ins_buf[0], ins_buf[1], x + 3, y, fg1, bg1, fg2, bg2);
	fg1 = fg2 = vol_fg(note); bg1 = bg2 = bg;
	if (cursor_pos === 4) { fg1 = 0; bg1 = 3; } else if (cursor_pos === 5) { fg2 = 0; bg2 = 3; }
	draw_half_width_chars(vol_buf[0], vol_buf[1], x + 4, y, fg1, bg1, fg2, bg2);
	fg1 = fg2 = 10; bg1 = bg2 = bg;
	switch (cursor_pos) {
	case 7: fg1 = 0; bg1 = 3; break;
	case 8: fg2 = 0; bg2 = 3; break;
	case 9: fg1 = fg2 = 0; bg1 = bg2 = 3; cursor_pos = 6; break;
	}
	draw_half_width_chars(hexdigits[note.param >> 4], hexdigits[note.param & 15], x + 6, y, fg1, bg1, fg2, bg2);
	draw_char(get_effect_char(note.effect), x + 5, y, cursor_pos === 6 ? 0 : 2, cursor_pos === 6 ? 3 : bg);
}
export function draw_mask_7(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	draw_text(m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 1) + m(MASK_INSTRUMENT, 2, 3)
		+ m(MASK_VOLUME, 4, 5) + m(MASK_EFFECT, 6, 0) + m(MASK_EFFECT, 7, 8), x, y, fg, bg);
}

// 3-column
export function draw_channel_header_3(chan, x, y, fg) { draw_text(' ' + String(chan).padStart(2, '0'), x, y, fg, 1); }
export function draw_note_3(x, y, note, cursor_pos, fg, bg) {
	let vfg = 6, buf;
	if (note.voleffect === C.VOLFX_VOLUME) vfg = 2;
	else if (note.voleffect === C.VOLFX_PANNING || note.voleffect === C.VOLFX_NONE) vfg = 1;
	switch (cursor_pos) {
	case 0: vfg = fg = 0; bg = 3; break;
	case 1: buf = get_note_string(note.note); draw_text(buf, x, y, 6, bg); draw_char(buf[2], x + 2, y, 0, 3); return;
	case 2: case 3:
		buf = ' ' + insstr(note.instrument); draw_text(buf, x, y, 6, bg);
		draw_char(buf[cursor_pos - 1], x + cursor_pos - 1, y, 0, 3); return;
	case 4: case 5:
		buf = ' ' + get_volume_string(note.volparam, note.voleffect); draw_text(buf, x, y, vfg, bg);
		draw_char(buf[cursor_pos - 3], x + cursor_pos - 3, y, 0, 3); return;
	case 6: case 7: case 8:
		buf = effstr(note); draw_text(buf, x, y, 2, bg); draw_char(buf[cursor_pos - 6], x + cursor_pos - 6, y, 0, 3); return;
	case 9: draw_text(effstr(note), x, y, 0, 3); return;
	default: fg = 6;
	}
	if (note.note) draw_text(get_note_string(note.note), x, y, fg, bg);
	else if (note.instrument) draw_text(' ' + str_from_num99(note.instrument), x, y, fg, bg);
	else if (note.voleffect) draw_text(' ' + get_volume_string(note.volparam, note.voleffect), x, y, vfg, bg);
	else if (note.effect || note.param) draw_text(effstr(note), x, y, cursor_pos !== 0 ? 2 : fg, bg);
	else draw_text('\xAD\xAD\xAD', x, y, fg, bg);
}
export function draw_mask_3(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	let b = ['\x8F', '\x8F', '\x8F'];
	switch (cursor_pos) {
	case 0: case 1: b = [m(MASK_NOTE, 0, 0), m(MASK_NOTE, 0, 0), m(MASK_NOTE, 0, 1)]; break;
	case 2: case 3: b[1] = m(MASK_INSTRUMENT, 2, 0); b[2] = m(MASK_INSTRUMENT, 3, 0); break;
	case 4: case 5: b[1] = m(MASK_VOLUME, 4, 0); b[2] = m(MASK_VOLUME, 5, 0); break;
	case 6: case 7: case 8: b = [m(MASK_EFFECT, 6, 0), m(MASK_EFFECT, 7, 0), m(MASK_EFFECT, 8, 0)]; break;
	}
	draw_text(b.join(''), x, y, fg, bg);
}

// 2-column
export function draw_channel_header_2(chan, x, y, fg) { draw_text(String(chan).padStart(2, '0'), x, y, fg, 1); }
function draw_effect_2(x, y, note, cursor_pos, bg) {
	let fg = 2, fg1 = 10, fg2 = 10, bg1 = bg, bg2 = bg;
	switch (cursor_pos) {
	case 0: fg = fg1 = fg2 = 0; break;
	case 6: fg = 0; bg = 3; break;
	case 7: fg1 = 0; bg1 = 3; break;
	case 8: fg2 = 0; bg2 = 3; break;
	case 9: fg = fg1 = fg2 = 0; bg = bg1 = bg2 = 3; break;
	}
	draw_char(get_effect_char(note.effect), x, y, fg, bg);
	draw_half_width_chars(hexdigits[note.param >> 4], hexdigits[note.param & 15], x + 1, y, fg1, bg1, fg2, bg2);
}
const special_note = c => c === '^' || c === '~' || c === '\xCD' || c === '\xAD';
function draw_note_tail(buf, x, y, fg, bg, cursor_pos) {
	if (special_note(buf[0])) {
		if (cursor_pos === 1) draw_char(buf[1], x + 1, y, 0, 3); else draw_char(buf[1], x + 1, y, fg, bg);
	} else draw_half_width_chars(buf[1], buf[2], x + 1, y, fg, bg, cursor_pos === 1 ? 0 : fg, cursor_pos === 1 ? 3 : bg);
}
export function draw_note_2(x, y, note, cursor_pos, fg, bg) {
	let vfg = 6, buf;
	if (note.voleffect === C.VOLFX_VOLUME) vfg = 2;
	else if (note.voleffect === C.VOLFX_PANNING || note.voleffect === C.VOLFX_NONE) vfg = 1;
	switch (cursor_pos) {
	case 0: vfg = fg = 0; bg = 3; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case 1:
		buf = get_note_string(note.note); draw_char(buf[0], x, y, fg, bg);
		draw_note_tail(buf, x, y, fg, bg, cursor_pos); return;
	case 2: case 3:
		buf = insstr(note.instrument); draw_text(buf, x, y, 6, bg); draw_char(buf[cursor_pos - 2], x + cursor_pos - 2, y, 0, 3); return;
	case 4: case 5:
		buf = get_volume_string(note.volparam, note.voleffect); draw_text(buf, x, y, vfg, bg);
		draw_char(buf[cursor_pos - 4], x + cursor_pos - 4, y, 0, 3); return;
	case 6: case 7: case 8: case 9: draw_effect_2(x, y, note, cursor_pos, bg); return;
	default: fg = 6;
	}
	if (note.note) { buf = get_note_string(note.note); draw_char(buf[0], x, y, 6, bg); draw_note_tail(buf, x, y, fg, bg, cursor_pos); }
	else if (note.instrument) draw_text(str_from_num99(note.instrument), x, y, fg, bg);
	else if (note.voleffect) draw_text(get_volume_string(note.volparam, note.voleffect), x, y, vfg, bg);
	else if (note.effect || note.param) draw_effect_2(x, y, note, cursor_pos, bg);
	else { draw_char('\xAD', x, y, fg, bg); draw_char('\xAD', x + 1, y, fg, bg); }
}
export function draw_mask_2(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	let b = ['\x8F', '\x8F'];
	switch (cursor_pos) {
	case 0: case 1: b = [m(MASK_NOTE, 0, 0), m(MASK_NOTE, 0, 1)]; break;
	case 2: case 3: b = [m(MASK_INSTRUMENT, 2, 0), m(MASK_INSTRUMENT, 3, 0)]; break;
	case 4: case 5: b = [m(MASK_VOLUME, 4, 0), m(MASK_VOLUME, 5, 0)]; break;
	case 6: case 7: case 8: b = [m(MASK_EFFECT, 6, 0), m(MASK_EFFECT, 7, 8)]; break;
	}
	draw_text(b.join(''), x, y, fg, bg);
}

// 1-column
export function draw_channel_header_1(chan, x, y, fg) {
	draw_half_width_chars(48 + Math.trunc(chan / 10), 48 + chan % 10, x, y, fg, 1, fg, 1);
}
function draw_effect_1(x, y, note, cursor_pos, fg, bg) {
	let fg1 = fg, fg2 = fg, bg1 = bg, bg2 = bg;
	switch (cursor_pos) {
	case 0: break;
	case 6: fg = 0; bg = 3; break;
	case 7: fg1 = 0; bg1 = 3; break;
	case 8: fg2 = 0; bg2 = 3; break;
	default: fg = 2;
	}
	if (cursor_pos === 7 || cursor_pos === 8 || (note.effect === 0 && note.param !== 0))
		draw_half_width_chars(hexdigits[note.param >> 4], hexdigits[note.param & 15], x, y, fg1, bg1, fg2, bg2);
	else draw_char(get_effect_char(note.effect), x, y, fg, bg);
}
export function draw_note_1(x, y, note, cursor_pos, fg, bg) {
	let buf;
	switch (cursor_pos) {
	case 0:
		fg = 0; bg = 3;
		if (note.note > 0 && note.note <= 120) { buf = get_note_string_short(note.note); draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, fg, bg); return; }
		break;
	case 1: buf = get_note_string_short(note.note); draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, 0, 3); return;
	case 2: case 3:
		buf = insstr(note.instrument);
		if (cursor_pos === 2) draw_half_width_chars(buf[0], buf[1], x, y, 0, 3, fg, bg);
		else draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, 0, 3);
		return;
	case 4: case 5:
		buf = get_volume_string(note.volparam, note.voleffect);
		fg = note.voleffect === C.VOLFX_PANNING ? 1 : 2;
		if (cursor_pos === 4) draw_half_width_chars(buf[0], buf[1], x, y, 0, 3, fg, bg);
		else draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, 0, 3);
		return;
	case 9: cursor_pos = 6; // fallthrough
	// eslint-disable-next-line no-fallthrough
	case 6: case 7: case 8: draw_effect_1(x, y, note, cursor_pos, fg, bg); return;
	}
	if (note.note) { buf = get_note_string_short(note.note); draw_char(buf[0], x, y, fg, bg); }
	else if (note.instrument) { buf = str_from_num99(note.instrument); draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, fg, bg); }
	else if (note.voleffect) {
		if (cursor_pos !== 0) fg = note.voleffect === C.VOLFX_PANNING ? 1 : 2;
		buf = get_volume_string(note.volparam, note.voleffect);
		draw_half_width_chars(buf[0], buf[1], x, y, fg, bg, fg, bg);
	} else if (note.effect || note.param) draw_effect_1(x, y, note, cursor_pos, fg, bg);
	else draw_char('\xAD', x, y, fg, bg);
}
export function draw_mask_1(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	let c = '\x8F';
	switch (cursor_pos) {
	case 0: case 1: c = m(MASK_NOTE, 0, 1); break;
	case 2: case 3: c = m(MASK_INSTRUMENT, 2, 3); break;
	case 4: case 5: c = m(MASK_VOLUME, 4, 5); break;
	case 6: c = m(MASK_EFFECT, 6, 0); break;
	case 7: case 8: c = m(MASK_EFFECT, 7, 8); break;
	}
	draw_char(c, x, y, fg, bg);
}

// 6-column
export function draw_channel_header_6(chan, x, y, fg) { draw_text(`Chnl${String(chan).padStart(2, '0')}`, x, y, fg, 1); }
export function draw_note_6(x, y, note, cursor_pos, fg, bg) {
	const note_buf = get_note_string(note.note);
	if (cursor_pos === 0) draw_char(note_buf[0], x, y, 0, 3); else draw_char(note_buf[0], x, y, fg, bg);
	draw_note_tail(note_buf, x, y, fg, bg, cursor_pos);
	const ins_buf = insstr(note.instrument);
	let fg1, fg2, bg1, bg2;
	fg1 = fg2 = note.instrument ? 10 : 2; bg1 = bg2 = bg;
	if (cursor_pos === 2) { fg1 = 0; bg1 = 3; } else if (cursor_pos === 3) { fg2 = 0; bg2 = 3; }
	draw_half_width_chars(ins_buf[0], ins_buf[1], x + 2, y, fg1, bg1, fg2, bg2);
	const vol_buf = get_volume_string(note.volparam, note.voleffect);
	fg1 = fg2 = vol_fg(note); bg1 = bg2 = bg;
	if (cursor_pos === 4) { fg1 = 0; bg1 = 3; } else if (cursor_pos === 5) { fg2 = 0; bg2 = 3; }
	draw_half_width_chars(vol_buf[0], vol_buf[1], x + 3, y, fg1, bg1, fg2, bg2);
	fg1 = fg2 = 10; bg1 = bg2 = bg;
	switch (cursor_pos) {
	case 7: fg1 = 0; bg1 = 3; break;
	case 8: fg2 = 0; bg2 = 3; break;
	case 9: fg1 = fg2 = 0; bg1 = bg2 = 3; cursor_pos = 6; break;
	}
	draw_half_width_chars(hexdigits[note.param >> 4], hexdigits[note.param & 15], x + 5, y, fg1, bg1, fg2, bg2);
	draw_char(get_effect_char(note.effect), x + 4, y, cursor_pos === 6 ? 0 : 2, cursor_pos === 6 ? 3 : bg);
}
export function draw_mask_6(x, y, mask, cursor_pos, fg, bg) {
	const m = MC(mask, cursor_pos);
	draw_text(m(MASK_NOTE, 0, 0) + m(MASK_NOTE, 0, 1) + m(MASK_INSTRUMENT, 2, 3) + m(MASK_VOLUME, 4, 5)
		+ m(MASK_EFFECT, 6, 0) + m(MASK_EFFECT, 7, 8), x, y, fg, bg);
}
