import fs from 'node:fs';
const S = process.argv[2];
function splitCsv(line){const out=[];let cur='',q=false;
  for(let i=0;i<line.length;i++){const c=line[i];
    if(c==='"'){q=!q;continue;} if(c===','&&!q){out.push(cur);cur='';continue;} cur+=c;}
  out.push(cur);return out;}
const num = v => { if (v==null||String(v).trim()==='') return null; const n=Number(v); return Number.isFinite(n)?n:null; };

function report(file, cols, dropCols){
  const lines = fs.readFileSync(`${S}/${file}`,'utf8').split('\n');
  const header = splitCsv(lines[0]).map(h=>h.trim());
  const idx = Object.fromEntries(header.map((h,i)=>[h,i]));
  const acc = {}; for(const c of cols) acc[c]={blank:0,zero:0,pos:0,sum:0,cnt:0,sumNZ:0,cntNZ:0,zeroOnDrop:0};
  let rows=0;
  for(const raw of lines.slice(1)){
    if(!raw.trim())continue; rows++;
    const p = splitCsv(raw);
    const drop = dropCols ? dropCols.some(c => String(p[idx[c]]??'').trim()!=='') : null;
    for(const c of cols){
      const a=acc[c]; const s=String(p[idx[c]]??'').trim(); const v=num(p[idx[c]]);
      if(s===''){a.blank++;} else if(v===0){a.zero++; if(drop)a.zeroOnDrop++;} else a.pos++;
      if(v!==null){a.sum+=v;a.cnt++; if(v!==0){a.sumNZ+=v;a.cntNZ++;}}
    }
  }
  console.log(`\n=== ${file}  rows=${rows} ===`);
  for(const c of cols){const a=acc[c];
    console.log(`${c}`);
    console.log(`   blank(->NULL)=${a.blank}  literal0(->0)=${a.zero}  positive=${a.pos}`
      + (dropCols?`  zeros on a charted dropback=${a.zeroOnDrop}`:''));
    console.log(`   AVG raw=${a.cnt?(a.sum/a.cnt).toFixed(4):'n/a'} (n=${a.cnt})   AVG NULLIF=${a.cntNZ?(a.sumNZ/a.cntNZ).toFixed(4):'n/a'} (n=${a.cntNZ})`);
  }
}
report('ftn_2024.csv', ['n_defense_box','n_blitzers','n_pass_rushers']);
report('part_2024.csv', ['defenders_in_box','number_of_pass_rushers'],
  ['defense_man_zone_type','defense_coverage_type']);
