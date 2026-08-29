/**
 * Are the people we follow actually the people we think we follow?
 *
 * This started as a routine expansion of the handle list and turned into a
 * warning. Of sixteen candidate handles added from memory, four did not exist
 * at all and four more resolved to accounts with 22, 41, 95 and 163 followers —
 * squatters and dormant namesakes sitting on the handle of a real reporter.
 * A pipeline reading those would be ingesting a stranger's timeline as though
 * it were Adam Schefter, and nothing downstream would ever notice.
 *
 * So handles are not a constant here, they are a claim that gets checked. The
 * check is deliberately blunt because the failure mode is blunt: a working NFL
 * beat reporter has tens of thousands of followers, and an account claiming to
 * be one with 41 does not need subtler analysis than that.
 *
 * The cost is trivial — one profile lookup per handle, roughly a third of a
 * cent — and the budget is capped and tracked in twitterapi-io.js.
 */
import { rows, row, run } from '../db/index.js';

const r2 = v => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));

run(`CREATE TABLE IF NOT EXISTS news_source_validation (
  handle       TEXT PRIMARY KEY,
  role         TEXT,
  team         TEXT,
  checked_at   TEXT NOT NULL,
  exists_now   INTEGER,
  verified     INTEGER,
  followers    INTEGER,
  display_name TEXT,
  bio          TEXT,
  verdict      TEXT,
  reason       TEXT
)`);

/**
 * Follower floors, by what the account is for.
 *
 * A national insider with under fifty thousand followers is not a national
 * insider. A team beat writer legitimately sits lower — some cover small
 * markets — but an account under a few thousand is not breaking news that moves
 * a line, whoever it is.
 */
const FLOORS = { national: 50000, beat: 5000, team: 20000, data: 20000 };

/**
 * Accounts that publish data rather than break news.
 *
 * They serve a different purpose — snap shares, route counts, usage — and do not
 * need an insider's reach to be worth reading, so they are judged against a
 * lower floor rather than failed for not being Schefter.
 */
const DATA_ACCOUNTS = new Set(['FantasyPtsData', 'Rotoworld_FB', 'NextGenStats']);

/** Judge one profile against what it claims to be. */
export function judgeSource({ exists, followers, verified, name, bio, handle }, role) {
  if (!exists) return { verdict: 'dead', reason: 'handle does not resolve' };
  if (handle && DATA_ACCOUNTS.has(handle)) role = 'data';
  const floor = FLOORS[role] ?? 5000;
  if ((followers ?? 0) < floor) {
    return { verdict: 'suspect',
      reason: `${followers ?? 0} followers is below the ${floor.toLocaleString()} floor for a ` +
        `${role} source — almost certainly a squatter or dormant namesake rather than the reporter` };
  }
  // The bio test is a tiebreaker, not a verdict. Beat reporters routinely write
  // terse bios that never say "NFL" — this test alone flagged 45 real writers
  // with 16,000 to 139,000 followers as questionable, which is a check that
  // manufactures work rather than catching anything. Reach well clear of the
  // floor settles it on its own.
  const text = `${name ?? ''} ${bio ?? ''}`.toLowerCase();
  const looksNfl = /nfl|football|espn|athletic|beat|insider|network|sports|writer|reporter|covers/.test(text);
  if (!looksNfl && (followers ?? 0) < floor * 3) {
    return { verdict: 'questionable',
      reason: `${(followers ?? 0).toLocaleString()} followers is above the floor but the profile ` +
        'says nothing about football, so this is worth a human glance' };
  }
  return { verdict: 'valid',
    reason: looksNfl
      ? `${(followers ?? 0).toLocaleString()} followers, football profile`
      : `${(followers ?? 0).toLocaleString()} followers — comfortably clear of the floor, so the ` +
        'terse bio is not disqualifying' };
}

/**
 * Verify every configured handle and record the verdict.
 *
 * Runs against the live API, so it costs budget and is deliberately not
 * automatic — this is a thing you do when the list changes, not every hour.
 */
/**
 * Handles do not change often, so re-checking one inside this window is pure
 * waste — and worse than waste, because a burst of a few hundred profile
 * lookups looks like abuse to the provider even when the spend is trivial.
 *
 * Learned the hard way: validating 108 handles three times in one hour put 340
 * calls through in a day and drew a usage notice, for eleven cents. The cost was
 * never the problem; the rate was.
 */
const REVALIDATE_AFTER_DAYS = 14;

