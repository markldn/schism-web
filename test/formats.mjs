// Save as S3M / MOD and reload: check the reloaded song renders the same as the source.
import fs from 'fs';
const root = new URL('../', import.meta.url);
const m = f => import(new URL(f, root).href);
for (const f of ['js/csndfile.js', 'js/effects.js', 'js/sndmix.js', 'js/filters.js', 'js/mixutil.js', 'js/mixer.js', 'js/equalizer.js']) await m(f);
const { app, provide } = await m('js/app.js');
const noop = () => {};
provide({ csf_midi_out_note: noop, GM_KeyOff: noop, GM_Touch: noop, GM_IncrementSongCounter: noop, Fmdrv_Mix: noop, Fmdrv_Init: noop, GM_Reset: noop, GM_DPatch: noop });
const L = await m('js/fmt/loaders.js'), S = await m('js/fmt/savers.js');
function render(song, frames) {
	app.csf_set_wave_config(song, 44100, 16, 2); app.csf_set_resampling_mode(song, 1);
	Object.assign(song, { repeat_count: -1, buffer_count: 0, stop_at_order: -1, stop_at_row: -1 });
	song.flags &= ~(0x80 | 0x40020 | 0x200); app.csf_set_current_order(song, 0);
	const pcm = new Int16Array(frames * 2); let got = 0;
	const bytes = new Uint8Array(pcm.buffer);
	while (got < frames) { const n = app.csf_read(song, bytes.subarray(got * 4), Math.min(4096, frames - got) * 4); if (!n) break; got += n; }
	return pcm;
}
const rms = a => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
for (const [f, saver] of process.argv.slice(2).map(a => a.split('@'))) {
	const src = L.song_create_load(fs.readFileSync(f));
	const out = S[saver](src);
	const back = L.song_create_load(out);
	const a = render(L.song_create_load(fs.readFileSync(f)), 44100 * 10), b = render(back, 44100 * 10);
	let diff = 0; for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
	console.log(`${saver} ${f.split('/').pop()}: ${out.length} bytes, reload ${back ? 'ok' : 'FAILED'} (${back && back.tracker_id}), rms ${rms(a).toFixed(0)} vs ${rms(b).toFixed(0)}, mean abs diff ${(diff / a.length).toFixed(1)}`);
}
