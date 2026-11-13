// Loop chunk scheduling from player/mixer.c (GPL-2.0-or-later).
// Lookahead addresses use { data, byteOffset } descriptors, retaining C pointer offsets.
import { app, provide } from './app.js';
import { cubic_spline_lut, windowed_fir_lut } from './gen/interpolation.js';
const whole = n => BigInt(n | 0) << 32n;
const wrap = n => BigInt.asIntN(64, n);
export function distance_to_buffer_length(from, to, increment) {
	return from.v < to.v ? Number(BigInt.asUintN(32, wrap(wrap(to.v - from.v) - whole(1)) / increment.v + 1n)) : 1;
}
export function get_sample_count(mls, chan, samples) {
	const loop_start = chan.flags & 2 ? chan.loop_start : 0;
	let increment = chan.increment.v;
	if (samples <= 0 || increment === 0n || !chan.length) return 0;
	chan.current_sample_data = mls.smp_ptr;
	if (chan.position.v < whole(loop_start)) {
		if (increment < 0n) {
			chan.position = { v: wrap(whole(loop_start) + wrap(whole(loop_start) - chan.position.v)) };
			if (chan.position.v < whole(loop_start) || chan.position.v >= whole(Math.trunc((loop_start + chan.length) / 2))) chan.position.v = whole(loop_start);
			increment = wrap(-increment); chan.increment = { v: increment }; chan.flags &= ~128;
			if (!(chan.flags & 2) || chan.position.v >= whole(chan.length)) { chan.position.v = whole(chan.length); return 0; }
		} else if (chan.position.v < 0n) chan.position = { v: 0n };
	} else if (chan.position.v >= whole(chan.length)) {
		if (!(chan.flags & 2)) return 0;
		if (chan.flags & 4) {
			if (increment > 0n) { increment = wrap(-increment); chan.increment = { v: increment }; }
			chan.flags |= 128;
			const overshoot = wrap(chan.position.v - whole(chan.length));
			chan.position = { v: overshoot < whole(chan.loop_end - chan.loop_start - 1) ? wrap(whole(chan.length - 1) - overshoot) : whole(chan.loop_start) };
		} else {
			if (increment < 0n) { increment = wrap(-increment); chan.increment = { v: increment }; }
			chan.position = { v: wrap(chan.position.v + whole(loop_start - chan.length)) };
			if (chan.position.v < whole(loop_start)) chan.position.v = whole(chan.loop_start);
			chan.flags |= 0x40000000;
		}
	}
	const position = Number(chan.position.v >> 32n);
	if (position < loop_start && (position < 0 || increment < 0n)) return 0;
	if (position < 0 || position >= chan.length) return 0;
	let count = Math.min(samples, mls.maxsamples);
	const destination = Number(wrap(chan.position.v + wrap(increment * BigInt(count - 1))) >> 32n);
	const at_loop_start = chan.position.v >= whole(chan.loop_start) && chan.position.v < whole(chan.loop_start + 16);
	if (!at_loop_start) chan.flags &= ~0x40000000;
	let checkdest = true;
	const absinc = { v: increment < 0n ? -increment : increment };
	if (mls.lookahead_ptr) {
		if (chan.position.v >= whole(mls.lookahead_start)) {
			if (chan.increment.v < 0n) {
				count = distance_to_buffer_length({v:whole(mls.lookahead_start)}, chan.position, absinc);
				chan.current_sample_data = mls.lookahead_ptr;
			} else if (chan.position.v <= whole(chan.loop_end)) {
				count = distance_to_buffer_length(chan.position, {v:whole(chan.loop_end)}, absinc);
				chan.current_sample_data = mls.lookahead_ptr;
			} else count = distance_to_buffer_length(chan.position, {v:whole(chan.length)}, absinc);
			checkdest = false;
		} else if ((chan.flags & 0x40000000) && at_loop_start) {
			count = distance_to_buffer_length(chan.position, {v:whole(loop_start + 16)}, absinc);
			const bytes = (chan.loop_end - loop_start) * ((chan.ptr_sample.flags & 64) ? 2 : 1) * ((chan.ptr_sample.flags & 1) ? 2 : 1);
			chan.current_sample_data = { data: mls.lookahead_ptr.data, byteOffset: mls.lookahead_ptr.byteOffset + bytes };
			checkdest = false;
		} else if (chan.increment.v > 0n && destination >= mls.lookahead_start && count > 1) {
			count = distance_to_buffer_length(chan.position, {v:whole(mls.lookahead_start)}, absinc);
			checkdest = false;
		}
	}
	const inv = { v: increment < 0n ? -increment : increment };
	if (checkdest && increment < 0n && destination < loop_start) count = distance_to_buffer_length({v:whole(loop_start)}, chan.position, inv);
	else if (checkdest && increment >= 0n && destination >= chan.length) count = distance_to_buffer_length(chan.position, {v:whole(chan.length)}, inv);
	return Math.max(1, Math.min(samples, count));
}
provide({ distance_to_buffer_length });

