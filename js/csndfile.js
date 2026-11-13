// Initial data-model portion of player/csndfile.c (GPL-2.0-or-later).
// Playback, sample decoding and mixer state are still unported.
import { app, provide } from './app.js';
import { VOICE_SCALARS } from './gen/voice.js';
import { QUIRK, FX, S3M_EFFECTS } from './gen/tables.js';

export const MAX_CHANNELS = 64, MAX_PATTERNS = 240, MAX_ORDERS = 256;
export const MAX_SAMPLES = 236, MAX_INSTRUMENTS = MAX_SAMPLES;
export const ORDER_LAST = 255;

export function csf_allocate_pattern(rows) {
	if (!Number.isInteger(rows) || rows < 0) throw new RangeError('Invalid pattern size');
	return Array.from({ length: rows * MAX_CHANNELS }, () => ({
		note: 0, instrument: 0, voleffect: 0, volparam: 0, effect: 0, param: 0,
	}));
}
export function csf_note_is_empty(note) {
	return !note.note && !note.instrument && !note.voleffect && !note.volparam && !note.effect && !note.param;
}
export function csf_pattern_is_empty(csf, n) {
	return !csf.patterns[n] || (csf.pattern_size[n] === 64 && csf.patterns[n].every(csf_note_is_empty));
}
export function csf_last_order(csf) {
	let n = 0;
	while (n < MAX_ORDERS && csf.orderlist[n] !== ORDER_LAST) n++;
	return n ? n - 1 : 0;
}
export function csf_get_num_orders(csf) {
	let n = MAX_ORDERS - 1;
	while (n >= 0 && csf.orderlist[n] === ORDER_LAST) n--;
	return n + 1;
}
export function csf_get_num_patterns(csf) {
	let n = MAX_PATTERNS - 1;
	while (n && csf_pattern_is_empty(csf, n)) n--;
	return n + 1;
}
function _init_envelope(value) {
	const ticks = new Int32Array(32), values = new Uint8Array(32);
	ticks[1] = 100;
	values[0] = values[1] = value;
	return { ticks, values, nodes: 2, loop_start: 0, loop_end: 0, sustain_start: 0, sustain_end: 0 };
}
export function csf_init_instrument(ins, samp) {
	for (const key of Object.keys(ins)) delete ins[key];
	for (const key of ['fadeout', 'flags', 'nna', 'dct', 'dca', 'pan_swing', 'vol_swing',
		'ifc', 'ifr', 'midi_channel_mask', 'pitch_pan_separation', 'played']) ins[key] = 0;
	Object.assign(ins, { global_volume: 128, panning: 128, midi_bank: -1, midi_program: -1,
		pitch_pan_center: 60, name: '', filename: '',
		vol_env: _init_envelope(64), pan_env: _init_envelope(32), pitch_env: _init_envelope(32),
		sample_map: new Uint8Array(128).fill(samp),
		note_map: Uint8Array.from({ length: 128 }, (_, n) => n + 1) });
}
export function csf_allocate_instrument() {
	const ins = {};
	csf_init_instrument(ins, 0);
	return ins;
}
provide({ csf_allocate_pattern, csf_note_is_empty, csf_pattern_is_empty,
	csf_last_order, csf_get_num_orders, csf_get_num_patterns,
	csf_init_instrument, csf_allocate_instrument });

