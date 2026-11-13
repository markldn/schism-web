#!/usr/bin/env python3
"""Differential pitch/slide checks using actual upstream C function bodies."""
import json
import random
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT.parent / 'schismtracker'
source = (SRC / 'player/effects.c').read_text()

def function(name):
    match = re.search(r'(?:int32_t|uint32_t) ' + name + r'\([^)]*\)\s*\{', source)
    start = match.start()
    end = match.end()
    depth = 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]

names = ['get_frequency_from_note', 'get_note_from_frequency', 'csf_fx_do_freq_slide']
header = (SRC / 'include/player/sndfile.h').read_text()
helpers = header[header.index('static inline SCHISM_CONST SCHISM_ALWAYS_INLINE int32_t _muldiv('):header.index('SCHISM_CONST SCHISM_ALWAYS_INLINE static inline\nuint32_t csf_calculate_tick_length')]
tables = re.sub(r'^#include.*$', '', (SRC / 'player/tables.c').read_text(), flags=re.M)
preamble = '#include <stdint.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <limits.h>\n#define SCHISM_CONST\n#define SCHISM_ALWAYS_INLINE\n#define SONG_LINEARSLIDES 16\n#define rshift_signed(a,b) ((a) >> (b))\n'
main = '''
int main(void) {
 int op,a,b,c,d;
 while(scanf("%d %d %d %d %d", &op,&a,&b,&c,&d)==5) {
  int32_t result = op==0 ? get_frequency_from_note(a,(uint32_t)b)
    : op==1 ? get_note_from_frequency(a,(uint32_t)b)
    : csf_fx_do_freq_slide((uint32_t)a,b,c,d);
  printf("%d\\n",result);
 }
}
'''
rng = random.Random(1266154)
cases = [[0,n,s,0,0] for s in [1,8363,44100,192000] for n in range(121)]
cases += [[1,f,8363,0,0] for f in [0,1,261,8362,8363,8364,16726,999999]]
for flags in [0,16]:
    for frequency in [0,1,2,100,8363,44100,1000000,2147483647]:
        for slide in [-2000,-1020,-16,-15,-1,0,1,15,16,1020,2000]:
            for tone in [0,1]: cases.append([2,flags,frequency,slide,tone])
for _ in range(10000):
    cases.append([2,rng.choice([0,16]),rng.randrange(1,2000000),rng.randrange(-2000,2001),rng.randrange(2)])
with tempfile.TemporaryDirectory() as directory:
    cfile = Path(directory)/'pitch.c'
    binary = Path(directory)/'pitch'
    cfile.write_text(preamble + tables + helpers + '\n'.join(function(n) for n in names) + main)
    subprocess.run(['cc','-O0','-fwrapv',str(cfile),'-o',str(binary)],check=True)
    expected = [int(v) for v in subprocess.check_output([str(binary)],input='\n'.join(' '.join(map(str,c)) for c in cases),text=True).splitlines()]
    program = '''
const fs=require('fs');const root=process.argv[1];
const url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let src=fs.readFileSync(root+'/js/effects.js','utf8');
for(const [path,file] of [['./app.js','js/app.js'],['./gen/tables.js','js/gen/tables.js']])
 src=src.replace("'"+path+"'",JSON.stringify(url(fs.readFileSync(root+'/'+file,'utf8'))));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
import(url(src)).then(m=>console.log(JSON.stringify(cases.map(([op,a,b,c,d])=>op===0?m.get_frequency_from_note(a,b):op===1?m.get_note_from_frequency(a,b):m.csf_fx_do_freq_slide(a,b,c,d)))));
'''
    actual = json.loads(subprocess.check_output(['node','-e',program,str(ROOT)],input=json.dumps(cases),text=True))
for case,c,js in zip(cases,expected,actual):
    assert c == js, (case,c,js)
print(f'{len(cases)} pitch/slide cases identical to compiled upstream C')
