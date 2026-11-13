// Initial pitch portion of player/effects.c (GPL-2.0-or-later).
import { app, provide } from './app.js';
import { linear_slide_up_table, linear_slide_down_table,
	fine_linear_slide_up_table, fine_linear_slide_down_table,
	sine_table, ramp_down_table, square_table, QUIRK, FX, VOLFX, vc_portamento_table, retrig_table_1, retrig_table_2 } from './gen/tables.js';

const i32 = value => Number(BigInt.asIntN(32, value));
function muldiv(a, b, c, round = false) {
	return i32((BigInt(a) * BigInt(b) + (round ? BigInt(c >> 1) : 0n)) / BigInt(c));
}
export function get_frequency_from_note(note, c5speed) {
	if (!note || note > 0xf0) return 0;
	note--;
	return muldiv(c5speed | 0, linear_slide_up_table[(note % 12) * 16] << Math.trunc(note / 12), 65536 << 5);
}
export function get_note_from_frequency(frequency, c5speed) {
	if (!frequency) return 0;
	for (let n = 0; n <= 120; n++)
		if (frequency <= get_frequency_from_note(n + 1, c5speed)) return n + 1;
	return 120;
}
export function transpose_to_frequency(transp, ftune) {
	return Math.trunc(8363 * Math.pow(2, (transp * 128 + ftune) / 1536)) >>> 0;
}
export function frequency_to_transpose(freq) {
	return Math.trunc(1536 * (Math.log(freq / 8363) / Math.log(2))) | 0;
}
export function calc_halftone(hz, rel) {
	return Math.trunc(Math.pow(2, rel / 12) * hz + 0.5) >>> 0;
}
export function csf_fx_do_freq_slide(flags, frequency, slide, is_tone_portamento) {
	if (!frequency) return 0;
	if (flags & 0x10) {
		const old_frequency = frequency, n = Math.min(Math.abs(slide), 1020);
		if (slide) {
			const table = slide > 0
				? (n < 16 ? fine_linear_slide_up_table : linear_slide_up_table)
				: (n < 16 ? fine_linear_slide_down_table : linear_slide_down_table);
			frequency = muldiv(frequency, table[n < 16 ? n : Math.trunc(n / 4)], 65536, true);
			if (frequency === old_frequency) frequency += slide > 0 ? 1 : -1;
		}
	} else if (slide < 0) {
		frequency = i32((14317456n * BigInt(frequency)) / (BigInt(frequency) * BigInt(-slide) + 14317456n));
	} else if (slide > 0) {
		let divisor = i32(14317456n - BigInt(frequency) * BigInt(slide));
		if (divisor <= 0) {
			if (is_tone_portamento) divisor = 1;
			else return 0;
		}
		frequency = Number((14317456n * BigInt(frequency)) / BigInt(divisor));
		frequency = Math.min(frequency, 0x7fffffff);
	}
	return frequency;
}
provide({ get_frequency_from_note, get_note_from_frequency, transpose_to_frequency,
	frequency_to_transpose, calc_halftone, csf_fx_do_freq_slide });

function portamento(flags, chan, param, sign) {
	if (!param) param = chan.mem_pitchslide;
	const fine = param & 0xf0;
	if (fine === 0xe0 || fine === 0xf0) {
		const amount = param & 15;
		if ((flags & 0x1000) && chan.frequency && amount)
			chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency,
				amount * sign * (fine === 0xf0 ? 4 : 1), 0);
	} else if (!(flags & 0x1000)) {
		chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency, param * 4 * sign, 0);
	}
}
export function fx_portamento_up(flags, chan, param) { portamento(flags, chan, param, 1); }
export function fx_portamento_down(flags, chan, param) { portamento(flags, chan, param, -1); }
export function fx_tone_portamento(flags, chan, param) {
	chan.flags |= 0x80000;
	if (!chan.frequency || !chan.portamento_target || (flags & 0x1000)) return;
	if (!param && chan.row_effect === 6) {
		if (chan.frequency > 1 && (flags & 0x10)) chan.frequency--;
		if (chan.frequency < chan.portamento_target) {
			chan.frequency = chan.portamento_target;
			chan.portamento_target = 0;
		}
	} else if (param && chan.frequency < chan.portamento_target) {
		chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency, param * 4, 1);
		if (chan.frequency >= chan.portamento_target) {
			chan.frequency = chan.portamento_target;
			chan.portamento_target = 0;
		}
	} else if (param && chan.frequency >= chan.portamento_target) {
		chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency, param * -4, 1);
		if (chan.frequency < chan.portamento_target) {
			chan.frequency = chan.portamento_target;
			chan.portamento_target = 0;
		}
	}
}
export function fx_note_slide(flags, chan, param, sign) {
	if (flags & 0x1000) {
		if (param & 0xf0) chan.note_slide_speed = param >> 4;
		if (param & 15) chan.note_slide_step = param & 15;
		chan.note_slide_counter = chan.note_slide_speed;
	} else {
		chan.note_slide_counter = (chan.note_slide_counter - 1) >>> 0;
		if (!chan.note_slide_counter) {
			chan.note_slide_counter = chan.note_slide_speed;
			chan.frequency = get_frequency_from_note(sign * chan.note_slide_step
				+ get_note_from_frequency(chan.frequency, chan.c5speed), chan.c5speed);
		}
	}
}

