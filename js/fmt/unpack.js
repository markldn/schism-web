// Decompressors for packed modules: fmt/bzip2.c, fmt/xz.c and fmt/zstd.c wrap
// libbz2 / liblzma / libzstd; the browser has none of them (DecompressionStream
// only knows gzip and deflate), so these are small stand-alone decoders.
// Each returns the unpacked bytes, or null when the data is not in its format
// or is corrupt (the caller then keeps the original bytes, as slurp.c does).

const MAX_OUTPUT = 512 * 1024 * 1024; // refuse anything that grows beyond this

class OutBuf {
	constructor(hint) { this.buf = new Uint8Array(Math.max(1024, hint | 0)); this.len = 0; }
	ensure(n) {
		if (this.len + n <= this.buf.length) return;
		let size = this.buf.length;
		while (size < this.len + n) size *= 2;
		if (size > MAX_OUTPUT) throw new Error('output too large');
		const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.len)); this.buf = b;
	}
	push(v) { if (this.len === this.buf.length) this.ensure(1); this.buf[this.len++] = v; }
	result() { return this.buf.slice(0, this.len); }
}

// ---------------------------------------------------------------------------
// bzip2

class BitReaderBE {
	constructor(data, pos = 0) { this.d = data; this.pos = pos; this.bit = 0; this.cur = 0; }
	bits(n) {
		let v = 0;
		while (n > 0) {
			if (!this.bit) {
				if (this.pos >= this.d.length) throw new Error('bzip2: truncated');
				this.cur = this.d[this.pos++]; this.bit = 8;
			}
			const take = Math.min(n, this.bit);
			v = (v * (1 << take)) + ((this.cur >>> (this.bit - take)) & ((1 << take) - 1));
			this.bit -= take; n -= take;
		}
		return v;
	}
	align() { this.bit = 0; }
}

function bz_huffman(lengths, n) {
	// canonical code: limit/base/perm tables as in the reference decoder
	let minLen = 32, maxLen = 0;
	for (let i = 0; i < n; i++) { minLen = Math.min(minLen, lengths[i]); maxLen = Math.max(maxLen, lengths[i]); }
	const perm = [];
	for (let l = minLen; l <= maxLen; l++) for (let i = 0; i < n; i++) if (lengths[i] === l) perm.push(i);
	const limit = new Int32Array(maxLen + 2), base = new Int32Array(maxLen + 2);
	let code = 0, idx = 0;
	for (let l = minLen; l <= maxLen; l++) {
		let count = 0;
		for (let i = 0; i < n; i++) if (lengths[i] === l) count++;
		base[l] = idx - code; // symbol index = code + base[l]
		code += count; idx += count;
		limit[l] = code - 1;
		code <<= 1;
	}
	return { minLen, maxLen, limit, base, perm };
}
function bz_decode_sym(br, h) {
	let l = h.minLen, code = br.bits(l);
	while (l <= h.maxLen) {
		if (code <= h.limit[l]) return h.perm[code + h.base[l]];
		code = (code << 1) | br.bits(1);
		l++;
	}
	throw new Error('bzip2: bad huffman code');
}

