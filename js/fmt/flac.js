// FLAC for fmt/flac.c (Schism Tracker, GPL-2.0-or-later). Upstream links libFLAC;
// the browser has no encoder and its decoder (decodeAudioData) drops the
// metadata Schism stores loops in, so both directions are implemented here.
//
// Metadata as upstream writes and reads it: STREAMINFO, APPLICATION "riff"
// blocks holding a WAV "xtra" and "smpl" chunk, and a VORBIS_COMMENT with
// SAMPLERATE / ENCODER / TITLE (LOOPSTART / LOOPLENGTH are also read).

// ---------------------------------------------------------------------------
// CRCs

const CRC8 = new Uint8Array(256), CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let j = 0; j < 8; j++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
	CRC8[i] = c;
	let d = i << 8;
	for (let j = 0; j < 8; j++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
	CRC16[i] = d;
}
const crc8 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = CRC8[c ^ b[i]]; return c; };
const crc16 = (b, s, e) => { let c = 0; for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]]; return c; };

// ---------------------------------------------------------------------------
// encoder

class BitWriter {
	constructor(size) { this.buf = new Uint8Array(Math.max(256, size)); this.pos = 0; this.acc = 0; this.n = 0; }
	grow(extra) {
		if (this.pos + extra + 8 <= this.buf.length) return;
		let s = this.buf.length; while (s < this.pos + extra + 8) s *= 2;
		const b = new Uint8Array(s); b.set(this.buf.subarray(0, this.pos)); this.buf = b;
	}
	bits(v, n) { // n <= 32, v unsigned (negative values must be masked by the caller)
		if (n > 24) { this.bits(Math.floor(v / 0x1000000) & ((1 << (n - 24)) - 1), n - 24); v &= 0xffffff; n = 24; }
		this.acc = (this.acc * (1 << n)) + (v & ((1 << n) - 1)); this.n += n;
		while (this.n >= 8) {
			this.n -= 8;
			if (this.pos >= this.buf.length) this.grow(1);
			this.buf[this.pos++] = Math.floor(this.acc / (1 << this.n)) & 0xff;
		}
		this.acc &= (1 << this.n) - 1;
	}
	signed(v, n) { this.bits(v < 0 ? v + 2 ** n : v, n); }
	unary0(q) { // q zero bits then a one
		while (q >= 24) { this.bits(0, 24); q -= 24; }
		this.bits(1, q + 1);
	}
	align() { if (this.n) this.bits(0, 8 - this.n); }
	bytes(arr) { this.align(); this.grow(arr.length); this.buf.set(arr, this.pos); this.pos += arr.length; }
	u8(v) { this.bits(v & 0xff, 8); }
	result() { return this.buf.slice(0, this.pos); }
}

const zz = r => r >= 0 ? r * 2 : -r * 2 - 1;

// residuals of the fixed predictors (orders 0..4) for samples[start..end)
function fixed_residual(x, order, out) {
	const n = x.length;
	for (let i = order; i < n; i++) {
		let p;
		switch (order) {
		case 0: p = 0; break;
		case 1: p = x[i - 1]; break;
		case 2: p = 2 * x[i - 1] - x[i - 2]; break;
		case 3: p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3]; break;
		default: p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
		}
		out[i] = x[i] - p;
	}
}
// best Rice partitioning for residual[order..n): returns { bits, porder, params }
function rice_plan(res, n, order) {
	let best = null;
	const max_porder = Math.min(8, 31 - Math.clz32(n & -n)); // partitions must divide the block
	for (let po = 0; po <= max_porder; po++) {
		const parts = 1 << po, psize = n >> po;
		if (psize <= order) break;
		let bits = 0;
		const params = [];
		for (let p = 0; p < parts; p++) {
			const s = p ? p * psize : order, e = (p + 1) * psize;
			let sum = 0;
			for (let i = s; i < e; i++) sum += zz(res[i]);
			const cnt = e - s;
			let k = cnt && sum > cnt ? Math.floor(Math.log2(sum / cnt)) : 0;
			let bk = -1, bb = Infinity;
			for (let kk = Math.max(0, k - 1); kk <= Math.min(14, k + 1); kk++) {
				let b = 4 + cnt * (kk + 1);
				for (let i = s; i < e; i++) b += Math.floor(zz(res[i]) / (1 << kk));
				if (b < bb) { bb = b; bk = kk; }
			}
			bits += bb; params.push(bk);
		}
		bits += 6; // method + partition order
		if (!best || bits < best.bits) best = { bits, porder: po, params };
	}
	return best;
}
// choose a subframe for one channel; returns { bits, write(bw) }
function plan_subframe(x, bps) {
	const n = x.length;
	let constant = true;
	for (let i = 1; i < n && constant; i++) if (x[i] !== x[0]) constant = false;
	if (constant) return { bits: 8 + bps, write: bw => { bw.bits(0, 8); bw.signed(x[0], bps); } };
	let best = { bits: 8 + n * bps, write: bw => { bw.bits(1 << 1, 8); for (let i = 0; i < n; i++) bw.signed(x[i], bps); } };
	const res = new Int32Array(n);
	for (let order = 0; order <= 4 && order < n; order++) {
		fixed_residual(x, order, res);
		const plan = rice_plan(res, n, order);
		if (!plan) continue;
		const bits = 8 + order * bps + plan.bits;
		if (bits < best.bits) {
			const r = res.slice();
			best = { bits, write: bw => {
				bw.bits((0x08 | order) << 1, 8);
				for (let i = 0; i < order; i++) bw.signed(x[i], bps);
				bw.bits(0, 2); bw.bits(plan.porder, 4);
				const psize = n >> plan.porder;
				plan.params.forEach((k, p) => {
					bw.bits(k, 4);
					const s = p ? p * psize : order, e = (p + 1) * psize;
					for (let i = s; i < e; i++) {
						const u = zz(r[i]);
						bw.unary0(Math.floor(u / (1 << k)));
						if (k) bw.bits(u & ((1 << k) - 1), k);
					}
				});
			} };
		}
	}
	return best;
}
function utf8_number(v) {
	if (v < 0x80) return [v];
	const out = [];
	let n = v < 0x800 ? 2 : v < 0x10000 ? 3 : v < 0x200000 ? 4 : v < 0x4000000 ? 5 : 6;
	for (let i = n - 1; i > 0; i--) { out.unshift(0x80 | (v & 0x3f)); v = Math.floor(v / 64); }
	out.unshift(((0xff00 >> n) & 0xff) | v);
	return out;
}