export function fx_volume_slide(flags, chan, param) {
	if (param) chan.mem_volslide = param;
	else param = chan.mem_volslide;
	let delta = 0;
	if (param === (param & 0xf0)) {
		param >>= 4;
		if (param === 15 || !(flags & 0x1000)) delta = param * 4;
	} else if (param === (param & 15)) {
		if (param === 15 || !(flags & 0x1000)) delta = -param * 4;
	} else if ((param & 15) === 15) {
		if (flags & 0x1000) delta = (param >> 4) * 4;
	} else if ((param & 0xf0) === 0xf0) {
		if (flags & 0x1000) delta = -(param & 15) * 4;
	}
	if (delta > 0) chan.volume = Math.min(256, chan.volume + delta);
	else if (delta < 0) chan.volume = Math.max(0, chan.volume + delta);
}
export function fx_panning_slide(flags, chan, param) {
	let slide = 0;
	if (param) chan.mem_panslide = param;
	else param = chan.mem_panslide;
	if ((param & 15) === 15 && (param & 0xf0)) {
		if (flags & 0x1000) slide = -((param & 0xf0) >> 2);
	} else if ((param & 0xf0) === 0xf0 && (param & 15)) {
		if (flags & 0x1000) slide = (param & 15) << 2;
	} else if (!(flags & 0x1000)) {
		slide = param & 15 ? (param & 15) << 2 : -((param & 0xf0) >> 2);
	}
	if (slide) {
		chan.panning = Math.max(0, Math.min(256, chan.panning + slide));
		chan.channel_panning = 0;
	}
	chan.flags &= ~0x800;
	chan.panbrello_delta = 0;
}
export function fx_vibrato(chan, param) {
	if (param & 15) chan.vibrato_depth = (param & 15) * 4;
	if (param & 0xf0) chan.vibrato_speed = (param >> 4) & 15;
	chan.flags |= 0x10000;
}
export function fx_fine_vibrato(chan, param) {
	if (param & 15) chan.vibrato_depth = param & 15;
	if (param & 0xf0) chan.vibrato_speed = (param >> 4) & 15;
	chan.flags |= 0x10000;
}

// libc rand() sequences are platform-specific. Callers can inject raw rand
// values for repeatable render comparisons; default range matches Linux RAND_MAX.
const random_raw = () => Math.floor(Math.random() * 0x80000000);
function waveform(type, position) {
	if (type === 1) return ramp_down_table[position];
	if (type === 2) return square_table[position];
	return sine_table[position];
}
export function fx_panbrello(chan, param, rand = random_raw) {
	const panpos = chan.panbrello_position & 255;
	if (param & 15) chan.panbrello_depth = param & 15;
	if (param & 0xf0) chan.panbrello_speed = (param >> 4) & 15;
	const pdelta = chan.panbrello_type === 3 ? (rand() & 127) - 64 : waveform(chan.panbrello_type, panpos);
	if (chan.panbrello_type === 3) {
		if (!chan.panbrello_position || chan.panbrello_position >= chan.panbrello_speed)
			chan.panbrello_position = 0;
		chan.panbrello_position++;
	} else chan.panbrello_position = (chan.panbrello_position + chan.panbrello_speed) >>> 0;
	chan.panbrello_delta = pdelta;
}
export function fx_tremolo(flags, chan, param, rand = random_raw) {
	const trempos = chan.tremolo_position & 255;
	if (param & 15) chan.tremolo_depth = (param & 15) << 2;
	if (param & 0xf0) chan.tremolo_speed = (param >> 4) & 15;
	chan.flags |= 0x20000;
	if ((flags & 0x1000) && (flags & 4)) return;
	let tdelta = chan.tremolo_type === 3
		? Math.trunc(128 * (rand() / 0x7fffffff) - 64) : waveform(chan.tremolo_type, trempos);
	chan.tremolo_position = (trempos + 4 * chan.tremolo_speed) & 255;
	chan.tremolo_delta = (tdelta * chan.tremolo_depth) >> 5;
}

export function fx_channel_vol_slide(flags, chan, param) {
	if (param) chan.mem_channel_volslide = param;
	else param = chan.mem_channel_volslide;
	let slide = 0;
	if ((param & 15) === 15 && (param & 0xf0)) {
		if (flags & 0x1000) slide = param >> 4;
	} else if ((param & 0xf0) === 0xf0 && (param & 15)) {
		if (flags & 0x1000) slide = -(param & 15);
	} else if (!(flags & 0x1000)) {
		slide = param & 15 ? -(param & 15) : (param & 0xf0) >> 4;
	}
	if (slide) chan.global_volume = Math.max(0, Math.min(64, chan.global_volume + slide));
}
export function fx_global_vol_slide(csf, chan, param) {
	if (param) chan.mem_global_volslide = param;
	else param = chan.mem_global_volslide;
	let slide = 0;
	if ((param & 15) === 15 && (param & 0xf0)) {
		if (csf.flags & 0x1000) slide = param >> 4;
	} else if ((param & 0xf0) === 0xf0 && (param & 15)) {
		if (csf.flags & 0x1000) slide = -(param & 15);
	} else if (!(csf.flags & 0x1000)) {
		slide = param & 0xf0 ? (param & 0xf0) >> 4 : -(param & 15);
	}
	if (slide) csf.current_global_volume = Math.max(0, Math.min(128, csf.current_global_volume + slide));
}
export function fx_pattern_loop(csf, chan, param) {
	if (param) {
		if (chan.cd_patloop) {
			chan.cd_patloop = (chan.cd_patloop - 1) >>> 0;
			if (!chan.cd_patloop) {
				chan.patloop_row = csf.row + 1;
				return;
			}
		} else chan.cd_patloop = param;
		csf.process_row = (chan.patloop_row - 1) >>> 0;
	} else chan.patloop_row = csf.row;
}

export function csf_set_instrument_panning(csf, chan, penv, pins) {
	let panning;
	if (penv && (penv.flags & 0x200)) panning = penv.panning;
	else if (pins.flags & 0x20) panning = pins.panning;
	else return;
	if (csf.quirks[QUIRK.IT_DO_NOT_OVERRIDE_CHANNEL_PAN]) {
		chan.channel_panning = (chan.panning + 1) & 0xffff;
		if (chan.flags & 0x800) chan.channel_panning |= 0x8000;
	} else chan.channel_panning = 0;
	chan.panning = panning;
	chan.flags &= ~0x800;
}
provide({ csf_set_instrument_panning });

