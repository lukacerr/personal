// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { AppBreadcrumb } from '@web/components/app-breadcrumb';
import type { Payment } from '@web/lib/finance-api';
import { useFinanceStore } from '@web/lib/finance-store';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
	cleanup();
	useFinanceStore.setState({ payments: [], status: 'idle' });
});

describe('AppBreadcrumb', () => {
	/**
	 * A deep link to a record resolves its trail before the store behind it has
	 * loaded. The breadcrumb has to hear the store land — the same signal the
	 * palette listens to — or the trail stays empty forever.
	 */
	it('recomputes the trail when a store-backed system loads after the deep link', async () => {
		render(
			<MemoryRouter>
				<AppBreadcrumb pathname="/finance" search="?payment=p1" />
			</MemoryRouter>,
		);

		await waitFor(() =>
			expect(screen.getAllByText('Finance').length).toBeGreaterThan(0),
		);
		expect(screen.queryByText('Rent March')).toBeNull();

		act(() => {
			useFinanceStore.setState({
				payments: [{ id: 'p1', title: 'Rent March' } as Payment],
			});
		});

		await waitFor(() =>
			expect(screen.getAllByText('Rent March').length).toBeGreaterThan(0),
		);
	});
});
