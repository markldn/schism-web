// Port of player/mixutil.c (GPL-2.0-or-later).
import { provide } from './app.js';
export function init_mix_buffer(buffer, samples) { buffer.fill(0, 0, samples); }
// Offset pointers are represented by a shared { rofs, lofs } object.
function decay(buffer, samples, offsets, add) {
	let { rofs, lofs } = offsets;
	for (let i = 0; i < samples; i++) {
		const xr = (rofs + ((-rofs >> 31) & 255)) >> 8;
		const xl = (lofs + ((-lofs >> 31) & 255)) >> 8;
		rofs = (rofs - xr) | 0;
		lofs = (lofs - xl) | 0;
		buffer[i * 2] = add ? (buffer[i * 2] + xr) | 0 : xr;
		buffer[i * 2 + 1] = add ? (buffer[i * 2 + 1] + xl) | 0 : xl;
	}
	offsets.rofs = rofs;
	offsets.lofs = lofs;
}
export function stereo_fill(buffer, samples, offsets) {
	if (!offsets.rofs && !offsets.lofs) init_mix_buffer(buffer, samples * 2);
	else decay(buffer, samples, offsets, false);
}
export function end_channel_ofs(channel, buffer, samples) {
	if (channel.rofs || channel.lofs) decay(buffer, samples, channel, true);
}
export function mono_from_stereo(buffer, samples) {
	for (let i = 0; i < samples; i++) buffer[i] = ((buffer[i * 2] + buffer[i * 2 + 1]) | 0) >> 1;
}
function clip(ptr, buffer, samples, mins, maxs, bits) {
	for (let i = 0; i < samples; i++) {
		let n = Math.max(-0x4000000, Math.min(0x3ffffff, buffer[i]));
		const channel = i & 1;
		if (n < mins[channel]) mins[channel] = n;
		else if (n > maxs[channel]) maxs[channel] = n;
		switch (bits) {
		case 8: ptr[i] = (n >> 19) ^ 128; break;
		case 16: ptr[i] = n >> 11; break;
		case 24:
			n >>= 3;
			ptr[i * 3] = n & 255;
			ptr[i * 3 + 1] = (n >> 8) & 255;
			ptr[i * 3 + 2] = (n >> 16) & 255;
			break;
		case 32: ptr[i] = n << 5; break;
		}
	}
	return samples * (bits / 8);
}
export function clip_32_to_8(ptr, buffer, samples, mins, maxs) { return clip(ptr, buffer, samples, mins, maxs, 8); }
export function clip_32_to_16(ptr, buffer, samples, mins, maxs) { return clip(ptr, buffer, samples, mins, maxs, 16); }
export function clip_32_to_24(ptr, buffer, samples, mins, maxs) { return clip(ptr, buffer, samples, mins, maxs, 24); }
export function clip_32_to_32(ptr, buffer, samples, mins, maxs) { return clip(ptr, buffer, samples, mins, maxs, 32); }
provide({ init_mix_buffer, stereo_fill, end_channel_ofs, mono_from_stereo,
	clip_32_to_8, clip_32_to_16, clip_32_to_24, clip_32_to_32 });
