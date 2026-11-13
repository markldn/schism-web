// Navigation/effect scheduling from player/sndmix.c (GPL-2.0-or-later).
import { app, provide } from './app.js';
import { sine_table, ramp_down_table, square_table, linear_slide_up_table, linear_slide_down_table, fine_linear_slide_up_table, fine_linear_slide_down_table, QUIRK, GMvolTransition, FX, VOLFX } from './gen/tables.js';
function repeat(csf) {
	csf.repeat_count = (csf.repeat_count + 1) | 0;
	if (!csf.repeat_count) { csf.process_row = 0xfffe; return false; }
	if (csf.repeat_count < 0) csf.repeat_count = 1;
	return true;
}
export function increment_order(csf) {
	csf.process_row = csf.break_row; csf.break_row = 0;
	if (csf.flags & 32) {
		if (csf.process_order) { if (!repeat(csf)) return 0; }
		else csf.process_order = 1;
	} else if (!(csf.flags & 0x40000)) {
		do { csf.process_order = (csf.process_order + 1) >>> 0; }
		while (csf.orderlist[csf.process_order] === 254);
		if (csf.orderlist[csf.process_order] === 255) {
			if (!repeat(csf)) return 0;
			csf.process_order = 0;
			while (csf.orderlist[csf.process_order] === 254) csf.process_order++;
		}
		if (csf.orderlist[csf.process_order] >= 240 || csf.process_order > 256) { csf.process_row = 0xfffe; return 0; }
		csf.current_order = csf.process_order;
		csf.current_pattern = csf.orderlist[csf.process_order];
	}
	if (!csf.pattern_size[csf.current_pattern] || !csf.patterns[csf.current_pattern]) {
		csf.patterns[csf.current_pattern] = app.csf_allocate_pattern(64);
		csf.pattern_size[csf.current_pattern] = csf.pattern_alloc_size[csf.current_pattern] = 64;
	}
	if (csf.process_row >= csf.pattern_size[csf.current_pattern]) csf.process_row = 0;
	return 1;
}
export function csf_process_tick(csf) {
	csf.flags &= ~0x1000;
	csf.tick_count = (csf.tick_count - 1) >>> 0;
	if (!csf.tick_count) {
		csf.tick_count = (csf.current_speed + csf.frame_delay) >>> 0;
		if (--csf.row_count <= 0) {
			csf.row_count = 0;
			csf.process_row = (csf.process_row + 1) >>> 0;
			if (csf.process_row >= csf.pattern_size[csf.current_pattern] && !increment_order(csf)) return 0;
			csf.row = csf.process_row; csf.frame_delay = 0;
			csf.tick_count = csf.current_speed; csf.flags |= 0x1000;
		}
		csf.last_global_volume = csf.current_global_volume;
		for (let nchan = 0; nchan < 64; nchan++) {
			const chan = csf.voices[nchan], m = csf.patterns[csf.current_pattern][csf.row * 64 + nchan];
			if (!(csf.mix_flags & 0x1000000)) app.csf_midi_out_note(csf, nchan, m);
			chan.row_note = m.note;
			if (m.instrument) chan.last_instrument = m.instrument;
			Object.assign(chan, { row_instr: m.instrument, row_voleffect: m.voleffect,
				row_volparam: m.volparam, row_effect: m.effect, row_param: m.param,
				left_volume: chan.left_volume_new, right_volume: chan.right_volume_new,
				flags: chan.flags & ~(0x80000 | 0x10000 | 0x20000), n_command: 0,
				last_instrument_volume: chan.instrument_volume });
		}
		app.csf_process_effects(csf, 1);
	} else {
		if (!(csf.mix_flags & 0x1000000)) for (let n = 0; n < 64; n++) app.csf_midi_out_note(csf, n, null);
		if (!(csf.tick_count % (csf.current_speed + csf.frame_delay))) csf.flags |= 0x1000;
		app.csf_process_effects(csf, 0);
	}
	return 1;
}
provide({ csf_process_tick });

