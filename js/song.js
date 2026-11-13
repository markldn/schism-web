// The song API: schism/mplink.c, the playback half of schism/audio_playback.c
// and parts of schism/audio_loadsave.c (Schism Tracker, GPL-2.0-or-later).
// Audio output is an AudioWorklet fed from the main thread; locking is a no-op
// because JavaScript runs the mixer and the UI on the same thread.
import { app, provide, optional } from "./app.js";
import * as C from './sndconst.js';
import { status, SONG_NEEDS_SAVE, NEED_UPDATE, PLAY_AFTER_LOAD } from './state.js';
import './csndfile.js';
import './effects.js';
import './sndmix.js';
import './filters.js';
import './mixutil.js';
import './mixer.js';
import { audio_settings as eq_audio_settings } from './equalizer.js';
import { csf_allocate, csf_allocate_pattern, csf_allocate_instrument, csf_init_instrument,
	csf_instrument_is_empty, csf_set_current_order, csf_loop_pattern, csf_reset_playmarks,
	csf_get_length, csf_stop_sample, csf_destroy_sample, csf_adjust_sample_loop,
	csf_update_playing_sample, csf_get_num_patterns } from './csndfile.js';
import { song_create_load } from './fmt/loaders.js';

export const MODE_STOPPED = 0, MODE_PLAYING = 1, MODE_PATTERN_LOOP = 2, MODE_SINGLE_STEP = 4;
export const KEYJAZZ_CHAN_CURRENT = 0, KEYJAZZ_CHAN_AUTO = -1, KEYJAZZ_NOINST = -1,
	KEYJAZZ_DEFAULTVOL = -1, KEYJAZZ_INST_FAKE = -2;
export const KEEP_PATTERNS = 1, KEEP_SAMPLES = 2, KEEP_INSTRUMENTS = 4, KEEP_ORDERLIST = 8;

// MIDI / OPL / GM transports are not ported; they are silent no-ops here.
const noop = () => 0;
provide({ csf_midi_out_note: noop, GM_KeyOff: noop, GM_Touch: noop, GM_IncrementSongCounter: noop,
	Fmdrv_Mix: noop, Fmdrv_Init: noop, GM_Reset: noop, OPL_NoteOff: noop, OPL_Patch: noop,
	OPL_Reset: noop, GM_DPatch: noop, GM_SendSongStartCode: noop, GM_SendSongStopCode: noop,
	csf_process_midi_macro: noop, csf_midi_send: noop });

export let current_song = null;
export let song_filename = '', song_basename = '';

export const audio_settings = Object.assign(eq_audio_settings, {
	sample_rate: 48000, bits: 16, channels: 2, buffer_size: 1024, channel_limit: 128,
	interpolation_mode: 2, no_ramping: 0, surround_effect: 1,
});

let max_channels_used = 0, samples_played = 0;

// ------------------------------------------------------------------------
// audio output

let ctx = null, node = null, mix_rate = 48000;
let produced = 0, played = 0, pumping = null;
const snapshots = []; // {frame, order, row, pattern, tick, speed, tempo, gvol, voices}
let audible = null, last_update = 0;
const CHUNK = 256;
let pcm32 = new Int32Array(CHUNK * 2);
const vis_buffer = new Int16Array(1024), vis_out = new Int16Array(1024);
let vis_pos = 0;
export function song_get_vis_buffer() {
	for (let i = 0; i < vis_out.length; i++) vis_out[i] = vis_buffer[(vis_pos + i) % vis_buffer.length];
	return vis_out;
}

const WORKLET = `
class SchismOut extends AudioWorkletProcessor {
	constructor() {
		super();
		this.q = []; this.pos = 0; this.played = 0; this.since = 0;
		this.port.onmessage = e => { if (e.data === 'flush') { this.q = []; this.pos = 0; } else this.q.push(e.data); };
	}
	process(inputs, outputs) {
		const out = outputs[0], L = out[0], R = out[1] || out[0];
		let i = 0;
		while (i < L.length && this.q.length) {
			const b = this.q[0];
			const n = Math.min(L.length - i, (b.length >> 1) - this.pos);
			for (let j = 0; j < n; j++) { L[i + j] = b[(this.pos + j) * 2]; R[i + j] = b[(this.pos + j) * 2 + 1]; }
			i += n; this.pos += n;
			if (this.pos * 2 >= b.length) { this.q.shift(); this.pos = 0; }
		}
		for (; i < L.length; i++) L[i] = R[i] = 0;
		this.played += L.length; this.since += L.length;
		if (this.since >= 256) { this.since = 0; this.port.postMessage(this.played); }
		return true;
	}
}
registerProcessor('schism-out', SchismOut);`;

export async function audio_init() {
	if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
	const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
	if (!AC) return;
	ctx = new AC({ latencyHint: 'interactive', sampleRate: audio_settings.sample_rate });
	mix_rate = ctx.sampleRate;
	const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
	await ctx.audioWorklet.addModule(url);
	node = new AudioWorkletNode(ctx, 'schism-out', { numberOfInputs: 0, outputChannelCount: [2] });
	node.port.onmessage = e => { played = e.data; pump(); };
	node.connect(ctx.destination);
	if (current_song) {
		app.csf_set_wave_config(current_song, mix_rate, 32, 2);
		song_init_modplug();
	}
	produced = played = 0;
	snapshots.length = 0;
	pumping = setInterval(pump, 8);
	if (ctx.state === 'suspended') ctx.resume();
}
export function audio_is_running() { return !!(ctx && ctx.state === 'running'); }
export function audio_sample_rate() { return mix_rate; }

function target_frames() {
	const base = Math.max(audio_settings.buffer_size, 512);
	return document.hidden ? mix_rate : base * 2; // keep playing in a background tab
}

