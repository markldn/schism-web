// MIDI: schism/midi-core.c with a Web MIDI provider, the MIDI parts of
// schism/audio_playback.c, csf_midi_out_note from player/effects.c and the
// General MIDI driver player/snd_gm.c (Schism Tracker, GPL-2.0-or-later).
//
// Ports come from navigator.requestMIDIAccess(); a device that has both an
// input and an output with the same name is one port with both capabilities,
// as the native providers present it. Output is timestamped so it lines up
// with the audio that is queued in the AudioWorklet.
import { app, provide, optional } from './app.js';
import * as C from './sndconst.js';
import { status, PAGE, NEED_UPDATE, MIDI_EVENT_CHANGED, MIDI_LIKE_TRACKER } from './state.js';
import { key_event_new, KEY_PRESS, KEY_RELEASE } from './keyboard.js';
import { csf_process_midi_macro, csf_midi_send, midi_event_length, midi_set_default_config } from './midimacro.js';

export const MIDI_TICK_QUANTIZE = 0x1, MIDI_BASE_PROGRAM1 = 0x2, MIDI_RECORD_NOTEOFF = 0x4,
	MIDI_RECORD_VELOCITY = 0x8, MIDI_RECORD_AFTERTOUCH = 0x10, MIDI_CUT_NOTE_OFF = 0x20,
	MIDI_PITCHBEND = 0x40, MIDI_DISABLE_RECORD = 0x10000;
export const MIDI_INPUT = 1, MIDI_OUTPUT = 2;
const MAX_MIDI_CHANNELS = 16, MAX_VOICES = 256, MAX_CHANNELS = 64;

export const midi = {
	flags: MIDI_TICK_QUANTIZE | MIDI_RECORD_NOTEOFF | MIDI_RECORD_VELOCITY | MIDI_RECORD_AFTERTOUCH | MIDI_PITCHBEND,
	pitch_depth: 12, amplification: 100, c5note: 60,
};
Object.assign(status, { last_midi_tick: 0, last_midi_event: new Uint8Array(64), last_midi_len: 0,
	last_midi_real_len: 0, last_midi_port: null });

// ------------------------------------------------------------------------
// ports (the Web MIDI provider)

const ports = [];             // { name, provider, iocap, io, input, output }
let access = null, access_pending = null, access_error = '';
const saved_ports = [];       // [{ name, input, output }] from the stored configuration

function port_by_name(name) { return ports.find(p => p.name === name); }
function refresh_ports() {
	if (!access) return;
	const seen = new Set();
	const add = (dev, cap) => {
		const name = dev.name || dev.id;
		let p = port_by_name(name);
		if (!p) {
			p = { name, provider: 'Web MIDI', iocap: 0, io: 0, input: null, output: null };
			ports.push(p);
			const s = saved_ports.find(q => q.name === name);
			if (s) p.io = (s.input ? MIDI_INPUT : 0) | (s.output ? MIDI_OUTPUT : 0);
		}
		p.iocap |= cap;
		if (cap === MIDI_INPUT) p.input = dev; else p.output = dev;
		seen.add(p);
	};
	for (const dev of access.inputs.values()) if (dev.state !== 'disconnected') add(dev, MIDI_INPUT);
	for (const dev of access.outputs.values()) if (dev.state !== 'disconnected') add(dev, MIDI_OUTPUT);
	for (let i = ports.length - 1; i >= 0; i--) if (!seen.has(ports[i])) { midi_port_disable(ports[i]); ports.splice(i, 1); }
	for (const p of ports) { p.io &= p.iocap; midi_port_enable(p); }
	status.flags |= NEED_UPDATE;
}
export function midi_engine_start() {
	if (access || access_pending) return access_pending;
	if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) { access_error = 'Web MIDI is not available in this browser'; return null; }
	access_pending = navigator.requestMIDIAccess({ sysex: false }).then(a => {
		access = a;
		a.onstatechange = refresh_ports;
		refresh_ports();
	}, () => { access_error = 'MIDI access was denied by the browser'; status.flags |= NEED_UPDATE; });
	return access_pending;
}
export const midi_engine_error = () => access_error;
export function midi_engine_poll_ports() { if (!access) midi_engine_start(); else refresh_ports(); }
export const midi_engine_port_count = () => ports.length;
export const midi_engine_port = n => ports[n] || null;
export function midi_port_enable(p) {
	if (p.input) p.input.onmidimessage = (p.io & MIDI_INPUT) ? e => midi_received_cb(p, e.data) : null;
	if ((p.io & MIDI_OUTPUT) && p.output && p.output.open) p.output.open().catch(() => {});
	return 1;
}
export function midi_port_disable(p) {
	if (p.input) p.input.onmidimessage = null;
	return 1;
}

