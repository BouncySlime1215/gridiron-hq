// @ts-nocheck -- The application does not currently install a browser component-test runner.
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PostDraftPlan from './PostDraftPlan';
import { useApi } from '../api';

vi.mock('../api', async importOriginal => ({ ...(await importOriginal()), useApi: vi.fn() }));
const mockedUseApi = vi.mocked(useApi);

describe('PostDraftPlan', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders nothing when there is no team selected yet', () => {
    mockedUseApi.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    const { container } = render(<PostDraftPlan leagueId={1} teamId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches the combined post-draft-plan endpoint for the active team', () => {
    mockedUseApi.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    render(<PostDraftPlan leagueId={1} teamId="42" />);
    expect(mockedUseApi).toHaveBeenCalledWith('/trades/1/post-draft-plan?team_id=42');
  });

  it('shows a loading state before data arrives', () => {
    mockedUseApi.mockReturnValue({ data: null, loading: true, error: null, refetch: vi.fn() });
    render(<PostDraftPlan leagueId={1} teamId="42" />);
    expect(screen.getByText(/Loading your post-draft plan/)).toBeInTheDocument();
  });

  it('shows an explicit not-yet-drafted state without erroring', () => {
    mockedUseApi.mockReturnValue({
      data: { drafted: false, message: 'Draft is still in progress.' }, loading: false, error: null, refetch: vi.fn()
    });
    render(<PostDraftPlan leagueId={1} teamId="42" />);
    expect(screen.getByText('Draft is still in progress.')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).not.toBeInTheDocument();
  });

  it('renders self-scout, trade, and lineup sections once the draft is complete', () => {
    mockedUseApi.mockReturnValue({
      data: {
        drafted: true,
        self_scout: { fixes: [{ issue: 'Thin at RB', action: 'Target a handcuff on waivers' }] },
        trades: { deals: [{ partner: 'Team B', i_give: [{ name: 'Player A' }], i_get: [{ name: 'Player B' }] }] },
        lineup: {
          points: 112.4,
          slots: [{ slot: 'QB', player: { name: 'Josh Allen', position: 'QB' } }, { slot: 'RB', player: null }],
          bench: []
        }
      },
      loading: false, error: null, refetch: vi.fn()
    });
    render(<PostDraftPlan leagueId={1} teamId="42" />);
    expect(screen.getByText('Thin at RB')).toBeInTheDocument();
    expect(screen.getByText('Target a handcuff on waivers')).toBeInTheDocument();
    expect(screen.getByText('Team B')).toBeInTheDocument();
    expect(screen.getByText(/Player A.*for.*Player B/)).toBeInTheDocument();
    expect(screen.getByText('Josh Allen')).toBeInTheDocument();
    expect(screen.getByText('— empty —')).toBeInTheDocument();
    expect(screen.getByText('112.4 ppg')).toBeInTheDocument();
  });

  it('shows an error state with a retry option and does not crash', () => {
    const refetch = vi.fn();
    mockedUseApi.mockReturnValue({ data: null, loading: false, error: 'network down', refetch });
    render(<PostDraftPlan leagueId={1} teamId="42" />);
    expect(screen.getByText(/Couldn't load the post-draft plan: network down/)).toBeInTheDocument();
    screen.getByRole('button', { name: 'Retry' }).click();
    expect(refetch).toHaveBeenCalled();
  });
});
