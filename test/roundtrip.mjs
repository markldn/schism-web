// IT save round-trip: load -> save -> load, render both, compare PCM byte for byte.
import fs from 'fs';
const root = new URL('../', import.meta.url), urls = new Map();
function moduleURL(file) { return new URL(file, root).href;
	const path = new URL(file, root);
	if (urls.has(path.href)) return urls.get(path.href);
	let source = fs.readFileSync(path, 'utf8');
	source = source.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_, q, rel) => 'from ' + JSON.stringify(moduleURL(new URL(rel, path).href)));
	const result = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); urls.set(path.href, result); return result;
}
for (const f of ['js/csndfile.js', 'js/effects.js', 'js/sndmix.js', 'js/filters.js', 'js/mixutil.js', 'js/mixer.js', 'js/equalizer.js']) await import(moduleURL(f));
const { app, provide } = await import(moduleURL('js/app.js'));
const noop = () => {};
provide({ csf_midi_out_note: noop, GM_KeyOff: noop, GM_Touch: noop, GM_IncrementSongCounter: noop, Fmdrv_Mix: noop, Fmdrv_Init: noop, GM_Reset: noop, GM_DPatch: noop });
const L = await import(moduleURL('js/fmt/loaders.js'));
const S = await import(moduleURL('js/fmt/savers.js'));
function render(song, frames) {
	app.csf_set_wave_config(song, 44100, 16, 2);
	app.csf_set_resampling_mode(song, 2);
	Object.assign(song, { repeat_count: -1, buffer_count: 0, stop_at_order: -1, stop_at_row: -1 });
	song.flags &= ~(0x80 | 0x40020 | 0x200);
	app.csf_set_current_order(song, 0);
	const pcm = new Uint8Array(frames * 4);
	let got = 0;
	while (got < frames) { const n = app.csf_read(song, pcm.subarray(got * 4), Math.min(4096, frames - got) * 4); if (!n) break; got += n; }
	return pcm.subarray(0, got * 4);
}
let fail = 0;
for (const f of process.argv.slice(2)) {
	const a = L.song_create_load(fs.readFileSync(f));
	const bytes = S.fmt_it_save_song(a);
	const b = L.song_create_load(bytes);
	const pa = render(L.song_create_load(fs.readFileSync(f)), 44100 * 20), pb = render(b, 44100 * 20);
	let diff = 0; for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) diff++;
	const ok = diff === 0 && pa.length === pb.length;
	if (!ok) fail++;
	console.log(`${ok ? 'OK  ' : 'FAIL'} ${f}: ${bytes.length} bytes written, ${pa.length / 4} frames, ${diff} differing bytes`);
	const s2 = S.fmt_it_save_song(b);
	console.log(`     resave identical: ${s2.length === bytes.length && s2.every((v, i) => v === bytes[i] || (i >= 0x40 && i < 0x40 + 0) )}`);
}
process.exit(fail ? 1 : 0);