// ------------------------------------------------------------------------
// sending

// how far ahead of the speakers the mixer is running, so MIDI lines up with audio
let latency_ms = () => 0;
export function midi_set_latency_source(fn) { latency_ms = fn; }

function send_to_ports(data, when) {
	for (const p of ports) {
		if (!(p.io & MIDI_OUTPUT) || !p.output) continue;
		try { p.output.send(data, when); } catch { /* sysex or a malformed message */ }
	}
}
export function midi_send_now(data, len = data.length) {
	send_to_ports(Array.from(data.subarray ? data.subarray(0, len) : data.slice(0, len)), undefined);
}
export function midi_send_buffer(data, len, pos_ms = 0) {
	if (status.current_page === PAGE.MIDI) {
		status.last_midi_real_len = len;
		status.last_midi_len = Math.min(64, len);
		status.last_midi_event.set(data.subarray(0, status.last_midi_len));
		status.last_midi_port = null;
		status.last_midi_tick = Date.now();
		status.flags |= NEED_UPDATE | MIDI_EVENT_CHANGED;
	}
	const now = typeof performance !== 'undefined' ? performance.now() : 0;
	send_to_ports(Array.from(data.subarray(0, len)), now + latency_ms() + pos_ms);
}
export function midi_send_flush() { /* Web MIDI sends as it goes */ }
export function midi_need_flush() { return 0; }

// csf.midi_out_raw for the playing song (_schism_midi_out_raw)
export function schism_midi_out_raw(csf, data, len, pos) {
	midi_send_buffer(data, len, csf.mix_frequency ? pos * 1000 / csf.mix_frequency : 0);
}

// ------------------------------------------------------------------------
// receiving (midi_received_cb and midi_engine_handle_event)

export function midi_received_cb(src, raw) {
	const len = raw.length;
	if (!len) return;
	const data = new Uint8Array(Math.max(4, len));
	data.set(raw);
	status.last_midi_real_len = len;
	status.last_midi_len = Math.min(64, len);
	status.last_midi_event.set(data.subarray(0, status.last_midi_len));
	status.flags |= MIDI_EVENT_CHANGED;
	status.last_midi_port = src;
	status.last_midi_tick = Date.now();
	if (status.current_page === PAGE.MIDI) {
		midi_send_now(data, len);
		status.flags |= NEED_UPDATE;
	}
	const cmd = data[0] >> 4, ch = data[0] & 15;
	if (cmd === 0x8 || (cmd === 0x9 && data[2] === 0)) midi_event_note(0, ch, data[1], 0);
	else if (cmd === 0x9) midi_event_note(1, ch, data[1], data[2]);
	else if (cmd === 0xa) midi_event_note(2, ch, data[1], data[2]);
	else if (cmd === 0xe) midi_event_pitchbend(ch, data[1]);
	else if (cmd === 0xf) {
		switch (data[0] & 15) {
		case 0: case 6: break;
		default: midi_event_system(data[0] & 15);
		}
	}
	status.flags |= NEED_UPDATE;
}
const MIDI_NOTEOFF = 0, MIDI_NOTEON = 1;
function midi_event_note(mnstatus, channel, note, velocity) {
	if (midi.flags & MIDI_DISABLE_RECORD) return;
	const kk = key_event_new();
	if (mnstatus === MIDI_NOTEON) kk.state = KEY_PRESS;
	else if (mnstatus === MIDI_NOTEOFF) {
		if (!(midi.flags & MIDI_RECORD_NOTEOFF)) return;
		kk.state = KEY_RELEASE;
	} else return; // key pressure: only recorded as an event upstream, not acted on
	kk.midi_channel = channel + 1;
	kk.midi_note = (note + 1 + midi.c5note) - 60;
	kk.midi_volume = (midi.flags & MIDI_RECORD_VELOCITY) ? velocity : 128;
	kk.midi_volume = Math.trunc(kk.midi_volume * midi.amplification / 100);
	app.handle_key(kk);
	status.flags |= NEED_UPDATE;
}
function midi_event_pitchbend(channel, value) {
	if (midi.flags & MIDI_DISABLE_RECORD) return;
	const kk = key_event_new();
	kk.midi_channel = channel + 1;
	kk.midi_volume = -1;
	kk.midi_note = -1;
	kk.midi_bend = value;
	app.handle_key(kk);
}
function midi_event_system(argv) {
	if (midi.flags & MIDI_DISABLE_RECORD) return;
	switch (argv) {
	case 0xa: case 0xb: app.song_start(); break;
	case 0xc: case 0xf: app.song_stop(); break;
	}
}
export function midi_toggle_record() {
	midi.flags ^= MIDI_DISABLE_RECORD;
	app.status_text_flash(`MIDI Input ${(midi.flags & MIDI_DISABLE_RECORD) ? 'Disabled' : 'Enabled'}`);
}

