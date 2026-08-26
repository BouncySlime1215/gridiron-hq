// @ts-nocheck -- no browser component-test runner types installed
// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveDraftSync } from './useLiveDraftSync';
import { ApiError, api } from '../api';

vi.mock('../api', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }));
const mockedApi = vi.mocked(api);

const okSync = { ok: true, espn_in_progress: true, espn_complete: false, picks_on_espn: 3, picks_mirrored: 3, new_picks: [], failures: [], desynced: false };
const board = { draft: { status: 'active' }, my_team: { picks: [] }, recent_picks: [], targets: [] };

function mockAssistThen(fn) { fn.mockImplementation((path: string) => (path.endsWith('/assist') ? Promise.resolve(board) : Promise.resolve(okSync))); }

// Both api calls in one tick (sync then assist) are already-resolved mocked promises, so
// a couple of microtask flushes under `act` is enough to settle them without real waiting.
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe('useLiveDraftSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

  it('starts connecting, then reaches synchronized after a successful poll', async () => {
    mockAssistThen(mockedApi);
    const { result } = renderHook(() => useLiveDraftSync('1'));
    expect(result.current.health).toBe('connecting');
    await flush();
    expect(result.current.health).toBe('synchronized');
    expect(result.current.board).toEqual(board);
    expect(result.current.picksMirrored).toBe(3);
    expect(result.current.picksOnEspn).toBe(3);
    expect(result.current.lastSyncedAt).not.toBeNull();
  });

  it('enters reconnect-required on ESPN auth failure and preserves the board', async () => {
    mockAssistThen(mockedApi);
    const { result } = renderHook(() => useLiveDraftSync('1'));
    await flush();
    expect(result.current.health).toBe('synchronized');

    mockedApi.mockImplementation((path: string) => path.endsWith('/sync')
      ? Promise.reject(new ApiError('ESPN authentication failed', { code: 'ESPN_AUTHENTICATION_FAILED', status: 401 }))
      : Promise.resolve(board));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await flush();
    expect(result.current.health).toBe('reconnect-required');
    expect(result.current.board).toEqual(board); // last valid board preserved

    mockAssistThen(mockedApi);
    act(() => { result.current.reconnect(); });
    await flush();
    expect(result.current.health).toBe('synchronized');
  });

  it('degrades to delayed then offline on repeated transient failures, preserving the board', async () => {
    mockAssistThen(mockedApi);
    const { result } = renderHook(() => useLiveDraftSync('1'));
    await flush();
    expect(result.current.health).toBe('synchronized');

    mockedApi.mockImplementation((path: string) => path.endsWith('/sync')
      ? Promise.reject(new Error('network error'))
      : Promise.resolve(board));

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await flush();
    expect(result.current.health).toBe('delayed');
    expect(result.current.board).toEqual(board);

    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
    await flush();
    expect(result.current.health).toBe('offline');
    expect(result.current.board).toEqual(board);
  });

  it('flags invalid-data when the server reports a desynced snapshot without throwing', async () => {
    mockedApi.mockImplementation((path: string) => path.endsWith('/sync')
      ? Promise.resolve({ ...okSync, desynced: true, failures: [{ pick: 5, reason: 'unknown team' }] })
      : Promise.resolve(board));
    const { result } = renderHook(() => useLiveDraftSync('1'));
    await flush();
    expect(result.current.health).toBe('invalid-data');
    expect(result.current.board).toEqual(board);
    expect(result.current.desynced).toBe(true);
  });

  it('pausing stops polling and resuming restarts it', async () => {
    mockAssistThen(mockedApi);
    const { result } = renderHook(() => useLiveDraftSync('1'));
    await flush();
    expect(result.current.health).toBe('synchronized');
    const callsBeforePause = mockedApi.mock.calls.length;

    act(() => { result.current.togglePause(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    await flush();
    expect(mockedApi.mock.calls.length).toBe(callsBeforePause);

    act(() => { result.current.togglePause(); });
    await flush();
    expect(mockedApi.mock.calls.length).toBeGreaterThan(callsBeforePause);
  });

  it('reports completed once ESPN marks the draft drafted', async () => {
    mockedApi.mockImplementation((path: string) => path.endsWith('/sync')
      ? Promise.resolve({ ...okSync, espn_complete: true })
      : Promise.resolve({ ...board, draft: { status: 'completed' } }));
    const { result } = renderHook(() => useLiveDraftSync('1'));
    await flush();
    expect(result.current.health).toBe('completed');
  });
});
