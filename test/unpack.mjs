// Packed-module decoders (js/fmt/unpack.js) against the reference command-line tools:
// each input is packed with bzip2, xz and zstd (several levels), then unpacked in JS
// and compared byte for byte.   node test/unpack.mjs file...
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const U = await import(new URL('../js/fmt/unpack.js', import.meta.url));
const tools = [
	['bzip2', ['-c'], U.bunzip2], ['bzip2', ['-1', '-c'], U.bunzip2],
	['xz', ['-c'], U.unxz], ['xz', ['-0', '-c'], U.unxz], ['xz', ['-9e', '--check=sha256', '-c'], U.unxz],
	['zstd', ['-q', '-c'], U.unzstd], ['zstd', ['-q', '-19', '-c'], U.unzstd], ['zstd', ['-q', '--ultra', '-22', '--no-check', '-c'], U.unzstd],
];
const files = process.argv.slice(2);
// synthetic inputs: incompressible and highly repetitive
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unpack-'));
const rnd = Buffer.alloc(1 << 20); for (let i = 0; i < rnd.length; i++) rnd[i] = (Math.imul(i, 2654435761) >>> 13) & 255;
fs.writeFileSync(path.join(tmp, 'random'), rnd);
fs.writeFileSync(path.join(tmp, 'repeat'), Buffer.from('abcabcabd\n'.repeat(300000)));
files.push(path.join(tmp, 'random'), path.join(tmp, 'repeat'));
let fail = 0, n = 0;
for (const f of files) {
	const orig = fs.readFileSync(f);
	for (const [tool, args, fn] of tools) {
		let packed;
		try { packed = execFileSync(tool, args, { input: orig, maxBuffer: 1 << 30 }); } catch { console.log(`skip ${tool}: not installed`); continue; }
		const out = fn(new Uint8Array(packed));
		const ok = out && Buffer.compare(Buffer.from(out), orig) === 0;
		n++; if (!ok) { fail++; console.log(`FAIL ${tool} ${args.join(' ')} ${f}`); }
	}
}
fs.rmSync(tmp, { recursive: true });
console.log(`${n} unpacks checked, ${fail} failed`);
process.exit(fail ? 1 : 0);
