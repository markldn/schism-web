import fs from 'fs';import assert from 'assert/strict';
const root=new URL('../',import.meta.url),url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const src=fs.readFileSync(new URL('js/mixutil.js',root),'utf8').replace("'./app.js'",JSON.stringify(url(fs.readFileSync(new URL('js/app.js',root),'utf8'))));
const m=await import(url(src));
const input=new Int32Array([-2147483648,2147483647,0,-1]);
for(const [bits,Type,expected]of[[8,Uint8Array,[0,255,128,127]],[16,Int16Array,[-32768,32767,0,-1]],[32,Int32Array,[-2147483648,2147483616,0,-32]]]){
const output=new Type(4),mins=[0,0],maxs=[0,0];
assert.equal(m['clip_32_to_'+bits](output,input,4,mins,maxs),bits/8*4);
assert.deepEqual([...output],expected);assert.equal(mins[0],-67108864);assert.equal(maxs[1],67108863);
}
const packed=new Uint8Array(12);m.clip_32_to_24(packed,input,4,[0,0],[0,0]);
assert.deepEqual([...packed],[0,0,128,255,255,127,0,0,0,255,255,255]);
const offsets={rofs:256,lofs:-256},buffer=new Int32Array(4);
m.stereo_fill(buffer,2,offsets);assert.deepEqual([...buffer],[1,-1,1,-1]);assert.deepEqual(offsets,{rofs:254,lofs:-254});
m.end_channel_ofs({rofs:256,lofs:-256},buffer,2);assert.deepEqual([...buffer],[2,-2,2,-2]);
m.mono_from_stereo(buffer,2);assert.deepEqual([...buffer.slice(0,2)],[0,0]);
console.log('Mixer clipping, packed 24-bit output, extrema and offset decay checks passed');