export async function validateAllSources({ limit = 200, force = false } = {}) {
  const { verifyHandle, hasKey, twitterSpendStatus } = await import('./twitterapi-io.js');
  if (!hasKey()) {
    return { error: 'no TWITTERAPI_IO_KEY configured',
      note: 'Verification needs the live API. Without a key every handle would report as dead, ' +
        'which is a configuration failure wearing the costume of a finding — this refuses rather ' +
        'than writing that to the database.' };
  }
  const ingest = await import('../news/twitter-ingest.js');
  const targets = [];
  for (const h of ingest.NATIONAL_INSIDER_HANDLES ?? []) targets.push({ handle: h, role: 'national', team: null });
  for (const [team, h] of Object.entries(ingest.TEAM_HANDLES ?? {})) targets.push({ handle: h, role: 'team', team });
  for (const [team, list] of Object.entries(ingest.BEAT_REPORTER_HANDLES ?? {})) {
    for (const h of (Array.isArray(list) ? list : [list])) targets.push({ handle: h, role: 'beat', team });
  }

  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - REVALIDATE_AFTER_DAYS * 86400000).toISOString();
  const fresh = new Set(
    force ? []
      : rows(`SELECT handle FROM news_source_validation WHERE checked_at >= ?`, cutoff)
        .map(r => r.handle));

  const due = targets.filter(t => !fresh.has(t.handle));
  if (!due.length) {
    return { checked: 0, skipped: targets.length,
      reason: `every handle was verified within the last ${REVALIDATE_AFTER_DAYS} days`,
      status: sourceStatus(),
      note: 'Nothing was called. Handles are stable, and re-checking them on a whim is how a ' +
        'trivial spend turns into a rate that looks like abuse. Pass force to override.' };
  }

  const results = [];
  for (const t of due.slice(0, limit)) {
    let v;
    try { v = await verifyHandle(t.handle, {}); }
    catch { v = { exists: false }; }
    if (v?.skipped) break;   // budget hit; stop rather than record false deaths
    const judged = judgeSource({ ...v, handle: t.handle }, t.role);
    run(`INSERT INTO news_source_validation
         (handle, role, team, checked_at, exists_now, verified, followers, display_name, bio,
          verdict, reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(handle) DO UPDATE SET checked_at=excluded.checked_at,
           exists_now=excluded.exists_now, verified=excluded.verified,
           followers=excluded.followers, display_name=excluded.display_name,
           bio=excluded.bio, verdict=excluded.verdict, reason=excluded.reason`,
    t.handle, t.role, t.team, now, v.exists ? 1 : 0, v.verified ? 1 : 0,
    v.followers ?? null, v.name ?? null, (v.bio ?? '').slice(0, 300),
    judged.verdict, judged.reason);
    results.push({ ...t, ...judged, followers: v.followers ?? null, name: v.name ?? null });
    await new Promise(r => setTimeout(r, 150));
  }

  const byVerdict = {};
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
  return {
    checked: results.length, skipped: targets.length - due.length,
    by_verdict: byVerdict,
    dead: results.filter(r => r.verdict === 'dead').map(r => r.handle),
    suspect: results.filter(r => r.verdict === 'suspect')
      .map(r => ({ handle: r.handle, team: r.team, followers: r.followers, reason: r.reason })),
    spend: twitterSpendStatus(),
    note: 'A handle is a claim, not a constant. Of sixteen added from memory in one pass, four did ' +
      'not exist and four resolved to accounts with under 200 followers sitting on a real ' +
      'reporter\'s name — a pipeline would have ingested those as insider news without complaint.'
  };
}

/** The current verdict on every source, without spending anything. */
export function sourceStatus() {
  const all = rows(`SELECT * FROM news_source_validation ORDER BY role, team, handle`);
  if (!all.length) {
    return { validated: 0,
      note: 'No sources validated yet. POST /news/sources/validate runs the check against the live ' +
        'API; it costs roughly a third of a cent per handle.' };
  }
  const byVerdict = {};
  for (const s of all) byVerdict[s.verdict] = (byVerdict[s.verdict] ?? 0) + 1;
  const usable = all.filter(s => s.verdict === 'valid');
  const teams = new Set(usable.filter(s => s.team).map(s => s.team));
  return {
    validated: all.length,
    by_verdict: byVerdict,
    usable_sources: usable.length,
    teams_with_a_valid_source: teams.size,
    teams_missing: [...new Set(all.filter(s => s.team).map(s => s.team))]
      .filter(t => !teams.has(t)),
    problems: all.filter(s => s.verdict !== 'valid').map(s => ({
      handle: s.handle, role: s.role, team: s.team, verdict: s.verdict,
      followers: s.followers, reason: s.reason })),
    checked_at: all[0]?.checked_at ?? null,
    sources: all.map(s => ({ handle: s.handle, role: s.role, team: s.team,
      followers: s.followers, name: s.display_name, verdict: s.verdict }))
  };
}

/**
 * Which handles the ingest should actually read.
 *
 * Anything judged dead or suspect is excluded, so a squatter cannot leak into
 * the news pipeline just because it was in a list once.
 */
export function trustedHandles({ role = null } = {}) {
  const where = role ? `WHERE verdict = 'valid' AND role = ?` : `WHERE verdict = 'valid'`;
  const args = role ? [role] : [];
  const list = rows(`SELECT handle, role, team, followers FROM news_source_validation ${where}
                     ORDER BY followers DESC`, ...args);
  return { count: list.length, handles: list,
    note: 'Only handles that resolved to a real, sizeable football account. If this is empty, run ' +
      'validation first — an unvalidated list is not the same as a trusted one.' };
}