export function mix_loop_state_update_lookahead_ptrs(mls, channel) {
	mls.smp_ptr = channel.ptr_sample ? channel.ptr_sample.data : null;
	mls.lookahead_ptr = null;
	mls.lookahead_start = channel.loop_end < 16 ? channel.loop_start : Math.max(channel.loop_start, channel.loop_end - 16);
	if (channel.ptr_sample && (channel.flags & 2)) {
		const pins = channel.ptr_sample;
		const offset = ((channel.flags & 8) ? 7 : 3) * 16 + pins.length - channel.loop_end;
		mls.lookahead_ptr = { data: mls.smp_ptr, byteOffset: offset * ((pins.flags & 64) ? 2 : 1) * ((pins.flags & 1) ? 2 : 1) };
	}
}
export function mix_loop_state_init(mls, chan) {
	if (!chan.current_sample_data) return;
	mix_loop_state_update_lookahead_ptrs(mls, chan);
	const inv = chan.increment.v < 0n ? -chan.increment.v : chan.increment.v;
	mls.maxsamples = Math.max(2, Math.trunc(16384 / (Number(inv >> 32n) + 1)));
}

// Shared implementation of the C nearest/linear mono/stereo 8/16-bit kernels.
// Spline/FIR kernels will use the upstream lookup tables in a later block.
export function mix_kernel(channel, buffer, start, frames, mode = 0, ramp = false, filter = false) {
	if (mode < 0 || mode > 3) throw new RangeError('Invalid interpolation mode');
	const bits = channel.flags & 1 ? 16 : 8, stereo = channel.flags & 64 ? 1 : 0, channels = stereo + 1;
	const pointer = channel.current_sample_data;
	const data = pointer.data || pointer, offset = pointer.byteOffset || 0;
	// Typed view over the whole padded allocation so negative indexes reach the
	// pre-padding exactly like the C pointer arithmetic does.
	const mem = bits === 16 ? (data._i16 || (data._i16 = new Int16Array(data.buffer)))
		: (data._i8 || (data._i8 = new Int8Array(data.buffer)));
	const base = (data.byteOffset + offset) / (bits >> 3);
	const shift8 = 16 - bits, lshift = bits - 8, tapshift = bits === 8 ? 6 : 14;
	const pv = channel.position.v, iv = channel.increment.v;
	let hi = Number(pv >> 32n), lo = Number(pv & 0xffffffffn);
	const ihi = Number(iv >> 32n), ilo = Number(iv & 0xffffffffn);
	let maximum = channel.vu_meter >>> 0;
	let leftRamp = channel.left_ramp_volume | 0, rightRamp = channel.right_ramp_volume | 0;
	const lr = channel.left_ramp | 0, rr = channel.right_ramp | 0;
	const lvol = channel.left_volume | 0, rvol = channel.right_volume | 0;
	const a0 = channel.filter_a0, b0 = channel.filter_b0, b1 = channel.filter_b1;
	let fy = null, f00 = 0, f01 = 0, f10 = 0, f11 = 0;
	if (filter) { fy = channel.filter_y; f00 = fy[0][0]; f01 = fy[0][1]; f10 = fy[1][0]; f11 = fy[1][1]; }
	const spline = cubic_spline_lut, fir = windowed_fir_lut;
	let l = 0, r = 0, p = 0, idx = 0, s0 = 0, sum = 0, h1 = 0, h2 = 0;
	for (let frame = 0, out = start; frame < frames; frame++, out += 2) {
		for (let c = 0; c <= stereo; c++) {
			p = base + hi * channels + c;
			if (mode === 0) s0 = mem[p] << shift8;
			else if (mode === 1) { s0 = mem[p]; s0 = (s0 << shift8) + (Math.imul(lo >>> 24, mem[p + channels] - s0) >> lshift); }
			else if (mode === 2) {
				idx = (lo >>> 20) & 4092; p -= channels;
				sum = Math.imul(spline[idx], mem[p]);
				sum = (sum + Math.imul(spline[idx + 1], mem[p + channels])) | 0;
				sum = (sum + Math.imul(spline[idx + 2], mem[p + 2 * channels])) | 0;
				sum = (sum + Math.imul(spline[idx + 3], mem[p + 3 * channels])) | 0;
				s0 = sum >> tapshift;
			} else {
				idx = (((lo >>> 16) + 8) >> 2) & 32760; p -= 3 * channels;
				h1 = Math.imul(fir[idx], mem[p]);
				h1 = (h1 + Math.imul(fir[idx + 1], mem[p + channels])) | 0;
				h1 = (h1 + Math.imul(fir[idx + 2], mem[p + 2 * channels])) | 0;
				h1 = (h1 + Math.imul(fir[idx + 3], mem[p + 3 * channels])) | 0;
				h2 = Math.imul(fir[idx + 4], mem[p + 4 * channels]);
				h2 = (h2 + Math.imul(fir[idx + 5], mem[p + 5 * channels])) | 0;
				h2 = (h2 + Math.imul(fir[idx + 6], mem[p + 6 * channels])) | 0;
				h2 = (h2 + Math.imul(fir[idx + 7], mem[p + 7 * channels])) | 0;
				s0 = (((h1 >> 1) + (h2 >> 1)) | 0) >> tapshift;
			}
			if (c) r = s0; else l = s0;
		}
		if (!stereo) r = l;
		if (filter) {
			let y0 = f00 < -65536 ? -65536 : f00 > 65534 ? 65534 : f00;
			let y1 = f01 < -65536 ? -65536 : f01 > 65534 ? 65534 : f01;
			let res = Math.floor((l * a0 + y0 * b0 + y1 * b1 + 8388608) / 16777216) | 0;
			f01 = f00; f00 = res; l = res;
			if (stereo) {
				y0 = f10 < -65536 ? -65536 : f10 > 65534 ? 65534 : f10;
				y1 = f11 < -65536 ? -65536 : f11 > 65534 ? 65534 : f11;
				res = Math.floor((r * a0 + y0 * b0 + y1 * b1 + 8388608) / 16777216) | 0;
				f11 = f10; f10 = res; r = res;
			} else r = l;
		}
		let lx, rx;
		if (ramp) {
			leftRamp = (leftRamp + lr) | 0; rightRamp = (rightRamp + rr) | 0;
			lx = Math.imul(l, rightRamp >> 12); rx = Math.imul(r, leftRamp >> 12);
		} else { lx = Math.imul(l, rvol); rx = Math.imul(r, lvol); }
		buffer[out] = (buffer[out] + lx) | 0; buffer[out + 1] = (buffer[out + 1] + rx) | 0;
		const average = Math.floor(((lx < 0 ? -lx : lx) + (rx < 0 ? -rx : rx)) / 2);
		if (average > maximum) maximum = average;
		lo += ilo; hi += ihi;
		if (lo >= 4294967296) { lo -= 4294967296; hi++; }
	}
	if (filter) { fy[0][0] = f00; fy[0][1] = f01; fy[1][0] = f10; fy[1][1] = f11; }
	channel.vu_meter = maximum; channel.position = { v: (BigInt(hi) << 32n) | BigInt(lo) };
	if (ramp) {
		channel.left_ramp_volume = leftRamp; channel.right_ramp_volume = rightRamp;
		channel.left_volume = leftRamp >> 12; channel.right_volume = rightRamp >> 12;
	}
}

