/**
 * Grade redistribution where it actually applies: player-weeks on a team that
 * had somebody ruled out. Everywhere else it is a no-op by construction, so
 * pooling over the whole league would bury the effect in 95% unchanged rows.
 */
process.env.SCHEDULER_DISABLED='1';
const R = new URL('../server/services/', import.meta.url).href;
const { buildPlayerWeekEngine } = await import(R+'player-week-engine.js');
const { rows } = await import(new URL('../server/db/index.js', import.meta.url).href);
const { PPR, scoreLine } = await import(R+'scoring.js');

const SEASON = Number(process.argv[2] ?? 2025);
const errOn=[], errOff=[], errOnAll=[], errOffAll=[];
for (let week = 5; week <= 17; week++) {
  const actual = new Map(rows(`SELECT u.*, p.name FROM player_week_usage u JOIN players p ON p.id=u.player_id
    WHERE u.season=? AND u.week=?`, SEASON, week).map(r => [r.player_id, scoreLine(r, PPR)]));
  if (!actual.size) continue;
  const on  = buildPlayerWeekEngine({ season: SEASON, week, redistributeVolume: true,  useCache: false });
  const off = buildPlayerWeekEngine({ season: SEASON, week, redistributeVolume: false, useCache: false });
  for (const [pid, a] of actual) {
    const pOn = on.get(pid), pOff = off.get(pid);
    if (!pOn || !pOff) continue;
    errOnAll.push(Math.abs(pOn.ppg - a)); errOffAll.push(Math.abs(pOff.ppg - a));
    if (!pOn.redistribution) continue;              // unchanged rows carry no information
    errOn.push(Math.abs(pOn.ppg - a)); errOff.push(Math.abs(pOff.ppg - a));
  }
  process.stdout.write('.');
}
const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
// paired bootstrap on the affected rows
const diffs = errOn.map((v,i)=>v-errOff[i]);
let s=42424242; const rand=()=>{s^=s<<13;s>>>=0;s^=s>>17;s^=s<<5;s>>>=0;return s/4294967296;};
const boot=[]; for(let b=0;b<3000;b++){let acc=0;for(let i=0;i<diffs.length;i++)acc+=diffs[Math.floor(rand()*diffs.length)];boot.push(acc/diffs.length);}
boot.sort((a,b)=>a-b);
console.log(`\n${SEASON} weeks 5-17`);
console.log(`affected player-weeks: ${errOn.length} of ${errOnAll.length} (${(100*errOn.length/errOnAll.length).toFixed(1)}%)`);
console.log(`  MAE on affected   with ${mean(errOn).toFixed(3)}  without ${mean(errOff).toFixed(3)}  change ${(100*(mean(errOn)-mean(errOff))/mean(errOff)).toFixed(2)}%`);
console.log(`  90% CI of the paired difference: [${boot[Math.floor(3000*0.05)].toFixed(4)}, ${boot[Math.floor(3000*0.95)].toFixed(4)}]  (negative = better)`);
console.log(`  MAE pooled (all)  with ${mean(errOnAll).toFixed(3)}  without ${mean(errOffAll).toFixed(3)}`);
process.exit(0);
