// fmt/mmcmp.c: ziRCONia MMCMP module unpacker (Schism Tracker, GPL-2.0-or-later).
// mmcmp_unpack(bytes) returns the unpacked file, or null if it isn't MMCMP data.

const mm_8bit_commands = [0x01, 0x03, 0x07, 0x0f, 0x1e, 0x3c, 0x78, 0xf8];
const mm_8bit_fetch = [3, 3, 3, 3, 2, 1, 0, 0];
const mm_16bit_commands = [0x0001, 0x0003, 0x0007, 0x000f, 0x001e, 0x003c, 0x0078, 0x00f0,
	0x01f0, 0x03f0, 0x07f0, 0x0ff0, 0x1ff0, 0x3ff0, 0x7ff0, 0xfff0];
const mm_16bit_fetch = [4, 4, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const MM_COMP = 1, MM_DELTA = 2, MM_16BIT = 4, MM_ABS16 = 0x200;

export function mmcmp_unpack(b) {
	if (b.length < 256) return null;
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	const u16 = o => dv.getUint16(o, true), u32 = o => dv.getUint32(o, true);
	let magic = ''; for (let i = 0; i < 8; i++) magic += String.fromCharCode(b[i]);
	const hdrsize = u16(8), blocks = u16(12), filesize = u32(14), blktable = u32(18);
	if (magic !== 'ziRCONia' || hdrsize < 14 || blocks === 0 || filesize < 16 || filesize > 0x8000000
		|| blktable + 4 * blocks > b.length) return null;
	const buffer = new Uint8Array((filesize + 31) & ~15);
	for (let block = 0; block < blocks; block++) {
		let p = u32(blktable + 4 * block);
		if (p + 20 > b.length) return null;
		const unpk_size = u32(p), pk_size = u32(p + 4), sub_blk = u16(p + 12), flags = u16(p + 14);
		const tt_entries = u16(p + 16), num_bits = u16(p + 18);
		void unpk_size;
		p += 20;
		if (p + 8 * sub_blk > b.length) return null;
		const sub = [];
		for (let i = 0; i < sub_blk; i++) sub.push({ pos: u32(p + 8 * i), size: u32(p + 8 * i + 4) });
		p += 8 * sub_blk;
		if (!(flags & MM_COMP)) {
			for (const s of sub) {
				if (s.pos > filesize || s.pos + s.size > filesize) break;
				if (p + s.size > b.length) return null;
				buffer.set(b.subarray(p, p + s.size), s.pos);
				p += s.size;
			}
			continue;
		}
		const ptable = new Uint8Array(256);
		ptable.set(b.subarray(p, Math.min(p + 256, b.length)));
		const buflen = pk_size - tt_entries;
		const src = p + tt_entries;
		if (buflen < 0 || src + buflen > b.length) return null;
		let bits = 0, bitbuf = 0, sp = src;
		const end = src + buflen;
		const get_bits = n => {
			if (!n) return 0;
			while (bits < 24) { bitbuf = (bitbuf | ((sp < end ? b[sp++] : 0) << bits)) >>> 0; bits += 8; }
			const d = bitbuf & ((1 << n) - 1);
			bitbuf >>>= n; bits -= n;
			return d;
		};
		let subblk = 0, destpos = 0, numbits = num_bits, oldval = 0;
		if (flags & MM_16BIT) {
			let dest = sub[0].pos, size = sub[0].size >> 1;
			while (subblk < sub_blk) {
				let newval = 0x10000;
				let d = get_bits(numbits + 1);
				if (d >= mm_16bit_commands[numbits]) {
					const fetch = mm_16bit_fetch[numbits];
					const newbits = get_bits(fetch) + ((d - mm_16bit_commands[numbits]) << fetch);
					if (newbits !== numbits) numbits = newbits & 0x0f;
					else if ((d = get_bits(4)) === 0x0f) { if (get_bits(1)) break; newval = 0xffff; }
					else newval = 0xfff0 + d;
				} else newval = d;
				if (newval < 0x10000) {
					newval = (newval & 1) ? (-((newval + 1) >> 1)) >>> 0 : newval >>> 1;
					if (flags & MM_DELTA) { newval = (newval + oldval) >>> 0; oldval = newval; }
					else if (!(flags & MM_ABS16)) newval = (newval ^ 0x8000) >>> 0;
					const o = dest + 2 * destpos++;
					if (o + 1 < buffer.length) { buffer[o] = newval & 0xff; buffer[o + 1] = (newval >> 8) & 0xff; }
				}
				if (destpos >= size) {
					if (++subblk >= sub_blk) break;
					destpos = 0; size = sub[subblk].size >> 1; dest = sub[subblk].pos;
				}
			}
		} else {
			let dest = sub[0].pos, size = sub[0].size;
			while (subblk < sub_blk) {
				let newval = 0x100;
				let d = get_bits(numbits + 1);
				if (d >= mm_8bit_commands[numbits]) {
					const fetch = mm_8bit_fetch[numbits];
					const newbits = get_bits(fetch) + ((d - mm_8bit_commands[numbits]) << fetch);
					if (newbits !== numbits) numbits = newbits & 0x07;
					else if ((d = get_bits(3)) === 7) { if (get_bits(1)) break; newval = 0xff; }
					else newval = 0xf8 + d;
				} else newval = d;
				if (newval < 0x100) {
					let n = ptable[newval];
					if (flags & MM_DELTA) { n += oldval; oldval = n; }
					if (dest + destpos < buffer.length) buffer[dest + destpos] = n & 0xff;
					destpos++;
				}
				if (destpos >= size) {
					if (++subblk >= sub_blk) break;
					destpos = 0; size = sub[subblk].size; dest = sub[subblk].pos;
				}
			}
		}
	}
	return buffer.subarray(0, filesize);
}

// slurp.c's decompression step: gzip (via the browser) then MMCMP.
export async function slurp_unpack(data) {
	let d = data;
	if (d.length > 18 && d[0] === 0x1f && d[1] === 0x8b && typeof DecompressionStream !== 'undefined') {
		try {
			const s = new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'));
			d = new Uint8Array(await new Response(s).arrayBuffer());
		} catch { d = data; }
	}
	return mmcmp_unpack(d) || (d !== data ? d : null);
}
