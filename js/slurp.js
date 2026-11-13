// Browser memory-backed subset of schism/slurp.c (GPL-2.0-or-later).
export function slurp_memstream(bytes) {
	return { bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), position: 0 };
}
export function slurp_tell(fp) { return fp.position; }
export function slurp_could_seek(fp, offset, whence = 0) {
	const position = offset + (whence === 1 ? fp.position : whence === 2 ? fp.bytes.length : 0);
	return Number.isSafeInteger(position) && position >= 0 && position <= fp.bytes.length;
}
export function slurp_seek(fp, offset, whence = 0) {
	if (!slurp_could_seek(fp,offset,whence)) return -1;
	fp.position = offset + (whence === 1 ? fp.position : whence === 2 ? fp.bytes.length : 0); return 0;
}
export function slurp_read(fp, target, count) {
	const n = Math.min(count, fp.bytes.length - fp.position);
	new Uint8Array(target.buffer,target.byteOffset,target.byteLength).set(fp.bytes.subarray(fp.position,fp.position+n));
	fp.position += n; return n;
}
export function slurp_getc(fp) { return fp.position < fp.bytes.length ? fp.bytes[fp.position++] : -1; }
