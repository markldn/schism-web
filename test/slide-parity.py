#!/usr/bin/env python3
"""Compile upstream slide handlers and compare state mutations with JavaScript."""
import json
import re
import subprocess
import tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
source = (ROOT.parent / 'schismtracker/player/effects.c').read_text()
names = ['fx_volume_up','fx_volume_down','fx_volume_slide','fx_panning_slide','fx_channel_vol_slide','fx_global_vol_slide']
def extract(name):
    match = re.search(r'static void '+name+r'\([^)]*\)\s*\{', source)
    end = match.end(); depth = 1
    while depth:
        depth += (source[end]=='{')-(source[end]=='}'); end += 1
    return source[match.start():end]
preamble = '''
#include <stdint.h>
#include <stdio.h>
#define SONG_FIRSTTICK 4096
#define CHN_SURROUND 2048
#define CLAMP(x,a,b) ((x)<(a)?(a):((x)>(b)?(b):(x)))
typedef struct {int32_t volume,panning,global_volume,channel_panning,panbrello_delta;uint32_t flags,mem_volslide,mem_panslide,mem_channel_volslide,mem_global_volslide;} song_voice_t;
typedef struct {uint32_t flags;int32_t current_global_volume;} song_t;
'''
main = '''
int main(void) {
 int op,first,param,initial,memory;
 while(scanf("%d %d %d %d %d",&op,&first,&param,&initial,&memory)==5) {
  song_voice_t c={0};song_t s={0};
  c.volume=c.panning=c.global_volume=initial;c.channel_panning=99;c.panbrello_delta=42;c.flags=2048;
  c.mem_volslide=c.mem_panslide=c.mem_channel_volslide=c.mem_global_volslide=memory;
  s.flags=first;s.current_global_volume=initial;
  if(op==0)fx_volume_slide(first,&c,param);
  if(op==1)fx_panning_slide(first,&c,param);
  if(op==2)fx_channel_vol_slide(first,&c,param);
  if(op==3)fx_global_vol_slide(&s,&c,param);
  printf("%d %d %d %d %d %u %u %u %u %u %d\\n",c.volume,c.panning,c.global_volume,c.channel_panning,c.panbrello_delta,c.flags,c.mem_volslide,c.mem_panslide,c.mem_channel_volslide,c.mem_global_volslide,s.current_global_volume);
 }
}
'''
cases=[]
for op,limit in [(0,256),(1,256),(2,64),(3,128)]:
    for first in [0,4096]:
        for initial in [0,1,limit//2,limit-1,limit]:
            for param in range(256):cases.append([op,first,param,initial,0x23])
program = '''
const fs=require('fs'),root=process.argv[1];const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let src=fs.readFileSync(root+'/js/effects.js','utf8');
for(const [p,f] of [['./app.js','js/app.js'],['./gen/tables.js','js/gen/tables.js']])src=src.replace("'"+p+"'",JSON.stringify(url(fs.readFileSync(root+'/'+f,'utf8'))));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
import(url(src)).then(m=>console.log(JSON.stringify(cases.map(([op,first,param,initial,memory])=>{
const c={volume:initial,panning:initial,global_volume:initial,channel_panning:99,panbrello_delta:42,flags:2048,mem_volslide:memory,mem_panslide:memory,mem_channel_volslide:memory,mem_global_volslide:memory};const s={flags:first,current_global_volume:initial};
if(op===0)m.fx_volume_slide(first,c,param);if(op===1)m.fx_panning_slide(first,c,param);if(op===2)m.fx_channel_vol_slide(first,c,param);if(op===3)m.fx_global_vol_slide(s,c,param);
return [...Object.values(c),s.current_global_volume];
}))));
'''
with tempfile.TemporaryDirectory() as directory:
    cfile=Path(directory)/'slides.c';binary=Path(directory)/'slides'
    cfile.write_text(preamble+'\n'.join(extract(n) for n in names)+main)
    subprocess.run(['cc',str(cfile),'-o',str(binary)],check=True)
    expected=[list(map(int,line.split())) for line in subprocess.check_output([str(binary)],input='\n'.join(' '.join(map(str,c)) for c in cases),text=True).splitlines()]
    actual=json.loads(subprocess.check_output(['node','-e',program,str(ROOT)],input=json.dumps(cases),text=True))
for case,c,js in zip(cases,expected,actual):assert c==js,(case,c,js)
print(f'{len(cases)} volume/panning/channel/global slide states identical to compiled C')
