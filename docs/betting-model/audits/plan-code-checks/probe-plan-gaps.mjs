import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const evidenceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo='/Users/nick_matta/Claude/Artifacts/fantasy-football-dashboard';
// Audited module imports node:crypto only; no database/application initialization.
const {validateForecastPacket,packetHash}=await import(pathToFileURL(repo+'/server/betting/nfl/contracts/forecast-packet.js'));
const base={event:{event_key:'fixture',season:2026,week:3,home:'CAR',away:'CHI',kickoff_at:'2026-09-20T17:00:00Z',schedule_version:'fixture'},market:{market:'spreads',period:'full_game',side:'home',handicap:-2.5,offered_price:-110,bookmaker:'fixture',settlement_rule_version:'ot_included',quote_id:'fixture'},observation:{experiment_id:'fixture',horizon:'T-60',cutoff_at:'2026-09-20T16:00:00Z',job_id:'fixture',observation_id:'fixture',attempt:1},source_lineage:{provider:'fixture',received_at:'2026-09-20T15:45:00Z',receipt_clock_source:'response_completion',mode:'prospective'},feature_lineage:{values:[{name:'x',value:1}],transformation_version:'fixture',missing:[]},forecast:{graph_version:'fixture',forecast_identity:'f'.repeat(64),probability_target:'full_game_spread_cover',calibration_id:'fixture'},decision:{policy_id:'fixture',policy_version:'fixture',qualification_state:'research_only'},integrity:{code_identity:'a'.repeat(64),data_identity_status:'unfrozen_live_tables',schema_version:'nfl-forecast-packet-v1'}};
const mutations={invalid_receipt:p=>p.source_lineage.received_at='bad-clock',empty_features:p=>p.feature_lineage.values={},null_features:p=>p.feature_lineage.values=null,nonfinite_feature:p=>p.feature_lineage.values=[{name:'x',value:NaN}],invalid_odds:p=>p.market.offered_price=0,wrong_market:p=>p.market.market='totals',cutoff_after_kickoff:p=>p.observation.cutoff_at='2026-09-20T18:00:00Z'};
const results={baseline_valid:validateForecastPacket(base).ok,malformed_cases:{}};
for(const [name,mutate] of Object.entries(mutations)){const p=structuredClone(base);mutate(p);results.malformed_cases[name]=validateForecastPacket(p).ok;}
const pnan=structuredClone(base),pnull=structuredClone(base);pnan.feature_lineage.values=[NaN];pnull.feature_lineage.values=[null];results.nonfinite_null_hash_collision=packetHash(pnan)===packetHash(pnull);
const src=fs.readFileSync(repo+'/server/services/nfl-t60-packet.js','utf8');
const start=src.indexOf('export function resolvePacketMarketQuote(packet)');
const end=src.indexOf('\n/**',start);
const pure=src.slice(start,end).replace('export function','function');
const resolver=vm.runInNewContext(pure+'\nresolvePacketMarketQuote',{SHARP_BOOKS:['pinnacle']});
const q=(book,side,line,at)=>({bookmaker_key:book,side_key:side,line,american_price:-110,received_at:at,snapshot_at:at});
const packet=values=>({sources:[{source:'nfl_quote_tape',values}],summary:{eligible:['nfl_quote_tape']},mode:'prospective'});
results.mismatched_handicaps=resolver(packet([q('pinnacle','home',-3,'2026-09-20T15:59:00Z'),q('pinnacle','away',2.5,'2026-09-20T15:30:00Z')]));
results.no_fallback_to_complete_book=resolver(packet([q('pinnacle','away',3,'2026-09-20T15:59:00Z'),q('other','home',-3,'2026-09-20T15:59:00Z'),q('other','away',3,'2026-09-20T15:59:00Z')]));
fs.writeFileSync(path.join(evidenceRoot,'PLAN-CODE-CHECKS.json'),JSON.stringify({reference_inspection_head:'21789a9',executed_at:new Date().toISOString(),mode:'isolated_synthetic_probes_no_database',source_hashes:Object.fromEntries(['server/betting/nfl/contracts/forecast-packet.js','server/services/nfl-t60-packet.js'].map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(repo+'/'+p)).digest('hex')])),results},null,2)+'\n');
console.log(JSON.stringify(results,null,2));