export function csf_create_stereo_mix(csf, count) {
	if (!count) return 0;
	let used = 0, mixed = 0;
	if (csf.multi_write) for (let n = 0; n < 64; n++) csf.multi_write[n].buffer.fill(0);
	for (let nchan = 0; nchan < csf.num_voices; nchan++) {
		const channel = csf.voices[csf.voice_mix[nchan]];
		if ((!channel.current_sample_data || !channel.ptr_sample) && !channel.lofs && !channel.rofs) continue;
		let buffer = csf.mix_buffer;
		if (csf.multi_write) {
			const master = csf.voice_mix[nchan] < 64 ? csf.voice_mix[nchan] : channel.master_channel - 1;
			buffer = csf.multi_write[master].buffer; csf.multi_write[master].used = 1;
		}
		used++;
		let remaining = count, offset = 0, added = 0;
		const state = {}; mix_loop_state_init(state, channel);
		channel.vu_meter = (channel.vu_meter << 16) >>> 0;
		do {
			const rampSamples = channel.ramp_length > 0 ? Math.min(remaining, channel.ramp_length) : remaining;
			const samples = channel.flags & 0x20000000 ? 1 : get_sample_count(state, channel, rampSamples);
			if (samples <= 0) {
				Object.assign(channel, {current_sample_data:null,length:0,position:{v:0n},ramp_length:0});
				app.end_channel_ofs(channel, buffer.subarray(offset), remaining);
				csf.dry_rofs_vol = (csf.dry_rofs_vol + channel.rofs) | 0;
				csf.dry_lofs_vol = (csf.dry_lofs_vol + channel.lofs) | 0;
				channel.rofs = channel.lofs = 0; channel.flags &= ~128; break;
			}
			if ((mixed >= csf.max_voices && !(csf.mix_flags & 0x10000)) || (!channel.ramp_length && !(channel.left_volume | channel.right_volume))) {
				const length = {v:wrap(channel.increment.v * BigInt(samples))};
				if (!(channel.flags & 0x20000000)) app.fake_vu_meter(channel, samples, length);
				channel.position = {v:wrap(channel.position.v + length.v)};
				channel.rofs = channel.lofs = 0; offset += samples * 2;
			} else if (!(channel.flags & 0x20000000)) {
				const end = offset + samples * 2;
				channel.rofs = -buffer[end-2]; channel.lofs = -buffer[end-1];
				mix_kernel(channel, buffer, offset, samples, channel.flags & 0x1000 ? 0 : csf.mix_interpolation, !!channel.ramp_length, !!(channel.flags & 0x4000));
				channel.rofs = (channel.rofs + buffer[end-2]) | 0; channel.lofs = (channel.lofs + buffer[end-1]) | 0;
				offset = end; added = 1;
			}
			remaining -= samples;
			if (channel.ramp_length) {
				if (channel.ramp_length <= samples) {
					channel.ramp_length = 0; channel.right_volume = channel.right_volume_new; channel.left_volume = channel.left_volume_new;
					channel.right_ramp = channel.left_ramp = 0;
					if ((channel.flags & 0x400) && !channel.fadeout_volume) { channel.length = 0; channel.current_sample_data = null; }
				} else channel.ramp_length -= samples;
			}
		} while (remaining > 0);
		channel.current_sample_data = state.smp_ptr;
		channel.vu_meter = Math.min(255, channel.vu_meter >>> 16); mixed += added;
	}
	app.GM_IncrementSongCounter(csf, count); app.Fmdrv_Mix(csf, count);
	return used;
}
provide({ csf_create_stereo_mix });

