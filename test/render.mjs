// Render a module to WAV with the JS player: node test/render.mjs in.it out.wav [seconds]
import fs from 'fs';
const root = new URL('../', import.meta.url), urls = new Map();
function moduleURL(file) { return new URL(file, root).href;
	const path = new URL(file, root);
	if (urls.has(path.href)) return urls.get(path.href);
	let source = fs.readFileSync(path, 'utf8');
	source = source.replace(/from\s+(["'])(\.\.?\/[^"']+)\1/g, (_, q, rel) => 'from ' + JSON.stringify(moduleURL(new URL(rel, path).href)));
	const result = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64'); urls.set(path.href, result); return result;
}
for (const f of ['js/midimacro.js', 'js/csndfile.js', 'js/effects.js', 'js/sndmix.js', 'js/filters.js', 'js/mixutil.js', 'js/mixer.js', 'js/equalizer.js']) await import(moduleURL(f));
const { app, provide, missing_calls } = await import(moduleURL('js/app.js'));
const noop = () => {};
provide({ csf_midi_out_note: noop, GM_KeyOff: noop, GM_Touch: noop, GM_IncrementSongCounter: noop, Fmdrv_Mix: noop, Fmdrv_Init: noop, GM_Reset: noop, OPL_NoteOff: noop, OPL_Patch: noop });
const L = await import(moduleURL('js/fmt/loaders.js'));
await import(moduleURL('js/fmt/loaders2.js'));
const [, , inp, out = '/tmp/out.wav', secs = '20'] = process.argv;
let t0 = performance.now();
const song = L.song_create_load(fs.readFileSync(inp));
if (!song) { console.log('load failed'); process.exit(1); }
console.log('loaded in', (performance.now() - t0).toFixed(1), 'ms:', JSON.stringify(song.title), song.tracker_id,
	'orders', [...song.orderlist.slice(0, 16)].join(','), 'samples', song.samples.filter(s => s.data).length,
	'instruments', song.instruments.filter(Boolean).length, 'patterns', song.patterns.filter(Boolean).length);
app.csf_set_wave_config(song, 44100, 16, 2);
app.csf_set_resampling_mode(song, 1);
song.mix_flags |= 0x100000;
Object.assign(song, { repeat_count: -1, buffer_count: 0, stop_at_order: -1, stop_at_row: -1 });
song.flags &= ~(0x80 | 0x40020 | 0x200);
app.csf_set_current_order(song, 0);
const frames = 44100 * +secs, pcm = new Uint8Array(frames * 4);
t0 = performance.now();
let got = 0;
while (got < frames) {
	const n = app.csf_read(song, pcm.subarray(got * 4, Math.min(frames, got + 4096) * 4), Math.min(4096, frames - got) * 4);
	if (!n) break;
	got += n;
}
const ms = performance.now() - t0;
console.log(`rendered ${got} frames (${(got / 44100).toFixed(1)} s) in ${ms.toFixed(0)} ms = ${((got / 44100) * 1000 / ms).toFixed(1)}x realtime; order ${song.current_order} row ${song.row}`);
const s16 = new Int16Array(pcm.buffer, 0, got * 2);
let peak = 0, sum = 0; for (const v of s16) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
console.log('peak', peak, 'rms', Math.sqrt(sum / s16.length).toFixed(0));
const hdr = Buffer.alloc(44); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + got * 4, 4); hdr.write('WAVEfmt ', 8);
hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(2, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(44100 * 4, 28); hdr.writeUInt16LE(4, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(got * 4, 40);
fs.writeFileSync(out, Buffer.concat([hdr, Buffer.from(pcm.buffer, 0, got * 4)]));
if (missing_calls().length) console.log('missing:', missing_calls());
