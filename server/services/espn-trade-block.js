/**
 * TM-10: the one reader of ESPN's trade block, `teams[].tradeBlock.players` in the stored league
 * payload ({ [espnPlayerId]: 'ON_THE_BLOCK' | ... }). Read by lineup-signals.js (benched and
 * shopped) and the campaign adapter (HIS-SIDE-WIRE). Pure: no DB.
 *
 * payload: the payload object or its JSON text.
 * -> { blocks: Map roster id (string) -> Map espn id (number) -> status, error: string | null }
 */
export function tradeBlocks(payload) {
  const out = new Map();
  let parsed = null;
  try { parsed = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) {
    // A stored payload that is not JSON cannot carry a trade block; say so rather than guess.
    return { blocks: out, error: `stored league payload is not JSON: ${e.message}` };
  }
  for (const t of parsed?.teams ?? []) {
    const players = t?.tradeBlock?.players ?? {};
    out.set(String(t.id), new Map(Object.entries(players).map(([id, s]) => [Number(id), s])));
  }
  return { blocks: out, error: null };
}