function pump() {
	if (!node || !current_song) return;
	if (produced < played) produced = played; // underrun: resync
	let guard = 64;
	while (produced - played < target_frames() && guard--) {
		const buf = new Float32Array(CHUNK * 2);
		const n = audio_callback(buf);
		node.port.postMessage(buf, [buf.buffer]);
		produced += CHUNK;
		snapshots.push({ frame: produced - CHUNK + (n ? 0 : 0), order: current_song.current_order,
			row: current_song.row, pattern: current_song.current_pattern, tick: current_song.tick_count,
			speed: current_song.current_speed, tempo: current_song.current_tempo,
			gvol: current_song.current_global_volume, voices: Math.min(current_song.num_voices, current_song.max_voices),
			vu_left: current_song.vu_left, vu_right: current_song.vu_right, mode: song_get_mode_live(),
			time: samples_played });
		if (snapshots.length > 4096) snapshots.splice(0, 2048);
	}
	update_audible();
}

function update_audible() {
	const now = played;
	let changed = false;
	while (snapshots.length && snapshots[0].frame <= now) {
		const s = snapshots.shift();
		if (!audible || s.row !== audible.row || s.order !== audible.order || s.pattern !== audible.pattern) changed = true;
		audible = s;
	}
	const t = performance.now();
	if (changed || (t - last_update > 40 && song_get_mode_live() !== MODE_STOPPED)) {
		last_update = t;
		optional('playback_update');
	}
}

// this gets called from the pump (audio_callback in audio_playback.c)
function audio_callback(out) {
	const song = current_song;
	if (song.flags & C.SONG_ENDREACHED) { out.fill(0); return 0; }
	const bytes = new Uint8Array(pcm32.buffer);
	const n = app.csf_read(song, bytes, CHUNK * 8);
	if (!n) {
		out.fill(0);
		song_stop_unlocked(0);
		optional("main_song_mode_changed_cb");
		return 0;
	}
	samples_played += n;
	const scale = 1 / 2147483648;
	for (let i = 0; i < n * 2; i++) out[i] = pcm32[i] * scale;
	for (let i = 0; i < n * 2; i++) vis_buffer[(vis_pos + i) % vis_buffer.length] = pcm32[i] >> 16;
	vis_pos = (vis_pos + n * 2) % vis_buffer.length;
	for (let i = n * 2; i < out.length; i++) out[i] = 0;
	if (song.num_voices > max_channels_used) max_channels_used = Math.min(song.num_voices, song.max_voices);
	return n;
}

function flush_audio() {
	// drop queued audio so changes (stop, jumps) are heard at once
	if (node) node.port.postMessage('flush');
	snapshots.length = 0;
	produced = played;
	audible = null;
}

// ------------------------------------------------------------------------
// song lifecycle

export function song_lock_audio() {}
export function song_unlock_audio() {}

export function song_initialise() {
	current_song = csf_allocate();
	app.csf_set_wave_config(current_song, mix_rate, 32, 2);
	song_set_linear_pitch_slides(1);
	song_new(0);
	current_song.mix_flags |= C.SNDMIX_MUTECHNMODE;
}

export function song_init_modplug() {
	current_song.max_voices = audio_settings.channel_limit;
	app.csf_set_resampling_mode(current_song, audio_settings.interpolation_mode);
	if (audio_settings.no_ramping) current_song.mix_flags |= C.SNDMIX_NORAMPING;
	else current_song.mix_flags &= ~C.SNDMIX_NORAMPING;
	song_set_surround(audio_settings.surround_effect);
}

export function blank_sample(s) {
	Object.assign(s, { data: null, name: '', filename: '', length: 0, loop_start: 0, loop_end: 0,
		sustain_start: 0, sustain_end: 0, panning: 0, flags: 0, vib_type: 0, vib_rate: 0, vib_depth: 0,
		vib_speed: 0, played: 0, globalvol_saved: 0, c5speed: 8363, volume: 256, global_volume: 64,
		adlib_bytes: new Uint8Array(12) });
	return s;
}

export function song_new(flags) {
	song_stop_unlocked(0);
	const song = current_song;
	song.quirks.fill(1);
	if (!(flags & KEEP_PATTERNS)) {
		song_set_filename(null);
		status.flags &= ~SONG_NEEDS_SAVE;
		for (let i = 0; i < C.MAX_PATTERNS; i++) {
			song.patterns[i] = null;
			song.pattern_size[i] = song.pattern_alloc_size[i] = 64;
		}
	}
	if (!(flags & KEEP_SAMPLES)) for (let i = 1; i < C.MAX_SAMPLES; i++) blank_sample(song.samples[i]);
	if (!(flags & KEEP_INSTRUMENTS)) song.instruments.fill(null);
	if (!(flags & KEEP_ORDERLIST)) {
		song.orderlist.fill(C.ORDER_LAST);
		song.title = '';
		song.message = '';
		for (let i = 0; i < C.MAX_CHANNELS; i++) {
			Object.assign(song.channels[i], { volume: 64, panning: 128, flags: 0 });
			Object.assign(song.voices[i], { volume: 256, global_volume: 64, panning: 128, flags: 0, cutoff: 0x7f });
		}
	}
	song.repeat_count = 0;
	song.history = [];
	song.editstart = Date.now();
	optional("main_song_changed_cb");
}

export function song_set_filename(file) {
	song_filename = file || '';
	song_basename = file ? file.split('/').pop() : '';
}
export function song_get_filename() { return song_filename; }
export function song_get_basename() { return song_basename; }
export function song_get_tracker_id() { return current_song.tracker_id || ''; }

function fix_name(s, max) { return (s || '').replace(/\0/g, ' ').slice(0, max).replace(/\s+$/, ''); }