// Pointer output becomes a return value; channel countdown changes in place.
export function rn_tremor(chan, vol) {
	if ((chan.cd_tremor & 128) && chan.length) {
		if (chan.cd_tremor === 128) chan.cd_tremor = (chan.mem_tremor >> 4) | 192;
		else if (chan.cd_tremor === 192) chan.cd_tremor = (chan.mem_tremor & 15) | 128;
		else chan.cd_tremor--;
	}
	if ((chan.cd_tremor & 192) === 128) vol = 0;
	chan.flags |= 0x1000000;
	return vol;
}
export function rn_vibrato(csf, chan, frequency, rand = () => Math.floor(Math.random() * 0x80000000)) {
	const vibpos = chan.vibrato_position & 255;
	let vdelta;
	switch (chan.vib_type) {
	case 1: vdelta = ramp_down_table[vibpos]; break;
	case 2: vdelta = square_table[vibpos]; break;
	case 3: vdelta = Math.trunc(128 * rand() / 0x7fffffff - 64); break;
	default: vdelta = sine_table[vibpos]; break;
	}
	const old = csf.flags & 4;
	if (old) vdelta = -vdelta;
	vdelta = Math.imul(vdelta, chan.vibrato_depth) >> (old ? 5 : 6);
	frequency = app.csf_fx_do_freq_slide(csf.flags, frequency, vdelta, 0);
	if (!(csf.flags & 0x1000) || !old) chan.vibrato_position = (vibpos + 4 * chan.vibrato_speed) & 255;
	return frequency;
}
export function rn_arpeggio(csf, chan, frequency) {
	const length = (csf.current_speed + csf.frame_delay) >>> 0;
	const tick = (((length - csf.tick_count) >>> 0) % length) % 3;
	const a = tick === 1 ? chan.mem_arpeggio >> 4 : tick === 2 ? chan.mem_arpeggio & 15 : 0;
	if (!a) return frequency;
	return Number(BigInt.asIntN(32, BigInt(frequency) * BigInt(linear_slide_up_table[a * 16]) / 65536n));
}

function envelope_value(env, position, scale, initial, clampPosition) {
	let envpos = position - 1, pt = env.nodes - 1;
	for (let i = 0; i < env.nodes - 1; i++) if (envpos <= env.ticks[i]) { pt = i; break; }
	const x2 = env.ticks[pt], y2 = env.values[pt] * scale;
	let value, x1;
	if (envpos >= x2) { value = y2; x1 = x2; }
	else if (pt) { value = env.values[pt - 1] * scale; x1 = env.ticks[pt - 1]; }
	else { value = initial; x1 = 0; }
	if (clampPosition && envpos > x2) envpos = x2;
	if (x2 > x1 && envpos > x1) value += Math.trunc((envpos - x1) * (y2 - value) / (x2 - x1));
	return value;
}
export function rn_process_vol_env(chan, vol) {
	const ins = chan.ptr_instrument;
	if (((chan.flags & 0x200000) || (ins.flags & 1)) && ins.vol_env.nodes && chan.vol_env_position) {
		const envvol = Math.max(0, Math.min(256, envelope_value(ins.vol_env, chan.vol_env_position, 4, 0, true)));
		vol = Math.imul(vol, envvol) >> 8;
	}
	return vol;
}
export function rn_process_pan_env(chan) {
	const ins = chan.ptr_instrument;
	if (((chan.flags & 0x400000) || (ins.flags & 8)) && ins.pan_env.nodes && chan.pan_env_position) {
		const envpan = Math.max(0, Math.min(64, envelope_value(ins.pan_env, chan.pan_env_position, 1, 128, false)));
		let pan = chan.final_panning;
		pan += Math.trunc((envpan - 32) * (pan >= 128 ? 256 - pan : pan) / 32);
		chan.final_panning = pan;
	}
}
export function rn_process_ins_fade(chan, vol) {
	if (chan.flags & 0x400) {
		const fadeout = chan.ptr_instrument.fadeout;
		if (fadeout) {
			chan.fadeout_volume = Math.max(0, chan.fadeout_volume - (fadeout << 1));
			vol = Math.imul(vol, chan.fadeout_volume) >> 16;
		} else if (!chan.fadeout_volume) vol = 0;
	}
	return vol;
}
export function rn_process_envelope(csf, chan, vol) {
	vol = rn_process_vol_env(chan, vol);
	rn_process_pan_env(chan);
	vol = rn_process_ins_fade(chan, vol);
	const ins = chan.ptr_instrument;
	if (!csf.quirks[QUIRK.IT_PITCH_PAN_SEPARATION] && ins.pitch_pan_separation && chan.final_panning && chan.note)
		chan.final_panning += Math.trunc((chan.note - ins.pitch_pan_center - 1) * ins.pitch_pan_separation / 2);
	return vol;
}