export function fake_vu_meter(channel, smpcount, len) {
	const bits = channel.flags & 1 ? 16 : 8, bytes = bits / 8;
	const pointer = channel.current_sample_data, data = pointer.data || pointer;
	const view = new DataView(data.buffer);
	let offset = data.byteOffset + (pointer.byteOffset || 0) + Number(channel.position.v >> 32n) * bytes;
	const length = Number(len.v >> 32n);
	if (length < 0) offset -= length * bytes;
	const count = Math.abs(length) * bytes;
	const stereo = !!(channel.flags & 64), stride = stereo ? 2 : 1;
	const mins = [bits === 16 ? 32767 : 127, bits === 16 ? 32767 : 127];
	const maxs = [bits === 16 ? -32768 : -128, bits === 16 ? -32768 : -128];
	// the C reads freely past the sample end here; clamp to the allocation instead
	const lo = Math.max(0, offset), hi = Math.min(view.byteLength - bytes, offset + (count - 1) * bytes);
	for (let i = 0; i < count; i++) {
		const at = offset + i * bytes;
		if (at < lo || at > hi) continue;
		const value = bits === 16 ? view.getInt16(at, true) : view.getInt8(at);
		const c = i % stride; mins[c] = Math.min(mins[c], value); maxs[c] = Math.max(maxs[c], value);
	}
	// Preserve upstream's documented approximate stereo meter and its use of
	// the minimum for both left extrema (also both mono extrema).
	const left = Math.abs(mins[0] << (23 - bits)) >>> 0;
	const right = stereo ? Math.max(Math.abs(mins[1] << (23 - bits)), Math.abs(maxs[1] << (23 - bits))) >>> 0 : left;
	const l = Math.imul(left, channel.right_volume_new) >>> 0;
	const r = Math.imul(right, channel.left_volume_new) >>> 0;
	let peak = Math.floor((l + r) / 2) >>> 0;
	peak = peak & 0x80000000 ? 0xffffffff : (peak << 1) >>> 0;
	channel.vu_meter = Math.max(channel.vu_meter >>> 0, peak >>> 8);
}
provide({ fake_vu_meter });