// song_load_unchecked, from a byte buffer instead of a path
export function song_load_data(name, data) {
	const was_playing = (status.flags & PLAY_AFTER_LOAD) && song_get_mode() === MODE_PLAYING;
	if (!(status.flags & PLAY_AFTER_LOAD)) song_stop();
	optional("log_nl");
	optional("log_appendf", 2, `Loading ${name}`);
	const newsong = song_create_load(data, current_song);
	if (!newsong) {
		optional("log_appendf", 4, ' Unrecognised file type');
		return 0;
	}
	song_set_filename(name);
	app.csf_set_wave_config(newsong, mix_rate, 32, 2);
	current_song = newsong;
	current_song.repeat_count = 0;
	current_song.editstart = Date.now();
	max_channels_used = 0;
	current_song.title = fix_name(current_song.title, 25);
	for (let n = 1; n < C.MAX_SAMPLES; n++) {
		const s = current_song.samples[n];
		s.name = fix_name(s.name, 25); s.filename = fix_name(s.filename, 12);
	}
	for (const ins of current_song.instruments) if (ins) { ins.name = fix_name(ins.name, 25); ins.filename = fix_name(ins.filename, 12); }
	current_song.mix_flags |= C.SNDMIX_MUTECHNMODE;
	song_stop_unlocked(0);
	song_init_modplug();
	flush_audio();
	if (was_playing) song_start();
	optional("main_song_changed_cb");
	status.flags &= ~SONG_NEEDS_SAVE;
	const nsmp = current_song.samples.slice(1).filter(s => s.data).length;
	const nins = current_song.instruments.filter(Boolean).length;
	if (current_song.tracker_id) optional("log_appendf", 5, ' ' + current_song.tracker_id);
	optional("log_appendf", 5, ` ${csf_get_num_patterns(current_song)} patterns, ${nsmp} samples` + (nins ? `, ${nins} instruments` : ''));
	return 1;
}

// ------------------------------------------------------------------------
// playback control (audio_playback.c)

let current_play_channel = 1, multichannel_mode = 0;
export function song_get_current_play_channel() { return current_play_channel; }
export function song_change_current_play_channel(relative, wraparound) {
	current_play_channel += relative;
	if (wraparound) {
		if (current_play_channel < 1) current_play_channel = C.MAX_CHANNELS;
		else if (current_play_channel > C.MAX_CHANNELS) current_play_channel = 1;
	} else current_play_channel = Math.max(1, Math.min(C.MAX_CHANNELS, current_play_channel));
	app.status_text_flash(`Using channel ${current_play_channel} for playback`);
}
export function song_toggle_multichannel_mode() {
	multichannel_mode = !multichannel_mode;
	app.status_text_flash(`Multichannel playback ${multichannel_mode ? 'enabled' : 'disabled'}`);
}
export function song_is_multichannel_mode() { return multichannel_mode; }

const keyjazz_note_to_chan = new Int32Array(C.NOTE_LAST + 1);
const keyjazz_chan_to_note = new Int32Array(C.MAX_CHANNELS + 1);

function song_keydown_ex(samp, ins, note, vol, chan, effect, param) {
	audio_init();
	const song = current_song;
	const midi_note = note;
	if (chan === KEYJAZZ_CHAN_CURRENT) {
		chan = current_play_channel;
		if (multichannel_mode) song_change_current_play_channel(1, 1);
	} else if (chan === KEYJAZZ_CHAN_AUTO) {
		if (multichannel_mode) { chan = current_play_channel; song_change_current_play_channel(1, 1); }
		else { for (chan = 1; chan < C.MAX_CHANNELS; chan++) if (!keyjazz_chan_to_note[chan]) break; }
	}
	const ci = chan - 1;
	const c = song.voices[ci];
	const ins_mode = song_is_instrument_mode();
	let s = null, i = null;
	if (note > 0 && note <= C.NOTE_LAST) {
		if (keyjazz_chan_to_note[chan]) keyjazz_note_to_chan[keyjazz_chan_to_note[chan]] = 0;
		keyjazz_note_to_chan[note] = chan;
		keyjazz_chan_to_note[chan] = note;
		if (samp === 0) samp = c.last_instrument; else if (samp === KEYJAZZ_INST_FAKE) samp = 0;
		if (ins === 0) ins = c.last_instrument; else if (ins === KEYJAZZ_INST_FAKE) ins = 0;
		c.last_instrument = ins_mode ? ins : samp;
		s = samp === KEYJAZZ_NOINST ? null : song.samples[samp];
		i = ins === KEYJAZZ_NOINST ? null : song_get_instrument(ins);
		if (i && samp === KEYJAZZ_NOINST)
			s = app.csf_translate_keyboard(song, i, note, ins_mode ? null : song.samples[ins]);
	}
	c.row_effect = effect;
	c.row_param = param;
	if (i) app.csf_check_nna(song, ci, ins, note, 0);
	if (s) {
		c.flags = (s.flags & C.CHN_SAMPLE_FLAGS) | (c.flags & C.CHN_MUTE);
		if (c.flags & C.CHN_MUTE) c.flags |= C.CHN_NNAMUTE;
		c.cutoff = 0x7f; c.resonance = 0;
		if (i) {
			c.ptr_instrument = i;
			if (!(i.flags & C.ENV_VOLCARRY)) c.vol_env_position = 0;
			if (!(i.flags & C.ENV_PANCARRY)) c.pan_env_position = 0;
			if (!(i.flags & C.ENV_PITCHCARRY)) c.pitch_env_position = 0;
			if (i.flags & C.ENV_VOLUME) c.flags |= C.CHN_VOLENV;
			if (i.flags & C.ENV_PANNING) c.flags |= C.CHN_PANENV;
			if (i.flags & C.ENV_PITCH) c.flags |= C.CHN_PITCHENV;
			i.played = 1;
			if (i.ifc & 0x80) c.cutoff = i.ifc & 0x7f;
			if (i.ifr & 0x80) c.resonance = i.ifr & 0x7f;
			c.vol_swing = i.vol_swing; c.pan_swing = i.pan_swing; c.nna = i.nna;
		} else {
			c.ptr_instrument = null; c.cutoff = 0x7f; c.resonance = 0;
		}
		c.master_channel = 0;
		c.ptr_sample = s;
		c.length = 0;
		c.volume = vol === KEYJAZZ_DEFAULTVOL ? s.volume : (vol << 2);
		c.instrument_volume = s.global_volume;
		if (i) c.instrument_volume = (c.instrument_volume * i.global_volume) >> 7;
		c.global_volume = 64;
		c.channel_panning = (c.panning + 1) & 0xffff;
		if (c.flags & C.CHN_SURROUND) c.channel_panning |= 0x8000;
		c.panning = 128;
		if (s.flags & C.CHN_PANNING) c.panning = s.panning;
		if (i && (i.flags & C.ENV_SETPANNING)) c.panning = i.panning;
		c.flags &= ~C.CHN_SURROUND;
		c.c5speed = s.c5speed;
		c.new_note = note;
		s.played = 1;
	} else if (note > 0 && note <= C.NOTE_LAST) {
		note = C.NOTE_NONE;
	}
	if (c.increment && c.increment.v < 0n) c.increment = { v: -c.increment.v };
	app.csf_note_change(song, ci, note, 0, 0, 1);
	void midi_note;
	if (song.flags & C.SONG_ENDREACHED) {
		song.flags &= ~C.SONG_ENDREACHED;
		song.flags |= C.SONG_PAUSED;
	}
	return chan;
}
export function song_keydown(samp, ins, note, vol, chan) { return song_keydown_ex(samp, ins, note, vol, chan, C.FX_PANNING, 0x80); }
export function song_keyrecord(samp, ins, note, vol, chan, effect, param) { return song_keydown_ex(samp, ins, note, vol, chan, effect, param); }
export function song_keyup(samp, ins, note) {
	const chan = keyjazz_note_to_chan[note];
	if (!chan) return -1;
	return song_keyup_channel(samp, ins, note, chan);
}
export function song_keyup_channel(samp, ins, note, chan) {
	if (keyjazz_chan_to_note[chan] !== note) return -1;
	keyjazz_chan_to_note[chan] = 0;
	keyjazz_note_to_chan[note] = 0;
	return song_keydown_ex(samp, ins, C.NOTE_OFF, KEYJAZZ_DEFAULTVOL, chan, 0, 0);
}

