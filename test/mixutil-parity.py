#!/usr/bin/env python3
"""Compare PCM bytes and extrema with compiled upstream mixutil.c."""
import json
import random
import re
import subprocess
import tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
source=(ROOT.parent/'schismtracker/player/mixutil.c').read_text()
source=re.sub(r'^#include.*$', '', source, flags=re.M)
header='''
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#define MIXING_ATTENUATION 5
#define MIXING_CLIPMIN (-0x04000000)
#define MIXING_CLIPMAX 0x03FFFFFF
#define CLAMP(x,a,b) ((x)<(a)?(a):((x)>(b)?(b):(x)))
#define rshift_signed(a,b) ((a) >> (b))
#define lshift_signed(a,b) ((int32_t)((uint32_t)(a) << (b)))
typedef struct {int32_t rofs,lofs;} song_voice_t;
'''
main='''
int main(void){int bits,n;while(scanf("%d %d",&bits,&n)==2){
int32_t buffer[128],mins[2]={0,0},maxs[2]={0,0};unsigned char output[512];
for(int i=0;i<n;i++)scanf("%d",&buffer[i]);uint32_t count=0;
if(bits==8)count=clip_32_to_8(output,buffer,n,mins,maxs);
if(bits==16)count=clip_32_to_16(output,buffer,n,mins,maxs);
if(bits==24)count=clip_32_to_24(output,buffer,n,mins,maxs);
if(bits==32)count=clip_32_to_32(output,buffer,n,mins,maxs);
printf("%u %d %d %d %d",count,mins[0],mins[1],maxs[0],maxs[1]);
for(unsigned i=0;i<count;i++)printf(" %u",output[i]);puts("");}}
'''
rng=random.Random(1266154)
cases=[]
boundaries=[-2147483648,-67108865,-67108864,-1,0,1,67108863,67108864,2147483647]
for bits in [8,16,24,32]:
    cases.append([bits,boundaries])
    for _ in range(250):cases.append([bits,[rng.randrange(-2147483648,2147483648) for _ in range(rng.randrange(1,129))]])
program='''
const fs=require('fs'),root=process.argv[1],url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
const src=fs.readFileSync(root+'/js/mixutil.js','utf8').replace("'./app.js'",JSON.stringify(url(fs.readFileSync(root+'/js/app.js','utf8'))));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
import(url(src)).then(m=>console.log(JSON.stringify(cases.map(([bits,values])=>{
const Type=bits===16?Int16Array:bits===32?Int32Array:Uint8Array;
const out=new Type(values.length*(bits===24?3:1)),mins=[0,0],maxs=[0,0];
const count=m['clip_32_to_'+bits](out,new Int32Array(values),values.length,mins,maxs);
return[count,...mins,...maxs,...new Uint8Array(out.buffer)];
}))));
'''
with tempfile.TemporaryDirectory() as directory:
    c=Path(directory)/'mixutil.c';binary=Path(directory)/'mixutil'
    c.write_text(header+source+main)
    subprocess.run(['cc','-O0','-fwrapv',str(c),'-o',str(binary)],check=True)
    data='\n'.join(' '.join(map(str,[bits,len(values),*values])) for bits,values in cases)
    expected=[list(map(int,line.split())) for line in subprocess.check_output([str(binary)],input=data,text=True).splitlines()]
    actual=json.loads(subprocess.check_output(['node','-e',program,str(ROOT)],input=json.dumps(cases),text=True))
for case,c,js in zip(cases,expected,actual):assert c==js,(case,c,js)
print(f'{len(cases)} PCM buffers ({sum(len(v) for _,v in cases)} samples) match C bytes and extrema')