// ------------------------------------------------------------------------
// player state (the MIDI members of song_t)

export function csf_midi_state(csf) {
	if (csf.midi_note_tracker) return csf;
	Object.assign(csf, {
		midi_note_tracker: new Int32Array(MAX_CHANNELS), midi_vol_tracker: new Int32Array(MAX_CHANNELS),
		midi_ins_tracker: new Int32Array(MAX_CHANNELS), midi_was_program: new Int32Array(MAX_MIDI_CHANNELS),
		midi_was_banklo: new Int32Array(MAX_MIDI_CHANNELS), midi_was_bankhi: new Int32Array(MAX_MIDI_CHANNELS),
		midi_last_row: new Array(MAX_CHANNELS).fill(null), midi_last_row_number: -1, midi_playing: 0,
		midi_s3m_chans: Array.from({ length: MAX_VOICES }, () => ({ note: 0, patch: 0, bank: 0, pan: 0, chan: -1, pref_chn_mask: -1 })),
		midi_chans: Array.from({ length: MAX_MIDI_CHANNELS }, () => ({ volume: 255, patch: 255, bank: 255, bend: 0x2000, pan: 0 })),
		midi_last_song_counter: 0, midi_running_status: 0,
	});
	return csf;
}

// player/effects.c: csf_midi_out_note
export function csf_midi_out_note(csf, chan, starting_note) {
	if (!csf || !(csf.flags & C.SONG_INSTRUMENTMODE) || (status.flags & MIDI_LIKE_TRACKER)) return;
	csf_midi_state(csf);
	let m = starting_note;
	if (!csf.midi_playing) {
		csf_process_midi_macro(csf, 0, csf.midi_config.start, 0, 0, 0, 0);
		csf.midi_playing = 1;
	}
	if (chan < 0) return;
	chan %= MAX_CHANNELS;
	if (!m) {
		if (csf.midi_last_row_number !== csf.row) return;
		m = csf.midi_last_row[chan];
		if (!m) return;
	} else {
		csf.midi_last_row[chan] = m;
		csf.midi_last_row_number = csf.row;
	}
	let ins = csf.midi_ins_tracker[chan];
	if (m.instrument > 0) ins = m.instrument;
	if (ins < 0 || ins >= C.MAX_INSTRUMENTS || !csf.instruments[ins]) return;
	const penv = csf.instruments[ins];
	let mc;
	if (penv.midi_channel_mask >= 0x10000) mc = chan % 16;
	else {
		mc = 0;
		if (penv.midi_channel_mask > 0) while (!(penv.midi_channel_mask & (1 << mc))) ++mc;
	}
	let m_note = m.note;
	const tc = csf.current_speed ? csf.tick_count % csf.current_speed : 0;
	if (m.effect === C.FX_SPECIAL) {
		switch (m.param & 0xf0) {
		case 0xc0:
			if (tc === (m.param & 15)) m_note = C.NOTE_CUT;
			else if (tc !== 0) return;
			break;
		case 0xd0: if (tc !== (m.param & 15)) return; break;
		default: if (tc !== 0) return;
		}
	} else if (tc !== 0 && !starting_note) return;
	let need_note = -1, need_velocity = -1;
	if (m_note > 120) {
		if (csf.midi_note_tracker[chan] !== 0)
			csf_process_midi_macro(csf, chan, csf.midi_config.note_off, 0, csf.midi_note_tracker[chan], 0, csf.midi_ins_tracker[chan]);
		csf.midi_note_tracker[chan] = 0;
		csf.midi_vol_tracker[chan] = m.voleffect === C.VOLFX_VOLUME ? m.volparam : 64;
	} else if (!m.note && m.voleffect === C.VOLFX_VOLUME) {
		csf.midi_vol_tracker[chan] = m.volparam;
		need_velocity = csf.midi_vol_tracker[chan];
	} else if (m.note) {
		if (csf.midi_note_tracker[chan] !== 0)
			csf_process_midi_macro(csf, chan, csf.midi_config.note_off, 0, csf.midi_note_tracker[chan], 0, csf.midi_ins_tracker[chan]);
		csf.midi_note_tracker[chan] = m_note;
		csf.midi_vol_tracker[chan] = m.voleffect === C.VOLFX_VOLUME ? m.volparam : 64;
		need_note = csf.midi_note_tracker[chan];
		need_velocity = csf.midi_vol_tracker[chan];
	}
	if (m.instrument > 0) csf.midi_ins_tracker[chan] = ins;
	const mg = penv.midi_program + ((midi.flags & MIDI_BASE_PROGRAM1) ? 1 : 0);
	const mbl = penv.midi_bank;
	const mbh = (penv.midi_bank >> 7) & 127;
	const buf = new Uint8Array(4);
	if (mbh > -1 && csf.midi_was_bankhi[mc] !== mbh) {
		buf[0] = 0xb0 | (mc & 15); buf[1] = 0x00; buf[2] = mbh;
		csf_midi_send(csf, buf, 3, 0, 0);
		csf.midi_was_bankhi[mc] = mbh;
	}
	if (mbl > -1 && csf.midi_was_banklo[mc] !== mbl) {
		buf[0] = 0xb0 | (mc & 15); buf[1] = 0x20; buf[2] = mbl & 0xff;
		csf_midi_send(csf, buf, 3, 0, 0);
		csf.midi_was_banklo[mc] = mbl;
	}
	if (mg > -1 && csf.midi_was_program[mc] !== mg) {
		csf.midi_was_program[mc] = mg;
		csf_process_midi_macro(csf, chan, csf.midi_config.set_program, mg, 0, 0, ins);
	}
	if (csf.voices[chan].flags & C.CHN_MUTE) {
		// don't send noteon events when muted
	} else if (need_note > 0) {
		if (need_velocity === -1) need_velocity = 64;
		need_velocity = Math.max(0, Math.min(127, need_velocity * 2));
		csf_process_midi_macro(csf, chan, csf.midi_config.note_on, 0, need_note, need_velocity, ins);
	} else if (need_velocity > -1 && csf.midi_note_tracker[chan] > 0) {
		need_velocity = Math.max(0, Math.min(127, need_velocity * 2));
		csf_process_midi_macro(csf, chan, csf.midi_config.set_volume, need_velocity, csf.midi_note_tracker[chan], need_velocity, ins);
	}
}

