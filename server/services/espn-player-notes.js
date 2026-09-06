/**
 * Freshest per-player note from ESPN's public athlete overview — the Rotowire
 * headline/story ESPN itself shows on a player card ("suited up and went
 * through drills at Tuesday's practice…"). No cookie needed. Proven 2026-09-06
 * against live data; one call per player, cached an hour, so the draft-advice
 * shortlist (5 players) costs five small requests per pick at most.
 */
const OVERVIEW = id => `https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/${id}/overview`;
const TTL_MS = 60 * 60 * 1000;
const cache = new Map();

export async function espnPlayerNote(espnId) {
  if (!espnId) return null;
  const hit = cache.get(espnId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.note;
  let note = null;
  try {
    const res = await fetch(OVERVIEW(espnId), { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const j = await res.json();
      const rw = j?.rotowire;
      if (rw?.headline) {
        note = {
          headline: String(rw.headline).slice(0, 300),
          story: rw.story ? String(rw.story).slice(0, 600) : null,
          published: rw.published ?? null,
          espn_draft_rank: j?.fantasy?.draftRank ?? null,
          espn_position_rank: j?.fantasy?.positionRank ?? null
        };
      }
    }
  } catch { /* a missing note never blocks advice */ }
  cache.set(espnId, { at: Date.now(), note });
  return note;
}

export async function espnPlayerNotes(espnIds) {
  return Object.fromEntries(await Promise.all(
    espnIds.filter(Boolean).map(async id => [id, await espnPlayerNote(id)])
  ));
}