// Core song storage. OPL, MIDI playback and voice/mixer structures are added
// with their respective player ports; this is not yet the full _csf_reset.
function allocate_sample() {
	const sample = { data: null, name: '', filename: '', adlib_bytes: new Uint8Array(12) };
	for (const key of ['length', 'loop_start', 'loop_end', 'sustain_start', 'sustain_end',
		'panning', 'flags', 'vib_type', 'vib_rate', 'vib_depth', 'vib_speed', 'played', 'globalvol_saved']) sample[key] = 0;
	return Object.assign(sample, { c5speed: 8363, volume: 256, global_volume: 64 });
}
export function csf_allocate() {
	return {
		mix_buffer: new Int32Array(1024),
		quirks: new Uint8Array(Object.keys(QUIRK).length).fill(1),
		voices: Array.from({ length: 256 }, allocate_voice), voice_mix: new Uint32Array(256),
		flags: 0, pan_separation: 128, num_voices: 0, last_moved_channel: 256,
		freq_factor: 128, tempo_factor: 128, initial_global_volume: 128,
		current_global_volume: 128, initial_speed: 6, initial_tempo: 125,
		mix_stat: 0, buffer_count: 0, tick_count: 0, frame_delay: 0, row_count: 0,
		current_speed: 0, current_tempo: 0, break_row: 0, repeat_count: 0, last_global_volume: 0,
		process_row: 0, row: 0, current_pattern: 0, current_order: 0, process_order: 0,
		mixing_volume: 0x30, message: '', title: '', tracker_id: '',
		ramping_samples_up: 16, ramping_samples_down: 42, vu_left: 0, vu_right: 0,
		dry_rofs_vol: 0, dry_lofs_vol: 0, max_voices: 32,
		row_highlight_major: 16, row_highlight_minor: 4,
		mix_flags: 0, mix_frequency: 4000, mix_bits_per_sample: 8, mix_channels: 1,
		samples: Array.from({ length: MAX_SAMPLES + 1 }, (_, n) => {
			const s = allocate_sample();
			// _csf_reset initializes indices strictly below MAX_SAMPLES.
			if (n === MAX_SAMPLES) s.c5speed = s.volume = s.global_volume = 0;
			return s;
		}),
		instruments: Array(MAX_INSTRUMENTS + 1).fill(null),
		channels: Array.from({ length: MAX_CHANNELS }, () => ({ panning: 128, volume: 64, flags: 0 })),
		patterns: Array(MAX_PATTERNS).fill(null),
		pattern_size: new Uint16Array(MAX_PATTERNS).fill(64),
		pattern_alloc_size: new Uint16Array(MAX_PATTERNS).fill(64),
		orderlist: new Uint8Array(MAX_ORDERS + 1).fill(ORDER_LAST),
	};
}
function name_is_blank(name) {
	return [...name.slice(0, 25)].every(c => c === '\0' || c === ' ');
}
export function csf_sample_is_empty(smp) {
	return smp.data === null && name_is_blank(smp.name) && (!smp.filename.length || smp.filename[0] === "\0")
		&& smp.c5speed === 8363 && smp.volume === 256 && smp.global_volume === 64
		&& !smp.panning && !(smp.flags & (0x02 | 0x08 | 0x20))
		&& ['length', 'loop_start', 'loop_end', 'sustain_start', 'sustain_end',
			'vib_type', 'vib_rate', 'vib_depth', 'vib_speed'].every(key => smp[key] === 0);
}
export function csf_get_num_samples(csf) {
	let n = MAX_SAMPLES - 1;
	while (n > 0 && csf_sample_is_empty(csf.samples[n])) n--;
	return n;
}
export function csf_first_blank_sample(csf, start) {
	for (let n = Math.max(start, 1); n < MAX_SAMPLES; n++)
		if (csf_sample_is_empty(csf.samples[n])) return n;
	return -1;
}
export function csf_get_highest_used_channel(csf) {
	let highchan = 0;
	for (let p = 0; p < MAX_PATTERNS; p++) {
		if (!csf.patterns[p]) continue;
		for (let j = 0; j < csf.pattern_size[p] * MAX_CHANNELS; j++) {
			const note = csf.patterns[p][j].note;
			if (note > 0 && note <= 120) highchan = Math.max(highchan, j % MAX_CHANNELS);
		}
	}
	return highchan;
}
provide({ csf_allocate, csf_sample_is_empty, csf_get_num_samples,
	csf_first_blank_sample, csf_get_highest_used_channel });