// the MIDI part of song_stop_unlocked
export function song_stop_midi(csf) {
	csf_midi_state(csf);
	if (csf.midi_playing) {
		const moff = new Uint8Array(4);
		for (let chan = 0; chan < MAX_CHANNELS; chan++) {
			if (csf.midi_note_tracker[chan] !== 0) {
				for (let j = 0; j < MAX_MIDI_CHANNELS; j++)
					csf_process_midi_macro(csf, chan, csf.midi_config.note_off, 0, csf.midi_note_tracker[chan], 0, j);
				moff[0] = 0x80 + chan; moff[1] = csf.midi_note_tracker[chan];
				csf_midi_send(csf, moff, 2, 0, 0);
			}
		}
		for (let j = 0; j < MAX_MIDI_CHANNELS; j++) {
			moff[0] = 0xe0 + j; moff[1] = 0;
			csf_midi_send(csf, moff, 2, 0, 0);
			moff[0] = 0xb0 + j; moff[1] = 0x78; moff[2] = 0;
			csf_midi_send(csf, moff, 3, 0, 0);
			moff[1] = 0x79;
			csf_midi_send(csf, moff, 3, 0, 0);
			moff[1] = 0x7b;
			csf_midi_send(csf, moff, 3, 0, 0);
		}
		csf_process_midi_macro(csf, 0, csf.midi_config.stop, 0, 0, 0, 0);
		midi_send_flush();
		csf.midi_playing = 0;
	}
}
export function song_reset_midi_state(csf) {
	csf_midi_state(csf);
	csf.midi_last_row.fill(null);
	csf.midi_last_row_number = -1;
	for (const k of ['midi_note_tracker', 'midi_vol_tracker', 'midi_ins_tracker', 'midi_was_program', 'midi_was_banklo', 'midi_was_bankhi']) csf[k].fill(0);
}