export function fx_note_cut(csf, nchan, clear_note) {
	const chan = csf.voices[nchan];
	if (chan.row_note > 0 && chan.row_note <= 120 && chan.row_voleffect === 11) return;
	chan.flags |= 0x400 | 0x1000000;
	chan.increment = { v: 0n };
	chan.fadeout_volume = 0;
	if (chan.flags & 0x20000000) {
		app.OPL_NoteOff(csf, nchan);
		app.OPL_Touch(csf, nchan, 0);
	}
	app.GM_KeyOff(csf, nchan);
	app.GM_Touch(csf, nchan, 0);
}
export function fx_key_off(csf, nchan) {
	const chan = csf.voices[nchan];
	if (chan.flags & 0x20000000) app.OPL_NoteOff(csf, nchan);
	app.GM_KeyOff(csf, nchan);
	const penv = csf.flags & 0x20000 ? chan.ptr_instrument : null;
	chan.flags |= 0x200;
	if (penv && !(chan.flags & 0x200000)) chan.flags |= 0x400;
	if (!chan.length) return;
	if ((chan.flags & 8) && chan.ptr_sample) {
		const psmp = chan.ptr_sample;
		if (psmp.flags & 2) {
			if (psmp.flags & 4) chan.flags |= 4;
			else chan.flags &= ~(4 | 128);
			chan.flags |= 2;
			chan.loop_start = psmp.loop_start;
			chan.loop_end = psmp.loop_end;
			chan.length = Math.min(psmp.length, chan.loop_end);
			const end = BigInt(chan.length) << 32n;
			if (chan.position.v >= end)
				chan.position = { v: BigInt.asIntN(64, chan.position.v - end + (BigInt(chan.loop_start) << 32n)) };
		} else {
			chan.flags &= ~(2 | 4 | 128);
			chan.length = psmp.length;
		}
	}
	if (penv && penv.fadeout && (penv.flags & 4)) chan.flags |= 0x400;
}
provide({ fx_note_cut, fx_key_off });

export function fx_retrig_note(csf, nchan, param) {
	const chan = csf.voices[nchan];
	if ((csf.flags & 0x1000) && chan.row_note !== 0) {
		chan.cd_retrig = param & 15;
	} else if (--chan.cd_retrig <= 0) {
		if (chan.position.v === 0n && csf.quirks[QUIRK.IT_SHORT_SAMPLE_RETRIG]) return;
		chan.cd_retrig = param & 15;
		param >>= 4;
		if (param) {
			let vol = chan.volume;
			if (retrig_table_1[param]) vol = (vol * retrig_table_1[param]) >> 4;
			else vol += retrig_table_2[param] << 2;
			chan.volume = Math.max(0, Math.min(256, vol));
			chan.flags |= 0x1000000;
		}
		const note = chan.new_note, frequency = chan.frequency;
		if (note > 0 && note <= 120 && chan.length) app.csf_check_nna(csf, nchan, 0, note, 1);
		app.csf_note_change(csf, nchan, note, 1, 1, 0);
		if (frequency && chan.row_note === 0) chan.frequency = frequency;
		chan.position = { v: 0n };
	}
}

export function fx_special(csf, nchan, param) {
	const chan = csf.voices[nchan], command = param & 0xf0;
	param &= 15;
	const first = csf.flags & 0x1000;
	switch (command) {
	case 0x10: chan.flags = (chan.flags & ~0x100000) | (param ? 0x100000 : 0); break;
	case 0x30: chan.vib_type = param; break;
	case 0x40: chan.tremolo_type = param; break;
	case 0x50: chan.panbrello_type = param < 4 ? param : 0; chan.panbrello_position = 0; break;
	case 0x60:
		if (first) { csf.frame_delay = (csf.frame_delay + param) >>> 0; csf.tick_count = (csf.tick_count + param) >>> 0; }
		break;
	case 0x70:
		if (!first) break;
		if (param <= 2) {
			for (let i = 64; i < 256; i++) {
				const bkp = csf.voices[i];
				if (bkp.master_channel !== nchan + 1) continue;
				if (param === 1) fx_key_off(csf, i);
				else { bkp.flags |= 0x400; if (!param) bkp.fadeout_volume = 0; }
			}
		} else if (param <= 6) chan.nna = param - 3;
		else if (param <= 12) {
			const bit = 0x200000 << Math.trunc((param - 7) / 2);
			if (param & 1) chan.flags &= ~bit;
			else chan.flags |= bit;
		}
		break;
	case 0x80:
		if (first) Object.assign(chan, { flags: (chan.flags & ~0x800) | 0x1000000,
			panbrello_delta: 0, panning: (param << 4) + 8, channel_panning: 0, pan_swing: 0 });
		break;
	case 0x90:
		if (!first) break;
		if (param === 0) { chan.flags &= ~0x800; chan.channel_panning = 0; }
		else if (param === 1) Object.assign(chan, { flags: chan.flags | 0x800,
			panbrello_delta: 0, panning: 128, channel_panning: 0 });
		else if (param === 14) chan.flags &= ~128;
		else if (param === 15) {
			if (chan.position.v === 0n && chan.length &&
				((chan.row_note > 0 && chan.row_note <= 120) || !(chan.flags & 2)))
				chan.position = { v: (BigInt(chan.length - 1) << 32n) | 0xffffffffn };
			chan.flags |= 128;
		}
		break;
	case 0xa0: if (first) chan.mem_offset = ((param << 16) | (chan.mem_offset & ~0xf0000)) >>> 0; break;
	case 0xb0: if (first) fx_pattern_loop(csf, chan, param); break;
	case 0xc0:
		if (first) chan.cd_note_cut = param || 1;
		else if (--chan.cd_note_cut === 0) fx_note_cut(csf, nchan, 1);
		break;
	case 0xe0: if (first && !csf.row_count) csf.row_count = param + 1; break;
	case 0xf0: chan.active_macro = param; break;
	}
}

