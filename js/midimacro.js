// MIDI macro processing: fx_midi_zxx, csf_process_midi_macro and csf_midi_send
// from player/effects.c, midi_event_length from schism/midi-core.c and the
// default macro set from cfg_load_midi (Schism Tracker, GPL-2.0-or-later).
// Internal filter macros (F0 F0 xx yy) drive the resonant filter; anything
// else goes to csf.midi_out_raw when a MIDI output is attached.
import { provide } from './app.js';
import * as C from './sndconst.js';
import { setup_channel_filter } from './filters.js';

const MAX_MIDI_MACRO = 32;
const muldiv = (a, b, c) => Math.trunc(a * b / c);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

export function default_midi_config() {
	return {
		start: 'FF', stop: 'FC', tick: '', note_on: '9c n v', note_off: '9c n 0', set_volume: '',
		set_panning: '', set_bank: '', set_program: 'Cc p',
		sfx: Array.from({ length: 16 }, (_, i) => i ? '' : 'F0F000z'),
		zxx: Array.from({ length: 128 }, (_, i) => i < 16 ? 'F0F001' + (i * 8).toString(16).padStart(2, '0') : ''),
	};
}
export const midi_config_defaults = default_midi_config();
export const copy_midi_config = mc => ({ ...mc, sfx: [...mc.sfx], zxx: [...mc.zxx] });
// the default macro set follows the stored configuration (cfg_load_midi)
export function midi_set_default_config(mc) {
	for (const k of ['start', 'stop', 'tick', 'note_on', 'note_off', 'set_volume', 'set_panning', 'set_bank', 'set_program'])
		if (typeof mc[k] === 'string') midi_config_defaults[k] = mc[k];
	if (Array.isArray(mc.sfx)) mc.sfx.forEach((v, i) => { if (i < 16 && typeof v === 'string') midi_config_defaults.sfx[i] = v; });
	if (Array.isArray(mc.zxx)) mc.zxx.forEach((v, i) => { if (i < 128 && typeof v === 'string') midi_config_defaults.zxx[i] = v; });
}

export function midi_event_length(b) {
	switch (b & 0xf0) {
	case 0xc0: case 0xd0: return 2;
	case 0xf0: return b === 0xf1 || b === 0xf3 ? 2 : b === 0xf2 ? 3 : 1;
	default: return 3;
	}
}

export function fx_midi_zxx(csf, chan) {
	const vel = chan.ptr_sample
		? muldiv((chan.volume + chan.vol_swing) * csf.current_global_volume,
			chan.global_volume * chan.instrument_volume, 1 << 20) : 0;
	const mc = csf.midi_config || midi_config_defaults;
	csf_process_midi_macro(csf, csf.voices.indexOf(chan),
		chan.row_param < 0x80 ? mc.sfx[chan.active_macro & 15] : mc.zxx[chan.row_param & 0x7f],
		chan.row_param, chan.note, vel, 0);
}

export function csf_midi_send(csf, data, len, nchan, fake) {
	const chan = csf.voices[nchan];
	if (len >= 1 && (data[0] === 0xfa || data[0] === 0xfc || data[0] === 0xff)) {
		for (const v of csf.voices) { v.cutoff = 0x7f; v.resonance = 0; }
	}
	if (len >= 4 && data[0] === 0xf0 && data[1] === 0xf0) {
		switch (data[2]) {
		case 0x00:
			if (data[3] < 0x80) { chan.cutoff = data[3]; setup_channel_filter(chan, !(chan.flags & C.CHN_FILTER), 256, csf.mix_frequency); }
			break;
		case 0x01:
			if (data[3] < 0x80) { chan.resonance = data[3]; setup_channel_filter(chan, !(chan.flags & C.CHN_FILTER), 256, csf.mix_frequency); }
			break;
		}
	} else if (!fake && csf.midi_out_raw) {
		// csf_ticks_to_samples(csf_get_current_tick(csf), mix_frequency, current_tempo)
		const tick = csf.current_speed - csf.tick_count;
		const pos = csf.current_tempo ? Math.trunc(tick * (5 * csf.mix_frequency) / (2 * csf.current_tempo)) : 0;
		csf.midi_out_raw(csf, data.slice(0, len), len, pos);
	}
}

