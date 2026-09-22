const DB = '/tmp/claude-0/-home-user-gridiron-hq/88465833-631d-5966-a586-9b2d13123842/scratchpad/gridiron.sqlite';
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB, { readOnly: true });
const THREE_RUSH=[{key:'goal_line_carries',subtractFrom:null},{key:'red_zone_carries',subtractFrom:'goal_line_carries'},{key:'carries',subtractFrom:'red_zone_carries'}];
const THREE_REC=[{key:'end_zone_targets',subtractFrom:null},{key:'red_zone_targets',subtractFrom:'end_zone_targets'},{key:'targets',subtractFrom:'red_zone_targets'}];
const FOUR_RUSH=[{key:'goal_line_carries',subtractFrom:null},{key:'inside_10_carries',subtractFrom:'goal_line_carries'},{key:'red_zone_carries',subtractFrom:'inside_10_carries',fallbackSubtractFrom:'goal_line_carries'},{key:'carries',subtractFrom:'red_zone_carries'}];
const FOUR_REC=[{key:'goal_to_go_targets',subtractFrom:null},{key:'end_zone_targets',subtractFrom:'goal_to_go_targets'},{key:'red_zone_targets',subtractFrom:'end_zone_targets'},{key:'targets',subtractFrom:'red_zone_targets'}];
const S3R={goal_line_carries:.15,red_zone_carries:.06,carries:.01}, S3C={end_zone_targets:.30,red_zone_targets:.12,targets:.03};
const S4R={goal_line_carries:.15,inside_10_carries:.16,red_zone_carries:.045,carries:.01}, S4C={goal_to_go_targets:.38,end_zone_targets:.29,red_zone_targets:.135,targets:.03};
const excl=(f,cs)=>{const o={};for(const c of cs){const raw=f[c.key]??0;const ab=c.subtractFrom==null?0:Math.max(f[c.subtractFrom]??0,c.fallbackSubtractFrom==null?0:f[c.fallbackSubtractFrom]??0);o[c.key]=Math.max(0,raw-ab);}return o;};
const gOf=p=>p==='QB'?'QB':p==='RB'?'RB':'REC'; const GR=['QB','RB','REC'];
const load=ss=>db.prepare(`SELECT season,week,player_id,position,features FROM nfl_player_week_features WHERE season IN (${ss.map(()=>'?').join(',')})`).all(...ss).map(r=>({...r,x:JSON.parse(r.features)}));
function fit(rws,R,C,sr,sc){const bl=cs=>Object.fromEntries(cs.map(c=>[c.key,{opp:0,td:0}]));let rr=Object.fromEntries(GR.map(g=>[g,{...sr}])),cr=Object.fromEntries(GR.map(g=>[g,{...sc}]));
 for(let i=0;i<12;i++){const ru=Object.fromEntries(GR.map(g=>[g,bl(R)])),re=Object.fromEntries(GR.map(g=>[g,bl(C)]));
 for(const f of rws){const x=f.x,g=gOf(f.position),ro=excl(x,R),co=excl(x,C);
  const rE=R.reduce((s,c)=>s+ro[c.key]*rr[g][c.key],0),cE=C.reduce((s,c)=>s+co[c.key]*cr[g][c.key],0);
  for(const c of R){ru[g][c.key].opp+=ro[c.key];if(rE>0)ru[g][c.key].td+=(x.rushing_tds??0)*(ro[c.key]*rr[g][c.key])/rE;}
  for(const c of C){re[g][c.key].opp+=co[c.key];if(cE>0)re[g][c.key].td+=(x.receiving_tds??0)*(co[c.key]*cr[g][c.key])/cE;}}
 rr=Object.fromEntries(GR.map(g=>[g,Object.fromEntries(R.map(c=>[c.key,ru[g][c.key].opp>=200?ru[g][c.key].td/ru[g][c.key].opp:rr[g][c.key]]))]));
 cr=Object.fromEntries(GR.map(g=>[g,Object.fromEntries(C.map(c=>[c.key,re[g][c.key].opp>=200?re[g][c.key].td/re[g][c.key].opp:cr[g][c.key]]))]));}
 return {rr,cr};}
const err=(f,R,C,rt)=>{const x=f.x,g=gOf(f.position),ro=excl(x,R),co=excl(x,C);
 const opp=R.reduce((s,c)=>s+ro[c.key],0)+C.reduce((s,c)=>s+co[c.key],0); if(opp<=0)return null;
 const e=R.reduce((s,c)=>s+ro[c.key]*rt.rr[g][c.key],0)+C.reduce((s,c)=>s+co[c.key]*rt.cr[g][c.key],0);
 const a=(x.rushing_tds??0)+(x.receiving_tds??0); return Math.abs(e-a);};
const train=load([2022,2023,2024]), test=load([2025]);
/* Which half earns the improvement? Each arm scored against the same 3/3
   baseline, paired on the same rows, player-clustered, seed 20260917. */
const ARMS = [
  ['rushing tiers alone  ', FOUR_RUSH, THREE_REC, S4R, S3C],
  ['receiving tiers alone', THREE_RUSH, FOUR_REC, S3R, S4C],
  ['both (shipped)       ', FOUR_RUSH, FOUR_REC, S4R, S4C]
];
const rBase = fit(train, THREE_RUSH, THREE_REC, S3R, S3C);
const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
console.log(`fit rows ${train.length}, test rows ${test.length}\n`);
for (const [name, R, C, sr, sc] of ARMS) {
  const rt = fit(train, R, C, sr, sc);
  const byPlayer = new Map(); let rows = 0;
  for (const f of test) {
    const a = err(f, THREE_RUSH, THREE_REC, rBase), b = err(f, R, C, rt);
    if (a == null || b == null) continue;
    rows++;
    if (!byPlayer.has(f.player_id)) byPlayer.set(f.player_id, []);
    byPlayer.get(f.player_id).push(b - a);
  }
  const players = [...byPlayer.keys()];
  const all = [].concat(...byPlayer.values());
  const obs = mean(all);
  let seed = 20260917; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const boots = [];
  for (let b = 0; b < 2000; b++) {
    let s = 0, n = 0;
    for (let i = 0; i < players.length; i++) {
      for (const d of byPlayer.get(players[Math.floor(rnd() * players.length)])) { s += d; n++; }
    }
    boots.push(s / n);
  }
  boots.sort((x, y) => x - y);
  const lo = boots[Math.floor(0.025 * boots.length)], hi = boots[Math.floor(0.975 * boots.length)];
  const excl = (lo < 0 && hi < 0) || (lo > 0 && hi > 0);
  console.log(`${name}  mean ${obs.toFixed(6)}  95% CI [${lo.toFixed(6)}, ${hi.toFixed(6)}]  ` +
    `${excl ? 'EXCLUDES zero' : 'includes zero'}   rows ${rows}, players ${players.length}`);
}
db.close();
