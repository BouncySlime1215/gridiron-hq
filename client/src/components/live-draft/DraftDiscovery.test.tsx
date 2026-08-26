// @ts-nocheck -- no browser component-test runner types installed
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DraftDiscovery from './DraftDiscovery';
import { ApiError, api } from '../../api';

vi.mock('../../api', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }));
const mockedApi = vi.mocked(api);

const baseFixture = {
  league_row_id: 1, league_id: '555555', season: 2026, name: 'Dynasty Dudes',
  status: 'scheduled', scheduled_at: '2026-09-01T00:00:00.000Z',
  team_count: 12, rounds: 16, draft_type: 'snake', pick_seconds: 90,
  roster_positions: { QB: 1, RB: 2, WR: 2 },
  my_team: { espn_team_id: 3, name: 'My Squad' }, my_slot: 3,
  pick_order: [7, 2, 3, 9], ownership_confirmed: true, local_draft_id: null
};

function renderPage() {
  return render(<MemoryRouter><DraftDiscovery /></MemoryRouter>);
}

describe('DraftDiscovery', () => {
  afterEach(() => { vi.clearAllMocks(); cleanup(); });

  it('shows all required setup fields for a fixture', async () => {
    mockedApi.mockResolvedValueOnce([baseFixture]);
    renderPage();
    const card = await screen.findByTestId('draft-fixture');
    expect(within(card).getByText('Dynasty Dudes')).toBeInTheDocument();
    expect(within(card).getAllByText('Scheduled').length).toBeGreaterThan(0);
    expect(within(card).getByText('555555')).toBeInTheDocument();
    expect(within(card).getByText('2026')).toBeInTheDocument();
    expect(within(card).getByText('12')).toBeInTheDocument();
    expect(within(card).getByText('16')).toBeInTheDocument();
    expect(within(card).getByText('snake')).toBeInTheDocument();
    expect(within(card).getByText('90s')).toBeInTheDocument();
    expect(within(card).getByText('My Squad')).toBeInTheDocument();
    expect(within(card).getByText('3')).toBeInTheDocument();
    expect(within(card).getByText(/QB, 2 RB, 2 WR/)).toBeInTheDocument();
  });

  it('shows a discovery-level error without crashing when the fetch fails', async () => {
    mockedApi.mockRejectedValueOnce(new Error('network down'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
  });

  it('shows an empty state when no ESPN drafts are found', async () => {
    mockedApi.mockResolvedValueOnce([]);
    renderPage();
    expect(await screen.findByText(/No ESPN drafts found/)).toBeInTheDocument();
  });

  it('disables Start until an unproven team is explicitly confirmed, then enables it', async () => {
    const user = userEvent.setup();
    const unconfirmed = { ...baseFixture, ownership_confirmed: false, my_team: null, my_slot: null };
    mockedApi.mockResolvedValueOnce([unconfirmed]);
    renderPage();
    const card = await screen.findByTestId('draft-fixture');
    const startBtn = within(card).getByRole('button', { name: 'Start Live Draft' });
    expect(startBtn).toBeDisabled();

    mockedApi.mockResolvedValueOnce({ ok: true });
    await user.selectOptions(within(card).getByLabelText('Your ESPN team'), '3');
    await user.click(within(card).getByRole('button', { name: 'Confirm my team' }));
    await waitFor(() => expect(startBtn).toBeEnabled());
    expect(mockedApi).toHaveBeenCalledWith('/drafts/live/confirm-team', expect.objectContaining({
      body: JSON.stringify({ league_row_id: 1, espn_team_id: 3 })
    }));
  });

  it('never silently assigns a roster: no start call happens before confirmation', async () => {
    const unconfirmed = { ...baseFixture, ownership_confirmed: false, my_team: null, my_slot: null };
    mockedApi.mockResolvedValueOnce([unconfirmed]);
    renderPage();
    await screen.findByTestId('draft-fixture');
    expect(mockedApi).toHaveBeenCalledTimes(1); // only the discover call
  });

  it('shows "Start Live Draft" for a never-started fixture and reuses the returned draft id', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValueOnce([baseFixture]);
    renderPage();
    const card = await screen.findByTestId('draft-fixture');
    expect(within(card).getByRole('button', { name: 'Start Live Draft' })).toBeInTheDocument();

    mockedApi.mockResolvedValueOnce({ draft_id: 42, created: true, sync: {} });
    await user.click(within(card).getByRole('button', { name: 'Start Live Draft' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith('/drafts/live/link', expect.objectContaining({
      body: JSON.stringify({ league_row_id: 1 })
    })));
  });

  it('shows "Resume Live Draft" once a local draft already exists for the league', async () => {
    mockedApi.mockResolvedValueOnce([{ ...baseFixture, status: 'active', local_draft_id: 42 }]);
    renderPage();
    const card = await screen.findByTestId('draft-fixture');
    expect(within(card).getByRole('button', { name: 'Resume Live Draft' })).toBeInTheDocument();
  });

  it('surfaces an authentication-expiry error with a recovery message instead of crashing', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValueOnce([{ ...baseFixture, local_draft_id: 42 }]);
    renderPage();
    const card = await screen.findByTestId('draft-fixture');
    mockedApi.mockRejectedValueOnce(new ApiError('expired', { code: 'ESPN_AUTHENTICATION_FAILED', status: 401 }));
    await user.click(within(card).getByRole('button', { name: 'Resume Live Draft' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent(/reconnect this league in Settings/);
  });
});
