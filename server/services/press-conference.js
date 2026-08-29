/**
 * Coach and player press conferences, transcribed and mined for availability.
 *
 * Teams stream every press conference to their own YouTube channel, and a coach
 * saying "he's day-to-day, we'll see how he moves Wednesday" on Monday afternoon
 * is real information roughly two days before it reaches the official injury
 * report. That gap is the entire reason this is worth building: the report is
 * authoritative but slow, and this is the fastest primary source that exists.
 *
 * THREE THINGS MADE THIS HARDER THAN IT LOOKS, all of them recorded here so the
 * next person does not rediscover them:
 *
 *   1. The handle is a claim. `youtube.com/@chiefs` displays "Chiefs" and its
 *      feed is Madden videos from 2006. The real channel is @KansasCityChiefs
 *      with 513,000 subscribers. Exactly the failure the Twitter handle audit
 *      turned up, so channels are validated the same way — by reach.
 *   2. Captions are no longer fetchable over plain HTTP. The signed caption URL
 *      on the watch page returns 200 with zero bytes, because YouTube now wants
 *      a session token. yt-dlp handles that, so it is used when present and the
 *      module degrades to titles-only when it is not.
 *   3. Coach-speak mostly is not signal. "We'll see" and "day-by-day" carry
 *      nothing. So this SURFACES quotes with the player they concern rather than
 *      converting vague language into a probability — inventing a number from
 *      "we'll see how he looks" would be worse than saying nothing.
 */
import { rows, row, run } from '../db/index.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run_ = promisify(execFile);
const FEED = id => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

run(`CREATE TABLE IF NOT EXISTS yt_channels (
  team         TEXT PRIMARY KEY,
  handle       TEXT NOT NULL,
  channel_id   TEXT,
  title        TEXT,
  subscribers  TEXT,
  verdict      TEXT,
  checked_at   TEXT
)`);
run(`CREATE TABLE IF NOT EXISTS press_conferences (
  video_id     TEXT PRIMARY KEY,
  team         TEXT,
  title        TEXT,
  published_at TEXT,
  is_presser   INTEGER,
  transcript   TEXT,
  chars        INTEGER,
  fetched_at   TEXT
)`);
run(`CREATE TABLE IF NOT EXISTS press_availability (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     TEXT NOT NULL,
  team         TEXT,
  published_at TEXT,
  player       TEXT,
  keyword      TEXT,
  quote        TEXT
)`);
run(`CREATE INDEX IF NOT EXISTS idx_pa_team ON press_availability(team, published_at)`);

/** Official team channels, by handle. Validated before use, never trusted. */
export const TEAM_CHANNEL_HANDLES = Object.freeze({
  // Every one of these was resolved against the live channel page and checked
  // for reach AND name. The obvious guesses are frequently wrong: @chiefs is a
  // Madden account from 2006, @clevelandbrowns has 27 subscribers, @denverbroncos
  // has 23, and @Lions is a Japanese baseball team with 257,000 subscribers —
  // which is why size alone is not enough and the name has to match too.
  ARI: 'AZCardinals', ATL: 'atlantafalcons', BAL: 'baltimoreravens', BUF: 'buffalobills',
  CAR: 'carolinapanthers', CHI: 'chicagobears', CIN: 'Bengals', CLE: 'Browns',
  DAL: 'DallasCowboys', DEN: 'Broncos', DET: 'detroitlionsnfl', GB: 'Packers',
  HOU: 'houstontexans', IND: 'Colts', JAX: 'Jaguars',
  KC: 'KansasCityChiefs', LAC: 'Chargers', LAR: 'RamsNFL', LV: 'Raiders',
  MIA: 'miamidolphins', MIN: 'Vikings', NE: 'Patriots', NO: 'neworleanssaints',
  NYG: 'nygiants', NYJ: 'nyjets', PHI: 'eagles', PIT: 'Steelers',
  SEA: 'seahawks', SF: '49ers', TB: 'Buccaneers',
  TEN: 'Titans', WAS: 'Commanders'
});

/** The name a valid channel should identify as, so a same-sized impostor fails. */
const TEAM_NAME_TOKENS = Object.freeze({
  ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills', CAR: 'panthers',
  CHI: 'bears', CIN: 'bengals', CLE: 'browns', DAL: 'cowboys', DEN: 'broncos',
  DET: 'lions', GB: 'packers', HOU: 'texans', IND: 'colts', JAX: 'jaguars',
  KC: 'chiefs', LAC: 'chargers', LAR: 'rams', LV: 'raiders', MIA: 'dolphins',
  MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants', NYJ: 'jets',
  PHI: 'eagles', PIT: 'steelers', SEA: 'seahawks', SF: '49ers', TB: 'buccaneers',
  TEN: 'titans', WAS: 'commanders'
});