// Row effect dispatch from handle_effect. Pattern break is deliberately handled
// in csf_process_effects upstream, rather than here.
export function handle_effect(csf, nchan, cmd, param, porta, firsttick) {
	const chan = csf.voices[nchan], flags = csf.flags | (firsttick ? 0x1000 : 0);
	switch (cmd) {
	case FX.NONE: break;
	case FX.VOLUME:
		if (csf.flags & 0x1000) { chan.volume = param < 64 ? param * 4 : 256; chan.flags |= 0x1000000; } break;
	case FX.PORTAMENTOUP: fx_portamento_up(flags, chan, chan.mem_pitchslide); break;
	case FX.PORTAMENTODOWN: fx_portamento_down(flags, chan, chan.mem_pitchslide); break;
	case FX.VOLUMESLIDE: fx_volume_slide(flags, chan, param); break;
	case FX.TONEPORTAMENTO: fx_tone_portamento(flags, chan, chan.mem_portanote); break;
	case FX.TONEPORTAVOL: fx_tone_portamento(flags, chan, chan.mem_portanote); fx_volume_slide(flags, chan, param); break;
	case FX.VIBRATO: fx_vibrato(chan, param); break;
	case FX.VIBRATOVOL: fx_volume_slide(flags, chan, param); fx_vibrato(chan, 0); break;
	case FX.SPEED:
		if ((csf.flags & 0x1000) && param) csf.tick_count = csf.current_speed = param;
		break;
	case FX.TEMPO:
		if (csf.flags & 0x1000) {
			if (param) chan.mem_tempo = param; else param = chan.mem_tempo;
			if (param >= 32) csf.current_tempo = param;
		} else {
			param = chan.mem_tempo;
			if ((param >> 4) === 0) csf.current_tempo = Math.max(32, (csf.current_tempo - (param & 15)) >>> 0);
			else if ((param >> 4) === 1) csf.current_tempo = Math.min(255, csf.current_tempo + (param & 15));
		}
		break;
	case FX.OFFSET:
		if (!(csf.flags & 0x1000)) break;
		if (param) chan.mem_offset = ((chan.mem_offset & ~0xff00) | (param << 8)) >>> 0;
		{ const note = chan.row_instr ? chan.new_note : chan.row_note;
		if (note > 0 && note <= 120) {
			chan.position = { v: BigInt(chan.mem_offset | 0) << 32n };
			if (chan.position.v > (BigInt(chan.length) << 32n)) chan.position = { v: csf.flags & 4 ? BigInt(chan.length) << 32n : 0n };
		} } break;
	case FX.ARPEGGIO: chan.n_command = FX.ARPEGGIO; if ((csf.flags & 0x1000) && param) chan.mem_arpeggio = param; break;
	case FX.RETRIG: if (param) chan.mem_retrig = param & 255; fx_retrig_note(csf, nchan, chan.mem_retrig); break;
	case FX.TREMOR:
		if (csf.flags & 0x1000) {
			if (!param) param = chan.mem_tremor;
			else if (!(csf.flags & 4)) { if (param & 0xf0) param -= 16; if (param & 15) param--; }
			chan.mem_tremor = param; chan.cd_tremor |= 128;
		} chan.n_command = FX.TREMOR; break;
	case FX.GLOBALVOLUME: if (firsttick && param <= 128) csf.current_global_volume = param; break;
	case FX.GLOBALVOLSLIDE: fx_global_vol_slide(csf, chan, param); break;
	case FX.PANNING:
		if (csf.flags & 0x1000) Object.assign(chan, { flags: (chan.flags & ~0x800) | 0x1000000, panbrello_delta: 0, panning: param, channel_panning: 0, pan_swing: 0 }); break;
	case FX.PANNINGSLIDE: fx_panning_slide(flags, chan, param); break;
	case FX.TREMOLO: fx_tremolo(flags, chan, param); break;
	case FX.FINEVIBRATO: fx_fine_vibrato(chan, param); break;
	case FX.SPECIAL: fx_special(csf, nchan, param); break;
	case FX.KEYOFF: if (((csf.current_speed - csf.tick_count) >>> 0) === param) fx_key_off(csf, nchan); break;
	case FX.CHANNELVOLUME: if ((csf.flags & 0x1000) && param <= 64) { chan.global_volume = param; chan.flags |= 0x1000000; } break;
	case FX.CHANNELVOLSLIDE: fx_channel_vol_slide(flags, chan, param); break;
	case FX.PANBRELLO: fx_panbrello(chan, param); break;
	case FX.SETENVPOSITION:
		if (!(csf.flags & 0x1000)) break;
		chan.vol_env_position = chan.pan_env_position = chan.pitch_env_position = param;
		if ((csf.flags & 0x20000) && chan.ptr_instrument) {
			const env = chan.ptr_instrument.pan_env;
			if ((chan.flags & 0x400000) && env.nodes && param > env.ticks[env.nodes - 1]) chan.flags &= ~0x400000;
		} break;
	case FX.NOTESLIDEUP: fx_note_slide(flags, chan, param, 1); break;
	case FX.NOTESLIDEDOWN: fx_note_slide(flags, chan, param, -1); break;
	case FX.MIDI: if (csf.flags & 0x1000) app.fx_midi_zxx(csf, chan); break;
	case FX.POSITIONJUMP:
		if (!(csf.mix_flags & 0x40000) || csf.process_order < param) csf.process_order = (param - 1) >>> 0;
		csf.process_row = 0xfffe; break;
	}
}

export function handle_voleffect(csf, chan, volcmd, vol, firsttick, start_note) {
	const flags = csf.flags | (firsttick ? 0x1000 : 0);
	switch (volcmd) {
	case VOLFX.NONE: break;
	case VOLFX.VOLUME:
		if (start_note) { chan.volume = Math.min(vol, 64) << 2; chan.flags |= 0x1000000; } break;
	case VOLFX.PANNING:
		if (start_note) Object.assign(chan, { panning: Math.min(vol, 64) << 2,
			channel_panning: 0, pan_swing: 0, panbrello_delta: 0, flags: (chan.flags | 0x1000000) & ~0x800 }); break;
	case VOLFX.PORTAUP:
		if (!start_note && !(flags & 0x1000)) chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency, chan.mem_pitchslide * 4, 0); break;
	case VOLFX.PORTADOWN:
		if (!start_note && !(flags & 0x1000)) chan.frequency = csf_fx_do_freq_slide(flags, chan.frequency, -chan.mem_pitchslide * 4, 0); break;
	case VOLFX.TONEPORTAMENTO: if (!start_note) fx_tone_portamento(flags, chan, chan.mem_portanote); break;
	case VOLFX.VOLSLIDEUP:
	case VOLFX.VOLSLIDEDOWN:
		if (start_note) { if (vol) chan.mem_vc_volslide = vol; }
		else if (volcmd === VOLFX.VOLSLIDEUP) chan.volume = Math.min(256, chan.volume + chan.mem_vc_volslide * 4);
		else chan.volume = Math.max(0, chan.volume - chan.mem_vc_volslide * 4);
		break;
	case VOLFX.FINEVOLUP:
	case VOLFX.FINEVOLDOWN:
		if (start_note) {
			if (vol) chan.mem_vc_volslide = vol; else vol = chan.mem_vc_volslide;
			if (volcmd === VOLFX.FINEVOLUP) chan.volume = Math.min(256, chan.volume + vol * 4);
			else chan.volume = Math.max(0, chan.volume - vol * 4);
		} break;
	case VOLFX.VIBRATODEPTH: fx_vibrato(chan, vol); break;
	case VOLFX.VIBRATOSPEED: chan.vibrato_speed = vol; break;
	case VOLFX.PANSLIDELEFT: fx_panning_slide(csf.flags, chan, (vol << 4) | 15); break;
	case VOLFX.PANSLIDERIGHT: fx_panning_slide(csf.flags, chan, (vol & 15) | 0xf0); break;
	}
}