// ------------------------------------------------------------------------
// player/snd_gm.c (only active with "Tracker semantics", MIDI_LIKE_TRACKER)

const PitchBendCenter = 0x2000, SEMITONE_BEND_DEPTH = Math.trunc(0x2000 / 12);
const like_tracker = () => status.flags & MIDI_LIKE_TRACKER;
function MPU_SendCommand(csf, buf, c) { if (buf.length) csf_midi_send(csf, Uint8Array.from(buf), buf.length, c, 0); }
function MPU_Ctrl(csf, c, i, v) { if (like_tracker()) MPU_SendCommand(csf, [0xb0 + c, i & 0xff, v & 0xff], c); }
function MPU_Patch(csf, c, p) { if (like_tracker()) MPU_SendCommand(csf, [0xc0 + c, p & 0xff], c); }
function MPU_Bend(csf, c, w) { if (like_tracker()) MPU_SendCommand(csf, [0xe0 + c, w & 127, (w >> 7) & 0xff], c); }
function MPU_NoteOn(csf, c, k, v) { if (like_tracker()) MPU_SendCommand(csf, [0x90 + c, k & 0xff, v & 0xff], c); }
function MPU_NoteOff(csf, c, k, v) {
	if (!like_tracker()) return;
	if ((csf.midi_running_status & 0xff) === 0x90 + c) MPU_NoteOn(csf, c, k, 0);
	else MPU_SendCommand(csf, [0x80 + c, k & 0xff, v & 0xff], c);
}
function MPU_SendPN(csf, ch, portindex, param, valuehi, valuelo) {
	MPU_Ctrl(csf, ch, portindex + 1, param >> 7);
	MPU_Ctrl(csf, ch, portindex, param & 0x80);
	if (param !== 0x4080) {
		MPU_Ctrl(csf, ch, 6, valuehi);
		if (valuelo) MPU_Ctrl(csf, ch, 38, valuelo);
	}
}
const s3m_active = ci => ci.note && ci.chan >= 0;
const s3m_percussion = ci => (ci.patch & 0x80) || (ci.pref_chn_mask & (1 << 9));
const msi_know_something = msi => msi.patch !== 255;
function msi_set_volume(csf, msi, c, v) { if (msi.volume !== v) { msi.volume = v; MPU_Ctrl(csf, c, 7, v); } }
function msi_set_patch_and_bank(csf, msi, c, p, b) {
	if (msi.bank !== b) { msi.bank = b; MPU_Ctrl(csf, c, 0, b); }
	if (msi.patch !== p) { msi.patch = p; MPU_Patch(csf, c, p); }
}
function msi_set_pitch_bend(csf, msi, c, v) { if (msi.bend !== v) { msi.bend = v; MPU_Bend(csf, c, v); } }
function msi_set_pan(csf, msi, c, v) {
	if (msi.pan !== v) { msi.pan = v; MPU_Ctrl(csf, c, 10, ((v + 128) & 0xff) >> 1); }
}
function GM_AllocateMelodyChannel(csf, c, patch, bank, key, pref) {
	const bad = new Int32Array(MAX_MIDI_CHANNELS), used = new Int32Array(MAX_MIDI_CHANNELS);
	for (const ci of csf.midi_s3m_chans) {
		if (s3m_active(ci) && !s3m_percussion(ci)) { used[ci.chan] = 1; if (ci.note === key) bad[ci.chan] = 1; }
	}
	let best_mc = c % MAX_MIDI_CHANNELS, best_score = -999;
	for (let mc = 0; mc < MAX_MIDI_CHANNELS; mc++) {
		if (mc === 9) continue;
		let score = 0;
		if (msi_know_something(csf.midi_chans[mc])) {
			if (csf.midi_chans[mc].patch !== patch) score -= 4;
			if (csf.midi_chans[mc].bank !== bank) score -= 6;
		}
		if (pref >= 0x10000) { if (mc !== c % MAX_MIDI_CHANNELS) continue; }
		else if (!(pref & (1 << mc))) continue;
		if (bad[mc]) score -= 9;
		if (!used[mc]) score += 2;
		if (score > best_score) { best_score = score; best_mc = mc; }
	}
	return best_mc;
}
const okc = c => c >= 0 && c < MAX_VOICES;
export function GM_Patch(csf, c, p, pref) { if (!okc(c)) return; csf_midi_state(csf); Object.assign(csf.midi_s3m_chans[c], { patch: p & 0xff, pref_chn_mask: pref }); }
export function GM_Bank(csf, c, b) { if (!okc(c)) return; csf_midi_state(csf); csf.midi_s3m_chans[c].bank = b & 0xff; }
export function GM_Touch(csf, c, vol) {
	if (!okc(c)) return;
	csf_midi_state(csf);
	const ci = csf.midi_s3m_chans[c];
	if (!s3m_active(ci)) return;
	msi_set_volume(csf, csf.midi_chans[ci.chan], ci.chan, Math.min(vol & 0xff, 127));
}
export function GM_KeyOn(csf, c, key, vol) {
	if (!okc(c)) return;
	GM_KeyOff(csf, c);
	const ci = csf.midi_s3m_chans[c];
	if (s3m_active(ci)) return;
	if (s3m_percussion(ci)) {
		let percu = key;
		if (ci.patch & 0x80) percu = ci.patch - 128;
		const mc = ci.chan = 9;
		msi_set_patch_and_bank(csf, csf.midi_chans[mc], mc, ci.patch, ci.bank);
		msi_set_pan(csf, csf.midi_chans[mc], mc, ci.pan);
		msi_set_volume(csf, csf.midi_chans[mc], mc, Math.min(vol & 0xff, 127));
		ci.note = key;
		MPU_NoteOn(csf, mc, ci.note = percu, 127);
	} else {
		const mc = ci.chan = GM_AllocateMelodyChannel(csf, c, ci.patch, ci.bank, key, ci.pref_chn_mask);
		msi_set_patch_and_bank(csf, csf.midi_chans[mc], mc, ci.patch, ci.bank);
		msi_set_volume(csf, csf.midi_chans[mc], mc, Math.min(vol & 0xff, 127));
		MPU_NoteOn(csf, mc, ci.note = key, 127);
		msi_set_pan(csf, csf.midi_chans[mc], mc, ci.pan);
	}
}
export function GM_KeyOff(csf, c) {
	if (!okc(c)) return;
	csf_midi_state(csf);
	const ci = csf.midi_s3m_chans[c];
	if (!s3m_active(ci)) return;
	MPU_NoteOff(csf, ci.chan, ci.note, 0);
	ci.chan = -1; ci.note = 0; ci.pan = 0;
}
export function GM_Bend(csf, c, count) {
	if (!okc(c)) return;
	const ci = csf.midi_s3m_chans[c];
	if (s3m_active(ci)) msi_set_pitch_bend(csf, csf.midi_chans[ci.chan], ci.chan, count);
}
export function GM_Reset(csf, quitting) {
	csf_midi_state(csf);
	for (let a = 0; a < MAX_VOICES; a++) {
		GM_KeyOff(csf, a);
		Object.assign(csf.midi_s3m_chans[a], { note: 0, patch: 0, bank: 0, pan: 0, chan: -1, pref_chn_mask: -1 });
	}
	const n128 = quitting ? 128 : Math.trunc(128 * 0x2000 / SEMITONE_BEND_DEPTH);
	for (let a = 0; a < MAX_MIDI_CHANNELS; a++) {
		MPU_Ctrl(csf, a, 120, 0);
		MPU_Ctrl(csf, a, 123, 0);
		MPU_Ctrl(csf, a, 121, 0);
		msi_set_pan(csf, csf.midi_chans[a], a, 0);
		msi_set_volume(csf, csf.midi_chans[a], a, 127);
		msi_set_pitch_bend(csf, csf.midi_chans[a], a, PitchBendCenter);
		Object.assign(csf.midi_chans[a], { volume: 255, patch: 255, bank: 255, bend: PitchBendCenter, pan: 0 });
		MPU_SendPN(csf, a, 100, 0, Math.trunc(n128 / 128), n128 % 128);
		MPU_SendPN(csf, a, 100, 0x4080, 0, 0);
	}
}
export function GM_DPatch(csf, ch, GM, bank, pref) {
	if (!okc(ch)) return;
	GM_Bank(csf, ch, bank);
	GM_Patch(csf, ch, GM, pref);
}
export function GM_Pan(csf, c, val) {
	if (!okc(c)) return;
	csf_midi_state(csf);
	val = (val << 24) >> 24;
	csf.midi_s3m_chans[c].pan = val;
	const ci = csf.midi_s3m_chans[c];
	if (s3m_active(ci)) msi_set_pan(csf, csf.midi_chans[ci.chan], ci.chan, val);
}
export function GM_SetFreqAndVol(csf, c, Hertz, vol, bend_mode, keyoff) {
	if (!okc(c)) return;
	csf_midi_state(csf);
	let midinote = 69 + 12.0 * (Math.log(Hertz / 440.0) / Math.log(2.0));
	midinote -= 12 * 5;
	const ci = csf.midi_s3m_chans[c];
	let note = ci.note;
	if (!s3m_active(ci) && !keyoff) {
		note = Math.trunc(midinote + 0.5);
		if (bend_mode === 1) note += Math.trunc(0x2000 / SEMITONE_BEND_DEPTH);
		if (bend_mode === 2) note -= Math.trunc(0x2000 / SEMITONE_BEND_DEPTH);
		note = Math.max(1, Math.min(127, note));
		GM_KeyOn(csf, c, note, vol);
	}
	if (!s3m_percussion(ci)) {
		const bend = Math.max(0, Math.min(0x3fff, Math.trunc((midinote - note) * SEMITONE_BEND_DEPTH) + PitchBendCenter));
		GM_Bend(csf, c, bend);
	}
	GM_Touch(csf, c, Math.max(0, Math.min(127, vol)));
}
export function GM_SendSongStartCode(csf) { csf_midi_state(csf); MPU_SendCommand(csf, [0xfa], 0); csf.midi_last_song_counter = 0; }
export function GM_SendSongStopCode(csf) { csf_midi_state(csf); MPU_SendCommand(csf, [0xfc], 0); csf.midi_last_song_counter = 0; }
export function GM_IncrementSongCounter(csf, count) {
	csf_midi_state(csf);
	const tick = csf.current_tempo ? (csf.mix_frequency * 5) / (csf.current_tempo * 2) : 0;
	if (!tick) return;
	csf.midi_last_song_counter += count / tick;
	const n = Math.trunc(csf.midi_last_song_counter);
	for (let a = 0; a < n; a++) MPU_SendCommand(csf, [0xf8], 0);
	csf.midi_last_song_counter -= n;
}