const MIN_SUBSCRIBERS = 50000;

function parseSubs(text) {
  const m = String(text ?? '').match(/([\d.]+)\s*([KM])?\s*subscriber/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'M' ? n * 1e6 : m[2] === 'K' ? n * 1e3 : n;
}

/**
 * Resolve a team's channel and check it is actually theirs.
 *
 * Reach is the test, for the same reason it was on Twitter: an official NFL
 * channel has hundreds of thousands of subscribers, and an account sitting on
 * the obvious handle with none is a squatter whose videos would otherwise be
 * ingested as team communication.
 */
export async function resolveChannel(team) {
  const handle = TEAM_CHANNEL_HANDLES[String(team).toUpperCase()];
  if (!handle) return { team, error: 'no handle configured' };
  let html;
  try {
    const res = await fetch(`https://www.youtube.com/@${handle}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { team, handle, error: `youtube returned ${res.status}` };
    html = await res.text();
  } catch (e) { return { team, handle, error: e.message }; }

  const channelId = (html.match(/<link rel="canonical" href="[^"]*?(UC[A-Za-z0-9_-]{20,})"/) ?? [])[1]
    ?? (html.match(/"externalId":"(UC[A-Za-z0-9_-]{20,})"/) ?? [])[1] ?? null;
  const title = (html.match(/<meta property="og:title" content="([^"]*)"/) ?? [])[1] ?? null;
  // Take the LARGEST subscriber figure on the page, not the first. Channel
  // pages carry counts for recommended channels too, and reading index zero
  // reported the 49ers at 179 subscribers on one fetch and 453,000 on another.
  const subsCandidates = [...html.matchAll(/([\d.]+\s*[KM]?)\s*subscribers/gi)]
    .map(m => ({ text: `${m[1]} subscribers`, n: parseSubs(`${m[1]} subscribers`) }))
    .filter(x => Number.isFinite(x.n));
  const simple = (html.match(/"subscriberCountText":\{"simpleText":"([^"]*)"/) ?? [])[1];
  if (simple) subsCandidates.push({ text: simple, n: parseSubs(simple) });
  const biggest = subsCandidates.sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0] ?? null;
  const subsText = biggest?.text ?? null;
  const subs = biggest?.n ?? null;

  // Both tests have to pass. Reach alone let a Japanese baseball team with
  // 257,000 subscribers through as the Detroit Lions, and a name test alone
  // would accept a 27-subscriber squatter calling itself "Cleveland Browns".
  const expectToken = TEAM_NAME_TOKENS[String(team).toUpperCase()];
  const nameMatches = !expectToken
    || String(title ?? '').toLowerCase().includes(expectToken);
  const verdict = !channelId ? 'unresolved'
    : (subs ?? 0) < MIN_SUBSCRIBERS ? 'suspect'
      : !nameMatches ? 'wrong_channel' : 'valid';

  run(`INSERT INTO yt_channels (team, handle, channel_id, title, subscribers, verdict, checked_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(team) DO UPDATE SET handle=excluded.handle, channel_id=excluded.channel_id,
         title=excluded.title, subscribers=excluded.subscribers, verdict=excluded.verdict,
         checked_at=excluded.checked_at`,
  String(team).toUpperCase(), handle, channelId, title, subsText, verdict, new Date().toISOString());

  return { team: String(team).toUpperCase(), handle, channel_id: channelId, title,
    subscribers: subsText, verdict,
    reason: verdict === 'suspect'
      ? `${subsText ?? 'no'} subscribers is below the ${MIN_SUBSCRIBERS.toLocaleString()} floor — ` +
        'almost certainly a squatter rather than the team'
      : verdict === 'wrong_channel'
        ? `channel is titled "${title}", which does not contain "${expectToken}" — sizeable, but ` +
          'not this team'
        : verdict === 'unresolved' ? 'could not extract a channel id'
          : `resolved, ${subsText}, name matches` };
}

/** Resolve every team's channel. */
export async function resolveAllChannels() {
  const out = [];
  for (const team of Object.keys(TEAM_CHANNEL_HANDLES)) {
    out.push(await resolveChannel(team));
    await new Promise(r => setTimeout(r, 250));
  }
  const byVerdict = {};
  for (const o of out) byVerdict[o.verdict ?? 'error'] = (byVerdict[o.verdict ?? 'error'] ?? 0) + 1;
  return { checked: out.length, by_verdict: byVerdict,
    problems: out.filter(o => o.verdict !== 'valid'),
    note: 'Validated by subscriber count. youtube.com/@chiefs displays "Chiefs" and serves Madden ' +
      'videos from 2006 — the real channel is @KansasCityChiefs with 513,000 subscribers.' };
}

const PRESSER_RE = /press conference|presser|media availability|speaks (?:to|with)|talks|injury update|availability|coach|postgame|pregame/i;

/** Discover recent videos on a team's channel and flag the press conferences. */
export async function discoverVideos(team) {
  const ch = row(`SELECT channel_id, verdict FROM yt_channels WHERE team = ?`,
    String(team).toUpperCase());
  if (!ch?.channel_id) return { team, error: 'channel not resolved — run resolveChannel first' };
  if (ch.verdict !== 'valid') return { team, error: `channel is ${ch.verdict}; refusing to ingest` };

  let xml;
  try {
    const res = await fetch(FEED(ch.channel_id), { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { team, error: `feed returned ${res.status}` };
    xml = await res.text();
  } catch (e) { return { team, error: e.message }; }

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const now = new Date().toISOString();
  let stored = 0, pressers = 0;
  const found = [];
  for (const e of entries) {
    const id = (e.match(/<yt:videoId>([^<]*)<\/yt:videoId>/) ?? [])[1];
    const title = (e.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '';
    const published = (e.match(/<published>([^<]*)<\/published>/) ?? [])[1] ?? null;
    if (!id) continue;
    const isPresser = PRESSER_RE.test(title) ? 1 : 0;
    if (isPresser) pressers++;
    run(`INSERT INTO press_conferences (video_id, team, title, published_at, is_presser, fetched_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT(video_id) DO NOTHING`,
    id, String(team).toUpperCase(), title, published, isPresser, now);
    stored++;
    found.push({ video_id: id, title, published_at: published, is_presser: !!isPresser });
  }
  return { team: String(team).toUpperCase(), videos: stored, pressers, found };
}

/** Is yt-dlp available? Captions are not reachable over plain HTTP without it. */
export async function transcriptToolAvailable() {
  try {
    const { stdout } = await run_('yt-dlp', ['--version'], { timeout: 15000 });
    return { available: true, version: stdout.trim() };
  } catch {
    return { available: false,
      note: 'yt-dlp is not installed. YouTube stopped serving captions to plain HTTP requests — the ' +
        'signed caption URL returns 200 with zero bytes — so without it this module can discover ' +
        'press conferences but not read them.' };
  }
}

/**
 * Pull one video's auto-generated transcript.
 *
 * Auto-captions on a press conference are good enough for this purpose: the
 * words that matter are player names and injury nouns, and ASR handles both far
 * better than it handles jargon.
 */
export async function fetchTranscript(videoId) {
  const tool = await transcriptToolAvailable();
  if (!tool.available) return { video_id: videoId, ...tool };

  const base = join(tmpdir(), `presser_${videoId}_${Date.now()}`);
  const file = `${base}.en.json3`;
  try {
    await run_('yt-dlp', ['--skip-download', '--write-auto-subs', '--sub-langs', 'en',
      '--sub-format', 'json3', '--no-warnings', '-o', `${base}.%(ext)s`,
      `https://www.youtube.com/watch?v=${videoId}`], { timeout: 120000 });
    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    const text = (parsed.events ?? [])
      .filter(e => e.segs)
      .map(e => (e.segs ?? []).map(s => s.utf8).join(''))
      .join(' ')
      // Strip the [music] and [applause] markers auto-captioning inserts.
      .replace(/\[[a-z ]+\]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    await unlink(file).catch(() => {});
    run(`UPDATE press_conferences SET transcript = ?, chars = ? WHERE video_id = ?`,
      text, text.length, videoId);
    return { video_id: videoId, chars: text.length, transcript: text };
  } catch (e) {
    await unlink(file).catch(() => {});
    return { video_id: videoId, error: e.message?.slice(0, 200) ?? 'transcript fetch failed' };
  }
}

const INJURY_TERMS = ['injur', 'out for', 'week to week', 'week-to-week', 'day to day', 'day-to-day',
  'mri', 'concussion', 'hamstring', 'x-ray', 'questionable', 'doubtful', 'tore', 'torn',
  'surgery', 'ankle', 'knee', 'shoulder', 'groin', 'ruled out', 'did not practice',
  'limited', 'return', 'available', 'miss', 'setback', 'ir', 'placed on'];

/**
 * Pull availability statements out of a transcript, attached to a player.
 *
 * Deliberately conservative. It finds sentences containing an injury term, then
 * looks for a rostered player's name in the same sentence. A quote with no name
 * attached is discarded rather than guessed at, because "he" in a press
 * conference resolves to whoever the reporter asked about and the transcript
 * does not contain the question.
 *
 * No probability is assigned. Coach language ranges from "he'll be fine" to
 * "we'll see", and turning that into a number would be fabricating precision
 * that the source does not contain.
 */
export function extractAvailability(videoId) {
  const v = row(`SELECT * FROM press_conferences WHERE video_id = ?`, videoId);
  if (!v?.transcript) return { video_id: videoId, error: 'no transcript stored' };

  const roster = rows(
    `SELECT DISTINCT player FROM nfl_snaps WHERE UPPER(team) = ? AND season >= 2024`,
    String(v.team).toUpperCase()).map(r => r.player).filter(Boolean);

  // Sentence-ish split. Auto-captions have no punctuation reliability, so this
  // also breaks on the ">>" speaker markers YouTube inserts.
  const chunks = v.transcript.split(/(?:>>|[.?!])\s+/).map(s => s.trim()).filter(s => s.length > 20);

  run(`DELETE FROM press_availability WHERE video_id = ?`, videoId);
  const found = [];
  for (const chunk of chunks) {
    const lower = chunk.toLowerCase();
    const term = INJURY_TERMS.find(t => lower.includes(t));
    if (!term) continue;
    // Match a rostered player by surname, which is how coaches refer to them.
    const named = roster.find(p => {
      const surname = String(p).split(' ').slice(-1)[0];
      return surname.length > 3 && lower.includes(surname.toLowerCase());
    });
    if (!named) continue;
    run(`INSERT INTO press_availability (video_id, team, published_at, player, keyword, quote)
         VALUES (?,?,?,?,?,?)`,
    videoId, v.team, v.published_at, named, term, chunk.slice(0, 400));
    found.push({ player: named, keyword: term, quote: chunk.slice(0, 220) });
  }
  return { video_id: videoId, team: v.team, published_at: v.published_at,
    transcript_chars: v.chars, statements: found.length, found,
    note: 'Only statements naming a rostered player are kept. A quote about "he" is discarded — the ' +
      'transcript does not contain the reporter\'s question, so the referent is unrecoverable.' };
}

/** Everything the press-conference pipeline has learned about a team. */
export function pressAvailabilityFor(team, { days = 14 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const statements = rows(
    `SELECT p.*, c.title FROM press_availability p
     JOIN press_conferences c ON c.video_id = p.video_id
     WHERE UPPER(p.team) = ? AND p.published_at >= ?
     ORDER BY p.published_at DESC`, String(team).toUpperCase(), since);
  const byPlayer = new Map();
  for (const s of statements) {
    if (!byPlayer.has(s.player)) byPlayer.set(s.player, []);
    byPlayer.get(s.player).push({ keyword: s.keyword, quote: s.quote,
      said_at: s.published_at, source: s.title });
  }
  return {
    team: String(team).toUpperCase(), window_days: days,
    players_mentioned: byPlayer.size, statements: statements.length,
    players: [...byPlayer.entries()].map(([player, quotes]) => ({ player, mentions: quotes.length, quotes })),
    note: 'Quotes, not probabilities. A coach saying "day-to-day" is evidence a lineup decision ' +
      'should weigh; it is not a number, and this does not pretend otherwise.'
  };
}

/** What the pipeline holds. */
export function pressStatus() {
  const ch = row(`SELECT COUNT(*) AS n, SUM(CASE WHEN verdict='valid' THEN 1 ELSE 0 END) AS valid
                  FROM yt_channels`) ?? {};
  const vids = row(`SELECT COUNT(*) AS n, SUM(is_presser) AS pressers,
                           SUM(CASE WHEN transcript IS NOT NULL THEN 1 ELSE 0 END) AS transcribed
                    FROM press_conferences`) ?? {};
  const st = row(`SELECT COUNT(*) AS n, COUNT(DISTINCT player) AS players FROM press_availability`) ?? {};
  return {
    channels: { resolved: ch.n ?? 0, valid: ch.valid ?? 0 },
    videos: { discovered: vids.n ?? 0, pressers: vids.pressers ?? 0, transcribed: vids.transcribed ?? 0 },
    statements: { extracted: st.n ?? 0, players: st.players ?? 0 },
    note: 'Discovery is free and keyless. Transcription needs yt-dlp, because YouTube stopped ' +
      'serving captions to plain HTTP requests — the signed URL returns 200 with zero bytes.'
  };
}