function resample_fir(oldbuf,newbuf,oldlen,newlen,bits,channels) {
	if (!Number.isInteger(newlen) || newlen <= 0 || !Number.isInteger(oldlen) || oldlen <= 0) throw new RangeError('Resampling requires positive lengths');
	const channel = { flags:(bits===16?1:0)|(channels===2?64:0),current_sample_data:oldbuf,
		position:{v:0n},increment:{v:(BigInt(oldlen|0)<<32n)/BigInt(newlen>>>0)},
		vu_meter:0,left_volume:1,right_volume:1 };
	const buffer=new Int32Array(newlen*2);
	mix_kernel(channel,buffer,0,newlen,3);
	const minimum=bits===8?-128:-32768,maximum=bits===8?127:32767;
	for(let i=0;i<newlen;i++)for(let c=0;c<channels;c++)
		newbuf[i*channels+c]=Math.max(minimum,Math.min(maximum,buffer[i*2+c]>>(bits===8?8:0)));
}
export function ResampleMono8BitFirFilter(oldbuf,newbuf,oldlen,newlen){resample_fir(oldbuf,newbuf,oldlen,newlen,8,1);}
export function ResampleMono16BitFirFilter(oldbuf,newbuf,oldlen,newlen){resample_fir(oldbuf,newbuf,oldlen,newlen,16,1);}
export function ResampleStereo8BitFirFilter(oldbuf,newbuf,oldlen,newlen){resample_fir(oldbuf,newbuf,oldlen,newlen,8,2);}
export function ResampleStereo16BitFirFilter(oldbuf,newbuf,oldlen,newlen){resample_fir(oldbuf,newbuf,oldlen,newlen,16,2);}
provide({ResampleMono8BitFirFilter,ResampleMono16BitFirFilter,ResampleStereo8BitFirFilter,ResampleStereo16BitFirFilter});