export function _process_envelope(chan, penv, envelope, field, env_flag, loop_flag, sus_flag, fade_flag) {
	if (!(chan.flags & env_flag)) return;
	let start, end;
	if ((penv.flags & sus_flag) && !(chan.old_flags & 0x200)) {
		start = envelope.ticks[envelope.sustain_start];
		end = envelope.ticks[envelope.sustain_end] + 1; fade_flag = 0;
	} else if (penv.flags & loop_flag) {
		start = envelope.ticks[envelope.loop_start];
		end = envelope.ticks[envelope.loop_end] + 1; fade_flag = 0;
	} else start = end = envelope.ticks[envelope.nodes - 1];
	if (chan[field] >= end) {
		if (fade_flag && !envelope.values[envelope.nodes - 1]) chan.fadeout_volume = chan.final_volume = 0;
		chan[field] = start; chan.flags |= fade_flag;
	}
	chan[field] = (chan[field] + 1) | 0;
}
export function rn_increment_env_pos(chan) {
	const penv = chan.ptr_instrument;
	_process_envelope(chan, penv, penv.vol_env, 'vol_env_position', 0x200000, 4, 2, 0x400);
	_process_envelope(chan, penv, penv.pan_env, 'pan_env_position', 0x400000, 32, 16, 0);
	_process_envelope(chan, penv, penv.pitch_env, 'pitch_env_position', 0x800000, 256, 128, 0);
}

export function rn_sample_vibrato(csf, chan, frequency, rand = () => Math.floor(Math.random() * 0x80000000)) {
	const vibpos = chan.autovib_position & 255, pins = chan.ptr_sample;
	let adepth = 1, vdelta;
	if (pins.vib_speed) {
		adepth = Math.min((chan.autovib_depth + (pins.vib_rate & 255)) | 0, pins.vib_depth << 8);
		chan.autovib_depth = adepth; adepth >>= 8;
		chan.autovib_position = (chan.autovib_position + pins.vib_speed) >>> 0;
	}
	switch (pins.vib_type) {
	case 1: vdelta = ramp_down_table[vibpos]; break;
	case 2: vdelta = square_table[vibpos]; break;
	case 3: vdelta = Math.trunc(128 * rand() / 0x7fffffff - 64); break;
	default: vdelta = sine_table[vibpos]; break;
	}
	vdelta = Math.imul(vdelta, adepth) >> 6;
	const l = Math.abs(vdelta);
	const linear = vdelta < 0 ? linear_slide_up_table : linear_slide_down_table;
	const fine = vdelta < 0 ? fine_linear_slide_up_table : fine_linear_slide_down_table;
	const factor = l < 16 ? fine[l] : linear[l >> 2];
	const adjusted = Number(BigInt.asIntN(32, BigInt(frequency) * BigInt(factor) / 65536n));
	return (frequency - ((adjusted - frequency) | 0)) | 0;
}

