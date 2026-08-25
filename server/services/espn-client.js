import crypto from 'node:crypto';

const ESPN_BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl';
const DEFAULT_TIMEOUT_MS = 15_000;
const SECRET_KEYS = /^(espn_s2|swid|cookie|authorization)$/i;

export class EspnError extends Error {
  constructor(message, { code = 'ESPN_ERROR', status = 502, upstreamStatus, cause } = {}) {
    super(message, { cause });
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (upstreamStatus != null) this.upstreamStatus = upstreamStatus;
  }
}

export class EspnAuthenticationError extends EspnError {
  constructor() { super('ESPN authentication failed', { code: 'ESPN_AUTHENTICATION_FAILED', status: 401 }); }
}
export class EspnTimeoutError extends EspnError {
  constructor(cause) { super('ESPN request timed out', { code: 'ESPN_TIMEOUT', status: 504, cause }); }
}
export class EspnResponseError extends EspnError {
  constructor(message = 'ESPN returned a malformed response', options = {}) {
    super(message, { code: 'ESPN_MALFORMED_RESPONSE', status: 502, ...options });
  }
}
export class EspnLeagueMismatchError extends EspnError {
  constructor() { super('ESPN response did not match the requested league and season', { code: 'ESPN_LEAGUE_MISMATCH', status: 400 }); }
}

function cleanCookieValue(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new EspnAuthenticationError();
  if (/[;\r\n]/.test(normalized)) throw new EspnError(`invalid ${name} cookie`, { code: 'ESPN_INVALID_CREDENTIALS', status: 400 });
  return normalized;
}

export function normalizeEspnS2(value) {
  return cleanCookieValue(value, 'espn_s2');
}

export function normalizeSwid(value) {
  let swid = cleanCookieValue(value, 'SWID');
  // Decode only the outer braces some cookie tools encode. The identifier body is
  // deliberately left byte-for-byte intact, avoiding double decoding/encoding.
  if (/^%7b/i.test(swid) && /%7d$/i.test(swid)) swid = `{${swid.slice(3, -3)}}`;
  if (!swid.startsWith('{')) swid = `{${swid}`;
  if (!swid.endsWith('}')) swid = `${swid}}`;
  return swid;
}

export function buildEspnCookieHeader({ espn_s2, swid }) {
  return `espn_s2=${normalizeEspnS2(espn_s2)}; SWID=${normalizeSwid(swid)}`;
}

export function redactEspnSecrets(value) {
  if (value == null) return value;
  if (value instanceof Error) return { name: value.name, message: 'ESPN request failed', code: value.code };
  if (Array.isArray(value)) return value.map(redactEspnSecrets);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, SECRET_KEYS.test(key) ? '[REDACTED]' : redactEspnSecrets(item)]));
  return value;
}

export async function espnRequest(url, credentials, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const timeout = Math.max(1, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 30_000));
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json', Cookie: buildEspnCookieHeader(credentials) },
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new EspnTimeoutError(error);
    throw new EspnError('ESPN request failed', { code: 'ESPN_NETWORK_ERROR', status: 502, cause: error });
  }
  if (response.status === 401 || response.status === 403) throw new EspnAuthenticationError();
  if (!response.ok) throw new EspnError('ESPN request failed', {
    code: 'ESPN_UPSTREAM_ERROR', status: 502, upstreamStatus: response.status
  });
  let data;
  try { data = await response.json(); } catch (error) { throw new EspnResponseError(undefined, { cause: error }); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new EspnResponseError();
  return data;
}

export function leagueUrl(leagueId, season, views = ['mTeam', 'mRoster', 'mMatchup', 'mSettings']) {
  const params = new URLSearchParams({ scoringPeriodId: '1' });
  for (const view of views) params.append('view', view);
  return `${ESPN_BASE}/seasons/${encodeURIComponent(String(season))}/segments/0/leagues/${encodeURIComponent(String(leagueId))}?${params}`;
}

export async function fetchEspnLeague({ leagueId, season, espn_s2, swid, views, ...options }) {
  const data = await espnRequest(leagueUrl(leagueId, season, views), { espn_s2, swid }, options);
  const actualLeague = data.id ?? data.leagueId;
  const actualSeason = data.seasonId ?? data.season;
  if (String(actualLeague) !== String(leagueId) || Number(actualSeason) !== Number(season)) {
    throw new EspnLeagueMismatchError();
  }
  return data;
}

export function espnAccountFingerprint(data) {
  const ids = (data?.members ?? []).map(member => member?.id).filter(Boolean).map(String).sort();
  if (!ids.length) return null;
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
}
