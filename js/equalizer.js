// Port of player/equalizer.c (GPL-2.0-or-later).
import { provide } from './app.js';
export const audio_settings = { channels: 2, eq_gain: [0,0,0,0], eq_freq: [0,16,96,127], master: { left: 31, right: 31 } };
const f = Math.fround;
export const eq = Array.from({length:12},(_,i)=>({a0:0,a1:0,a2:0,b1:0,b2:0,x1:0,x2:0,y1:0,y2:0,gain:1,center_frequency:[120,600,1200,3000,6000,10000][i%6],enabled:0}));
const muldiv = (a,b,c) => Number(BigInt.asIntN(32,BigInt(a)*BigInt(b)/BigInt(c)));
export function normalize_mono(csf,buffer,samples) {
	const gain=audio_settings.master.left+audio_settings.master.right;
	if(gain===62)return;
	if(!gain)buffer.fill(0,0,samples);
	for(let i=0;i<samples;i++)buffer[i]=muldiv(buffer[i],gain,62);
}
export function normalize_stereo(csf,buffer,samples) {
	const {left,right}=audio_settings.master;
	if(left+right===62)return;
	if(left+right===0)buffer.fill(0,0,samples*2);
	for(let i=0;i<samples*2;i+=2){buffer[i]=muldiv(buffer[i],left,31);buffer[i+1]=muldiv(buffer[i+1],right,31);}
}
export function eq_filter(band,buffer,count,offset=0) {
	const stride=audio_settings.channels===1?1:2;
	for(let i=0;i<count;i+=stride){
		const x=f(buffer[offset+i]);
		const y=f(f(f(f(f(band.a1*band.x1)+f(band.a2*band.x2))+f(band.a0*x))+f(band.b1*band.y1))+f(band.b2*band.y2));
		band.x2=band.x1;band.y2=band.y1;band.x1=x;buffer[offset+i]=Math.trunc(y);band.y1=y;
	}
}
export function eq_mono(csf,buffer,count){for(let b=0;b<6;b++)if(eq[b].enabled&&eq[b].gain!==1)eq_filter(eq[b],buffer,count);}
export function eq_stereo(csf,buffer,count){for(let b=0;b<6;b++){if(eq[b].enabled&&eq[b].gain!==1)eq_filter(eq[b],buffer,count*2);if(eq[b+6].enabled&&eq[b+6].gain!==1)eq_filter(eq[b+6],buffer,count*2,1);}}
export function initialize_eq(reset,freq){
	for(const band of eq){
		if(!band.enabled){for(const key of ['a0','a1','a2','b1','b2','x1','x2','y1','y2'])band[key]=0;continue;}
		const ratio=f(band.center_frequency/f(freq));
		if(ratio>f(0.45))band.gain=1;
		let k=f(ratio*f(3.141592654));k=f(k+f(k*ratio));
		const k2=f(k*k),scale=band.gain<1?0.25:0.5,v0=f(band.gain*scale),v1=scale;
		const denominator=f(f(1+f(v1*k))+k2);
		const coefficients={a0:f(f(f(1+f(v0*k))+k2)/denominator),a1:f(f(2*f(k2-1))/denominator),a2:f(f(f(1-f(v0*k))+k2)/denominator),b1:f(f(-2*f(k2-1))/denominator),b2:f(-f(f(1-f(v1*k))+k2)/denominator)};
		const changed=reset||Object.keys(coefficients).some(key=>band[key]!==coefficients[key]);
		Object.assign(band,coefficients);if(changed)band.x1=band.x2=band.y1=band.y2=0;
	}
}
export function set_eq_gains(gainbuff,gains,freqs,reset,mix_freq){
	for(let i=0;i<6;i++){
		const gain=i<gains?f(1+(gainbuff[i]>>>0)/64):1,frequency=i<gains&&freqs?f(freqs[i]|0):0;
		for(const index of [i,i+6])Object.assign(eq[index],{gain,center_frequency:frequency,enabled:frequency>20&&i<gains?1:0});
	}initialize_eq(reset,mix_freq);
}
provide({normalize_mono,normalize_stereo,eq_mono,eq_stereo,initialize_eq,set_eq_gains});

// audio_playback.c wrapper that derives four UI-controlled band frequencies.
export function song_init_eq(reset,mix_freq){
	const gains=[],frequencies=[];
	for(let i=0;i<4;i++){
		gains[i]=audio_settings.eq_gain[i];
		frequencies[i]=120+Math.trunc((Math.imul(i*128,audio_settings.eq_freq[i])*Math.trunc(mix_freq/128))/1024);
	}
	set_eq_gains(gains,4,frequencies,reset,mix_freq);
}
provide({song_init_eq});
