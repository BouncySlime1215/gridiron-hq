import { Router } from 'express';
import { db, rows, row, run } from '../db/index.js';

const r = Router();

db.exec(`
  CREATE TABLE IF NOT EXISTS player_accolades (
    roster_player_id INTEGER PRIMARY KEY REFERENCES roster_players(id),
    name TEXT,
    pro_bowls INTEGER DEFAULT 0,
    first_team_all_pro INTEGER DEFAULT 0,
    second_team_all_pro INTEGER DEFAULT 0,
    super_bowls INTEGER DEFAULT 0,
    major_awards TEXT,              -- MVP / OPOY / DPOY / OROY / DROY etc
    all_rookie INTEGER DEFAULT 0,
    draft_round INTEGER,
    draft_pick INTEGER,
    draft_year INTEGER,
    source TEXT,
    fetched_at TEXT
  );
`);

const WIKI_API = 'https://en.wikipedia.org/w/api.php';

/** Pull the infobox "highlights" block and count accolades. */
function parseHighlights(wikitext) {
  const block = wikitext.match(/highlights\s*=([\s\S]{0,4000}?)(?:\n\s*\|\s*[a-zA-Z_]+\s*=|\n\}\})/i);
  const text = block ? block[1] : '';
  const num = re => {
    const m = text.match(re);
    if (!m) return 0;
    return m[1] ? Number(m[1]) : 1;
  };
  const majors = [];
  for (const [label, re] of [
    ['NFL MVP', /NFL Most Valuable Player|\bNFL MVP\b/i],
    ['Super Bowl MVP', /Super Bowl MVP/i],
    ['Offensive Player of the Year', /Offensive Player of the Year/i],
    ['Defensive Player of the Year', /Defensive Player of the Year/i],
    ['Offensive Rookie of the Year', /Offensive Rookie of the Year/i],
    ['Defensive Rookie of the Year', /Defensive Rookie of the Year/i],
    ['Comeback Player of the Year', /Comeback Player of the Year/i]
  ]) if (re.test(text)) majors.push(label);

  return {
    pro_bowls: num(/(\d+)×\s*\[?\[?Pro Bowl/i) || (/\[\[Pro Bowl/i.test(text) ? 1 : 0),
    first_team_all_pro: num(/(\d+)×\s*First-team\s*\[?\[?All-Pro/i) || (/First-team\s*\[?\[?All-Pro/i.test(text) ? 1 : 0),
    second_team_all_pro: num(/(\d+)×\s*Second-team\s*\[?\[?All-Pro/i) || (/Second-team\s*\[?\[?All-Pro/i.test(text) ? 1 : 0),
    super_bowls: num(/(\d+)×\s*\[?\[?Super Bowl champion/i) || (/Super Bowl\s*(champion|[IVXL]+\s*champion)/i.test(text) ? 1 : 0),
    all_rookie: /All-Rookie/i.test(text) ? 1 : 0,
    major_awards: majors.join(', ') || null,
    found: !!block
  };
}

/**
 * Resolve a player's Wikipedia article and pull its infobox highlights.
 * Direct title guesses fail for most NFL players (pages are disambiguated as
 * "Name (American football)"), so we search and fetch content in one call, then
 * verify the article is actually about this player before trusting it.
 */
async function wikiHighlights(name, { position, college } = {}) {
  const search = `${name} American football ${position ?? ''}`.trim();
  const url = `${WIKI_API}?action=query&generator=search&gsrsearch=${encodeURIComponent(search)}`
    + `&gsrlimit=3&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2`;
  let resp = await fetch(url, { headers: { 'User-Agent': 'GridironHQ/1.0 (local personal use)' } });
  if (resp.status === 429 || resp.status === 503) {
    await new Promise(r => setTimeout(r, 2500));
    resp = await fetch(url, { headers: { 'User-Agent': 'GridironHQ/1.0 (local personal use)' } });
  }
  if (!resp.ok) { const e = new Error(`wiki ${resp.status}`); e.rateLimited = resp.status === 429; throw e; }
  const data = await resp.json();
  const pages = data?.query?.pages ?? [];

  // Only trust an article whose TITLE is this player. Body mentions are not
  // enough: searching "Myles Garrett" surfaces Mason Rudolph's article, and
  // "Sauce Gardner" surfaces a team-mate's. Wrong accolades are worse than none.
  const norm = x => x.toLowerCase().replace(/[.'’-]/g, '').replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '').replace(/\s+/g, ' ').trim();
  const want = norm(name);

  for (const page of pages) {
    const text = page?.revisions?.[0]?.slots?.main?.content;
    if (!text || !page.title) continue;
    // strip any "(American football)" style qualifier before comparing
    const title = norm(page.title.replace(/\s*\([^)]*\)\s*$/, ''));
    if (title !== want) continue;
    if (!/american football|national football league/i.test(text.slice(0, 4000))) continue;
    const parsed = parseHighlights(text);
    return { ...parsed, title: page.title };
  }
  return null;
}

/** ESPN draft round / pick / year. */
async function espnDraft(espnId, season) {
  const url = `https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/athletes/${espnId}?lang=en`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return null;
  const d = await resp.json();
  if (!d.draft) return null;
  return { round: d.draft.round ?? null, pick: d.draft.selection ?? null, year: d.draft.year ?? null };
}

/**
 * Sync accolades for depth-chart starters (the players the diagrams show).
 * Wikipedia + ESPN draft data; both free, both rate-limited politely.
 */
export async function syncAccolades({ onlyStarters = true, limit = 0 } = {}) {
  // resumable: skip anyone already verified against Wikipedia
  let targets = rows(`SELECT rp.id, rp.name, rp.espn_id, rp.depth_order, rp.position
                      FROM roster_players rp
                      LEFT JOIN player_accolades a ON a.roster_player_id = rp.id
                      WHERE rp.espn_id IS NOT NULL
                        ${onlyStarters ? 'AND rp.depth_order = 1 AND rp.depth_slot IS NOT NULL' : ''}
                        AND (a.source IS NULL OR a.source <> 'wikipedia+espn')
                      ORDER BY rp.team_id, rp.depth_slot`);
  if (limit) targets = targets.slice(0, limit);

  const upsert = db.prepare(`INSERT INTO player_accolades
    (roster_player_id, name, pro_bowls, first_team_all_pro, second_team_all_pro, super_bowls,
     major_awards, all_rookie, draft_round, draft_pick, draft_year, source, fetched_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(roster_player_id) DO UPDATE SET
      pro_bowls=excluded.pro_bowls, first_team_all_pro=excluded.first_team_all_pro,
      second_team_all_pro=excluded.second_team_all_pro, super_bowls=excluded.super_bowls,
      major_awards=excluded.major_awards, all_rookie=excluded.all_rookie,
      draft_round=excluded.draft_round, draft_pick=excluded.draft_pick, draft_year=excluded.draft_year,
      fetched_at=excluded.fetched_at`);

  const season = Number(process.env.NFL_SEASON) || 2026;
  let done = 0, withAccolades = 0, wikiOk = 0, wikiFailed = 0;
  const BATCH = 2;
  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(async t => {
      let hi = null, failed = false;
      try { hi = await wikiHighlights(t.name, { position: t.position }); }
      catch { failed = true; }
      const draft = await espnDraft(t.espn_id, season).catch(() => null);
      return { t, hi, draft, failed };
    }));
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const { t, hi, draft, failed } = res.value;
      if (failed) wikiFailed++; else if (hi) wikiOk++;
      upsert.run(t.id, t.name, hi?.pro_bowls ?? 0, hi?.first_team_all_pro ?? 0,
        hi?.second_team_all_pro ?? 0, hi?.super_bowls ?? 0, hi?.major_awards ?? null,
        hi?.all_rookie ?? 0, draft?.round ?? null, draft?.pick ?? null, draft?.year ?? null,
        hi?.found ? 'wikipedia+espn' : 'espn');
      done++;
      if ((hi?.pro_bowls ?? 0) > 0 || (hi?.first_team_all_pro ?? 0) > 0) withAccolades++;
    }
    await new Promise(r => setTimeout(r, 700));  // Wikipedia rate-limits anon clients
  }
  return { processed: done, wiki_verified: wikiOk, wiki_failed: wikiFailed,
           with_accolades: withAccolades, remaining: Math.max(0, targets.length - done) };
}

r.post('/sync', async (req, res, next) => {
  try {
    res.json(await syncAccolades({
      onlyStarters: req.query.all !== 'true',
      limit: Number(req.query.limit) || 0
    }));
  } catch (e) { next(e); }
});

r.get('/:abbr', (req, res) => {
  const team = row('SELECT id, abbr FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
  if (!team) return res.status(404).json({ error: 'team not found' });
  res.json(rows(`SELECT rp.name, rp.depth_slot, rp.position, a.*
                 FROM roster_players rp JOIN player_accolades a ON a.roster_player_id = rp.id
                 WHERE rp.team_id = ? ORDER BY rp.depth_slot`, team.id));
});

export default r;

// ---- AI weakness review (the only path that can mark a slot weak) ----
db.exec(`
  CREATE TABLE IF NOT EXISTS slot_weakness (
    roster_player_id INTEGER PRIMARY KEY REFERENCES roster_players(id),
    verdict TEXT,              -- 'weak' | 'fine'
    reasoning TEXT,
    stats_seen TEXT,
    generated_at TEXT
  );
`);

/** Season stat line from ESPN for any player (works for OL/DEF, not just fantasy). */
async function seasonStatLine(espnId, season) {
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${espnId}/stats?season=${season}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) return null;
  const d = await resp.json();
  const cats = d?.categories ?? [];
  const out = {};
  for (const c of cats) {
    const names = c.names ?? [];
    const totals = c.totals ?? [];
    if (!totals.length) continue;
    out[c.name ?? c.displayName] = Object.fromEntries(names.map((n, i) => [n, totals[i]]));
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Ask Claude to judge production. Only players with NO accolades are eligible —
 * a Pro Bowler is never marked weak by a stat blip. Returns 'weak' or 'fine'.
 */
r.post('/weakness/:abbr', async (req, res, next) => {
  try {
    const { getApiKey, callClaude, parseJson } = await import('../services/claude.js');
    if (!getApiKey()) {
      return res.status(400).json({ error: 'No Anthropic API key — add one in the Dev Hub (top right).' });
    }
    const team = row('SELECT id, abbr, name FROM nfl_teams WHERE abbr = ?', req.params.abbr.toUpperCase());
    if (!team) return res.status(404).json({ error: 'team not found' });

    // starters with no accolades to their name — the only weakness candidates
    const candidates = rows(`SELECT rp.id, rp.name, rp.position, rp.depth_slot, rp.age, rp.experience, rp.espn_id,
                                    a.pro_bowls, a.first_team_all_pro, a.second_team_all_pro, a.major_awards,
                                    a.draft_round, a.draft_pick, a.draft_year
                             FROM roster_players rp
                             LEFT JOIN player_accolades a ON a.roster_player_id = rp.id
                             WHERE rp.team_id = ? AND rp.depth_order = 1 AND rp.depth_slot IS NOT NULL
                               AND COALESCE(a.pro_bowls,0) = 0 AND COALESCE(a.first_team_all_pro,0) = 0
                               AND COALESCE(a.second_team_all_pro,0) = 0 AND a.major_awards IS NULL`, team.id);
    if (!candidates.length) return res.json({ ok: true, reviewed: 0, weak: [], note: 'Every starter has an accolade — nothing to review.' });

    const season = (Number(process.env.NFL_SEASON) || 2026) - 1;
    const withStats = [];
    for (let i = 0; i < candidates.length; i += 6) {
      const batch = candidates.slice(i, i + 6);
      const got = await Promise.allSettled(batch.map(async c => ({ c, stats: await seasonStatLine(c.espn_id, season) })));
      for (const g of got) if (g.status === 'fulfilled') withStats.push(g.value);
    }

    const msg = await callClaude({
      feature: 'weakness-review',
      maxTokens: 2500,
      prompt: `You are grading ${team.name} starters for the 2026 NFL season. These players have NO Pro Bowls, All-Pro selections or major awards. Judge each ONLY on the production shown.

${withStats.map(({ c, stats }) => `SLOT ${c.depth_slot} — ${c.name} (${c.position}, age ${c.age ?? '?'}, ${c.experience ?? '?'} yrs${c.draft_round ? `, ${c.draft_year} R${c.draft_round}P${c.draft_pick}` : ', undrafted'})
${season} stats: ${stats ? JSON.stringify(stats).slice(0, 700) : 'no recorded stats'}`).join('\n\n')}

Mark a player "weak" ONLY when the production is genuinely below a starting NFL standard for that position, or there is essentially no track record at a premium spot. A solid-but-unspectacular starter is "fine". A rookie with no stats is "fine" unless the position demands proven play.

Respond with ONLY a JSON array:
[{"slot":"LT","name":"...","verdict":"weak"|"fine","reasoning":"one specific sentence citing the numbers"}]`
    });
    const verdicts = parseJson(msg);

    const upsert = db.prepare(`INSERT INTO slot_weakness (roster_player_id, verdict, reasoning, stats_seen, generated_at)
      VALUES (?,?,?,?,datetime('now'))
      ON CONFLICT(roster_player_id) DO UPDATE SET verdict=excluded.verdict, reasoning=excluded.reasoning,
        stats_seen=excluded.stats_seen, generated_at=excluded.generated_at`);
    const weak = [];
    for (const v of verdicts) {
      const match = withStats.find(({ c }) => c.name === v.name || c.depth_slot === v.slot);
      if (!match) continue;
      upsert.run(match.c.id, v.verdict === 'weak' ? 'weak' : 'fine', v.reasoning ?? null,
        match.stats ? JSON.stringify(match.stats).slice(0, 1000) : null);
      if (v.verdict === 'weak') weak.push({ slot: v.slot, name: v.name, reasoning: v.reasoning });
    }
    res.json({ ok: true, reviewed: verdicts.length, weak });
  } catch (e) { next(e); }
});
