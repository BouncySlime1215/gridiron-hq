// @ts-nocheck -- The application does not currently install a browser component-test runner.
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EspnConnect from './EspnConnect';
import { ApiError, api } from '../api';

vi.mock('../api', async importOriginal => ({ ...(await importOriginal()), api: vi.fn() }));
const mockedApi = vi.mocked(api);

async function enterLeague(user) {
  await user.type(screen.getByLabelText('League ID'), '1234567');
  await user.clear(screen.getByLabelText('Season'));
  await user.type(screen.getByLabelText('Season'), '2025');
}

describe('EspnConnect', () => {
  afterEach(() => vi.clearAllMocks());

  it('checks public access before revealing credential fields', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValue({ code: 'ESPN_PUBLIC_ACCESS', connection_state: 'public', message: 'Public.' });
    render(<EspnConnect />);
    expect(screen.queryByLabelText('espn_s2')).not.toBeInTheDocument();
    await enterLeague(user);
    await user.click(screen.getByRole('button', { name: 'Check league access' }));
    await screen.findByText(/Access confirmed/);
    expect(mockedApi.mock.calls[0][0]).toBe('/espn-connect/test');
    expect(JSON.parse(mockedApi.mock.calls[0][1].body)).toEqual({ league_id: '1234567', season: 2025 });
  });

  it('reveals private credentials, masks them, supports keyboard controls, and normalizes paste', async () => {
    const user = userEvent.setup();
    mockedApi.mockResolvedValueOnce({
      code: 'ESPN_CREDENTIALS_REQUIRED', connection_state: 'credentials_required', message: 'Credentials required.'
    });
    render(<EspnConnect />);
    await enterLeague(user);
    await user.click(screen.getByRole('button', { name: 'Check league access' }));
    const s2 = await screen.findByLabelText('espn_s2');
    const swid = screen.getByLabelText('SWID');
    expect(s2).toHaveAttribute('type', 'password');
    fireEvent.paste(s2, { clipboardData: { getData: () => ' espn_s2=secret-value; ' } });
    fireEvent.paste(swid, { clipboardData: { getData: () => 'SWID=%7bmember-id%7d;' } });
    screen.getByRole('button', { name: 'Show espn_s2' }).focus();
    await user.keyboard('{Enter}');
    expect(s2).toHaveAttribute('type', 'text');
    mockedApi.mockResolvedValueOnce({
      code: 'ESPN_CREDENTIALS_VALID', connection_state: 'credentialed', message: 'Valid.'
    });
    await user.click(screen.getByRole('button', { name: 'Test private access' }));
    await waitFor(() => expect(mockedApi).toHaveBeenCalledTimes(2));
    expect(mockedApi.mock.calls[1][0]).toBe('/espn-connect/test');
    expect(JSON.parse(mockedApi.mock.calls[1][1].body)).toMatchObject({ espn_s2: 'secret-value', swid: '{member-id}' });
  });

  it('clears rejected secrets but retains non-secret values', async () => {
    const user = userEvent.setup();
    mockedApi
      .mockResolvedValueOnce({ code: 'ESPN_CREDENTIALS_REQUIRED', connection_state: 'credentials_required', message: 'Required.' })
      .mockRejectedValueOnce(new ApiError('auth', { code: 'ESPN_CREDENTIALS_INVALID', status: 401 }));
    render(<EspnConnect />);
    await enterLeague(user);
    await user.click(screen.getByRole('button', { name: 'Check league access' }));
    await user.type(await screen.findByLabelText('espn_s2'), 'rejected');
    await user.type(screen.getByLabelText('SWID'), 'rejected');
    await user.click(screen.getByRole('button', { name: 'Test private access' }));
    await waitFor(() => expect(screen.getByLabelText('espn_s2')).toHaveValue(''));
    expect(screen.getByLabelText('SWID')).toHaveValue('');
    expect(screen.getByLabelText('League ID')).toHaveValue('1234567');
    expect(screen.getByLabelText('Season')).toHaveValue(2025);
  });

  it('prevents duplicate submissions while a request is pending', async () => {
    const user = userEvent.setup();
    let resolve;
    mockedApi.mockReturnValue(new Promise(done => { resolve = done; }));
    render(<EspnConnect />);
    await enterLeague(user);
    const form = screen.getByRole('button', { name: 'Check league access' }).closest('form');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mockedApi).toHaveBeenCalledTimes(1);
    resolve({ code: 'ESPN_PUBLIC_ACCESS', connection_state: 'public', message: 'Public.' });
  });
});
