// Browser replacement for schism/dmoz.c: a virtual disk kept in IndexedDB.
// Paths look like "/Modules/song.it". Directories exist implicitly (any path
// prefix) or explicitly (empty marker entries). Files are imported from the
// real disk with a file picker or drag-and-drop, and saved files can also be
// downloaded.
import { provide } from './app.js';
import { status, NEED_UPDATE, DIR_MODULES_CHANGED, DIR_SAMPLES_CHANGED, DIR_INSTRUMENTS_CHANGED } from './state.js';

const files = new Map();   // path -> { data: Uint8Array, mtime: number }
const dirs = new Set(['/', '/Modules', '/Samples', '/Instruments', '/Demo']);
let db = null;

function idb() {
	if (db) return Promise.resolve(db);
	return new Promise((resolve) => {
		let req;
		try { req = indexedDB.open('schism-tracker', 1); } catch { resolve(null); return; }
		req.onupgradeneeded = () => req.result.createObjectStore('files');
		req.onsuccess = () => { db = req.result; resolve(db); };
		req.onerror = () => resolve(null);
	});
}
async function idb_put(path, value) {
	const d = await idb();
	if (!d) return;
	d.transaction('files', 'readwrite').objectStore('files').put(value, path);
}
async function idb_delete(path) {
	const d = await idb();
	if (!d) return;
	d.transaction('files', 'readwrite').objectStore('files').delete(path);
}

export async function dmoz_init() {
	const d = await idb();
	if (d) {
		await new Promise((resolve) => {
			const req = d.transaction('files').objectStore('files').openCursor();
			req.onsuccess = () => {
				const c = req.result;
				if (!c) { resolve(); return; }
				const v = c.value;
				if (v && v.dir) dirs.add(c.key);
				else if (v && v.data) files.set(c.key, { data: new Uint8Array(v.data), mtime: v.mtime || Date.now() });
				c.continue();
			};
			req.onerror = () => resolve();
		});
	}
	for (const p of files.keys()) add_parent_dirs(p);
	// bundled demo files (served next to the page)
	for (const name of ['demo/tute.it']) {
		const path = '/Demo/' + name.split('/').pop();
		if (files.has(path)) continue;
		try {
			const r = await fetch(name);
			if (r.ok) files.set(path, { data: new Uint8Array(await r.arrayBuffer()), mtime: Date.now(), bundled: true });
		} catch { /* offline */ }
	}
	status.flags |= DIR_MODULES_CHANGED | DIR_SAMPLES_CHANGED | DIR_INSTRUMENTS_CHANGED | NEED_UPDATE;
}

export const dmoz_path_get_basename = p => p.replace(/\/+$/, '').split('/').pop() || '/';
export const dmoz_path_get_extension = p => { const b = dmoz_path_get_basename(p), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export function dmoz_path_get_parent(p) {
	const parts = p.replace(/\/+$/, '').split('/');
	parts.pop();
	return parts.join('/') || '/';
}
export function dmoz_path_concat(dir, name) {
	if (name.startsWith('/')) return dmoz_path_normal(name);
	return dmoz_path_normal((dir.endsWith('/') ? dir : dir + '/') + name);
}
export function dmoz_path_normal(p) {
	const out = [];
	for (const part of p.split('/')) {
		if (!part || part === '.') continue;
		if (part === '..') out.pop(); else out.push(part);
	}
	return '/' + out.join('/');
}
function add_parent_dirs(p) {
	let d = dmoz_path_get_parent(p);
	while (!dirs.has(d)) { dirs.add(d); d = dmoz_path_get_parent(d); }
}

export function dmoz_is_dir(p) { return dirs.has(dmoz_path_normal(p)); }
export function dmoz_file_exists(p) { return files.has(dmoz_path_normal(p)); }
export function dmoz_read_file(p) { const f = files.get(dmoz_path_normal(p)); return f ? f.data : null; }
export function dmoz_write_file(p, data) {
	p = dmoz_path_normal(p);
	const v = { data: data instanceof Uint8Array ? data : new Uint8Array(data), mtime: Date.now() };
	files.set(p, v);
	add_parent_dirs(p);
	idb_put(p, { data: v.data.slice().buffer, mtime: v.mtime });
	status.flags |= DIR_MODULES_CHANGED | DIR_SAMPLES_CHANGED | DIR_INSTRUMENTS_CHANGED;
}
export function dmoz_remove(p) {
	p = dmoz_path_normal(p);
	if (files.delete(p)) idb_delete(p);
	else if (dirs.has(p) && p !== '/') {
		for (const f of [...files.keys()]) if (f.startsWith(p + '/')) { files.delete(f); idb_delete(f); }
		for (const d of [...dirs]) if (d === p || d.startsWith(p + '/')) { dirs.delete(d); idb_delete(d); }
	}
	status.flags |= DIR_MODULES_CHANGED | DIR_SAMPLES_CHANGED | DIR_INSTRUMENTS_CHANGED;
}
export function dmoz_mkdir(p) {
	p = dmoz_path_normal(p);
	add_parent_dirs(p + '/x');
	idb_put(p, { dir: true });
}
export function dmoz_mtime(p) { const f = files.get(dmoz_path_normal(p)); return f ? f.mtime : 0; }

// list a directory: { files: [{path, base, size, mtime}], dirs: [{path, base}] }
export function dmoz_read_directory(dir) {
	dir = dmoz_path_normal(dir);
	const prefix = dir === '/' ? '/' : dir + '/';
	const out = { files: [], dirs: [] };
	if (dir !== '/') out.dirs.push({ path: dmoz_path_get_parent(dir), base: '..' });
	const sub = new Set();
	for (const d of dirs) if (d !== dir && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) sub.add(d);
	for (const d of [...sub].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1)) out.dirs.push({ path: d, base: dmoz_path_get_basename(d) });
	for (const [p, f] of files) {
		if (!p.startsWith(prefix) || p.slice(prefix.length).includes('/')) continue;
		out.files.push({ path: p, base: dmoz_path_get_basename(p), size: f.data.length, mtime: f.mtime, data: f.data });
	}
	out.files.sort((a, b) => a.base.toLowerCase() < b.base.toLowerCase() ? -1 : a.base.toLowerCase() > b.base.toLowerCase() ? 1 : 0);
	return out;
}

// give the user a copy of a file
export function download_file(name, data) {
	try {
		const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
		const a = document.createElement('a');
		a.href = url; a.download = name;
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10000);
	} catch { /* not in a browser */ }
}

// open the browser's file picker; imported files land in `dir`
export function dmoz_import_files(dir, done) {
	const input = document.createElement('input');
	input.type = 'file';
	input.multiple = true;
	input.onchange = async () => {
		const names = [];
		for (const f of input.files) {
			dmoz_write_file(dmoz_path_concat(dir, f.name), new Uint8Array(await f.arrayBuffer()));
			names.push(f.name);
		}
		status.flags |= NEED_UPDATE;
		if (done) done(names);
	};
	input.click();
}

provide({ dmoz_init, dmoz_read_file, dmoz_write_file, dmoz_remove, dmoz_read_directory, download_file,
	dmoz_import_files, dmoz_path_concat, dmoz_path_get_basename, dmoz_is_dir, dmoz_file_exists, dmoz_mkdir });
