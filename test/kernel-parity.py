#!/usr/bin/env python3
"""Compile original mixer macros and compare rendered samples/state."""
import json,re,subprocess,tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
src=(ROOT.parent/'schismtracker/player/mixer.c').read_text()
macros=src[src.index('#define SNDMIX_BEGINSAMPLELOOP'):src.index('//////////////////////////////////////////////////////////\n// Resampling\n')]
header='''
#include <stdint.h>
#include <stdio.h>
#define SCHISM_ALWAYS_INLINE
#define FILTERPRECISION 24
#define VOLUMERAMPPRECISION 12
#define SPLINE_8SHIFT 6
#define SPLINE_16SHIFT 14
#define SPLINE_FRACSHIFT 4
#define SPLINE_FRACMASK 4092
#define WFIR_FRACHALVE 8
#define WFIR_FRACSHIFT 2
#define WFIR_FRACMASK 32760
#define WFIR_8SHIFT 7
#define WFIR_16SHIFT 15
#define CLAMP(x,a,b) ((x)<(a)?(a):((x)>(b)?(b):(x)))
#define rshift_signed(a,b) ((a)>>(b))
#define lshift_signed(a,b) ((a)<<(b))
#define safe_abs_32(x) ((uint32_t)((x)<0?-(int64_t)(x):(x)))
#define avg_u32(a,b) ((uint32_t)(((uint64_t)(a)+(b))/2))
struct song_smp_pos {int64_t v;};
struct song_smp_pos csf_smp_pos_add(struct song_smp_pos a,struct song_smp_pos b){a.v+=b.v;return a;}
int32_t csf_smp_pos_get_whole(struct song_smp_pos a){return a.v>>32;}
uint32_t csf_smp_pos_get_frac(struct song_smp_pos a){return a.v&0xffffffff;}
int64_t csf_smp_pos_get_full(struct song_smp_pos a){return a.v;}
typedef struct {struct song_smp_pos position,increment;void *current_sample_data;uint32_t vu_meter;int32_t left_volume,right_volume,left_ramp,right_ramp,left_ramp_volume,right_ramp_volume;int32_t filter_a0,filter_b0,filter_b1,filter_y[2][2];} song_voice_t;
'''
lut=(ROOT.parent/'schismtracker/include/player/precomp_lut.h').read_text()
rows=[];cases=[]
for bits in [8,16]:
 for stereo in [0,1]:
  for mode,name in enumerate(['','Linear','Spline','FirFilter']):
   for ramp in [0,1]:
    for filt in [0,1]:
     func=('Filter' if filt else '')+('Stereo' if stereo else 'Mono')+str(bits)+'Bit'+name+('Ramp' if ramp else '')+'Mix'
     cases.append([bits,stereo,mode,ramp,filt]);rows.append(func)
main='''
int main(void){
int8_t a[128];int16_t b[128];for(int i=0;i<128;i++){a[i]=(int8_t)(i*73+19);b[i]=(int16_t)(i*7819+113);}
mix_interface_t funcs[]={'''+','.join(rows)+'''};
'''
for index,(bits,stereo,mode,ramp,filt) in enumerate(cases):
 main+='''{song_voice_t c={0};int32_t output[32]={0};
c.position.v=((int64_t)20<<32)+1234567890;c.increment.v=(((int64_t)1<<32)/3);
c.current_sample_data='''+('a' if bits==8 else 'b')+''';c.left_volume=2;c.right_volume=3;
c.left_ramp_volume=8192;c.right_ramp_volume=12288;c.left_ramp=111;c.right_ramp=-77;
c.filter_a0=8388608;c.filter_b0=4194304;c.filter_b1=-2097152;
funcs['''+str(index)+'''](&c,output,output+32);
for(int i=0;i<32;i++)printf("%d ",output[i]);printf("%lld %u %d %d\\n",(long long)c.position.v,c.vu_meter,c.left_volume,c.right_volume);}
'''
main+='}\n'
js='''
const fs=require('fs'),root=process.argv[1],url=s=>'data:text/javascript;base64,'+Buffer.from(s).toString('base64');
let src=fs.readFileSync(root+'/js/mixer.js','utf8');for(const[p,f]of[['./app.js','js/app.js'],['./gen/interpolation.js','js/gen/interpolation.js']])src=src.replace("'"+p+"'",JSON.stringify(url(fs.readFileSync(root+'/'+f,'utf8'))));
const cases=JSON.parse(fs.readFileSync(0,'utf8'));
import(url(src)).then(m=>console.log(JSON.stringify(cases.map(([bits,stereo,mode,ramp,filter])=>{
const data=bits===8?Int8Array.from({length:128},(_,i)=>i*73+19):Int16Array.from({length:128},(_,i)=>i*7819+113);
const c={flags:(bits===16?1:0)|(stereo?64:0),current_sample_data:data,position:{v:(20n<<32n)+1234567890n},increment:{v:(1n<<32n)/3n},vu_meter:0,left_volume:2,right_volume:3,left_ramp_volume:8192,right_ramp_volume:12288,left_ramp:111,right_ramp:-77,filter_a0:8388608,filter_b0:4194304,filter_b1:-2097152,filter_y:[new Int32Array(2),new Int32Array(2)]};
const out=new Int32Array(32);m.mix_kernel(c,out,0,16,mode,!!ramp,!!filter);return[...out,Number(c.position.v),c.vu_meter,c.left_volume,c.right_volume];
}))));
'''
with tempfile.TemporaryDirectory() as tmp:
 c=Path(tmp)/'kernels.c';binary=Path(tmp)/'kernels';c.write_text(header+lut+macros+main)
 subprocess.run(['cc','-O0','-fwrapv',str(c),'-o',str(binary)],check=True)
 expected=[list(map(int,line.split())) for line in subprocess.check_output([str(binary)],text=True).splitlines()]
 actual=json.loads(subprocess.check_output(['node','-e',js,str(ROOT)],input=json.dumps(cases),text=True))
for case,c,js in zip(cases,expected,actual):assert c==js,(case,c,js)
print(f'{len(cases)} kernel variants match compiled upstream C samples, position, VU and ramp state')