function env_is_blank(env, value) {
	return env.nodes === 2 && !env.loop_start && !env.loop_end
		&& !env.sustain_start && !env.sustain_end && env.ticks[0] === 0
		&& env.ticks[1] === 100 && env.values[0] === value && env.values[1] === value;
}
export function csf_instrument_is_empty(ins) {
	if (!ins) return true;
	// Preserve the upstream NOTE_LAST - NOTE_FIRST bound, including its
	// exclusion of map entries 119..127.
	for (let n = 0; n < 119; n++)
		if (ins.sample_map[n] !== 0 || ins.note_map[n] !== n + 1) return false;
	return name_is_blank(ins.name) && (!ins.filename.length || ins.filename[0] === '\0')
		&& ['flags', 'nna', 'dct', 'dca', 'fadeout', 'vol_swing', 'pitch_pan_separation',
			'pan_swing', 'ifc', 'ifr', 'midi_channel_mask'].every(key => ins[key] === 0)
		&& env_is_blank(ins.vol_env, 64) && env_is_blank(ins.pan_env, 32)
		&& env_is_blank(ins.pitch_env, 32) && ins.global_volume === 128
		&& ins.panning === 128 && ins.pitch_pan_center === 60
		&& ins.midi_program === -1 && ins.midi_bank === -1;
}
export function csf_get_num_instruments(csf) {
	let n = MAX_INSTRUMENTS - 1;
	while (n > 0 && csf_instrument_is_empty(csf.instruments[n])) n--;
	return n;
}
export function csf_first_blank_instrument(csf, start) {
	for (let n = Math.max(start, 1); n < MAX_INSTRUMENTS; n++)
		if (csf_instrument_is_empty(csf.instruments[n])) return n;
	return -1;
}
export function csf_reset_playmarks(csf) {
	for (let n = 1; n < MAX_SAMPLES; n++) csf.samples[n].played = 0;
	for (let n = 1; n < MAX_INSTRUMENTS; n++)
		if (csf.instruments[n]) csf.instruments[n].played = 0;
}
provide({ csf_instrument_is_empty, csf_get_num_instruments,
	csf_first_blank_instrument, csf_reset_playmarks });

function allocate_voice() {
	return Object.assign(Object.fromEntries(VOICE_SCALARS.map(key => [key, 0])), {
		current_sample_data: null, ptr_instrument: null, ptr_sample: null,
		position: { v: 0n }, increment: { v: 0n },
		filter_y: [new Int32Array(2), new Int32Array(2)],
	});
}
export const SONG_PATTERNLOOP = 0x40020, SONG_ENDREACHED = 0x200;
export const PROCESS_NEXT_ORDER = 0xfffe;
function set_current_pos_0(csf) {
	for (let i = 0; i < 256; i++) {
		const v = csf.voices[i];
		for (const key of Object.keys(v)) delete v[key];
		Object.assign(v, allocate_voice(), { note: 1, new_note: 1, cutoff: 127, volume: 256,
			panning: i < MAX_CHANNELS ? csf.channels[i].panning : 128,
			global_volume: i < MAX_CHANNELS ? csf.channels[i].volume : 64,
			flags: i < MAX_CHANNELS ? csf.channels[i].flags : 0 });
	}
	csf.current_global_volume = csf.initial_global_volume;
	csf.current_speed = csf.initial_speed;
	csf.current_tempo = csf.initial_tempo;
}
export function csf_set_current_order(csf, position) {
	position >>>= 0;
	for (const v of csf.voices) Object.assign(v, { frequency: 0, note: 1, new_note: 1,
		new_instrument: 0, portamento_target: 0, n_command: 0, cd_patloop: 0,
		patloop_row: 0, cd_tremor: 0, vibrato_position: csf.flags & 4 ? 0 : 16,
		tremolo_position: 0 });
	if (position > MAX_ORDERS) position = 0;
	if (!position) set_current_pos_0(csf);
	Object.assign(csf, { process_order: (position - 1) >>> 0, process_row: PROCESS_NEXT_ORDER,
		row: 0, break_row: 0, tick_count: 1, row_count: 0, buffer_count: 0, last_moved_channel: 256 });
	csf.flags &= ~(SONG_PATTERNLOOP | SONG_ENDREACHED);
}
export function csf_loop_pattern(csf, pat, row) {
	if (pat < 0 || pat >= MAX_PATTERNS || !csf.patterns[pat]) {
		csf.flags &= ~SONG_PATTERNLOOP;
		return;
	}
	if (row < 0 || row >= csf.pattern_size[pat]) row = 0;
	Object.assign(csf, { process_order: 0, process_row: PROCESS_NEXT_ORDER, break_row: row,
		tick_count: 1, row_count: 0, current_pattern: pat, buffer_count: 0 });
	csf.flags |= SONG_PATTERNLOOP;
}
provide({ csf_set_current_order, csf_loop_pattern });