// The memory-initialization block in csf_process_effects must run after note
// changes and before either column dispatcher, in this precise order.
export function initialize_portamento_memory(csf, chan, cmd, param, volcmd, vol) {
	const effect_column_tone_porta = cmd === FX.TONEPORTAMENTO || cmd === FX.TONEPORTAVOL;
	const compat = csf.flags & 8;
	if (effect_column_tone_porta) {
		const toneporta_param = cmd !== FX.TONEPORTAVOL ? param : 0;
		if (toneporta_param) chan.mem_portanote = toneporta_param;
		else if (!compat) chan.mem_portanote = chan.mem_pitchslide;
		if (!compat) chan.mem_pitchslide = chan.mem_portanote;
	}
	if (volcmd === VOLFX.TONEPORTAMENTO) {
		if (vol) chan.mem_portanote = vc_portamento_table[vol & 15];
		if (!compat) chan.mem_pitchslide = chan.mem_portanote;
	}
	if (vol && (volcmd === VOLFX.PORTAUP || volcmd === VOLFX.PORTADOWN)) {
		chan.mem_pitchslide = 4 * vol;
		if (!effect_column_tone_porta && !compat) chan.mem_portanote = chan.mem_pitchslide;
	}
	if (param && (cmd === FX.PORTAMENTOUP || cmd === FX.PORTAMENTODOWN)) {
		chan.mem_pitchslide = param;
		if (!compat) chan.mem_portanote = chan.mem_pitchslide;
	}
}

// Per-channel scheduling and dispatch. Note-start changes are late-bound while
// their instrument/NNA dependencies are ported; missing calls stay visible.
export function csf_process_effects(csf, firsttick) {
	let patloop = false;
	for (let nchan = 0; nchan < 64; nchan++) {
		const chan = csf.voices[nchan];
		chan.n_command = 0;
		const instr = chan.row_instr, volcmd = chan.row_voleffect, vol = chan.row_volparam;
		const cmd = chan.row_effect;
		let param = chan.row_param;
		let porta = cmd === FX.TONEPORTAMENTO || cmd === FX.TONEPORTAVOL || volcmd === VOLFX.TONEPORTAMENTO;
		let start_note = !!(csf.flags & 0x1000);
		chan.flags &= ~(0x1000000 | 0x2000000);
		if (instr && start_note) chan.new_instrument = instr;
		if ((csf.flags & 0x20000) && instr > 0 && instr < 236 && csf.instruments[instr]) {
			const note = chan.row_note !== 0 ? chan.row_note : chan.new_note;
			if (note > 0 && note <= 120 && !csf.instruments[instr].sample_map[note - 1]) {
				chan.new_note = note;
				chan.row_instr = instr;
				chan.row_voleffect = VOLFX.NONE;
				chan.row_effect = FX.NONE;
				continue;
			}
		}
		if (cmd === FX.SPECIAL) {
			if (param) chan.mem_special = param; else param = chan.mem_special;
			if ((param >> 4) === 13) {
				if (firsttick) { chan.cd_note_delay = (param & 15) || 1; continue; }
				if (--chan.cd_note_delay > 0) continue;
				start_note = chan.cd_note_delay === 0;
			}
		}
		if (start_note && !(csf.mix_flags & 0x1000000))
			porta = csf_process_note_start(csf, nchan, instr, porta);
		if (firsttick) initialize_portamento_memory(csf, chan, cmd, param, volcmd, vol);
		if (!(csf.mix_flags & 0x1000000)) handle_voleffect(csf, chan, volcmd, vol, firsttick, start_note);
		handle_effect(csf, nchan, cmd, param, porta, firsttick);
		if (volcmd === VOLFX.VIBRATODEPTH && cmd === FX.VIBRATO) fx_vibrato(chan, vol);
		if (chan.cd_patloop) patloop = true;
	}
	for (let nchan = 0; nchan < 64; nchan++) {
		const chan = csf.voices[nchan];
		if (chan.row_effect === FX.PATTERNBREAK && !patloop) {
			csf.break_row = chan.row_param;
			csf.process_row = 0xfffe;
		}
	}
}
provide({ csf_process_effects });