export function song_single_step(patno, row) {
	const pattern = song_get_pattern_buf(patno);
	const total_rows = song_get_pattern(patno);
	if (!pattern || row >= total_rows) return;
	for (let i = 1; i <= C.MAX_CHANNELS; i++) {
		const cx = current_song.voices[i - 1], n = pattern[row * 64 + i - 1];
		if (cx.flags & C.CHN_MUTE) continue;
		const vol = n.voleffect === C.VOLFX_VOLUME ? n.volparam : KEYJAZZ_DEFAULTVOL;
		let smp = n.instrument, ins = n.instrument;
		if (song_is_instrument_mode()) { if (ins < 1) ins = KEYJAZZ_NOINST; smp = -1; }
		else { if (smp < 1) smp = KEYJAZZ_NOINST; ins = -1; }
		song_keyrecord(smp, ins, n.note, vol, i, n.effect, n.param);
	}
}

function song_reset_play_state() {
	keyjazz_note_to_chan.fill(0);
	keyjazz_chan_to_note.fill(0);
	current_song.mix_flags &= ~(C.SNDMIX_NOBACKWARDJUMPS | C.SNDMIX_DIRECTTODISK);
	csf_set_current_order(current_song, 0);
	current_song.repeat_count = 0;
	current_song.buffer_count = 0;
	current_song.flags &= ~(C.SONG_PAUSED | C.SONG_PATTERNLOOP | C.SONG_ENDREACHED);
	current_song.stop_at_order = -1;
	current_song.stop_at_row = -1;
	samples_played = 0;
}
function mode_changed() { flush_audio(); optional("main_song_mode_changed_cb"); status.flags |= NEED_UPDATE; }

export function song_start_once() {
	audio_init();
	song_reset_play_state();
	current_song.mix_flags |= C.SNDMIX_NOBACKWARDJUMPS;
	max_channels_used = 0;
	current_song.repeat_count = -1;
	mode_changed();
	csf_reset_playmarks(current_song);
}
export function song_start() {
	audio_init();
	song_reset_play_state();
	max_channels_used = 0;
	mode_changed();
	csf_reset_playmarks(current_song);
}
export function song_pause() {
	if (!(current_song.flags & C.SONG_PAUSED)) current_song.flags ^= C.SONG_ENDREACHED;
	mode_changed();
}
export function song_stop() { song_stop_unlocked(0); mode_changed(); }
export function song_stop_unlocked() {
	if (!current_song) return;
	song_reset_play_state();
	current_song.flags |= C.SONG_PAUSED | C.SONG_ENDREACHED;
	current_song.vu_left = current_song.vu_right = 0;
}
export function song_loop_pattern(pattern, row) {
	audio_init();
	song_reset_play_state();
	max_channels_used = 0;
	csf_loop_pattern(current_song, pattern, row);
	mode_changed();
	csf_reset_playmarks(current_song);
}
export function song_start_at_order(order, row) {
	audio_init();
	song_reset_play_state();
	csf_set_current_order(current_song, order);
	current_song.break_row = row;
	max_channels_used = 0;
	mode_changed();
	csf_reset_playmarks(current_song);
}
export function song_start_at_pattern(pattern, row) {
	if (pattern < 0 || pattern > 199) return;
	const n = song_next_order_for_pattern(pattern);
	if (n > -1) { song_start_at_order(n, row); return; }
	song_loop_pattern(pattern, row);
}

