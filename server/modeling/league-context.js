/** Resolve projection scoring context explicitly; never guess the first league. */
export function requireLeagueId(request) {
  const value = request.params?.leagueId ?? request.query?.league_id ?? request.headers?.['x-active-league-id'];
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    const error = new Error('active league is required (league_id or X-Active-League-Id)');
    error.status = 400;
    throw error;
  }
  return id;
}

