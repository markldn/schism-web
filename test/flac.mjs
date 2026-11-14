// FLAC: every sample of each module saved as FLAC and loaded back (data, loops,
// sustain loops, vibrato, volumes, name, rate); when ffmpeg is installed, it must
// decode each file to the same PCM.   node test/flac.mjs file...
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const root = new URL('../', import.meta.url), urls = new Map();
function moduleURL(file) {
	const p = new URL(file, root);
	if (urls.has(p.href)) return urls.get(p.href);
	let source = fs.readFileSync(p, 'utf8');
	source = source.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_, q, rel) => 'from ' + JSON.stringify(moduleURL(new URL(rel, p).href)));
	source = source.replace(/import\s+(["'])(\.\.?\/[^"']+)\1/g, (_, q, rel) => 'import ' + JSON.stringify(moduleURL(new URL(rel, p).href)));
	const r = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); urls.set(p.href, r); return r;
}
for (const f of ['js/midimacro.js', 'js/csndfile.js', 'js/effects.js']) await import(moduleURL(f));
const { provide } = await import(moduleURL('js/app.js')); provide({ log_appendf: () => 0 });
const L = await import(moduleURL('js/fmt/loaders.js'));
await import(moduleURL('js/fmt/loaders2.js'));
const I = await import(moduleURL('js/fmt/info.js'));
const SV = await import(moduleURL('js/fmt/savers.js'));
const CS = await import(moduleURL('js/csndfile.js'));
let ffmpeg = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpeg = false; }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-'));
let n = 0, fail = 0;
for (const f of process.argv.slice(2)) {
	const song = L.song_create_load(fs.readFileSync(f));
	if (!song) continue;
	for (let s = 1; s < song.samples.length; s++) {
		const a = song.samples[s];
		if (!a.data || !a.length || (a.flags & 0x20000000)) continue;
		const bytes = SV.fmt_flac_save_sample(a);
		const b = CS.csf_allocate().samples[1];
		const ok = I.fmt_load_sample('x.flac', bytes, b);
		const ch = a.flags & 0x40 ? 2 : 1, errs = [];
		if (!ok) errs.push('load');
		else {
			for (let i = 0; i < a.length * ch; i++) if (a.data[i] !== b.data[i]) { errs.push(`data@${i}`); break; }
			for (const k of ['length', 'c5speed', 'vib_type', 'vib_speed', 'vib_depth', 'vib_rate', 'global_volume'])
				if (a[k] !== b[k]) errs.push(`${k} ${a[k]}/${b[k]}`);
			// like WAV, the smpl chunk stores only enabled loops
			if ((a.flags & 0x02) && (a.loop_start !== b.loop_start || a.loop_end !== b.loop_end)) errs.push(`loop ${a.loop_start}-${a.loop_end}/${b.loop_start}-${b.loop_end}`);
			if ((a.flags & 0x10) && (a.sustain_start !== b.sustain_start || a.sustain_end !== b.sustain_end)) errs.push('sustain');
			if ((a.flags & 0x3f) !== (b.flags & 0x3f)) errs.push(`flags ${a.flags.toString(16)}/${b.flags.toString(16)}`);
			if (Math.min(((a.volume + 2) >> 2) * 4, 256) !== b.volume) errs.push(`volume ${a.volume}/${b.volume}`); // iff_read_xtra_chunk rounds
		}
		if (ffmpeg && !errs.length) {
			const file = path.join(tmp, 'x.flac');
			fs.writeFileSync(file, bytes);
			const bits = a.flags & 1 ? 16 : 8;
			const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', bits === 16 ? 's16le' : 'u8', '-'], { maxBuffer: 1 << 28 });
			for (let i = 0; i < a.length * ch; i++) {
				const v = bits === 16 ? raw.readInt16LE(i * 2) : raw[i] - 128;
				if (v !== a.data[i]) { errs.push(`ffmpeg@${i}`); break; }
			}
		}
		n++;
		if (errs.length) { fail++; console.log(`FAIL ${path.basename(f)} #${s}: ${errs.join(', ')}`); }
	}
}
fs.rmSync(tmp, { recursive: true });
console.log(`${n} samples checked${ffmpeg ? ' (and decoded by ffmpeg)' : ''}, ${fail} failed`);
process.exit(fail ? 1 : 0);