export function csf_stop_sample(csf, smp) {
	if (!smp.data) return;
	for (const v of csf.voices) {
		if (v.ptr_sample !== smp && v.current_sample_data !== smp.data) continue;
		Object.assign(v, { note: 1, new_note: 1, new_instrument: 0, fadeout_volume: 0,
			frequency: 0, position: { v: 0n }, length: 0, loop_start: 0, loop_end: 0,
			rofs: 0, lofs: 0, current_sample_data: null, ptr_sample: null, ptr_instrument: null,
			left_volume: 0, right_volume: 0, left_volume_new: 0, right_volume_new: 0,
			left_ramp: 0, right_ramp: 0 });
		v.flags |= 0x200 | 0x400; // CHN_KEYOFF | CHN_NOTEFADE
	}
}
export function csf_destroy_sample(csf, nsmp) {
	nsmp >>>= 0;
	if (nsmp >= MAX_SAMPLES) return 0;
	const smp = csf.samples[nsmp];
	if (!smp.data) return 1;
	csf_stop_sample(csf, smp);
	smp.data = null;
	smp.length = 0;
	smp.flags &= ~1; // CHN_16BIT; keep the other metadata, as in C.
	return 1;
}
provide({ csf_stop_sample, csf_destroy_sample });

export function csf_insert_restart_pos(csf, restart_order) {
	restart_order >>>= 0;
	if (!restart_order) return;
	let max = 0, ord = 0, n = 0;
	for (; n < MAX_ORDERS && csf.orderlist[n] < MAX_PATTERNS; ord = n, n++)
		max = Math.max(max, csf.orderlist[n]);
	let newpat = max + 1, pat = csf.orderlist[ord];
	if (pat >= MAX_PATTERNS || !csf.patterns[pat] || !csf.pattern_size[pat]) return;
	let used = 0;
	for (let i = 0; i < n; i++) if (csf.orderlist[i] === pat) used++;
	if (used > 1) {
		while (newpat < MAX_PATTERNS && csf.patterns[newpat]) newpat++;
		if (newpat >= MAX_PATTERNS) return;
		csf.patterns[newpat] = csf.patterns[pat]
			.slice(0, csf.pattern_size[pat] * MAX_CHANNELS).map(note => ({ ...note }));
		csf.pattern_size[newpat] = csf.pattern_alloc_size[newpat] = csf.pattern_size[pat];
		csf.orderlist[ord] = pat = newpat;
	}
	max = csf.pattern_size[pat] - 1;
	for (let row = 0; row <= max; row++) {
		let empty = null, has_break = false, has_jump = false;
		for (let channel = 0; channel < MAX_CHANNELS; channel++) {
			const note = csf.patterns[pat][row * MAX_CHANNELS + channel];
			switch (note.effect) {
			case 12: has_jump = true; break; // FX_POSITIONJUMP
			case 14: // FX_PATTERNBREAK
				has_break = true;
				if (!note.param) empty = note;
				break;
			case 0: if (!empty) empty = note; break;
			}
		}
		if (!has_jump && empty && (has_break || row === max)) {
			empty.effect = 12;
			empty.param = restart_order & 255;
		}
	}
}
provide({ csf_insert_restart_pos });