function song_get_mode_live() {
	const f = current_song.flags;
	if ((f & (C.SONG_ENDREACHED | C.SONG_PAUSED)) === (C.SONG_ENDREACHED | C.SONG_PAUSED)) return MODE_STOPPED;
	if (f & C.SONG_PAUSED) return MODE_SINGLE_STEP;
	if (f & C.SONG_PATTERNPLAYBACK) return MODE_PATTERN_LOOP;
	return MODE_PLAYING;
}
export function song_get_mode() { return song_get_mode_live(); }
// position getters report what is being heard, not what was last mixed
const A = key => (audible && song_get_mode_live() !== MODE_STOPPED ? audible[key] : null);
export function song_get_current_time() { const t = A('time'); return Math.trunc((t ?? samples_played) / current_song.mix_frequency); }
export function song_get_current_tick() { const t = A('tick') ?? current_song.tick_count; const s = A('speed') ?? current_song.current_speed; return s ? t % s : 0; }
export function song_get_current_speed() { return current_song.current_speed; }
export function song_set_current_tempo(t) { current_song.current_tempo = Math.max(31, Math.min(255, t)); }
export function song_get_current_tempo() { return current_song.current_tempo; }
export function song_get_current_global_volume() { return current_song.current_global_volume; }
export function song_get_current_order() { return A('order') ?? current_song.current_order; }
export function song_get_playing_pattern() { return A('pattern') ?? current_song.current_pattern; }
export function song_get_current_row() { return A('row') ?? current_song.row; }
export function song_get_playing_channels() { return A('voices') ?? Math.min(current_song.num_voices, current_song.max_voices); }
export function song_get_max_channels() { return max_channels_used; }
function dB_s(noisefloor, correction_dBs, val) {
	const dB = 20 * Math.log10(val) + correction_dBs;
	return Math.max(0, Math.min(128, Math.round((dB + noisefloor) * 128 / noisefloor)));
}
export function song_get_vu_meter() {
	const l = A('vu_left') ?? current_song.vu_left, r = A('vu_right') ?? current_song.vu_right;
	return [dB_s(40, 0, l / 256), dB_s(40, 0, r / 256)];
}
export function song_update_playing_instrument(i) { optional("csf_update_playing_instrument", current_song, i); }
export function song_update_playing_sample(s) { csf_update_playing_sample(current_song, s); }
export function song_get_playing_samples() {
	const samples = new Int32Array(C.MAX_SAMPLES);
	let n = Math.min(current_song.num_voices, current_song.max_voices);
	while (n--) {
		const ch = current_song.voices[current_song.voice_mix[n]];
		if (ch.ptr_sample && ch.current_sample_data) {
			const s = current_song.samples.indexOf(ch.ptr_sample);
			if (s >= 0 && s < C.MAX_SAMPLES) samples[s] = Math.max(samples[s], 1 + (ch.strike | 0));
		}
	}
	return samples;
}
export function song_get_playing_instruments() {
	const instruments = new Int32Array(C.MAX_INSTRUMENTS);
	let n = Math.min(current_song.num_voices, current_song.max_voices);
	while (n--) {
		const ch = current_song.voices[current_song.voice_mix[n]];
		const ins = song_get_instrument_number(ch.ptr_instrument);
		if (ins > 0 && ins < C.MAX_INSTRUMENTS) instruments[ins] = Math.max(instruments[ins], 1 + (ch.strike | 0));
	}
	return instruments;
}
export function song_set_current_speed(speed) { if (speed >= 1 && speed <= 255) current_song.current_speed = speed; }
export function song_set_current_global_volume(v) { if (v >= 0 && v <= 128) current_song.current_global_volume = v; }
export function song_set_current_order(order) { csf_set_current_order(current_song, order); flush_audio(); }
export function song_set_next_order(order) { current_song.process_order = order - 1; }
export function song_toggle_orderlist_locked() { current_song.flags ^= C.SONG_ORDERLOCKED; return current_song.flags & C.SONG_ORDERLOCKED; }
export function song_flip_stereo() { current_song.mix_flags ^= C.SNDMIX_REVERSESTEREO; }
export function song_get_surround() { return current_song.mix_flags & C.SNDMIX_NOSURROUND ? 0 : 1; }
export function song_set_surround(on) {
	if (on) current_song.mix_flags &= ~C.SNDMIX_NOSURROUND; else current_song.mix_flags |= C.SNDMIX_NOSURROUND;
	audio_settings.surround_effect = on;
}

// ------------------------------------------------------------------------
// mplink.c

export function song_get_length_to(order, row) {
	current_song.stop_at_order = order; current_song.stop_at_row = row;
	const t = csf_get_length(current_song);
	current_song.stop_at_order = current_song.stop_at_row = -1;
	return t;
}
export function song_get_length() { return csf_get_length(current_song); }
export function song_get_at_time(seconds) {
	if (!seconds) return [0, 0];
	current_song.stop_at_order = C.MAX_ORDERS; current_song.stop_at_row = 255;
	current_song.stop_at_time = seconds;
	csf_get_length(current_song);
	const r = [current_song.stop_at_order, current_song.stop_at_row];
	current_song.stop_at_order = current_song.stop_at_row = -1;
	current_song.stop_at_time = 0;
	return r;
}
export function song_get_sample(n) { return n >= C.MAX_SAMPLES ? null : current_song.samples[n]; }
export function song_get_instrument(n) {
	if (n >= C.MAX_INSTRUMENTS) return null;
	if (!current_song.instruments[n]) current_song.instruments[n] = csf_allocate_instrument();
	return current_song.instruments[n];
}
export function song_get_instrument_number(inst) {
	if (inst) for (let n = 1; n < C.MAX_INSTRUMENTS; n++) if (inst === current_song.instruments[n]) return n;
	return 0;
}
export function song_get_channel(n) { return n >= C.MAX_CHANNELS ? null : current_song.channels[n]; }
export function song_get_mix_channel(n) { return n >= C.MAX_VOICES ? null : current_song.voices[n]; }
export function song_get_mix_state() { return [Math.min(current_song.num_voices, current_song.max_voices), current_song.voice_mix]; }

