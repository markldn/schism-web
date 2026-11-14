// Instrument save round trip: every instrument of each module -> ITI and XI -> reload,
// compare sample data, loops, envelopes and the sample map.
//   node test/instsave.mjs file.xm file.it ...
import fs from 'fs';
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
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
let fail = 0, tested = 0;
for (const f of process.argv.slice(2)) {
	const song = L.song_create_load(fs.readFileSync(f));
	if (!song) { console.log('SKIP', f); continue; }
	for (let n = 1; n < song.instruments.length; n++) {
		const ins = song.instruments[n];
		if (!ins || ![...ins.sample_map].some(s => s > 0 && song.samples[s]?.data)) continue;
		for (const fmt of SV.instrument_save_formats) {
			const bytes = fmt.save(song, ins);
			if (!bytes) continue;
			const got = I.fmt_load_instrument('x' + fmt.ext, bytes, () => CS.csf_allocate().samples[1]);
			const errs = [];
			if (!got) errs.push('load failed');
			else {
				const map = new Map();
				for (let j = fmt.label === 'XI' ? 12 : 0; j < (fmt.label === 'XI' ? 108 : 120); j++) {
					const o = ins.sample_map[j], r = got.ins.sample_map[j];
					if (!o) continue;
					if (!map.has(o)) map.set(o, r);
					if (map.get(o) !== r) { errs.push(`map ${j}`); break; }
				}
				for (const [o, r] of map) {
					if (fmt.label === 'XI' && [...map.keys()].indexOf(o) >= 16) continue; // XI maps at most 16 samples (C clamps on load)
					const a = song.samples[o], b = got.samples[r - 1];
					if (!b) { errs.push(`sample ${o} missing`); continue; }
					if (!a.data || !a.length) continue;
					if (!b.data) { errs.push(`no data ${o} len ${a.length}/${b.length}`); continue; }
					if (!same(a.data.subarray(0, a.length * (a.flags & 0x40 ? 2 : 1)), b.data.subarray(0, a.length * (a.flags & 0x40 ? 2 : 1)))) errs.push(`data ${o}`);
					for (const k of ['length', 'loop_start', 'loop_end']) if (a[k] !== b[k]) errs.push(`${k} ${o} ${a[k]}!=${b[k]}`);
					if ((a.volume >> 2) !== (b.volume >> 2)) errs.push(`volume ${o}`);
					if (fmt.label === 'ITI') for (const k of ['global_volume', 'c5speed', 'vib_type', 'vib_depth', 'vib_speed', 'vib_rate', 'sustain_start', 'sustain_end']) if (a[k] !== b[k]) errs.push(`${k} ${o}`);
				}
				for (const e of ['vol_env', 'pan_env']) {
					const ea = ins[e], eb = got.ins[e], nn = Math.min(ea.nodes, fmt.label === 'XI' ? 12 : 25);
					if (nn < 2) continue; // IT loading resets envelopes with fewer than 2 nodes
					if (eb.nodes !== nn) errs.push(`${e}.nodes ${ea.nodes}/${eb.nodes}`);
					for (let k = 0; k < nn; k++) if (ea.ticks[k] !== eb.ticks[k] || ea.values[k] !== eb.values[k]) { errs.push(`${e}[${k}]`); break; }
				}
			}
			tested++;
			if (errs.length) { fail++; console.log(`FAIL ${fmt.label} ${f} #${n}: ${errs.slice(0, 5).join(', ')}`); }
		}
	}
}
console.log(`${tested} instrument saves checked, ${fail} failed`);
process.exit(fail ? 1 : 0);