export function csf_calculate_vu_meters(csf, vus = new Float32Array(MAX_CHANNELS)) {
	vus.fill(0);
	for (let c = 0; c < 256; c++) {
		const voice = csf.voices[c];
		if (!(voice.current_sample_data && voice.length) && !(voice.flags & 0x20000000)) continue;
		const mc = voice.master_channel ? voice.master_channel - 1 : c;
		if (mc < 0 || mc >= MAX_CHANNELS) continue;
		const vu = Math.fround(voice.vu_meter * Math.fround(1 / 255));
		vus[mc] = Math.fround(vus[mc] + Math.fround(vu * vu));
	}
	for (let c = 0; c < MAX_CHANNELS; c++) vus[c] = Math.min(1, Math.fround(Math.sqrt(vus[c])));
	return vus;
}
provide({ csf_calculate_vu_meters });

export function csf_update_playing_sample(csf, s_changed) {
	const loopFlags = 0x10 | 0x08 | 0x80 | 0x04 | 0x02;
	let n = Math.min(csf.num_voices, csf.max_voices);
	while (n--) {
		const channel = csf.voices[csf.voice_mix[n]];
		if (!channel.ptr_sample || !channel.current_sample_data) continue;
		if (channel.ptr_sample !== csf.samples[s_changed]) continue;
		const inst = channel.ptr_sample;
		if (inst.flags & (0x10 | 0x08)) {
			channel.loop_start = inst.sustain_start;
			channel.loop_end = inst.sustain_end;
		} else if (inst.flags & (0x80 | 0x04 | 0x02)) {
			channel.loop_start = inst.loop_start;
			channel.loop_end = inst.loop_end;
		}
		if (inst.flags & loopFlags) channel.length = channel.loop_end;
		if (channel.length > inst.length) {
			channel.current_sample_data = inst.data;
			channel.length = inst.length;
		}
		channel.flags = (channel.flags & ~loopFlags) | (inst.flags & loopFlags);
		channel.instrument_volume = inst.global_volume;
	}
}
provide({ csf_update_playing_sample });

export function csf_adjust_sample_loop(smp) {
	if (!smp.data || smp.length < 1) return;
	smp.sustain_end = Math.min(smp.sustain_end, smp.length);
	smp.loop_end = Math.min(smp.loop_end, smp.length);
	if (smp.sustain_start >= smp.sustain_end) { smp.sustain_start = smp.sustain_end = 0; smp.flags &= ~(8 | 16); }
	if (smp.loop_start >= smp.loop_end) { smp.loop_start = smp.loop_end = 0; smp.flags &= ~(2 | 4); }
	const channels = smp.flags & 64 ? 2 : 1, Type = smp.flags & 1 ? Int16Array : Int8Array;
	const base = channels * 16, payload = smp.length * channels;
	const padded = new Type(base + payload + channels * 16 * 9);
	const input = smp.data;
	// Sample data uses signed element views at its native bit width.
	padded.set(input.subarray(0, payload), base);
	for (let i = 0; i < 16; i++) for (let c = 0; c < channels; c++) {
		padded[base + payload + i * channels + c] = padded[base + payload - channels + c];
		padded[base - (i + 1) * channels + c] = padded[base + c];
	}
	function precompute(target, start, end, bidi) {
		const length = end - start;
		if (length <= 0) return;
		for (const direction of [1, 0]) {
			const write = direction ? 1 : -1;
			let dest = target + channels * 31, position = length - 1, read = write;
			for (let i = 0; i < 32 + direction; i++) {
				for (let c = 0; c < channels; c++) padded[dest + c] = padded[base + (start + position) * channels + c];
				dest += write * channels;
				if (position === length - 1 && read > 0) {
					if (bidi) { read = -1; if (position > 0) position--; } else position = 0;
				} else if (position === 0 && read < 0) {
					if (bidi) read = 1; else position = length - 1;
				} else position += read;
			}
		}
	}
	if (smp.flags & 2) precompute(base + payload + channels * 16, smp.loop_start, smp.loop_end, smp.flags & 4);
	if (smp.flags & 8) precompute(base + payload + channels * 80, smp.sustain_start, smp.sustain_end, smp.flags & 16);
	smp.data = padded.subarray(base);
}
provide({ csf_adjust_sample_loop });