export function rn_update_sample(csf, chan, nchan, master_vol) {
	if (csf.mix_channels < 2 || (csf.flags & 0x80000)) {
		chan.right_volume_new = Math.imul(chan.final_volume, master_vol) >> 8;
		chan.left_volume_new = chan.right_volume_new;
	} else if ((chan.flags & 0x800) && !(csf.mix_flags & 0x200000)) {
		chan.right_volume_new = Math.imul(chan.final_volume, master_vol) >> 8;
		chan.left_volume_new = -chan.right_volume_new;
	} else {
		let pan = Math.trunc(Math.imul(chan.final_panning - 128, csf.pan_separation) / 128);
		if ((csf.flags & 0x20000) && chan.ptr_instrument?.midi_channel_mask > 0) app.GM_Pan(csf, nchan, pan);
		pan = Math.max(0, Math.min(256, pan + 128));
		if (csf.mix_flags & 1) pan = 256 - pan;
		const realvol = Math.imul(chan.final_volume, master_vol) >> 7;
		chan.left_volume_new = Math.imul(realvol, pan) >> 8;
		chan.right_volume_new = Math.imul(realvol, 256 - pan) >> 8;
	}
	chan.right_volume_new = Math.min(chan.right_volume_new, 65535);
	chan.left_volume_new = Math.min(chan.left_volume_new, 65535);
	chan.flags &= ~(0x1000 | 0x2000);
	if (csf.mix_interpolation === 0 || (csf.mix_interpolation === 1 && chan.increment.v >= 0xff000000n) || chan.increment.v === 0x100000000n) chan.flags |= 0x1000;
	chan.right_volume_new >>= 5; chan.left_volume_new >>= 5;
	chan.right_ramp = chan.left_ramp = 0;
	if (chan.flags & 128) chan.increment = { v: BigInt.asIntN(64, -chan.increment.v) };
	if (chan.flags & 0x100) chan.left_volume = chan.right_volume = 0;
	else if (!(csf.mix_flags & 0x800000) && (chan.flags & 0x8000) && (chan.right_volume !== chan.right_volume_new || chan.left_volume !== chan.left_volume_new)) {
		let length = chan.right_volume_new > chan.right_volume || chan.left_volume_new > chan.right_volume ? csf.ramping_samples_up : csf.ramping_samples_down;
		const right_delta = (chan.right_volume_new - chan.right_volume) << 12;
		const left_delta = (chan.left_volume_new - chan.left_volume) << 12;
		if ((chan.right_volume | chan.left_volume) && (chan.right_volume_new | chan.left_volume_new) && !(chan.flags & 0x1000000)) length = Math.max(length, Math.min(2048, csf.buffer_count));
		chan.right_ramp = Math.trunc(right_delta / length); chan.left_ramp = Math.trunc(left_delta / length);
		chan.right_volume = chan.right_volume_new - (Math.imul(chan.right_ramp, length) >> 12);
		chan.left_volume = chan.left_volume_new - (Math.imul(chan.left_ramp, length) >> 12);
		if (chan.right_ramp | chan.left_ramp) chan.ramp_length = length;
		else { chan.flags &= ~0x8000; chan.right_volume = chan.right_volume_new; chan.left_volume = chan.left_volume_new; }
	} else { chan.flags &= ~0x8000; chan.right_volume = chan.right_volume_new; chan.left_volume = chan.left_volume_new; }
	chan.right_ramp_volume = chan.right_volume << 12; chan.left_ramp_volume = chan.left_volume << 12;
	csf.voice_mix[csf.num_voices++] = nchan;
	if (nchan >= 64 && !(chan.volume && chan.global_volume && chan.instrument_volume)) chan.length = 0;
	return csf.num_voices >= 256 ? 0 : 1;
}

// Both pointer outputs are returned together; filter envelopes leave frequency
// unchanged and return the cutoff modifier for the filter setup stage.
export function rn_pitch_filter_envelope(csf, chan, envpitch, frequency) {
	const ins = chan.ptr_instrument;
	if (((chan.flags & 0x800000) || (ins.flags & (64 | 1024))) && ins.pitch_env.nodes && chan.pitch_env_position) {
		envpitch = Math.max(-256, Math.min(256, envelope_value(ins.pitch_env, chan.pitch_env_position, 8, 256, true) - 256));
		if (!(ins.flags & 1024)) {
			const l = Math.min(Math.abs(envpitch), 255);
			const ratio = (envpitch < 0 ? linear_slide_down_table : linear_slide_up_table)[l];
			frequency = Number(BigInt.asIntN(32, BigInt(frequency) * BigInt(ratio) / 65536n));
		}
	}
	return { envpitch, frequency };
}

