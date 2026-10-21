#!/usr/bin/env node
// Synthetic VM timings for the actual client queue and destination-read functions.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {performance}=require('node:perf_hooks');
const root=path.resolve(__dirname,'..');
const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
(async()=>{for(const mode of ['baseline','updated']){
 const source=name=>mode==='baseline'?execFileSync('git',['show',(process.env.DCC_PROFILE_BASE||'71091e9')+':public/js/'+name+'.js'],{cwd:root,encoding:'utf8'}):fs.readFileSync(path.join(root,'public/js',name+'.js'),'utf8');
 const state=source('state');const rows=new Map(['a','b','c','d'].map(id=>[id,{id,properties:{title:id}}]));
 const ctx={console,window:{blockStore:{updateBlock:async(id,properties)=>{await pause();rows.set(id,{id,properties});return rows.get(id);}}},_rowForDateWrite:async id=>rows.get(id)};
 vm.createContext(ctx);vm.runInContext(state.slice(state.search(/(?:let _rowPropsChain|const _rowPropsChains)=/),state.indexOf('// ── C6b:')),ctx);
 let start=performance.now();await Promise.all([...rows.keys()].map(id=>ctx.enqueueRowPropsWrite(id,p=>({...p,title:'new'}))));const fourIndependentWritesMs=performance.now()-start;
 const day=source('day-context'),dayCtx={_resolveKnownState:()=>null,_root:{fetch:async()=>{await pause();return {json:async()=>[]};}},buildDayContext:()=>({})};vm.createContext(dayCtx);
 vm.runInContext(day.slice(day.indexOf('  async function _loadDayContext('),day.indexOf('  function getDayContext(')),dayCtx);
 start=performance.now();await dayCtx._loadDayContext('2026-10-21');console.log(JSON.stringify({mode,fourIndependentWritesMs,destinationReadsMs:performance.now()-start}));
}})().catch(error=>{console.error(error);process.exitCode=1;});