export function csf_set_wave_config(csf, rate, bits, channels) {
	const reset = csf.mix_frequency !== rate || csf.mix_bits_per_sample !== bits || csf.mix_channels !== channels;
	csf.mix_channels = channels >>> 0; csf.mix_frequency = rate >>> 0; csf.mix_bits_per_sample = bits >>> 0;
	app.csf_init_player(csf, reset);
	return 1;
}
export function csf_set_resampling_mode(csf, mode) {
	if (!Number.isInteger(mode) || mode < 0 || mode >= 4) throw new RangeError('Invalid resampling mode');
	csf.mix_interpolation = mode; return 1;
}
provide({csf_set_wave_config,csf_set_resampling_mode});

export function csf_get_length(csf) {
	// Preserve C struct-copy semantics for inline playback state without
	// duplicating immutable sample payloads or the pattern event arrays.
	const copy = { ...csf,
		voices: csf.voices.map(v => ({ ...v, position:{...v.position},increment:{...v.increment},filter_y:v.filter_y.map(c=>new Int32Array(c)) })),
		channels: csf.channels.map(c=>({...c})),
		voice_mix: new Uint32Array(csf.voice_mix),
		patterns: [...csf.patterns], pattern_size:new Uint16Array(csf.pattern_size),
		pattern_alloc_size:new Uint16Array(csf.pattern_alloc_size),
		orderlist:new Uint8Array(csf.orderlist), quirks:new Uint8Array(csf.quirks),
		midi_out_raw:null };
	csf_set_current_order(copy,0);
	copy.mix_flags |= 0x40000 | 0x1000000;
	copy.repeat_count=-1;copy.flags &= ~(128 | SONG_PATTERNLOOP | SONG_ENDREACHED);
	copy.stop_at_order=copy.stop_at_row=-1;
	let total=0;
	for (;;) {
		copy.tick_count=1;
		if(!app.csf_process_tick(copy))break;
		const length=Math.trunc(((copy.mix_frequency*5*copy.tempo_factor)>>>0)/((copy.current_tempo<<8)>>>0))>>>0;
		total=(total+Math.imul(length,copy.tick_count))>>>0;
	}
	return Number(((((BigInt(total)<<1n)/BigInt(copy.mix_frequency))+1n)>>1n));
}
provide({csf_get_length});

// Initial uncompressed PCM portion of csf_read_sample. Other encodings remain
// explicit failures until their source branches are ported.
export function csf_read_sample(sample, flags, fp) {
	if (!sample || !sample.length || !fp || (sample.flags & 0x20000000)) return 0;
	const bits=flags&255, layout=(flags>>>8)&15, endian=(flags>>>12)&15, encoding=(flags>>>16)&255;
	if ([24,32,64].includes(bits)) return read_high_resolution_sample(sample, flags, fp, bits, layout, endian, encoding);
	if (![7,8,16].includes(bits) || ![1,2,3].includes(layout) || ![1,2].includes(endian) || ![1,2,3].includes(encoding) || (flags&~0xffffff)) return 0;
	if(bits===7&&(layout!==1||encoding!==1))return 0;
	sample.length=Math.min(sample.length,0x10000000);
	const channels=layout===1?1:2, bytes=bits===16?2:1;
	const count=sample.length*channels, size=count*bytes;
	if(fp.position+size>fp.bytes.length)return 0;
	const data=bits===16?new Int16Array(count):new Int8Array(count);
	const input=new DataView(fp.bytes.buffer,fp.bytes.byteOffset+fp.position,size);
	const delta=[0,0];
	for(let i=0;i<count;i++){
		const channel=layout===3?Math.trunc(i/sample.length):i%channels;
		const frame=layout===3?i%sample.length:Math.trunc(i/channels);
		let value=bytes===2?input.getUint16(i*2,endian===1):input.getUint8(i);
		if(encoding===2)value^=bits===16?0x8000:0x80;
		if(encoding===3){value+=delta[channel];delta[channel]=value&((1<<bits)-1);}
		data[frame*channels+channel]=value;
	}
	if(bits===7)for(let i=0;i<count;i++)data[i]=Math.max(-128,Math.min(127,data[i]*2));
	fp.position+=size;sample.flags=(sample.flags&~65)|(bits===16?1:0)|(channels===2?64:0);
	sample.data=data;csf_adjust_sample_loop(sample);return size;
}
provide({csf_read_sample});