export function csf_process_note_start(csf, nchan, instr, porta) {
	const chan = csf.voices[nchan], instrumentMode = csf.flags & 0x20000;
	const isNote = n => n > 0 && n <= 120;
	let note = chan.row_note;
	if (instrumentMode && (isNote(note) || !note)) {
		const check = instr || chan.last_instrument;
		if (check && (check < 0 || check > 236 || !csf.instruments[check])) { note = 0; instr = 0; }
	}
	if (instrumentMode && instr && !isNote(note) && ((porta && (csf.flags & 8)) || (!porta && (csf.flags & 4))))
		app.csf_env_reset(csf, chan, porta, 1);
	if (instr && !note) {
		const trigger = csf.quirks[QUIRK.IT_MULTI_SAMPLE_INSTRUMENT_NUMBER] && !chan.current_sample_data;
		if (instrumentMode) { if (chan.ptr_sample) chan.volume = chan.ptr_sample.volume; }
		else if (instr < 236) chan.volume = csf.samples[instr].volume;
		if (instrumentMode) {
			if (instr < 236 && (chan.ptr_instrument !== csf.instruments[instr] || trigger)) note = chan.new_note;
		} else if (instr < 236 && (chan.ptr_sample !== csf.samples[instr] || trigger)) note = chan.new_note;
	}
	if (instr >= 236) instr = 0;
	if (note > 120) {
		if (instr) {
			const smp = instrumentMode ? (csf.instruments[instr]?.sample_map[chan.note] || 0) : instr;
			if (smp > 0 && smp < 236) chan.volume = csf.samples[smp].volume;
		}
		if (!(csf.flags & 4)) instr = 0;
	}
	if (note > 120 || (note && !porta)) {
		if (chan.flags & 0x20000000) { app.OPL_NoteOff(csf, nchan); app.OPL_Touch(csf, nchan, 0); }
		app.GM_KeyOff(csf, nchan); app.GM_Touch(csf, nchan, 0);
	}
	const previous_new_note = chan.new_note & 255;
	if (isNote(note)) {
		chan.new_note = note;
		if (!porta) app.csf_check_nna(csf, nchan, instr, note, 0);
		if (chan.channel_panning > 0) {
			chan.panning = (chan.channel_panning & 0x7fff) - 1;
			if (chan.channel_panning & 0x8000) chan.flags |= 0x800;
			chan.channel_panning = 0;
		}
	}
	const patch = index => {
		if (csf.samples[index].flags & 0x20000000) app.OPL_Patch(csf, nchan, csf.samples[index].adlib_bytes);
		if (instrumentMode && csf.instruments[index]) {
			const ins = csf.instruments[index];
			app.GM_DPatch(csf, nchan, ins.midi_program, ins.midi_bank, ins.midi_channel_mask);
		}
	};
	if (instr) {
		const psmp = chan.ptr_sample;
		app.csf_instrument_change(csf, chan, instr, porta, 1);
		patch(instr);
		if (isNote(note)) chan.new_instrument = 0;
		if (csf.quirks[QUIRK.IT_PORTAMENTO_SWAP_RESETS_POSITION]) {
			if (isNote(note) && psmp !== chan.ptr_sample) chan.position = { v: 0n };
		} else if (psmp !== chan.ptr_sample && isNote(note)) porta = false;
	}
	if (note) {
		if (!instr && chan.new_instrument && isNote(note)) {
			if (isNote(previous_new_note)) chan.new_note = previous_new_note;
			app.csf_instrument_change(csf, chan, chan.new_instrument, porta, 0);
			if (instrumentMode && chan.new_instrument < 236 && csf.instruments[chan.new_instrument]) patch(chan.new_instrument);
			chan.new_note = note; chan.new_instrument = 0;
		}
		app.csf_note_change(csf, nchan, note, porta, 0, !instr);
	}
	return porta;
}
provide({ csf_process_note_start });

export function csf_translate_keyboard(csf, penv, note, def) {
	const n = penv.sample_map[note - 1];
	return n && n < 236 ? csf.samples[n] : def;
}
export function csf_env_reset(csf, chan, porta, always) {
	if (chan.ptr_instrument) {
		chan.flags |= 0x1000000;
		if (always) chan.vol_env_position = chan.pan_env_position = chan.pitch_env_position = 0;
		else {
			const compat = csf.quirks[QUIRK.IT_COMPAT_GXX_CARRY_PORTA_WITH_INS] && porta && (csf.flags & 8);
			const last = csf.last_moved_channel < 256 ? csf.voices[csf.last_moved_channel] : null;
			for (const [field, bit] of [['vol_env_position',0x800],['pan_env_position',0x1000],['pitch_env_position',0x2000]]) {
				if (!(chan.ptr_instrument.flags & bit)) chan[field] = 0;
				else if (compat) chan[field] = last ? last[field] : 0;
			}
		}
	}
	chan.fadeout_volume = 65536;
}
provide({ csf_translate_keyboard, csf_env_reset });