// ------------------------------------------------------------------------
// configuration (stored with the rest of the settings in localStorage)

export function cfg_get_midi() {
	const mc = app.current_song && app.current_song();
	return { flags: midi.flags & ~MIDI_DISABLE_RECORD, pitch_depth: midi.pitch_depth, amplification: midi.amplification,
		c5note: midi.c5note, config: mc && mc.midi_config ? mc.midi_config : null,
		ports: ports.filter(p => p.io).map(p => ({ name: p.name, input: p.io & MIDI_INPUT ? 1 : 0, output: p.io & MIDI_OUTPUT ? 1 : 0 })) };
}
export function cfg_load_midi(data) {
	if (!data) return;
	for (const k of ['flags', 'pitch_depth', 'amplification', 'c5note']) if (typeof data[k] === 'number') midi[k] = data[k];
	if (data.config) midi_set_default_config(data.config);
	if (Array.isArray(data.ports)) {
		saved_ports.splice(0, saved_ports.length, ...data.ports);
		if (saved_ports.length) midi_engine_start(); // only ask for MIDI access when ports were in use
	}
}
try {
	const d = JSON.parse(localStorage.getItem('schism-config') || 'null');
	if (d && d.midi) cfg_load_midi(d.midi);
} catch { /* no storage */ }

provide({ csf_midi_out_note, GM_KeyOff, GM_KeyOn, GM_Touch, GM_Bend, GM_Reset, GM_DPatch, GM_Pan, GM_SetFreqAndVol,
	GM_SendSongStartCode, GM_SendSongStopCode, GM_IncrementSongCounter, midi_toggle_record, midi_received_cb,
	midi_engine_start, midi_engine_poll_ports, cfg_get_midi, midi_event_length });