export function find_volume(vol) {
	vol &= 65535;
	let l = 0, r = 128;
	while (l < r) { const m = l + Math.trunc((r - l) / 2); if (GMvolTransition[m] < vol) l = m + 1; else r = m; }
	return l;
}
export function rn_gen_key(csf, chan, chan_num, freq, vol) {
	if ((csf.flags & 0x20000) && chan.ptr_instrument && chan.ptr_instrument.midi_channel_mask > 0 && !(chan.flags & 0x100)) {
		const volume = chan.flags & 0x20000000 && vol > 0
			? Math.trunc(find_volume(vol) * chan.instrument_volume / 64)
			: Math.trunc(Math.imul(vol, chan.instrument_volume) / 8192);
		app.GM_SetFreqAndVol(csf, chan_num, freq, volume, 0, chan.flags & 0x200);
	}
	if (chan.flags & 0x20000000) {
		const milliHertz = Number(BigInt.asIntN(32, BigInt(freq) * 261625n / 8363n));
		app.OPL_HertzTouch(csf, chan_num, milliHertz, chan.flags & 0x200);
		app.OPL_Touch(csf, chan_num, Math.trunc(Math.imul(Math.imul(vol, chan.instrument_volume), 63) / 1048576));
		app.OPL_Pan(csf, chan_num, csf.flags & 0x80000 ? 128 : chan.final_panning);
	}
}
export function rn_process_midi_macro(csf, chan) {
	if ((csf.flags & 0x1000) && chan.row_effect === FX.MIDI) app.fx_midi_zxx(csf, chan);
}