const channel_states = new Int32Array(C.MAX_CHANNELS);
const _save_state = ch => { channel_states[ch] = current_song.voices[ch].flags & C.CHN_MUTE; };
export function song_save_channel_states() { for (let n = 0; n < C.MAX_CHANNELS; n++) _save_state(n); }
function _fix_mutes_like(chan) {
	for (let i = 0; i < C.MAX_VOICES; i++) {
		if (i === chan) continue;
		const v = current_song.voices[i];
		if (v.master_channel !== chan + 1) continue;
		v.flags = (v.flags & ~C.CHN_MUTE) | (current_song.voices[chan].flags & C.CHN_MUTE);
	}
}
export function song_set_channel_mute(channel, muted) {
	if (muted) {
		current_song.channels[channel].flags |= C.CHN_MUTE;
		current_song.voices[channel].flags |= C.CHN_MUTE;
	} else {
		current_song.channels[channel].flags &= ~C.CHN_MUTE;
		current_song.voices[channel].flags &= ~C.CHN_MUTE;
		_save_state(channel);
	}
	_fix_mutes_like(channel);
}
export function song_restore_channel_states() { for (let n = 0; n < C.MAX_CHANNELS; n++) song_set_channel_mute(n, channel_states[n]); }
export function song_toggle_channel_mute(channel) {
	song_set_channel_mute(channel, (current_song.voices[channel].flags & C.CHN_MUTE) === 0);
}
function _soloed(channel) {
	if (current_song.voices[channel].flags & C.CHN_MUTE) return 0;
	for (let n = 0; n < C.MAX_CHANNELS; n++) if (n !== channel && !(current_song.voices[n].flags & C.CHN_MUTE)) return 0;
	return 1;
}
export function song_handle_channel_solo(channel) {
	if (_soloed(channel)) song_restore_channel_states();
	else for (let n = 0; n < C.MAX_CHANNELS; n++) song_set_channel_mute(n, n !== channel);
}
export function song_find_last_channel() {
	let n = C.MAX_CHANNELS;
	while (channel_states[--n]) if (n === 0) return C.MAX_CHANNELS - 1;
	return n;
}