export function csf_instrument_change(csf, chan, instr, porta, inst_column, rand = random_raw) {
	if (instr >= 236) return;
	let penv = csf.flags & 0x20000 ? csf.instruments[instr] : null;
	let psmp = csf.samples[instr];
	const oldsmp = chan.ptr_sample, oldVolume = chan.instrument_volume, note = chan.new_note;
	const isNote = n => n > 0 && n <= 120;
	if (!note) return;
	if (penv && isNote(note)) {
		if (!penv.sample_map[note - 1] && csf.quirks[QUIRK.IT_EMPTY_NOTE_MAP_SLOT]) { chan.ptr_instrument = penv; return; }
		if (penv.note_map[note - 1] > 120) return;
		psmp = csf_translate_keyboard(csf, penv, note, null);
	} else if (csf.flags & 0x20000) {
		if (note > 120) return;
		if (csf.quirks[QUIRK.IT_EMPTY_NOTE_MAP_SLOT] && !penv) { chan.ptr_instrument = null; chan.new_instrument = 0; return; }
		psmp = null;
	}
	if (inst_column && psmp) chan.volume = psmp.volume;
	const changed = penv !== chan.ptr_instrument || !chan.current_sample_data;
	if (changed) chan.ptr_instrument = penv;
	chan.new_instrument = 0;
	if (psmp) {
		psmp.played = 1;
		if (penv) { penv.played = 1; chan.instrument_volume = (psmp.global_volume * penv.global_volume) >> 7; }
		else chan.instrument_volume = psmp.global_volume;
		if (!csf.quirks[QUIRK.IT_PANNING_RESET]) csf_set_instrument_panning(csf, chan, penv, psmp);
	}
	if (chan.ptr_sample && psmp !== chan.ptr_sample && porta && chan.increment.v !== 0n && (csf.flags & 8)) psmp = chan.ptr_sample;
	if (csf.quirks[QUIRK.IT_MULTI_SAMPLE_INSTRUMENT_NUMBER] && penv && !changed && psmp !== oldsmp && chan.ptr_sample && !isNote(chan.row_note)) return;
	if (!penv && psmp !== oldsmp && porta) chan.flags |= 0x2000000;
	const reset = !chan.length || (inst_column && porta && (csf.flags & 8)) || (inst_column && !porta && (chan.flags & 0x600) && (csf.flags & 4));
	if (penv) {
		if (reset) csf_env_reset(csf, chan, porta, changed || (csf.quirks[QUIRK.IT_CARRY_AFTER_NOTE_OFF] ? (!chan.fadeout_volume || !isNote(chan.row_note)) : (chan.flags & 0x200)));
		else if (!(penv.flags & 1)) chan.vol_env_position = 0;
		if (!porta) {
			chan.vol_swing = chan.pan_swing = 0;
			if (penv.vol_swing) chan.vol_swing = Math.floor((2 * rand() / 0x7fffffff - 1) * penv.vol_swing / 100 * chan.instrument_volume);
			if (penv.pan_swing) chan.pan_swing = Math.trunc((2 * rand() / 0x7fffffff - 1) * penv.pan_swing * 4);
		}
	} else if (reset) chan.flags |= 0x1000000;
	if (!psmp) { chan.ptr_sample = null; chan.instrument_volume = 0; return; }
	const was_key_off = chan.flags & 0x200, sampleFlags = 0x200000ff;
	if (psmp === chan.ptr_sample && chan.current_sample_data && chan.length) {
		if (porta && changed && penv) chan.flags &= ~0x600;
		return;
	}
	if (porta && !chan.length) chan.increment = { v: 0n };
	chan.flags &= ~(sampleFlags | 0x600 | 0xe00000);
	if (penv) {
		if (penv.flags & 1) chan.flags |= 0x200000;
		if (penv.flags & 8) chan.flags |= 0x400000;
		if (penv.flags & 64) chan.flags |= 0x800000;
		if (penv.ifc & 128) chan.cutoff = penv.ifc & 127;
		if (penv.ifr & 128) chan.resonance = penv.ifr & 127;
	}
	if (chan.row_note === 255 && (csf.flags & 4) && psmp !== oldsmp) {
		if (chan.ptr_sample) chan.flags |= chan.ptr_sample.flags & sampleFlags;
		if (psmp.flags & 32) chan.panning = psmp.panning;
		chan.instrument_volume = oldVolume; chan.volume = psmp.volume; chan.position = { v: 0n }; return;
	}
	chan.autovib_depth = chan.autovib_position = 0;
	if ((chan.flags & 0x600) && inst_column) chan.frequency = 0;
	chan.flags |= psmp.flags & sampleFlags;
	Object.assign(chan, { ptr_sample: psmp, length: psmp.length, loop_start: psmp.loop_start,
		loop_end: psmp.loop_end, c5speed: psmp.c5speed, current_sample_data: psmp.data, position: { v: 0n } });
	if ((chan.flags & 8) && (!porta || (penv && !was_key_off))) {
		chan.loop_start = psmp.sustain_start; chan.loop_end = psmp.sustain_end; chan.flags |= 2;
		if (chan.flags & 16) chan.flags |= 4;
	}
	if ((chan.flags & 2) && chan.loop_end < chan.length) chan.length = chan.loop_end;
}
provide({ csf_instrument_change });

export function csf_note_change(csf, nchan, note, porta, retrig, have_inst) {
	if (note <= 0) return;
	const truenote = note, chan = csf.voices[nchan];
	let pins = chan.ptr_sample;
	const penv = csf.flags & 0x20000 ? chan.ptr_instrument : null;
	if (penv && note <= 120) {
		if (csf.quirks[QUIRK.IT_EMPTY_NOTE_MAP_SLOT] && !penv.sample_map[note - 1]) return;
		if (!(have_inst && porta && pins)) pins = csf_translate_keyboard(csf, penv, note, pins);
		note = penv.note_map[note - 1];
	}
	if (note > 120) {
		chan.new_note = 255;
		if (note === 255) {
			fx_key_off(csf, nchan);
			if (!porta && (csf.flags & 4) && chan.row_instr) chan.flags &= ~0x600;
		} else if (note === 254) fx_note_cut(csf, nchan, 1);
		else if (csf.flags & 0x20000) chan.flags |= 0x400;
		return;
	}
	if (!pins) return;
	if (!porta) chan.c5speed = pins.c5speed;
	if (porta && chan.increment.v === 0n) porta = false;
	note = Math.max(1, Math.min(120, note));
	chan.note = Math.max(1, Math.min(120, truenote));
	chan.new_instrument = 0;
	const frequency = get_frequency_from_note(note, chan.c5speed) >>> 0;
	chan.panbrello_delta = 0;
	if (frequency) {
		if (porta && chan.frequency) chan.portamento_target = frequency;
		else { chan.portamento_target = 0; chan.frequency = frequency | 0; }
		if (!porta || !chan.length) {
			Object.assign(chan, { ptr_sample: pins, current_sample_data: pins.data,
				length: pins.length, loop_end: pins.length, loop_start: 0,
				flags: (chan.flags & ~0x200000ff) | (pins.flags & 0x200000ff) });
			if (chan.flags & 8) {
				chan.loop_start = pins.sustain_start; chan.loop_end = pins.sustain_end;
				chan.flags = (chan.flags & ~4) | 2;
				if (chan.flags & 16) chan.flags |= 4;
				chan.length = Math.min(chan.length, chan.loop_end);
			} else if (chan.flags & 2) {
				chan.loop_start = pins.loop_start; chan.loop_end = pins.loop_end;
				chan.length = Math.min(chan.length, chan.loop_end);
			}
			chan.position = { v: 0n };
		}
		if (chan.position.v >= (BigInt(chan.length) << 32n)) chan.position = { v: BigInt(chan.loop_start) << 32n };
	} else porta = false;
	if (csf.quirks[QUIRK.IT_PANNING_RESET]) csf_set_instrument_panning(csf, chan, penv, pins);
	if (csf.quirks[QUIRK.IT_PITCH_PAN_SEPARATION] && penv && penv.pitch_pan_separation) {
		if (!chan.channel_panning) chan.channel_panning = (chan.panning + 1) & 0xffff;
		const delta = Math.trunc((chan.note - penv.pitch_pan_center - 1) * penv.pitch_pan_separation / 2);
		chan.panning = Math.max(0, Math.min(256, chan.panning + delta));
	}
	if (penv) chan.nna = penv.nna;
	if (!porta) { csf_env_reset(csf, chan, porta, 0); chan.flags &= ~0x400; }
	if (!(porta && (!(csf.flags & 8) || !chan.row_instr))) chan.flags &= ~0x200;
	if (!porta) {
		chan.strike = 4;
		chan.flags = (chan.flags & ~0x4000) | 0x1000000 | 0x2000000;
		if (!retrig) chan.autovib_depth = chan.autovib_position = chan.vibrato_position = 0;
		chan.left_volume = chan.right_volume = 0;
		if (penv) {
			if (penv.ifr & 128) chan.resonance = penv.ifr & 127;
			if (penv.ifc & 128) chan.cutoff = penv.ifc & 127;
		} else chan.vol_swing = chan.pan_swing = 0;
	}
}
provide({ csf_note_change });