export function csf_read_note(csf) {
	if (csf.flags & 128) {
		if (!csf.current_speed) csf.current_speed = csf.initial_speed || 6;
		if (!csf.current_tempo) csf.current_tempo = csf.initial_tempo || 125;
		csf.flags &= ~0x1000;
		csf.tick_count = (csf.tick_count - 1) >>> 0;
		if (!csf.tick_count) {
			csf.tick_count = csf.current_speed;
			if (--csf.row_count <= 0) csf.row_count = 0;
			for (let n = 0; n < 64; n++) Object.assign(csf.voices[n], {row_note:0,row_instr:0,row_voleffect:0,row_volparam:0,row_effect:0,row_param:0,n_command:0});
		}
		app.csf_process_effects(csf, 0);
	} else if (!csf_process_tick(csf)) return 0;
	if (!csf.current_tempo) return 0;
	csf.buffer_count = Math.trunc(((csf.mix_frequency * 5 * csf.tempo_factor) >>> 0) / ((csf.current_tempo << 8) >>> 0));
	if (csf.stop_at_order > -1 && csf.stop_at_row > -1 && csf.stop_at_order <= (csf.current_order | 0) && csf.stop_at_row <= (csf.row | 0)) return 0;
	const master_vol = (csf.mixing_volume << 2) >>> 0;
	csf.num_voices = 0;
	for (let cn = 0; cn < 256; cn++) {
		const chan = csf.voices[cn]; chan.vu_meter = 0;
		if (cn >= 64 && !chan.length && !(chan.flags & 0x20000000)) continue;
		chan.increment = { v: 0n }; chan.final_volume = 0;
		chan.final_panning = chan.panning + chan.pan_swing;
		if (chan.panbrello_delta) chan.final_panning += (Math.imul(chan.panbrello_delta, chan.panbrello_depth) + 2) >> 3;
		chan.ramp_length = 0;
		if (chan.frequency && chan.length) {
			let vol = chan.volume;
			if (chan.flags & 0x20000) vol += chan.tremolo_delta;
			vol = Math.max(0, Math.min(256, vol));
			if (chan.n_command === FX.TREMOR) vol = rn_tremor(chan, vol);
			vol = Math.max(0, Math.min(256, vol)) << 6;
			if ((csf.flags & 0x20000) && chan.ptr_instrument) { rn_increment_env_pos(chan); vol = rn_process_envelope(csf, chan, vol); }
			else if (chan.flags & 0x400) { chan.fadeout_volume = 0; vol = 0; }
			if (vol) chan.final_volume = Number(BigInt.asIntN(32, BigInt(Math.imul(vol, csf.current_global_volume)) * BigInt(chan.global_volume * Math.max(0, Math.min(64, chan.instrument_volume + chan.vol_swing))) / 524288n));
			chan.calc_volume = vol;
			let frequency = chan.frequency, envpitch = 0;
			if ((chan.flags & 0x180000) === 0x180000) frequency = app.get_frequency_from_note(app.get_note_from_frequency(frequency, chan.c5speed), chan.c5speed);
			if (chan.n_command === FX.ARPEGGIO) frequency = rn_arpeggio(csf, chan, frequency);
			if (cn < 64) rn_process_midi_macro(csf, chan);
			if ((csf.flags & 0x20000) && chan.ptr_instrument) ({envpitch,frequency} = rn_pitch_filter_envelope(csf, chan, envpitch, frequency));
			if (chan.flags & 0x10000) {
				if (chan.row_voleffect === VOLFX.VIBRATODEPTH && [FX.VIBRATO,FX.VIBRATOVOL,FX.FINEVIBRATO].includes(chan.row_effect)) frequency = rn_vibrato(csf, chan, frequency);
				frequency = rn_vibrato(csf, chan, frequency);
			}
			if (chan.ptr_sample?.vib_depth) frequency = rn_sample_vibrato(csf, chan, frequency);
			if (!(chan.flags & 0x400)) rn_gen_key(csf, chan, cn, frequency, vol);
			if (chan.flags & 0x2000000) app.setup_channel_filter(chan, 1, 256, csf.mix_frequency);
			if (chan.ptr_instrument?.flags & 1024) app.setup_channel_filter(chan, !(chan.flags & 0x4000), envpitch, csf.mix_frequency);
			chan.sample_freq = frequency;
			let increment = (BigInt(frequency | 0) << 32n) / BigInt(csf.mix_frequency >>> 0);
			if (csf.freq_factor !== 128) increment = BigInt.asIntN(64, increment * BigInt(csf.freq_factor)) / 128n;
			chan.increment = { v: increment || 1n };
		}
		if ((chan.flags & 0x400) && !(chan.fadeout_volume | chan.right_volume | chan.left_volume)) { chan.length = 0; chan.rofs = chan.lofs = 0; }
		chan.final_panning = Math.max(0, Math.min(256, chan.final_panning)); chan.flags &= ~0x8000;
		if (chan.final_volume || chan.left_volume || chan.right_volume) chan.flags |= 0x8000;
		if (chan.strike) chan.strike--;
		if (Number(chan.increment.v >> 32n) + 1 >= ((chan.loop_end - chan.loop_start) | 0)) chan.flags &= ~2;
		chan.right_volume_new = chan.left_volume_new = 0;
		if (!(chan.length && chan.increment.v !== 0n)) chan.current_sample_data = null;
		if (chan.current_sample_data) { if (!rn_update_sample(csf, chan, cn, master_vol)) break; }
		else { chan.left_volume = chan.right_volume = chan.length = 0; if (chan.lofs || chan.rofs) csf.voice_mix[csf.num_voices++] = cn; }
		chan.old_flags = chan.flags; chan.flags &= ~0x2000000;
	}
	if (csf.num_voices >= csf.max_voices && !(csf.mix_flags & 0x10000)) {
		for (let i = 0; i < csf.num_voices; i++) {
			let j = i;
			while (j + 1 < csf.num_voices && csf.voices[csf.voice_mix[j]].final_volume < csf.voices[csf.voice_mix[j+1]].final_volume) {
				const n = csf.voice_mix[j]; csf.voice_mix[j] = csf.voice_mix[j+1]; csf.voice_mix[j+1] = n; j++;
			}
		}
	}
	return 1;
}
provide({ csf_read_note });