// song_get_pattern: returns the length; song_get_pattern_buf returns the notes (allocating)
export function song_get_pattern(n) {
	if (n >= C.MAX_PATTERNS || n < 0) return 0;
	if (!current_song.patterns[n]) return 64;
	return current_song.pattern_size[n];
}
export function song_get_pattern_buf(n) {
	if (n >= C.MAX_PATTERNS || n < 0) return null;
	if (!current_song.patterns[n]) {
		current_song.pattern_size[n] = current_song.pattern_alloc_size[n] = 64;
		current_song.patterns[n] = csf_allocate_pattern(64);
	}
	return current_song.patterns[n];
}
// returns [length, pattern, row] or [0]
export function song_get_pattern_offset(pattern, row, offset) {
	if (song_get_mode() & MODE_PATTERN_LOOP) {
		const max = song_get_max_row_number_in_pattern(pattern);
		row = (row + offset) % (max + 1);
		return [song_get_pattern(pattern), pattern, row];
	}
	let max = song_get_max_row_number_in_pattern(pattern);
	while (offset + row > max) {
		offset -= max + 1;
		pattern++;
		max = song_get_max_row_number_in_pattern(pattern);
		if (max < 0) return [0, pattern, row];
	}
	return [song_get_pattern(pattern), pattern, row + offset];
}
export function song_pattern_allocate_copy(patno) {
	const old = current_song.patterns[patno];
	return [old ? old.map(n => ({ ...n })) : null, current_song.pattern_size[patno]];
}
export function song_pattern_install(patno, n, rows) {
	current_song.patterns[patno] = n;
	current_song.pattern_alloc_size[patno] = current_song.pattern_size[patno] = rows;
}
export function song_get_orderlist() { return current_song.orderlist; }
export function song_pattern_is_empty(p) { return app.csf_pattern_is_empty(current_song, p); }
export function song_next_order_for_pattern(pat) {
	const ord = Math.max(0, Math.min(255, current_song.current_order));
	for (let i = ord; i < 255; i++) if (current_song.orderlist[i] === pat) return i;
	for (let i = 0; i < ord; i++) if (current_song.orderlist[i] === pat) return i;
	return -1;
}
export function song_get_max_row_number_in_pattern(pattern) {
	if (pattern < 0 || pattern >= C.MAX_PATTERNS) return -1;
	return (current_song.pattern_size[pattern] || 64) - 1;
}
export function song_pattern_resize(pattern, newsize) {
	const song = current_song;
	status.flags |= SONG_NEEDS_SAVE;
	const old = song.patterns[pattern];
	if (!old && newsize !== 64) {
		song.patterns[pattern] = csf_allocate_pattern(newsize);
		song.pattern_alloc_size[pattern] = newsize;
	} else if (old && old.length < newsize * 64) {
		const n = csf_allocate_pattern(newsize);
		for (let i = 0; i < old.length; i++) n[i] = old[i];
		song.patterns[pattern] = n;
		song.pattern_alloc_size[pattern] = Math.max(newsize, song.pattern_alloc_size[pattern]);
	}
	song.pattern_size[pattern] = newsize;
}
export function song_get_initial_speed() { return current_song.initial_speed; }
export function song_set_initial_speed(v) { current_song.initial_speed = Math.max(1, Math.min(255, v)); }
export function song_get_initial_tempo() { return current_song.initial_tempo; }
export function song_set_initial_tempo(v) { current_song.initial_tempo = Math.max(31, Math.min(255, v)); }
export function song_get_initial_global_volume() { return current_song.initial_global_volume; }
export function song_set_initial_global_volume(v) { current_song.initial_global_volume = Math.max(0, Math.min(128, v)); }
export function song_get_mixing_volume() { return current_song.mixing_volume; }
export function song_set_mixing_volume(v) { current_song.mixing_volume = Math.max(0, Math.min(128, v)); }
export function song_get_separation() { return current_song.pan_separation; }
export function song_set_separation(v) { current_song.pan_separation = Math.max(0, Math.min(128, v)); }
export function song_is_stereo() { return current_song.flags & C.SONG_NOSTEREO ? 0 : 1; }
export function song_toggle_stereo() { current_song.flags ^= C.SONG_NOSTEREO; optional("song_vars_sync_stereo"); }
export function song_set_mono() { current_song.flags |= C.SONG_NOSTEREO; optional("song_vars_sync_stereo"); }
export function song_set_stereo() { current_song.flags &= ~C.SONG_NOSTEREO; optional("song_vars_sync_stereo"); }
const flagfns = (flag) => [() => (current_song.flags & flag) ? 1 : 0, (v) => { if (v) current_song.flags |= flag; else current_song.flags &= ~flag; }];
export const [song_has_old_effects, song_set_old_effects] = flagfns(C.SONG_ITOLDEFFECTS);
export const [song_has_compatible_gxx, song_set_compatible_gxx] = flagfns(C.SONG_COMPATGXX);
export const [song_has_linear_pitch_slides, song_set_linear_pitch_slides] = flagfns(C.SONG_LINEARSLIDES);
export function song_is_instrument_mode() { return current_song.flags & C.SONG_INSTRUMENTMODE ? 1 : 0; }
export function song_set_instrument_mode(value) {
	const old = song_is_instrument_mode();
	if (value && !old) {
		current_song.flags |= C.SONG_INSTRUMENTMODE;
		for (const ins of current_song.instruments) {
			if (!ins) continue;
			for (let j = 0; j < 128; j++) if (ins.note_map[j] < 1 || ins.note_map[j] > 120) ins.note_map[j] = j + 1;
		}
	} else if (!value && old) current_song.flags &= ~C.SONG_INSTRUMENTMODE;
}
export function song_get_current_instrument() {
	return song_is_instrument_mode() ? app.instrument_get_current() : app.sample_get_current();
}
export function song_exchange_samples(a, b) {
	if (a === b) return;
	csf_stop_sample(current_song, current_song.samples[a]);
	csf_stop_sample(current_song, current_song.samples[b]);
	const s = current_song.samples, t = s[a]; s[a] = s[b]; s[b] = t;
	status.flags |= SONG_NEEDS_SAVE;
}
export function song_copy_instrument(dst, src) {
	if (src === dst) return;
	song_get_instrument(dst); song_get_instrument(src);
	const s = current_song.instruments[src];
	current_song.instruments[dst] = { ...s, vol_env: clone_env(s.vol_env), pan_env: clone_env(s.pan_env),
		pitch_env: clone_env(s.pitch_env), sample_map: new Uint8Array(s.sample_map), note_map: new Uint8Array(s.note_map) };
	status.flags |= SONG_NEEDS_SAVE;
}
function clone_env(e) { return { ...e, ticks: new Int32Array(e.ticks), values: new Uint8Array(e.values) }; }
export function song_exchange_instruments(a, b) {
	if (a === b) return;
	const i = current_song.instruments, t = i[a]; i[a] = i[b]; i[b] = t;
	status.flags |= SONG_NEEDS_SAVE;
}
function _for_each_note(fn) {
	for (let pat = 0; pat < C.MAX_PATTERNS; pat++) {
		const p = current_song.patterns[pat];
		if (!p) continue;
		const n = C.MAX_CHANNELS * current_song.pattern_size[pat];
		for (let i = 0; i < n && i < p.length; i++) fn(p[i]);
	}
}
function _swap_instruments_in_patterns(a, b) {
	_for_each_note(n => { if (n.instrument === a) n.instrument = b; else if (n.instrument === b) n.instrument = a; });
}
export function song_swap_samples(a, b) {
	if (a === b) return;
	if (song_is_instrument_mode()) {
		for (const ins of current_song.instruments) if (ins)
			for (let s = 0; s < 128; s++) {
				if (ins.sample_map[s] === a) ins.sample_map[s] = b;
				else if (ins.sample_map[s] === b) ins.sample_map[s] = a;
			}
	} else _swap_instruments_in_patterns(a, b);
	song_exchange_samples(a, b);
}
export function song_swap_instruments(a, b) {
	if (a === b) return;
	if (song_is_instrument_mode()) _swap_instruments_in_patterns(a, b);
	song_exchange_instruments(a, b);
}
function _adjust_instruments_in_patterns(start, delta) {
	_for_each_note(n => { if (n.instrument >= start) n.instrument = Math.max(0, Math.min(C.MAX_SAMPLES - 1, n.instrument + delta)); });
}
function _adjust_samples_in_instruments(start, delta) {
	for (let n = 1; n < C.MAX_INSTRUMENTS; n++) {
		const ins = current_song.instruments[n];
		if (!ins) continue;
		for (let s = 0; s < 128; s++) if (ins.sample_map[s] >= start) ins.sample_map[s] = Math.max(0, Math.min(C.MAX_SAMPLES - 1, ins.sample_map[s] + delta));
	}
}
export function song_init_instrument_from_sample(insn, samp) {
	if (!csf_instrument_is_empty(current_song.instruments[insn])) return;
	if (!current_song.samples[samp].data) return;
	const ins = song_get_instrument(insn);
	csf_init_instrument(ins, samp);
	ins.name = current_song.samples[samp].name;
}
export function song_init_instruments(qq) {
	for (let n = 1; n < C.MAX_INSTRUMENTS; n++) {
		if (qq > -1 && qq !== n) continue;
		song_init_instrument_from_sample(n, n);
	}
}
export function song_insert_sample_slot(n) {
	const s = current_song.samples;
	if (s[C.MAX_SAMPLES - 1].data) return;
	status.flags |= SONG_NEEDS_SAVE;
	s.splice(C.MAX_SAMPLES - 1, 1);
	s.splice(n, 0, blank_sample({}));
	if (song_is_instrument_mode()) _adjust_samples_in_instruments(n, 1);
	else _adjust_instruments_in_patterns(n, 1);
}
export function song_remove_sample_slot(n) {
	const s = current_song.samples;
	if (s[n].data) return;
	status.flags |= SONG_NEEDS_SAVE;
	s.splice(n, 1);
	s.splice(C.MAX_SAMPLES - 1, 0, blank_sample({}));
	if (song_is_instrument_mode()) _adjust_samples_in_instruments(n, -1);
	else _adjust_instruments_in_patterns(n, -1);
}
export function song_insert_instrument_slot(n) {
	const ins = current_song.instruments;
	if (!csf_instrument_is_empty(ins[C.MAX_INSTRUMENTS - 1])) return;
	status.flags |= SONG_NEEDS_SAVE;
	for (let i = C.MAX_INSTRUMENTS - 1; i > n; i--) ins[i] = ins[i - 1];
	ins[n] = null;
	_adjust_instruments_in_patterns(n, 1);
}
export function song_remove_instrument_slot(n) {
	const ins = current_song.instruments;
	if (!csf_instrument_is_empty(ins[n])) return;
	for (let i = n; i < C.MAX_INSTRUMENTS; i++) ins[i] = ins[i + 1] || null;
	ins[C.MAX_INSTRUMENTS - 1] = null;
	_adjust_instruments_in_patterns(n, -1);
}
export function song_wipe_instrument(n) {
	if (csf_instrument_is_empty(current_song.instruments[n])) return;
	if (!current_song.instruments[n]) return;
	status.flags |= SONG_NEEDS_SAVE;
	current_song.instruments[n] = null;
}
function _used_by_many(n) {
	let found = 0;
	for (const ins of current_song.instruments) if (ins && ins.sample_map.includes(n)) { if (found) return 1; found = 1; }
	return 0;
}
export function song_delete_instrument(n, preserve_samples) {
	const ins = current_song.instruments[n];
	if (!ins) return;
	for (let i = 0; i < 128; i++) {
		const j = ins.sample_map[i];
		if (j && (!preserve_samples || !_used_by_many(j))) song_clear_sample(j);
	}
	song_wipe_instrument(n);
}
export function song_replace_sample(num, wth) {
	if (num < 1 || num > C.MAX_SAMPLES || wth < 1 || wth > C.MAX_SAMPLES) return;
	if (song_is_instrument_mode()) {
		for (const ins of current_song.instruments) if (ins) for (let j = 0; j < 128; j++) if (ins.sample_map[j] === num) ins.sample_map[j] = wth;
	} else _for_each_note(n => { if (n.instrument === num) n.instrument = wth; });
}
export function song_replace_instrument(num, wth) {
	if (num < 1 || num > C.MAX_INSTRUMENTS || wth < 1 || wth > C.MAX_INSTRUMENTS || !song_is_instrument_mode()) return;
	_for_each_note(n => { if (n.instrument === num) n.instrument = wth; });
}
export function song_clear_sample(n) {
	csf_destroy_sample(current_song, n);
	blank_sample(current_song.samples[n]);
}
export function song_copy_sample(n, src) {
	csf_stop_sample(current_song, current_song.samples[n]);
	const dst = current_song.samples[n];
	Object.assign(dst, src, { adlib_bytes: new Uint8Array(src.adlib_bytes || 12) });
	if (src.data) {
		const ch = src.flags & C.CHN_STEREO ? 2 : 1;
		dst.data = src.data.slice(0, src.length * ch);
		csf_adjust_sample_loop(dst);
	}
}
export function song_get_title() { return current_song.title; }
export function song_get_message() { return current_song.message; }

