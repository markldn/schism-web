// Compare the JS player against native Schism Tracker sample by sample.
//   node test/cref.mjs [--secs N] file...
// Needs a native build: CREF_BIN=/path/to/schismtracker (built from ../schismtracker,
// run as `schismtracker --headless --diskwrite=out.wav file`). Renders both at 44.1 kHz
// with diskwriter settings (all voices, linear interpolation, no backward jumps).
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
for (const f of ['js/midimacro.js', 'js/csndfile.js', 'js/effects.js', 'js/sndmix.js', 'js/filters.js', 'js/mixutil.js', 'js/mixer.js', 'js/equalizer.js']) await import(moduleURL(f));
const { app, provide } = await import(moduleURL('js/app.js'));
const noop = () => 0;
provide({ csf_midi_out_note: noop, GM_KeyOff: noop, GM_Touch: noop, GM_IncrementSongCounter: noop, GM_DPatch: noop,
	Fmdrv_Mix: noop, Fmdrv_Init: noop, GM_Reset: noop, OPL_NoteOff: noop, OPL_Patch: noop, OPL_Reset: noop,
	log_appendf: noop });
for (const f of ['js/snd_fm.js', 'js/midi.js']) if (fs.existsSync(new URL(f, root))) await import(moduleURL(f));
const L = await import(moduleURL('js/fmt/loaders.js'));
// CREF_RAND=n: C side runs with rand() pinned to n (LD_PRELOAD shim from CREF_RAND_SO), JS side matches
if (process.env.CREF_RAND) (await import(moduleURL('js/effects.js'))).csf_set_rand(() => +process.env.CREF_RAND);
await import(moduleURL('js/fmt/loaders2.js'));

const args = process.argv.slice(2);
let secs = 30;
if (args[0] === '--secs') { secs = +args[1]; args.splice(0, 2); }
const bin = process.env.CREF_BIN;
if (!bin) { console.error('set CREF_BIN to a native schismtracker binary'); process.exit(2); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cref-'));

function read_wav(file) {
	const b = fs.readFileSync(file);
	let p = 12, ch = 2, data = null;
	while (p + 8 <= b.length) {
		const id = b.toString('latin1', p, p + 4), len = b.readUInt32LE(p + 4);
		if (id === 'fmt ') ch = b.readUInt16LE(p + 10);
		if (id === 'data') data = new Int16Array(b.buffer.slice(b.byteOffset + p + 8, b.byteOffset + p + 8 + len));
		p += 8 + len + (len & 1);
	}
	return { ch, data };
}
let bad = 0;
for (const file of args) {
	const name = path.basename(file);
	const out = path.join(tmp, 'ref.wav');
	try { fs.unlinkSync(out); } catch {}
	try { execFileSync(bin, ['--headless', `--diskwrite=${out}`, file], { env: { ...process.env, HOME: tmp, ...(process.env.CREF_RAND_SO ? { LD_PRELOAD: process.env.CREF_RAND_SO } : {}) }, stdio: 'pipe', timeout: 120000 }); } catch {}
	const ref = fs.existsSync(out) ? read_wav(out) : null;
	const song = L.song_create_load(new Uint8Array(fs.readFileSync(file)));
	if (!song || !ref) { console.log(`${name}: ${!song ? 'JS load failed' : ''} ${!ref ? 'C render failed' : ''}`); bad++; continue; }
	const ch = (song.flags & 0x80000) ? 1 : 2;
	app.csf_set_wave_config(song, 44100, 16, ch);
	app.csf_set_resampling_mode(song, 1);
	song.max_voices = 256;
	song.mix_flags = (song.mix_flags & ~0x200000) | 0x10000 | 0x40000;
	Object.assign(song, { repeat_count: -1, buffer_count: 0, stop_at_order: -1, stop_at_row: -1 });
	song.flags &= ~(0x80 | 0x40020 | 0x200);
	app.csf_set_current_order(song, 0);
	const frames = Math.min(ref.data.length / ref.ch, 44100 * secs);
	const pcm = new Uint8Array(frames * 2 * ch);
	let got = 0;
	while (got < frames) {
		const n = app.csf_read(song, pcm.subarray(got * 2 * ch), Math.min(4096, frames - got) * 2 * ch);
		if (!n) break;
		got += n;
	}
	const js = new Int16Array(pcm.buffer, 0, got * ch);
	let maxd = 0, ndiff = 0, first = -1, sum = 0, sumr = 0;
	const n = Math.min(js.length, frames * ref.ch);
	for (let i = 0; i < n; i++) {
		const d = Math.abs(js[i] - ref.data[i]);
		if (d) { ndiff++; if (first < 0) first = i; }
		if (d > maxd) maxd = d;
		sum += d * d; sumr += ref.data[i] * ref.data[i];
	}
	const rms = Math.round(Math.sqrt(sumr / Math.max(1, n)));
	const snr = sum ? (10 * Math.log10(sumr / sum)).toFixed(1) + ' dB' : 'exact';
	const ok = ref.ch === ch && (!ndiff || +snr.split(' ')[0] > 60);
	if (!ok) bad++;
	console.log(`${ok ? 'ok  ' : 'DIFF'} ${name}: ${(n / ch / 44100).toFixed(1)}s ch ${ch}/${ref.ch} rms ${rms} maxdiff ${maxd} differing ${ndiff} snr ${snr}` +
		(first >= 0 ? ` first at ${(first / ch / 44100).toFixed(3)}s` : '') + (got < frames ? ` JS ended early at ${(got / 44100).toFixed(1)}s` : ''));
}
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