export function csf_read(csf, output, bufsize) {
	csf.mix_stat = 0;
	const bits = [16,24,32].includes(csf.mix_bits_per_sample) ? csf.mix_bits_per_sample : 8;
	const sampleSize = csf.mix_channels * bits / 8;
	const max = Math.trunc(bufsize / sampleSize);
	if (!max || !output) return 0;
	const bytes = new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
	let left = csf.flags & 0x200 ? 0 : max, offset = 0, chunks = 0;
	const mins = [0x7fffffff,0x7fffffff], maxs = [-0x7fffffff,-0x7fffffff];
	function convert(buffer, samples) {
		const Type = bits === 16 ? Int16Array : bits === 32 ? Int32Array : Uint8Array;
		const converted = new Type(samples * (bits === 24 ? 3 : 1));
		const count = app['clip_32_to_'+bits](converted, buffer, samples, mins, maxs);
		return {bytes:new Uint8Array(converted.buffer),count};
	}
	while (left > 0) {
		if (!csf.buffer_count) {
			if (!(csf.mix_flags & 0x10000)) csf.buffer_count = left;
			if (!csf_read_note(csf)) {
				csf.flags |= 0x200;
				if (csf.stop_at_order > -1) return 0;
				if (left === max) break;
				if (!(csf.mix_flags & 0x10000)) csf.buffer_count = left;
			}
			if (!csf.buffer_count) break;
		}
		const count = Math.min(csf.buffer_count,512,left);
		if (!count) break;
		const samples = count * (csf.mix_channels >= 2 ? 2 : 1);
		const offsets = {rofs:csf.dry_rofs_vol,lofs:csf.dry_lofs_vol};
		app.stereo_fill(csf.mix_buffer,count,offsets);
		csf.dry_rofs_vol = offsets.rofs; csf.dry_lofs_vol = offsets.lofs;
		csf.mix_stat += app.csf_create_stereo_mix(csf,count);
		if (csf.mix_channels < 2) app.mono_from_stereo(csf.mix_buffer,count);
		if (csf.mix_channels >= 2) {
			app.eq_stereo(csf,csf.mix_buffer,count);
			if (!(csf.mix_flags & 0x10000)) app.normalize_stereo(csf,csf.mix_buffer,count);
		} else {
			app.eq_mono(csf,csf.mix_buffer,count);
			if (!(csf.mix_flags & 0x10000)) app.normalize_mono(csf,csf.mix_buffer,count);
		}
		chunks++;
		if (csf.multi_write) {
			for (let n=0;n<64;n++) {
				const writer=csf.multi_write[n];
				if (writer.used) {
					if(csf.mix_channels<2)app.mono_from_stereo(writer.buffer,count);
					const result=convert(writer.buffer,samples);bytes.set(result.bytes,offset);writer.write(writer.data,bytes.subarray(offset),result.count);
				} else writer.silence(writer.data,samples*Math.ceil(bits/8));
			}
		} else { const result=convert(csf.mix_buffer,samples);bytes.set(result.bytes,offset);offset+=result.count; }
		left-=count;csf.buffer_count-=count;
	}
	if(left)bytes.fill(bits===8?128:0,offset,offset+left*sampleSize);
	for(let c=0;c<2;c++){mins[c]>>=19;maxs[c]>>=19;if(maxs[c]<mins[c])maxs[c]=mins[c];}
	csf.vu_left=(maxs[0]-mins[0])>>>0;csf.vu_right=(maxs[1]-mins[1])>>>0;
	if(chunks)csf.mix_stat=Math.trunc((csf.mix_stat+chunks-1)/chunks);
	return max-left;
}
provide({ csf_read });

export function csf_init_player(csf, reset) {
	csf.max_voices = Math.min(csf.max_voices,256);
	csf.mix_frequency = Math.max(4000,Math.min(192000,csf.mix_frequency));
	csf.ramping_samples_up = Math.max(8,Math.trunc(csf.mix_frequency*363/1000000));
	csf.ramping_samples_down = Math.max(8,Math.trunc(csf.mix_frequency*952/1000000));
	if(csf.mix_flags&0x800000)csf.ramping_samples_up=csf.ramping_samples_down=2;
	csf.dry_rofs_vol=csf.dry_lofs_vol=0;
	if(reset)csf.vu_left=csf.vu_right=0;
	app.song_init_eq(reset,csf.mix_frequency);
	if(csf.mix_frequency!==4000)app.Fmdrv_Init(csf,csf.mix_frequency);
	app.GM_Reset(csf,0);
	return 1;
}
provide({csf_init_player});