export function csf_process_midi_macro(csf, nchan, macro, param, note, velocity, use_instr) {
	if (!macro) return;
	const chan = csf.voices[nchan];
	const penv = (csf.flags & C.SONG_INSTRUMENTMODE) && chan.last_instrument < C.MAX_INSTRUMENTS
		? csf.instruments[use_instr ? use_instr : chan.last_instrument] : null;
	const out = new Uint8Array(MAX_MIDI_MACRO * 2 + 2);
	let midi_channel, fake = 0, saw_c = 0, nibble_pos = 0, w = 0;
	if (!penv || !penv.midi_channel_mask) { midi_channel = 15; fake = 1; }
	else if (penv.midi_channel_mask >= 0x10000) midi_channel = ((nchan - 1) % 16 + 16) % 16;
	else { midi_channel = 0; while (!(penv.midi_channel_mask & (1 << midi_channel))) ++midi_channel; }
	for (let r = 0; r <= MAX_MIDI_MACRO && r < macro.length; r++) {
		const ch = macro[r];
		let data = 0, is_nibble = 0;
		if (ch >= '0' && ch <= '9') { data = ch.charCodeAt(0) - 48; is_nibble = 1; }
		else if (ch >= 'A' && ch <= 'F') { data = ch.charCodeAt(0) - 55; is_nibble = 1; }
		else switch (ch) {
		case 'c': data = midi_channel; is_nibble = 1; saw_c = 1; break;
		case 'n': data = (note - 1) & 0xff; break;
		case 'v': data = clamp(velocity, 1, 0x7f); break;
		case 'u': {
			const vol = muldiv(chan.calc_volume * csf.last_global_volume, chan.global_volume * chan.last_instrument_volume, 2 ** 26);
			data = clamp(vol, 1, 0x7f);
			break;
		}
		case 'x': data = Math.min(chan.panning, 0x7f); break;
		case 'y': data = Math.min(chan.final_panning, 0x7f); break;
		case 'a': if (penv && penv.midi_bank !== -1) data = (penv.midi_bank >> 7) & 0x7f; break;
		case 'b': if (penv && penv.midi_bank !== -1) data = penv.midi_bank & 0x7f; break;
		case 'p': if (penv && penv.midi_program !== -1) data = penv.midi_program & 0x7f; break;
		case 'z': data = param & 0xff; break;
		case 'h': data = nchan & 0x7f; break;
		case 'm': data = (chan.flags & C.CHN_PINGPONGFLAG) ? 1 : 0; break;
		case 'o': data = (chan.mem_offset >> 8) & 0xff; break;
		default: continue;
		}
		if (is_nibble) {
			if (!nibble_pos) { out[w] = data; nibble_pos = 1; }
			else { out[w] = ((out[w] << 4) | data) & 0xff; w++; nibble_pos = 0; }
		} else {
			if (nibble_pos) { w++; nibble_pos = 0; }
			out[w++] = data;
		}
	}
	if (nibble_pos) w++;
	let s = 0, running = 0;
	while (s < w) {
		let len = 0;
		if (out[s] === 0xf0) {
			if (w - s >= 4 && out[s + 1] === 0xf0) len = 4;
			else {
				for (let i = s + 1; i < w; i++) if (out[i] === 0xf7) { len = i - s + 1; break; }
				if (!len) { out[w++] = 0xf7; len = w - s; }
			}
		} else if (!(out[s] & 0x80)) {
			if (running) { s--; out[s] = running; } else s++;
			continue;
		} else len = Math.min(midi_event_length(out[s]), w - s);
		if (!len) break;
		if (out[s] < 0xf0) running = out[s];
		csf_midi_send(csf, out.subarray(s), len, nchan, saw_c && fake);
		s += len;
	}
}

provide({ fx_midi_zxx, csf_process_midi_macro, csf_midi_send, midi_event_length });
