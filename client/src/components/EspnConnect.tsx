import { ClipboardEvent, FormEvent, useId, useRef, useState } from 'react';
import { ApiError, api } from '../api';

type Step = 'league' | 'credentials' | 'success';
const AUTH_CODES = new Set(['ESPN_AUTHENTICATION_FAILED', 'ESPN_INVALID_CREDENTIALS', 'ESPN_CREDENTIALS_INVALID']);

type AccessTestResult = {
  code: string;
  connection_state: 'public' | 'credentials_required' | 'credentialed' | 'unknown' | 'mismatch' | 'not_found';
  message: string;
};

export function normalizeEspnS2(value: string) {
  return value.trim().replace(/^espn_s2\s*=\s*/i, '').replace(/;.*$/, '').trim();
}

export function normalizeSwid(value: string) {
  let normalized = value.trim().replace(/^SWID\s*=\s*/i, '').replace(/;.*$/, '').trim();
  if (/^%7b/i.test(normalized) && /%7d$/i.test(normalized)) normalized = `{${normalized.slice(3, -3)}}`;
  if (normalized && !normalized.startsWith('{')) normalized = `{${normalized}`;
  if (normalized && !normalized.endsWith('}')) normalized = `${normalized}}`;
  return normalized;
}

function SecretInput({ label, value, onChange, normalize }: {
  label: string; value: string; onChange: (value: string) => void; normalize: (value: string) => string;
}) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    onChange(normalize(event.clipboardData.getData('text')));
  };

  return <div>
    <label htmlFor={id} className="text-xs font-medium text-slate-700">{label}</label>
    <div className="mt-1 flex gap-2">
      <input id={id} className="input min-w-0 flex-1 font-mono" type={visible ? 'text' : 'password'}
        autoComplete="off" spellCheck={false} value={value} onChange={event => onChange(event.target.value)}
        onPaste={handlePaste} onBlur={() => value && onChange(normalize(value))} />
      <button type="button" className="btn-ghost text-xs" aria-pressed={visible}
        aria-label={`${visible ? 'Hide' : 'Show'} ${label}`} onClick={() => setVisible(show => !show)}>
        {visible ? 'Hide' : 'Show'}
      </button>
      <button type="button" className="btn-ghost text-xs" disabled={!value}
        aria-label={`Clear ${label}`} onClick={() => onChange('')}>Clear</button>
    </div>
  </div>;
}

export default function EspnConnect() {
  const [step, setStep] = useState<Step>('league');
  const [leagueId, setLeagueId] = useState('');
  const [season, setSeason] = useState(new Date().getFullYear());
  const [espnS2, setEspnS2] = useState('');
  const [swid, setSwid] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('Enter the ESPN league ID and season to check whether the league is public.');
  const [error, setError] = useState<string | null>(null);
  const submitLock = useRef(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitLock.current || !/^\d+$/.test(leagueId.trim()) || !Number.isInteger(season) || season < 2000 || season > 2200) return;
    if (step === 'credentials' && (!espnS2.trim() || !swid.trim())) return;

    submitLock.current = true;
    setBusy(true);
    setError(null);
    setMessage(step === 'credentials' ? 'Testing private league access…' : 'Checking league access…');
    try {
      const body: Record<string, string | number> = { league_id: leagueId.trim(), season };
      if (step === 'credentials') {
        body.espn_s2 = normalizeEspnS2(espnS2);
        body.swid = normalizeSwid(swid);
      }
      const result = await api<AccessTestResult>('/espn-connect/test', {
        method: 'POST', body: JSON.stringify(body)
      });
      if (result.connection_state === 'credentials_required') {
        setStep('credentials');
        setMessage(step === 'credentials'
          ? 'ESPN did not accept those credentials. Paste fresh values from your signed-in ESPN session.'
          : 'This league is private. Add credentials from your signed-in ESPN session to test access.');
        if (step === 'credentials') { setEspnS2(''); setSwid(''); }
        return;
      }
      setEspnS2(''); setSwid(''); setStep('success');
      setMessage('Access confirmed. No league or credentials were saved.');
    } catch (caught) {
      const apiError = caught as ApiError;
      if (AUTH_CODES.has(apiError.code ?? '')) {
        setStep('credentials');
        setMessage(step === 'credentials'
          ? 'ESPN did not accept those credentials. Paste fresh values from your signed-in ESPN session.'
          : 'This league is private. Add credentials from your signed-in ESPN session to test access.');
        if (step === 'credentials') { setEspnS2(''); setSwid(''); }
      } else {
        const known: Record<string, string> = {
          ESPN_TIMEOUT: 'ESPN took too long to respond. Your league ID and season are still here; try again.',
          ESPN_NETWORK_ERROR: 'ESPN could not be reached. Your league ID and season are still here; try again.',
          ESPN_UPSTREAM_ERROR: 'ESPN is temporarily unavailable. Your league ID and season are still here; try again.',
          ESPN_LEAGUE_MISMATCH: 'ESPN returned a different league or season. Check both values and try again.',
          ESPN_MALFORMED_RESPONSE: 'ESPN returned an unexpected response. Try again in a moment.'
        };
        setError(known[apiError.code ?? ''] ?? apiError.message ?? 'Access could not be checked. Try again.');
        setMessage('Access was not confirmed.');
      }
    } finally {
      submitLock.current = false;
      setBusy(false);
    }
  };

  const reset = () => {
    setStep('league'); setEspnS2(''); setSwid(''); setError(null);
    setMessage('Enter the ESPN league ID and season to check whether the league is public.');
  };

  const ready = /^\d+$/.test(leagueId.trim()) && Number.isInteger(season) && season >= 2000 && season <= 2200
    && (step !== 'credentials' || (!!espnS2.trim() && !!swid.trim()));

  return <section className="card p-4" aria-labelledby="espn-connect-title">
    <h2 id="espn-connect-title" className="font-bold text-slate-800">Test ESPN league access</h2>
    <p className="mt-1 text-xs text-slate-600">This check does not connect, save, or sync a league.</p>
    <p className="mt-3 text-sm text-slate-700" role="status" aria-live="polite">{message}</p>
    {error && <p className="mt-2 text-sm text-rose-700" role="alert">{error}</p>}

    {step !== 'success' ? <form className="mt-4 space-y-4" onSubmit={submit} aria-busy={busy}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-slate-700">League ID
          <input className="input mt-1 block w-full" inputMode="numeric" pattern="[0-9]+" required autoComplete="off"
            value={leagueId} onChange={event => setLeagueId(event.target.value)} />
        </label>
        <label className="text-xs font-medium text-slate-700">Season
          <input className="input mt-1 block w-full" type="number" min="2000" max="2200" required
            value={season} onChange={event => setSeason(Number(event.target.value))} />
        </label>
      </div>
      {step === 'credentials' && <fieldset className="space-y-3">
        <legend className="text-xs text-slate-600">In ESPN, open browser storage for espn.com and copy these two cookie values. They are used for this test only.</legend>
        <SecretInput label="espn_s2" value={espnS2} onChange={setEspnS2} normalize={normalizeEspnS2} />
        <SecretInput label="SWID" value={swid} onChange={setSwid} normalize={normalizeSwid} />
      </fieldset>}
      <button className="btn-primary" type="submit" disabled={busy || !ready}>
        {busy ? 'Checking…' : step === 'credentials' ? 'Test private access' : 'Check league access'}
      </button>
    </form> : <button type="button" className="btn-primary mt-4" onClick={reset}>Check another league</button>}
  </section>;
}
