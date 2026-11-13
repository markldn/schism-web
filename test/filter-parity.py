#!/usr/bin/env python3
"""Compare filter coefficient/state output with the actual upstream C code."""
import json
import re
import subprocess
import tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
source=(ROOT.parent/'schismtracker/player/filters.c').read_text()
source=re.sub(r'^#include.*$', '', source, flags=re.M)
header='''
#include <stdint.h>
#include <stdio.h>
#include <math.h>
#define CHN_FILTER 0x4000
#define CHN_NEWNOTE 0x2000000
#define FILTERPRECISION 24
typedef struct {int32_t cutoff,resonance;uint32_t flags;int32_t filter_a0,filter_b0,filter_b1,filter_y[2][2];} song_voice_t;
'''
main='''
int main(void){int cutoff,resonance,modifier,rate,reset;unsigned flags;
while(scanf("%d %d %d %d %d %u",&cutoff,&resonance,&modifier,&rate,&reset,&flags)==6){
song_voice_t c={cutoff,resonance,flags,11,22,33,{{1,2},{3,4}}};
setup_channel_filter(&c,reset,modifier,rate);
printf("%u %d %d %d %d %d %d %d\\n",c.flags,c.filter_a0,c.filter_b0,c.filter_b1,c.filter_y[0][0],c.filter_y[0][1],c.filter_y[1][0],c.filter_y[1][1]);}}
'''
cases=[[c,r,m,rate,reset,flags] for c in range(0,128,3) for r in [0,1,32,64,127] for m in [-128,0,256] for rate in [4000,44100,48000,96000] for reset,flags in [(0,0x4000),(1,0x2004000)]]
cases += [[c,r,256,44100,1,0x2004000] for c in range(128) for r in range(128)]
program='''
const fs=require('fs'),root=process.argv[1],url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let src=fs.readFileSync(root+'/js/filters.js','utf8');
for(const[p,f]of[['./app.js','js/app.js'],['./gen/tables.js','js/gen/tables.js']])src=src.replace("'"+p+"'",JSON.stringify(url(fs.readFileSync(root+'/'+f,'utf8'))));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
import(url(src)).then(m=>console.log(JSON.stringify(cases.map(([cutoff,resonance,modifier,rate,reset,flags])=>{
const c={cutoff,resonance,flags,filter_a0:11,filter_b0:22,filter_b1:33,filter_y:[new Int32Array([1,2]),new Int32Array([3,4])]};
m.setup_channel_filter(c,reset,modifier,rate);return[c.flags,c.filter_a0,c.filter_b0,c.filter_b1,...c.filter_y[0],...c.filter_y[1]];
}))));
'''
with tempfile.TemporaryDirectory() as directory:
    c=Path(directory)/'filter.c';binary=Path(directory)/'filter'
    c.write_text(header+source+main)
    subprocess.run(['cc','-O0',str(c),'-lm','-o',str(binary)],check=True)
    expected=[list(map(int,line.split())) for line in subprocess.check_output([str(binary)],input='\n'.join(' '.join(map(str,c)) for c in cases),text=True).splitlines()]
    actual=json.loads(subprocess.check_output(['node','-e',program,str(ROOT)],input=json.dumps(cases),text=True))
for case,c,js in zip(cases,expected,actual):assert c==js,(case,c,js)
print(f'{len(cases)} filter coefficient/state cases identical to compiled C')
