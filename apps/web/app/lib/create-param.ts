import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

/**
 * The command palette can only navigate, so "add" intents arrive as `?new=1`.
 * The parameter is consumed on sight and erased with `replace`: left in the
 * url, every later change to the view would fire the intent again.
 */
export function useConsumeCreateParam(onCreate: () => void) {
	const [searchParams, setSearchParams] = useSearchParams();

	useEffect(() => {
		if (!searchParams.has('new')) return;
		onCreate();
		setSearchParams(
			(current) => {
				const next = new URLSearchParams(current);
				next.delete('new');
				return next;
			},
			{ replace: true },
		);
	}, [searchParams, setSearchParams, onCreate]);
}