provide({
	song_initialise, song_new, song_init_modplug, song_load_data, song_get_filename, song_get_basename,
	song_get_tracker_id, song_get_current_play_channel, song_change_current_play_channel,
	song_toggle_multichannel_mode, song_is_multichannel_mode, song_keydown, song_keyrecord, song_keyup,
	song_keyup_channel, song_single_step, song_start_once, song_start, song_pause, song_stop,
	song_stop_unlocked, song_loop_pattern, song_start_at_order, song_start_at_pattern, song_get_mode,
	song_get_current_time, song_get_current_tick, song_get_current_speed, song_set_current_tempo,
	song_get_current_tempo, song_get_current_global_volume, song_get_current_order,
	song_get_playing_pattern, song_get_current_row, song_get_playing_channels, song_get_max_channels,
	song_get_vu_meter, song_update_playing_instrument, song_update_playing_sample,
	song_get_playing_samples, song_get_playing_instruments, song_set_current_speed,
	song_set_current_global_volume, song_set_current_order, song_set_next_order,
	song_toggle_orderlist_locked, song_flip_stereo, song_get_surround, song_set_surround,
	song_get_length_to, song_get_length, song_get_at_time, song_get_sample, song_get_instrument,
	song_get_instrument_number, song_get_channel, song_get_mix_channel, song_get_mix_state,
	song_save_channel_states, song_set_channel_mute, song_restore_channel_states,
	song_toggle_channel_mute, song_handle_channel_solo, song_find_last_channel, song_get_pattern,
	song_get_pattern_buf, song_get_pattern_offset, song_pattern_allocate_copy, song_pattern_install,
	song_get_orderlist, song_pattern_is_empty, song_next_order_for_pattern,
	song_get_max_row_number_in_pattern, song_pattern_resize, song_get_initial_speed,
	song_set_initial_speed, song_get_initial_tempo, song_set_initial_tempo,
	song_get_initial_global_volume, song_set_initial_global_volume, song_get_mixing_volume,
	song_set_mixing_volume, song_get_separation, song_set_separation, song_is_stereo,
	song_toggle_stereo, song_set_mono, song_set_stereo, song_has_old_effects, song_set_old_effects,
	song_has_compatible_gxx, song_set_compatible_gxx, song_has_linear_pitch_slides,
	song_set_linear_pitch_slides, song_is_instrument_mode, song_set_instrument_mode,
	song_get_current_instrument, song_exchange_samples, song_copy_instrument,
	song_exchange_instruments, song_swap_samples, song_swap_instruments,
	song_init_instrument_from_sample, song_init_instruments, song_insert_sample_slot,
	song_remove_sample_slot, song_insert_instrument_slot, song_remove_instrument_slot,
	song_wipe_instrument, song_delete_instrument, song_replace_sample, song_replace_instrument,
	song_clear_sample, song_copy_sample, song_get_title, song_get_message, audio_init,
	song_get_vis_buffer, current_song: () => current_song,
});