function read_high_resolution_sample(sample, flags, fp, bits, layout, endian, encoding) {
	const floating=encoding===11;
	if(![1,2,3].includes(layout)||![1,2].includes(endian)||(flags&~0xffffff))return 0;
	if(floating?![32,64].includes(bits):(![24,32].includes(bits)||![1,2].includes(encoding)||layout===3))return 0;
	sample.length=Math.min(sample.length,0x10000000);
	const channels=layout===1?1:2,count=sample.length*channels,bytes=bits/8,size=count*bytes;
	if(fp.position+size>fp.bytes.length)return 0;
	const input=new DataView(fp.bytes.buffer,fp.bytes.byteOffset+fp.position,size),data=new Int16Array(count),little=endian===1;
	const destination=i=>layout===3?(i%sample.length)*2+Math.trunc(i/sample.length):i;
	if(floating){
		for(let i=0;i<count;i++){
			const num=(bits===32?input.getFloat32(i*bytes,little):input.getFloat64(i*bytes,little))*32768;
			data[destination(i)]=Math.trunc(Math.max(-32768,Math.min(32767,num)));
		}
		fp.position+=size;
	}else if(sample.length>8){
		const values=new Int32Array(count);let maximum=bits===24?255:65535;
		for(let i=0;i<count;i++){
			let value;
			if(bits===32)value=input.getInt32(i*4,little);
			else {const p=i*3;value=little?input.getUint8(p)|(input.getUint8(p+1)<<8)|(input.getUint8(p+2)<<16):(input.getUint8(p)<<16)|(input.getUint8(p+1)<<8)|input.getUint8(p+2);value<<=8;}
			if(encoding===2)value=(value+(-2147483648))|0;
			values[i]=value;
			const scan=bits===24?value>>8:value;
			maximum=Math.max(maximum,scan,(-scan)|0);
		}
		const divisor=(maximum>>(bits===24?7:15))+1;
		for(let i=0;i<count;i++)data[i]=Math.trunc(values[i]/divisor);
		fp.position+=size;
	}
	// Upstream deliberately leaves <=8-frame integer high-resolution samples
	// zero-initialized and does not advance the input in that branch.
	sample.flags=(sample.flags&~65)|1|(channels===2?64:0);sample.data=data;
	csf_adjust_sample_loop(sample);return size;
}

export function csf_import_s3m_effect(m, from_it) {
	const letter=String.fromCharCode(m.effect+64);
	let effect=S3M_EFFECTS[letter] || (letter==='\\'?FX.MIDI:0),param=m.param;
	if(letter==='C'&&!from_it)param=(param>>4)*10+(param&15);
	else if(letter==='V'&&!from_it)param*=2;
	else if(letter==='X'&&!from_it){
		if(param===0xa4){effect=FX.SPECIAL;param=0x91;}
		else param=param>127?255:param*2;
	}
	m.effect=effect;m.param=param&255;
}
export function csf_export_s3m_effect(m, to_it) {
	let effect=Object.keys(S3M_EFFECTS).find(letter=>S3M_EFFECTS[letter]===m.effect),param=m.param;
	if(m.effect===FX.PATTERNBREAK&&!to_it)param=(Math.trunc(param/10)<<4)+(param%10);
	else if(m.effect===FX.SPECIAL&&!to_it&&param===0x91){effect='X';param=0xa4;}
	else if((m.effect===FX.GLOBALVOLUME||m.effect===FX.PANNING)&&!to_it)param>>=1;
	m.effect=effect?(effect.charCodeAt(0)&~64):0;m.param=param&255;
}
provide({csf_import_s3m_effect,csf_export_s3m_effect});