export function csf_get_nna_channel(csf, nchan) {
	const chan = csf.voices[nchan];
	for (let i = 64; i < 256; i++) {
		const voice = csf.voices[i];
		if (!voice.length) {
			if (voice.flags & 0x100) {
				if (voice.flags & 0x10000000) voice.flags &= ~(0x10000000 | 0x100);
				else continue;
			}
			return i;
		}
	}
	if (!chan.fadeout_volume) return 0;
	let result = 0, vol = 64 * 65536, envpos = 0xffffff;
	for (let j = 64; j < 256; j++) {
		const voice = csf.voices[j];
		if (!voice.fadeout_volume) return j;
		let v = voice.volume >>> 0;
		v = voice.flags & 0x400 ? Math.imul(v, voice.fadeout_volume) >>> 0 : (v << 16) >>> 0;
		if (voice.flags & 2) v >>>= 1;
		if (v < vol || (v === vol && voice.vol_env_position > envpos)) {
			envpos = voice.vol_env_position; vol = v; result = j;
		}
	}
	if (result) csf.voices[result].flags &= ~(0x100 | 0x10000000);
	return result;
}
// C struct assignment copies inline positions/filter history but keeps sample
// and instrument pointers shared. Object spread alone would alias history.
export function csf_copy_voice(destination, source) {
	Object.assign(destination, source, {
		position: { ...source.position }, increment: { ...source.increment },
		filter_y: source.filter_y.map(channel => new Int32Array(channel)),
	});
}
provide({ csf_get_nna_channel });

export function csf_check_nna(csf, nchan, instr, note, force_cut) {
	if (!(note > 0 && note <= 120)) return;
	const chan = csf.voices[nchan];
	const move = n => {
		const p = csf.voices[n]; csf_copy_voice(p, chan);
		p.flags &= ~(0x10000 | 0x20000 | 0x80000);
		p.panbrello_delta = p.tremolo_delta = 0;
		p.master_channel = nchan + 1; p.n_command = 0;
		return p;
	};
	const stop = () => { chan.length = 0; chan.position = { v: 0n }; chan.rofs = chan.lofs = 0; };
	const midiOff = () => {
		if (chan.flags & 0x20000000) { app.OPL_NoteOff(csf, nchan); app.OPL_Touch(csf, nchan, 0); }
		app.GM_KeyOff(csf, nchan); app.GM_Touch(csf, nchan, 0);
	};
	if (force_cut || !(csf.flags & 0x20000)) {
		if (!chan.length || (chan.flags & 0x100) || (!chan.left_volume && !chan.right_volume)) return;
		const n = csf_get_nna_channel(csf, nchan);
		if (csf.last_moved_channel === nchan) csf.last_moved_channel = n || 256;
		if (!n) return;
		const p = move(n);
		p.fadeout_volume = 0; p.flags |= 0x400 | 0x1000000;
		stop(); chan.left_volume = chan.right_volume = 0; midiOff(); return;
	}
	if (instr >= 236) instr = 0;
	let data = chan.current_sample_data;
	const ptr_instrument = instr > 0 ? csf.instruments[instr] : chan.ptr_instrument;
	if (ptr_instrument) {
		const n = ptr_instrument.sample_map[note - 1];
		if (n > 0 && n < 236) data = csf.samples[n].data;
		else if (csf.quirks[QUIRK.IT_EMPTY_NOTE_MAP_SLOT]) return;
	}
	for (let i = nchan; i < 256; i++) {
		const p = csf.voices[i];
		if (!((i >= 64 || p === chan) && (p.master_channel === nchan + 1 || p === chan) && p.ptr_instrument)) continue;
		let apply = false;
		switch (p.ptr_instrument.dct) {
		case 1: apply = p.note === note && ptr_instrument === p.ptr_instrument; break;
		case 2: apply = !!data && data === p.current_sample_data && ptr_instrument === p.ptr_instrument; break;
		case 3: apply = ptr_instrument === p.ptr_instrument; break;
		}
		if (apply) {
			switch (p.ptr_instrument.dca) {
			case 0:
				fx_key_off(csf, i); p.volume = 0;
				if (chan.flags & 0x20000000) { app.OPL_NoteOff(csf, nchan); app.OPL_Touch(csf, nchan, 0); }
				break;
			case 1: fx_key_off(csf, i); break;
			case 2: p.flags |= 0x400; break;
			}
			if (!p.volume) { p.fadeout_volume = 0; p.flags |= 0x400 | 0x1000000; }
		}
	}
	if (chan.flags & 0x100) return;
	csf.last_moved_channel = 256;
	if (chan.increment.v !== 0n && chan.length) {
		const n = csf_get_nna_channel(csf, nchan);
		if (chan.ptr_instrument === ptr_instrument) csf.last_moved_channel = n || 256;
		if (n) {
			const p = move(n);
			if (chan.nna === 2) fx_key_off(csf, n);
			else if (chan.nna === 0) { p.fadeout_volume = 0; p.flags |= 0x400; }
			else if (chan.nna === 3) p.flags |= 0x400;
			if (!p.volume) { p.fadeout_volume = 0; p.flags |= 0x400 | 0x1000000; }
			stop();
		}
	}
}
provide({ csf_check_nna });