// channels: array of Int32Array (one per channel, same length); bps 8, 16 or 24
// meta: [{ type, data: Uint8Array }] extra metadata blocks after STREAMINFO
export function flac_encode(channels, bps, rate, meta = []) {
	const nch = channels.length, total = channels[0].length, BS = 4096;
	const bw = new BitWriter(total * nch * (bps >> 3) / 2 + 1024);
	bw.bytes([0x66, 0x4c, 0x61, 0x43]); // fLaC
	const blocks = [{ type: 0, data: null }, ...meta];
	const si_pos = [];
	blocks.forEach((m, i) => {
		const last = i === blocks.length - 1 ? 0x80 : 0;
		const len = m.type === 0 ? 34 : m.data.length;
		bw.bytes([last | m.type, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
		if (m.type === 0) { si_pos.push(bw.pos); bw.bytes(new Uint8Array(34)); }
		else bw.bytes(m.data);
	});
	let min_frame = 0xffffff, max_frame = 0, frame_no = 0;
	for (let start = 0; start < total; start += BS, frame_no++) {
		const n = Math.min(BS, total - start);
		const x = channels.map(c => c.subarray(start, start + n));
		// stereo decorrelation: independent, left/side, right/side or mid/side, whichever is smallest
		let assign = nch - 1, subs = x.map(c => plan_subframe(c, bps));
		if (nch === 2) {
			const side = new Int32Array(n), mid = new Int32Array(n);
			for (let i = 0; i < n; i++) { side[i] = x[0][i] - x[1][i]; mid[i] = (x[0][i] + x[1][i]) >> 1; }
			const ps = plan_subframe(side, bps + 1), pm = plan_subframe(mid, bps);
			const options = [
				[1, subs[0].bits + subs[1].bits, subs],
				[8, subs[0].bits + ps.bits, [subs[0], ps]],
				[9, ps.bits + subs[1].bits, [ps, subs[1]]],
				[10, pm.bits + ps.bits, [pm, ps]],
			];
			options.sort((a, b) => a[1] - b[1]);
			assign = options[0][0]; subs = options[0][2];
		}
		bw.align();
		const fstart = bw.pos;
		bw.bits(0x3ffe, 14); bw.bits(0, 1); bw.bits(0, 1); // sync, reserved, fixed blocking
		bw.bits(7, 4); // block size: 16-bit field follows
		bw.bits(0, 4); // sample rate: from STREAMINFO
		bw.bits(assign, 4);
		bw.bits(bps === 8 ? 1 : bps === 16 ? 4 : 6, 3); bw.bits(0, 1);
		for (const b of utf8_number(frame_no)) bw.u8(b);
		bw.bits(n - 1, 16);
		bw.u8(crc8(bw.buf, fstart, bw.pos));
		subs.forEach(s => s.write(bw));
		bw.align();
		const c16 = crc16(bw.buf, fstart, bw.pos);
		bw.u8(c16 >> 8); bw.u8(c16);
		const flen = bw.pos - fstart;
		min_frame = Math.min(min_frame, flen); max_frame = Math.max(max_frame, flen);
	}
	const out = bw.result();
	// STREAMINFO
	const si = new BitWriter(34);
	si.bits(BS, 16); si.bits(BS, 16); // nominal block size; the last block may be shorter
	si.bits(total ? min_frame : 0, 24); si.bits(max_frame, 24);
	si.bits(rate, 20); si.bits(nch - 1, 3); si.bits(bps - 1, 5);
	si.bits(Math.floor(total / 2 ** 32) & 0xf, 4); si.bits(total >>> 0, 32);
	for (let i = 0; i < 16; i++) si.u8(0); // MD5 unknown
	out.set(si.result(), si_pos[0]);
	return out;
}

// ---------------------------------------------------------------------------
// decoder

class BitReader {
	constructor(d, pos) { this.d = d; this.pos = pos; this.bit = 0; }
	bits(n) {
		let v = 0;
		while (n > 0) {
			if (this.pos >= this.d.length) throw new Error('flac: truncated');
			const avail = 8 - this.bit, take = Math.min(avail, n);
			const b = (this.d[this.pos] >> (avail - take)) & ((1 << take) - 1);
			v = v * (1 << take) + b;
			this.bit += take; n -= take;
			if (this.bit === 8) { this.bit = 0; this.pos++; }
		}
		return v;
	}
	signed(n) { const v = this.bits(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
	unary() {
		let q = 0;
		for (;;) {
			if (this.pos >= this.d.length) throw new Error('flac: truncated');
			const rest = (this.d[this.pos] << this.bit) & 0xff;
			if (rest) { const z = Math.clz32(rest) - 24; q += z; this.bit += z + 1; if (this.bit >= 8) { this.bit -= 8; this.pos++; } return q; }
			q += 8 - this.bit; this.bit = 0; this.pos++;
		}
	}
	align() { if (this.bit) { this.bit = 0; this.pos++; } }
}
function utf8_read(br) {
	const b = br.bits(8);
	if (b < 0x80) return b;
	let n = 0, v;
	if ((b & 0xe0) === 0xc0) { n = 1; v = b & 0x1f; }
	else if ((b & 0xf0) === 0xe0) { n = 2; v = b & 0x0f; }
	else if ((b & 0xf8) === 0xf0) { n = 3; v = b & 0x07; }
	else if ((b & 0xfc) === 0xf8) { n = 4; v = b & 0x03; }
	else if ((b & 0xfe) === 0xfc) { n = 5; v = b & 0x01; }
	else if (b === 0xfe) { n = 6; v = 0; }
	else throw new Error('flac: bad frame number');
	for (let i = 0; i < n; i++) v = v * 64 + (br.bits(8) & 0x3f);
	return v;
}
function read_residual(br, out, n, order) {
	const method = br.bits(2);
	if (method > 1) throw new Error('flac: reserved residual coding');
	const pbits = method ? 5 : 4, esc = method ? 31 : 15;
	const porder = br.bits(4), parts = 1 << porder, psize = n >> porder;
	if ((psize << porder) !== n || psize < order) throw new Error('flac: bad partition order');
	let i = order;
	for (let p = 0; p < parts; p++) {
		const k = br.bits(pbits), end = (p + 1) * psize;
		if (k === esc) {
			const nb = br.bits(5);
			for (; i < end; i++) out[i] = nb ? br.signed(nb) : 0;
		} else {
			for (; i < end; i++) {
				const u = br.unary() * (1 << k) + (k ? br.bits(k) : 0);
				out[i] = u & 1 ? -((u + 1) / 2) : u / 2;
			}
		}
	}
}
function read_subframe(br, n, bps) {
	if (br.bits(1)) throw new Error('flac: bad subframe padding');
	const type = br.bits(6);
	let wasted = 0;
	if (br.bits(1)) { wasted = 1; while (!br.bits(1)) wasted++; }
	bps -= wasted;
	const out = new Float64Array(n); // exact for the 32-bit-plus sums LPC needs
	if (type === 0) { out.fill(br.signed(bps)); }
	else if (type === 1) { for (let i = 0; i < n; i++) out[i] = br.signed(bps); }
	else if (type >= 8 && type <= 12) {
		const order = type - 8;
		for (let i = 0; i < order; i++) out[i] = br.signed(bps);
		read_residual(br, out, n, order);
		for (let i = order; i < n; i++) {
			switch (order) {
			case 1: out[i] += out[i - 1]; break;
			case 2: out[i] += 2 * out[i - 1] - out[i - 2]; break;
			case 3: out[i] += 3 * out[i - 1] - 3 * out[i - 2] + out[i - 3]; break;
			case 4: out[i] += 4 * out[i - 1] - 6 * out[i - 2] + 4 * out[i - 3] - out[i - 4]; break;
			}
		}
	} else if (type >= 32) {
		const order = type - 31;
		for (let i = 0; i < order; i++) out[i] = br.signed(bps);
		const prec = br.bits(4) + 1;
		if (prec === 16) throw new Error('flac: bad LPC precision');
		const shift = br.signed(5), coefs = [];
		for (let i = 0; i < order; i++) coefs.push(br.signed(prec));
		read_residual(br, out, n, order);
		const div = 2 ** shift;
		for (let i = order; i < n; i++) {
			let sum = 0;
			for (let j = 0; j < order; j++) sum += coefs[j] * out[i - 1 - j];
			out[i] += Math.floor(sum / div);
		}
	} else throw new Error('flac: reserved subframe type');
	if (wasted) for (let i = 0; i < n; i++) out[i] *= 2 ** wasted;
	return out;
}
const BS_TABLE = [0, 192, 576, 1152, 2304, 4608, -8, -16, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const RATE_TABLE = [0, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000];
const BPS_TABLE = [0, 8, 12, 0, 16, 20, 24, 32];

// returns { rate, channels, bps, total, meta: [{type, data}], pcm: [Float64Array per channel] } or null
export function flac_decode(b, meta_only = false) {
	if (b.length < 42 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null;
	let pos = 4, info = null;
	const meta = [];
	for (;;) {
		if (pos + 4 > b.length) return null;
		const hdr = b[pos], len = (b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3];
		const data = b.subarray(pos + 4, pos + 4 + len);
		if ((hdr & 0x7f) === 0) {
			const br = new BitReader(data, 0);
			br.bits(16); const max_block = br.bits(16); br.bits(24); br.bits(24);
			info = { max_block, rate: br.bits(20), channels: br.bits(3) + 1, bps: br.bits(5) + 1, total: br.bits(4) * 2 ** 32 + br.bits(32) };
		} else meta.push({ type: hdr & 0x7f, data });
		pos += 4 + len;
		if (hdr & 0x80) break;
	}
	if (!info) return null;
	const result = { ...info, meta, pcm: null };
	if (meta_only) return result;
	const total = info.total, nch = info.channels;
	const pcm = Array.from({ length: nch }, () => new Float64Array(total));
	const br = new BitReader(b, pos);
	let done = 0;
	while (done < total && br.pos + 2 < b.length) {
		// find the next frame sync
		br.align();
		if (b[br.pos] !== 0xff || (b[br.pos + 1] & 0xfe) !== 0xf8) { br.pos++; continue; }
		const fstart = br.pos;
		br.bits(15); const variable = br.bits(1);
		const bsc = br.bits(4), src = br.bits(4), ch = br.bits(4), ssc = br.bits(3); br.bits(1);
		const num = utf8_read(br);
		let n = BS_TABLE[bsc];
		if (n === -8) n = br.bits(8) + 1; else if (n === -16) n = br.bits(16) + 1;
		if (src === 12) br.bits(8); else if (src === 13 || src === 14) br.bits(16);
		br.bits(8); // CRC-8
		if (!n) throw new Error('flac: reserved block size');
		const bps = ssc ? BPS_TABLE[ssc] : info.bps;
		const first = variable ? num : num * (info.max_block || n);
		const sub = [];
		for (let c = 0; c < (ch < 8 ? ch + 1 : 2); c++) {
			const side = (ch === 8 && c === 1) || (ch === 9 && c === 0) || (ch === 10 && c === 1);
			sub.push(read_subframe(br, n, bps + (side ? 1 : 0)));
		}
		if (ch === 8) for (let i = 0; i < n; i++) sub[1][i] = sub[0][i] - sub[1][i];
		else if (ch === 9) for (let i = 0; i < n; i++) sub[0][i] += sub[1][i];
		else if (ch === 10) for (let i = 0; i < n; i++) {
			const s = sub[1][i], m = sub[0][i] * 2 + (s & 1);
			sub[0][i] = (m + s) / 2; sub[1][i] = (m - s) / 2;
		}
		br.align();
		const c16 = br.bits(16);
		if (crc16(b, fstart, br.pos - 2) !== c16) throw new Error('flac: frame CRC mismatch');
		const count = Math.min(n, total - first);
		for (let c = 0; c < nch; c++) pcm[c].set(sub[c].subarray(0, Math.max(0, count)), first);
		done = first + n;
	}
	result.pcm = pcm;
	return result;
}
