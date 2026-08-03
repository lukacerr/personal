import { AuthLoading } from '@web/components/auth-loading';
import { useAuthStore } from '@web/lib/auth-store';
import {
	createLoginPath,
	getOAuthSessionFromHash,
	getSafeReturnTo,
} from '@web/lib/session';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

export function meta() {
	return [{ title: 'Completing sign in | Personal systems' }];
}

export default function AuthCallback() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const setSession = useAuthStore(({ setSession }) => setSession);
	const clearSession = useAuthStore(({ clearSession }) => clearSession);
	const returnTo = getSafeReturnTo(searchParams.get('returnTo'));

	useEffect(() => {
		const session = getOAuthSessionFromHash(window.location.hash);

		if (!session) {
			clearSession();
			navigate(`${createLoginPath(returnTo)}&error=oauth`, {
				replace: true,
			});
			return;
		}

		setSession(session);
		navigate(returnTo, { replace: true });
	}, [clearSession, navigate, returnTo, setSession]);

	return <AuthLoading label="Completing Google sign in" />;
}
