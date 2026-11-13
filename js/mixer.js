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
	const bits = channel.flags & 1 ? 16 : 8, channels = channel.flags & 64 ? 2 : 1;
	const pointer = channel.current_sample_data;
	const data = pointer.data || pointer, offset = pointer.byteOffset || 0;
	const view = new DataView(data.buffer);
	const sample = index => {
		const byte = data.byteOffset + offset + index * (bits / 8);
		if (byte < 0 || byte + bits / 8 > view.byteLength) throw new RangeError('Sample padding required for interpolation');
		return bits === 16 ? view.getInt16(byte, true) : view.getInt8(byte);
	};
	let position = channel.position.v, maximum = channel.vu_meter >>> 0;
	let leftRamp = channel.left_ramp_volume | 0, rightRamp = channel.right_ramp_volume | 0;
	const filtered = (value, c) => {
		const y = channel.filter_y[c], clip = n => Math.max(-65536, Math.min(65534, n));
		const result = Number(BigInt.asIntN(32, (BigInt(value) * BigInt(channel.filter_a0) + BigInt(clip(y[0])) * BigInt(channel.filter_b0) + BigInt(clip(y[1])) * BigInt(channel.filter_b1) + 8388608n) >> 24n));
		y[1] = y[0]; y[0] = result; return result;
	};
	for (let frame = 0; frame < frames; frame++) {
		const hi = Number(position >> 32n), lo = Number((position & 0xffffffffn) >> 24n);
		const read = c => {
			const first = sample(hi * channels + c);
			if (mode === 0) return first << (16 - bits);
			if (mode === 1) return (first << (16 - bits)) + (Math.imul(lo, sample((hi + 1) * channels + c) - first) >> (bits - 8));
			if (mode === 2) {
				const index = Number((position >> 20n) & 4092n);
				let sum = 0;
				for (let tap = 0; tap < 4; tap++) sum = (sum + Math.imul(cubic_spline_lut[index + tap], sample((hi + tap - 1) * channels + c))) | 0;
				return sum >> (bits === 8 ? 6 : 14);
			}
			const index = ((Number((position & 0xffffffffn) >> 16n) + 8) >> 2) & 32760;
			let firstHalf = 0, secondHalf = 0;
			for (let tap = 0; tap < 4; tap++) {
				firstHalf = (firstHalf + Math.imul(windowed_fir_lut[index + tap], sample((hi + tap - 3) * channels + c))) | 0;
				secondHalf = (secondHalf + Math.imul(windowed_fir_lut[index + tap + 4], sample((hi + tap + 1) * channels + c))) | 0;
			}
			return (((firstHalf >> 1) + (secondHalf >> 1)) | 0) >> (bits === 8 ? 6 : 14);
		};
		let l = read(0), r = channels === 2 ? read(1) : l;
		if (filter) { l = filtered(l, 0); r = channels === 2 ? filtered(r, 1) : l; }
		if (ramp) { leftRamp = (leftRamp + channel.left_ramp) | 0; rightRamp = (rightRamp + channel.right_ramp) | 0; }
		const lx = Math.imul(l, ramp ? rightRamp >> 12 : channel.right_volume);
		const rx = Math.imul(r, ramp ? leftRamp >> 12 : channel.left_volume);
		const index = start + frame * 2;
		buffer[index] = (buffer[index] + lx) | 0; buffer[index + 1] = (buffer[index + 1] + rx) | 0;
		const average = Math.floor((Math.abs(lx) + Math.abs(rx)) / 2);
		maximum = Math.max(maximum, average);
		position = wrap(position + channel.increment.v);
	}
	channel.vu_meter = maximum; channel.position = { v: position };
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
	for (let i = 0; i < count; i++) {
		const value = bits === 16 ? view.getInt16(offset + i * bytes, true) : view.getInt8(offset + i);
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