export function bunzip2(data) {
	if (data.length < 14 || data[0] !== 0x42 || data[1] !== 0x5a || data[2] !== 0x68 || data[3] < 0x31 || data[3] > 0x39) return null;
	try {
		const out = new OutBuf(data.length * 4);
		let pos = 0;
		while (pos + 4 <= data.length && data[pos] === 0x42 && data[pos + 1] === 0x5a && data[pos + 2] === 0x68) {
			const blockMax = (data[pos + 3] - 0x30) * 100000;
			const br = new BitReaderBE(data, pos + 4);
			for (;;) {
				const m1 = br.bits(24), m2 = br.bits(24);
				if (m1 === 0x177245 && m2 === 0x385090) { br.bits(32); break; } // end of stream
				if (m1 !== 0x314159 || m2 !== 0x265359) throw new Error('bzip2: bad block');
				br.bits(32); // block CRC
				if (br.bits(1)) throw new Error('bzip2: randomised blocks are not supported');
				const origPtr = br.bits(24);
				const used = br.bits(16), seqToUnseq = [];
				for (let i = 0; i < 16; i++) if (used & (0x8000 >> i)) {
					const bits = br.bits(16);
					for (let j = 0; j < 16; j++) if (bits & (0x8000 >> j)) seqToUnseq.push(i * 16 + j);
				}
				if (!seqToUnseq.length) throw new Error('bzip2: no symbols');
				const alphaSize = seqToUnseq.length + 2;
				const nGroups = br.bits(3), nSelectors = br.bits(15);
				if (nGroups < 2 || nGroups > 6 || !nSelectors) throw new Error('bzip2: bad tables');
				const mtfGroups = [0, 1, 2, 3, 4, 5].slice(0, nGroups), selectors = new Uint8Array(nSelectors);
				for (let i = 0; i < nSelectors; i++) {
					let j = 0;
					while (br.bits(1)) if (++j >= nGroups) throw new Error('bzip2: bad selector');
					const v = mtfGroups[j];
					mtfGroups.splice(j, 1); mtfGroups.unshift(v);
					selectors[i] = v;
				}
				const tables = [];
				for (let t = 0; t < nGroups; t++) {
					const lengths = new Uint8Array(alphaSize);
					let curr = br.bits(5);
					for (let i = 0; i < alphaSize; i++) {
						for (;;) {
							if (curr < 1 || curr > 20) throw new Error('bzip2: bad code length');
							if (!br.bits(1)) break;
							curr += br.bits(1) ? -1 : 1;
						}
						lengths[i] = curr;
					}
					tables.push(bz_huffman(lengths, alphaSize));
				}
				// MTF / RLE2 decode into tt
				const EOB = alphaSize - 1, tt = new Uint32Array(blockMax), unzftab = new Int32Array(256);
				const mtf = new Uint8Array(256);
				for (let i = 0; i < 256; i++) mtf[i] = i;
				let count = 0, groupPos = 0, groupNo = -1, h = null, runPos = 0, runLen = 0;
				for (;;) {
					if (!groupPos) {
						if (++groupNo >= nSelectors) throw new Error('bzip2: selector overflow');
						groupPos = 50; h = tables[selectors[groupNo]];
					}
					groupPos--;
					const sym = bz_decode_sym(br, h);
					if (sym <= 1) { // RUNA / RUNB
						if (!runPos) { runPos = 1; runLen = 0; }
						runLen += (sym + 1) * runPos;
						runPos *= 2;
						if (runLen > blockMax) throw new Error('bzip2: run too long');
						continue;
					}
					if (runPos) {
						runPos = 0;
						if (count + runLen > blockMax) throw new Error('bzip2: block overflow');
						const b = seqToUnseq[mtf[0]];
						unzftab[b] += runLen;
						while (runLen--) tt[count++] = b;
					}
					if (sym === EOB) break;
					if (count >= blockMax) throw new Error('bzip2: block overflow');
					const n = sym - 1, v = mtf[n];
					mtf.copyWithin(1, 0, n); mtf[0] = v;
					const b = seqToUnseq[v];
					unzftab[b]++;
					tt[count++] = b;
				}
				if (origPtr >= count) throw new Error('bzip2: bad origPtr');
				// inverse BWT
				const cftab = new Int32Array(256);
				for (let i = 0, sum = 0; i < 256; i++) { cftab[i] = sum; sum += unzftab[i]; }
				for (let i = 0; i < count; i++) { const b = tt[i] & 0xff; tt[cftab[b]++] |= i << 8; }
				// RLE1 decode
				out.ensure(count * 2);
				let tpos = tt[origPtr] >>> 8, last = -1, run = 0;
				for (let i = 0; i < count; i++) {
					const e = tt[tpos]; tpos = e >>> 8;
					const b = e & 0xff;
					if (run === 4) {
						out.ensure(b);
						for (let k = 0; k < b; k++) out.push(last);
						run = 0; last = -1;
						continue;
					}
					out.push(b);
					if (b === last) run++; else { run = 1; last = b; }
				}
			}
			br.align();
			pos = br.pos;
		}
		return out.len ? out.result() : null;
	} catch (e) {
		console.warn('bunzip2:', e.message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// xz (LZMA2 filter only, CRC/check fields are skipped, not verified)

class LzmaDecoder {
	constructor(out) {
		this.out = out; // OutBuf; the whole output is the dictionary
		this.dictStart = 0;
		this.lc = 0; this.lp = 0; this.pb = 0;
	}
	setProps(b) {
		if (b >= 9 * 5 * 5) throw new Error('lzma: bad props');
		this.lc = b % 9; b = (b / 9) | 0; this.lp = b % 5; this.pb = (b / 5) | 0;
		if (this.lc + this.lp > 4) throw new Error('lzma: lc + lp > 4');
	}
	resetState() {
		const p = n => new Uint16Array(n).fill(1024);
		this.literal = p(0x300 << (this.lc + this.lp));
		this.isMatch = p(192); this.isRep = p(12); this.isRepG0 = p(12); this.isRepG1 = p(12); this.isRepG2 = p(12);
		this.isRep0Long = p(192); this.posSlot = p(256); this.posSpecial = p(115); this.align = p(16);
		const len = () => ({ choice: p(2), low: p(128), mid: p(128), high: p(256) });
		this.lenDec = len(); this.repLenDec = len();
		this.state = 0; this.rep = [0, 0, 0, 0];
	}
	// range decoder over data[pos..end)
	rcInit(data, pos, end) {
		this.d = data; this.p = pos; this.end = end;
		if (data[pos] !== 0) throw new Error('lzma: bad range coder start');
		this.range = 0xffffffff; this.code = 0;
		for (let i = 1; i < 5; i++) this.code = ((this.code << 8) | data[pos + i]) >>> 0;
		this.p = pos + 5;
	}
	normalize() {
		if (this.range < 0x1000000) {
			this.range = (this.range << 8) >>> 0;
			this.code = ((this.code << 8) | (this.p < this.end ? this.d[this.p] : 0)) >>> 0;
			this.p++;
		}
	}
	bit(probs, i) {
		this.normalize();
		const prob = probs[i], bound = (this.range >>> 11) * prob;
		if (this.code < bound) { this.range = bound; probs[i] = prob + ((2048 - prob) >>> 5); return 0; }
		this.range = (this.range - bound) >>> 0; this.code = (this.code - bound) >>> 0; probs[i] = prob - (prob >>> 5); return 1;
	}
	direct(n) {
		let v = 0;
		while (n--) {
			this.normalize();
			this.range >>>= 1;
			let t = 0;
			if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; t = 1; }
			v = ((v << 1) | t) >>> 0;
		}
		return v;
	}
	tree(probs, base, nbits) {
		let m = 1;
		for (let i = 0; i < nbits; i++) m = (m << 1) | this.bit(probs, base + m);
		return m - (1 << nbits);
	}
	reverseTree(probs, base, nbits) {
		let m = 1, sym = 0;
		for (let i = 0; i < nbits; i++) { const b = this.bit(probs, base + m); m = (m << 1) | b; sym |= b << i; }
		return sym;
	}
	length(ld, posState) {
		if (!this.bit(ld.choice, 0)) return this.tree(ld.low, posState << 3, 3);
		if (!this.bit(ld.choice, 1)) return 8 + this.tree(ld.mid, posState << 3, 3);
		return 16 + this.tree(ld.high, 0, 8);
	}
	// decode until `unpacked` more bytes have been produced
	decode(unpacked) {
		const out = this.out, target = out.len + unpacked;
		out.ensure(unpacked);
		const buf = () => out.buf;
		const pbMask = (1 << this.pb) - 1, lpMask = (1 << this.lp) - 1;
		while (out.len < target) {
			const pos = out.len, posState = pos & pbMask;
			const st = this.state;
			if (!this.bit(this.isMatch, (st << 4) + posState)) {
				const prev = pos > this.dictStart ? buf()[pos - 1] : 0;
				const base = 0x300 * (((pos & lpMask) << this.lc) + (prev >>> (8 - this.lc)));
				let sym = 1;
				if (st >= 7) {
					let match = buf()[pos - this.rep[0] - 1];
					do {
						const mbit = (match >>> 7) & 1; match <<= 1;
						const b = this.bit(this.literal, base + ((1 + mbit) << 8) + sym);
						sym = (sym << 1) | b;
						if (mbit !== b) break;
					} while (sym < 0x100);
				}
				while (sym < 0x100) sym = (sym << 1) | this.bit(this.literal, base + sym);
				out.buf[out.len++] = sym & 0xff;
				this.state = st < 4 ? 0 : st < 10 ? st - 3 : st - 6;
				continue;
			}
			let len;
			if (this.bit(this.isRep, st)) {
				if (pos === this.dictStart) throw new Error('lzma: rep at start');
				if (!this.bit(this.isRepG0, st)) {
					if (!this.bit(this.isRep0Long, (st << 4) + posState)) {
						this.state = st < 7 ? 9 : 11;
						out.buf[out.len] = out.buf[pos - this.rep[0] - 1]; out.len++;
						continue;
					}
				} else {
					let dist;
					if (!this.bit(this.isRepG1, st)) dist = this.rep[1];
					else {
						if (!this.bit(this.isRepG2, st)) dist = this.rep[2];
						else { dist = this.rep[3]; this.rep[3] = this.rep[2]; }
						this.rep[2] = this.rep[1];
					}
					this.rep[1] = this.rep[0]; this.rep[0] = dist;
				}
				len = this.length(this.repLenDec, posState);
				this.state = st < 7 ? 8 : 11;
			} else {
				this.rep[3] = this.rep[2]; this.rep[2] = this.rep[1]; this.rep[1] = this.rep[0];
				len = this.length(this.lenDec, posState);
				this.state = st < 7 ? 7 : 10;
				const lenState = Math.min(len, 3);
				const slot = this.tree(this.posSlot, lenState << 6, 6);
				let dist;
				if (slot < 4) dist = slot;
				else {
					const nb = (slot >>> 1) - 1;
					dist = ((2 | (slot & 1)) << nb) >>> 0;
					if (slot < 14) dist = (dist + this.reverseTree(this.posSpecial, dist - slot - 1, nb)) >>> 0;
					else {
						dist = (dist + ((this.direct(nb - 4) << 4) >>> 0)) >>> 0;
						dist = (dist + this.reverseTree(this.align, 0, 4)) >>> 0;
					}
				}
				this.rep[0] = dist;
				if (dist === 0xffffffff) break; // end marker
			}
			len += 2;
			const from = out.len - this.rep[0] - 1;
			if (from < this.dictStart) throw new Error('lzma: distance beyond dictionary');
			const n = Math.min(len, target - out.len);
			const b = out.buf;
			for (let i = 0; i < n; i++) b[out.len + i] = b[from + i];
			out.len += n;
		}
	}
}

function read_varint(d, p) {
	let v = 0, shift = 0;
	for (let i = 0; i < 9; i++) {
		const b = d[p.pos++];
		v += (b & 0x7f) * Math.pow(2, shift);
		if (!(b & 0x80)) return v;
		shift += 7;
	}
	throw new Error('xz: bad varint');
}

export function unxz(data) {
	const magic = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
	if (data.length < 32 || magic.some((m, i) => data[i] !== m)) return null;
	try {
		const check = data[7] & 0x0f;
		const check_size = check === 0 ? 0 : check <= 3 ? 4 : check <= 6 ? 8 : check <= 9 ? 16 : check <= 12 ? 32 : 64;
		const out = new OutBuf(data.length * 4);
		const lz = new LzmaDecoder(out);
		let pos = 12;
		for (;;) {
			const hsize = data[pos];
			if (hsize === 0) break; // index: all blocks done
			const hdr_end = pos + (hsize + 1) * 4;
			const flags = data[pos + 1], p = { pos: pos + 2 };
			if (flags & 0x40) read_varint(data, p); // compressed size
			if (flags & 0x80) read_varint(data, p); // uncompressed size
			const nfilters = (flags & 3) + 1;
			let dict_props = -1;
			for (let f = 0; f < nfilters; f++) {
				const id = read_varint(data, p), psize = read_varint(data, p);
				if (id !== 0x21 || f !== nfilters - 1) throw new Error('xz: only the LZMA2 filter is supported');
				dict_props = data[p.pos];
				p.pos += psize;
			}
			if (dict_props < 0) throw new Error('xz: no filter');
			pos = hdr_end;
			// LZMA2 chunks
			lz.dictStart = out.len;
			let need_props = true;
			for (;;) {
				const ctl = data[pos++];
				if (ctl === undefined) throw new Error('xz: truncated');
				if (ctl === 0x00) break;
				if (ctl === 0x01 || ctl === 0x02) {
					const size = ((data[pos] << 8) | data[pos + 1]) + 1; pos += 2;
					if (ctl === 0x01) lz.dictStart = out.len;
					out.ensure(size);
					out.buf.set(data.subarray(pos, pos + size), out.len); out.len += size; pos += size;
					continue;
				}
				if (ctl < 0x80) throw new Error('xz: bad LZMA2 control');
				const unpacked = ((ctl & 0x1f) << 16) + ((data[pos] << 8) | data[pos + 1]) + 1;
				const packed = ((data[pos + 2] << 8) | data[pos + 3]) + 1;
				pos += 4;
				const reset = (ctl >>> 5) & 3;
				if (reset === 3) lz.dictStart = out.len;
				if (reset >= 2) { lz.setProps(data[pos++]); need_props = false; }
				else if (need_props) throw new Error('xz: missing LZMA properties');
				if (reset >= 1) lz.resetState();
				lz.rcInit(data, pos, pos + packed);
				lz.decode(unpacked);
				pos += packed;
			}
			pos = hdr_end + Math.ceil((pos - hdr_end) / 4) * 4; // block padding
			pos += check_size;
		}
		return out.result();
	} catch (e) {
		console.warn('unxz:', e.message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// zstd (RFC 8878; no dictionaries, checksums skipped)

const highbit = v => 31 - Math.clz32(v);

// forward little-endian bit reader (FSE table descriptions)
class BitReaderLE {
	constructor(d, pos) { this.d = d; this.pos = pos; this.bitpos = 0; }
	bits(n) {
		let v = 0;
		for (let i = 0; i < n; i++) {
			const p = this.pos + ((this.bitpos + i) >> 3);
			if (p >= this.d.length) throw new Error('zstd: truncated table');
			v |= ((this.d[p] >> ((this.bitpos + i) & 7)) & 1) << i;
		}
		this.bitpos += n;
		return v;
	}
	peek(n) { const save = this.bitpos; const v = this.bits(n); this.bitpos = save; return v; }
	bytes_used() { return (this.bitpos + 7) >> 3; }
}

// backward bit reader: zstd's entropy-coded bitstreams are read from the end
class BitReaderBack {
	constructor(d, start, end) {
		if (end <= start) throw new Error('zstd: empty bitstream');
		const last = d[end - 1];
		if (!last) throw new Error('zstd: bad bitstream end');
		this.d = d; this.start = start;
		this.bitpos = (end - start - 1) * 8 + highbit(last); // bits left above the marker
	}
	extract(p, n) { // bits [p, p+n) of the stream, p >= 0, n <= 24
		const b = this.start + (p >> 3), s = p & 7, d = this.d;
		const v = d[b] | (d[b + 1] << 8) | (d[b + 2] << 16) | (d[b + 3] << 24);
		return (v >>> s) & ((1 << n) - 1);
	}
	read(n) {
		if (!n) return 0;
		if (n > 24) { const hi = this.read(n - 24); return hi * 0x1000000 + this.read(24); }
		this.bitpos -= n;
		const p = this.bitpos;
		if (p >= 0) return this.extract(p, n);
		if (p + n <= 0) return 0;
		return this.extract(0, p + n) << -p; // past the start: zeros
	}
	peek(n) {
		const p = this.bitpos - n;
		if (p >= 0) return this.extract(p, n);
		if (this.bitpos <= 0) return 0;
		return this.extract(0, this.bitpos) << -p;
	}
	skip(n) { this.bitpos -= n; }
}

function fse_read_ncount(d, pos, max_symbol, max_log) {
	const br = new BitReaderLE(d, pos);
	const acc = br.bits(4) + 5;
	if (acc > max_log) throw new Error('zstd: accuracy log too large');
	const norm = [];
	let remaining = (1 << acc) + 1, threshold = 1 << acc, nbBits = acc + 1, symbol = 0;
	while (remaining > 1 && symbol <= max_symbol) {
		const max = 2 * threshold - 1 - remaining;
		let count;
		const low = br.peek(nbBits - 1);
		if (low < max) { count = low; br.bits(nbBits - 1); }
		else {
			count = br.bits(nbBits);
			if (count >= threshold) count -= max;
		}
		count--;
		remaining -= Math.abs(count);
		norm[symbol++] = count;
		if (count === 0) {
			for (;;) { // repeat flags: runs of zero probabilities
				const rep = br.bits(2);
				for (let i = 0; i < rep; i++) norm[symbol++] = 0;
				if (rep !== 3) break;
			}
		}
		while (remaining < threshold) { nbBits--; threshold >>= 1; }
	}
	if (remaining !== 1 || symbol > max_symbol + 1) throw new Error('zstd: bad probabilities');
	return { acc, norm, size: br.bytes_used() };
}
function fse_build(norm, acc) {
	const size = 1 << acc, mask = size - 1;
	const symbol = new Uint8Array(size), nb = new Uint8Array(size), base = new Uint16Array(size);
	const next = new Uint16Array(norm.length);
	let high = size - 1;
	norm.forEach((n, s) => { if (n === -1) { symbol[high--] = s; next[s] = 1; } else next[s] = n; });
	const step = (size >> 1) + (size >> 3) + 3;
	let pos = 0;
	norm.forEach((n, s) => {
		for (let i = 0; i < n; i++) {
			symbol[pos] = s;
			do pos = (pos + step) & mask; while (pos > high);
		}
	});
	if (pos !== 0) throw new Error('zstd: bad FSE table');
	for (let u = 0; u < size; u++) {
		const s = symbol[u], ns = next[s]++;
		nb[u] = acc - highbit(ns);
		base[u] = (ns << nb[u]) - size;
	}
	return { acc, symbol, nb, base };
}
const fse_rle = s => ({ acc: 0, symbol: Uint8Array.of(s), nb: Uint8Array.of(0), base: Uint16Array.of(0) });

const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
	35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const LL_DEFAULT = fse_build([4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1], 6);
const ML_DEFAULT = fse_build([1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1], 6);
const OF_DEFAULT = fse_build([1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1], 5);

function huf_build(weights) {
	// the last symbol's weight is implied: the total must reach a power of two
	let total = 0;
	for (const w of weights) if (w) total += 1 << (w - 1);
	if (!total) throw new Error('zstd: empty huffman weights');
	const maxBits = highbit(total) + 1, rest = (1 << maxBits) - total;
	if (rest & (rest - 1)) throw new Error('zstd: bad huffman weights');
	const all = [...weights, highbit(rest) + 1];
	if (maxBits > 11) throw new Error('zstd: huffman depth too large');
	const size = 1 << maxBits, symbol = new Uint8Array(size), nb = new Uint8Array(size);
	let pos = 0;
	for (let w = 1; w <= maxBits; w++) {
		all.forEach((ww, s) => {
			if (ww !== w) return;
			const n = 1 << (w - 1), bits = maxBits + 1 - w;
			symbol.fill(s, pos, pos + n); nb.fill(bits, pos, pos + n);
			pos += n;
		});
	}
	return { maxBits, symbol, nb };
}
function huf_read_table(d, pos) {
	const hb = d[pos++];
	let weights;
	if (hb >= 128) {
		const n = hb - 127;
		weights = [];
		for (let i = 0; i < n; i++) weights.push(i & 1 ? d[pos + (i >> 1)] & 15 : d[pos + (i >> 1)] >> 4);
		pos += (n + 1) >> 1;
	} else {
		const end = pos + hb;
		const nc = fse_read_ncount(d, pos, 255, 6);
		const t = fse_build(nc.norm, nc.acc);
		const br = new BitReaderBack(d, pos + nc.size, end);
		let s1 = br.read(t.acc), s2 = br.read(t.acc);
		weights = [];
		for (;;) {
			weights.push(t.symbol[s1]); s1 = t.base[s1] + br.read(t.nb[s1]);
			if (br.bitpos < 0) { weights.push(t.symbol[s2]); break; }
			weights.push(t.symbol[s2]); s2 = t.base[s2] + br.read(t.nb[s2]);
			if (br.bitpos < 0) { weights.push(t.symbol[s1]); break; }
			if (weights.length > 255) throw new Error('zstd: too many weights');
		}
		pos = end;
	}
	return { table: huf_build(weights), pos };
}
function huf_decode_stream(d, start, end, h, out, count) {
	const br = new BitReaderBack(d, start, end);
	for (let i = 0; i < count; i++) {
		const v = br.peek(h.maxBits);
		out.push(h.symbol[v]);
		br.skip(h.nb[v]);
	}
	if (br.bitpos !== 0) throw new Error('zstd: huffman stream size mismatch');
}

export function unzstd(data) {
	const u32 = p => (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
	if (data.length < 9 || u32(0) !== 0xFD2FB528) return null;
	try {
		const out = new OutBuf(data.length * 4);
		let pos = 0;
		while (pos + 4 <= data.length) {
			const magic = u32(pos);
			if ((magic & 0xFFFFFFF0) === 0x184D2A50) { pos += 8 + u32(pos + 4); continue; } // skippable frame
			if (magic !== 0xFD2FB528) break;
			pos += 4;
			const fhd = data[pos++];
			const fcs_flag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, did_flag = fhd & 3;
			if (fhd & 8) throw new Error('zstd: reserved bit set');
			if (!single) pos++; // window descriptor (the whole output is the window here)
			const did_size = [0, 1, 2, 4][did_flag];
			if (did_size && data.subarray(pos, pos + did_size).some(b => b)) throw new Error('zstd: dictionaries are not supported');
			pos += did_size;
			pos += [single ? 1 : 0, 2, 4, 8][fcs_flag];
			const frame_start = out.len;
			const rep = [1, 4, 8];
			let huf = null, ll_t = null, of_t = null, ml_t = null;
			for (;;) {
				const bh = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16);
				pos += 3;
				const last = bh & 1, type = (bh >> 1) & 3, bsize = bh >>> 3;
				if (type === 0) { out.ensure(bsize); out.buf.set(data.subarray(pos, pos + bsize), out.len); out.len += bsize; pos += bsize; }
				else if (type === 1) { out.ensure(bsize); out.buf.fill(data[pos], out.len, out.len + bsize); out.len += bsize; pos += 1; }
				else if (type === 2) {
					const bend = pos + bsize;
					// literals section
					const lh = data[pos], ltype = lh & 3, sf = (lh >> 2) & 3;
					let lsize, csize = 0, nstreams = 1;
					if (ltype < 2) {
						if (sf === 0 || sf === 2) { lsize = lh >> 3; pos += 1; }
						else if (sf === 1) { lsize = (lh >> 4) | (data[pos + 1] << 4); pos += 2; }
						else { lsize = (lh >> 4) | (data[pos + 1] << 4) | (data[pos + 2] << 12); pos += 3; }
					} else {
						nstreams = sf === 0 ? 1 : 4;
						if (sf < 2) { const v = lh | (data[pos + 1] << 8) | (data[pos + 2] << 16); lsize = (v >> 4) & 0x3ff; csize = (v >> 14) & 0x3ff; pos += 3; }
						else if (sf === 2) { const v = (lh | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) >>> 0; lsize = (v >>> 4) & 0x3fff; csize = (v >>> 18) & 0x3fff; pos += 4; }
						else { const v = (lh | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) >>> 0; lsize = (v >>> 4) & 0x3ffff; csize = ((v >>> 22) | (data[pos + 4] << 10)) & 0x3ffff; pos += 5; }
					}
					let lits;
					if (ltype === 0) { lits = data.subarray(pos, pos + lsize); pos += lsize; }
					else if (ltype === 1) { lits = new Uint8Array(lsize).fill(data[pos]); pos += 1; }
					else {
						const lend = pos + csize;
						if (ltype === 2) { const t = huf_read_table(data, pos); huf = t.table; pos = t.pos; }
						else if (!huf) throw new Error('zstd: treeless literals without a table');
						const lo = new OutBuf(lsize);
						if (nstreams === 1) huf_decode_stream(data, pos, lend, huf, lo, lsize);
						else {
							const s1 = data[pos] | (data[pos + 1] << 8), s2 = data[pos + 2] | (data[pos + 3] << 8), s3 = data[pos + 4] | (data[pos + 5] << 8);
							const per = (lsize + 3) >> 2;
							let p = pos + 6;
							const ends = [p + s1, p + s1 + s2, p + s1 + s2 + s3, lend];
							for (let i = 0; i < 4; i++) {
								huf_decode_stream(data, p, ends[i], huf, lo, i < 3 ? per : lsize - 3 * per);
								p = ends[i];
							}
						}
						lits = lo.result();
						pos = lend;
					}
					// sequences section
					let nseq = data[pos++];
					if (nseq >= 128) {
						if (nseq < 255) nseq = ((nseq - 128) << 8) + data[pos++];
						else { nseq = data[pos] + (data[pos + 1] << 8) + 0x7f00; pos += 2; }
					}
					let lp = 0;
					if (nseq) {
						const modes = data[pos++];
						const table = (mode, def, maxsym, maxlog, prev) => {
							if (mode === 0) return def;
							if (mode === 1) return fse_rle(data[pos++]);
							if (mode === 3) { if (!prev) throw new Error('zstd: repeat mode without a table'); return prev; }
							const nc = fse_read_ncount(data, pos, maxsym, maxlog);
							pos += nc.size;
							return fse_build(nc.norm, nc.acc);
						};
						ll_t = table(modes >> 6, LL_DEFAULT, 35, 9, ll_t);
						of_t = table((modes >> 4) & 3, OF_DEFAULT, 31, 8, of_t);
						ml_t = table((modes >> 2) & 3, ML_DEFAULT, 52, 9, ml_t);
						const br = new BitReaderBack(data, pos, bend);
						let lls = br.read(ll_t.acc), ofs = br.read(of_t.acc), mls = br.read(ml_t.acc);
						for (let i = 0; i < nseq; i++) {
							const llc = ll_t.symbol[lls], ofc = of_t.symbol[ofs], mlc = ml_t.symbol[mls];
							if (llc > 35 || mlc > 52 || ofc > 31) throw new Error('zstd: bad code');
							const ofv = ofc ? (1 << ofc) * 1 + br.read(ofc) : 1;
							const ml = ML_BASE[mlc] + br.read(ML_BITS[mlc]);
							const ll = LL_BASE[llc] + br.read(LL_BITS[llc]);
							let offset;
							if (ofv > 3) { offset = ofv - 3; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset; }
							else {
								const idx = ofv - 1 + (ll === 0 ? 1 : 0);
								if (idx === 0) offset = rep[0];
								else {
									offset = idx === 3 ? rep[0] - 1 : rep[idx];
									if (!offset) offset = 1;
									if (idx !== 1) rep[2] = rep[1];
									rep[1] = rep[0]; rep[0] = offset;
								}
							}
							if (i + 1 < nseq) {
								lls = ll_t.base[lls] + br.read(ll_t.nb[lls]);
								mls = ml_t.base[mls] + br.read(ml_t.nb[mls]);
								ofs = of_t.base[ofs] + br.read(of_t.nb[ofs]);
							}
							// execute
							if (lp + ll > lits.length) throw new Error('zstd: literal overrun');
							out.ensure(ll + ml);
							out.buf.set(lits.subarray(lp, lp + ll), out.len); out.len += ll; lp += ll;
							const from = out.len - offset;
							if (from < frame_start) throw new Error('zstd: offset beyond window');
							const b = out.buf;
							for (let k = 0; k < ml; k++) b[out.len + k] = b[from + k];
							out.len += ml;
						}
					}
					const rest = lits.length - lp;
					out.ensure(rest);
					out.buf.set(lits.subarray(lp), out.len); out.len += rest;
					pos = bend;
				} else throw new Error('zstd: reserved block type');
				if (last) break;
			}
			if (checksum) pos += 4;
		}
		return out.result();
	} catch (e) {
		console.warn('unzstd:', e.message);
		return null;
	}
}

// slurp.c order: gzip, bzip2, xz, zstd, each applied to what the previous step left
export function unpack_bzip2_xz_zstd(d) {
	let changed = false, r;
	if ((r = bunzip2(d))) { d = r; changed = true; }
	if ((r = unxz(d))) { d = r; changed = true; }
	if ((r = unzstd(d))) { d = r; changed = true; }
	return changed ? d : null;
}
