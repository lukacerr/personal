import { AuthLoading } from '@web/components/auth-loading';
import { useAuthStore } from '@web/lib/auth-store';
import { createLoginPath } from '@web/lib/session';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

export default function AuthenticatedLayout() {
	const status = useAuthStore(({ status }) => status);
	const bootstrap = useAuthStore(({ bootstrap }) => bootstrap);
	const location = useLocation();

	useEffect(() => {
		if (status === 'booting') void bootstrap();
	}, [bootstrap, status]);

	if (status === 'booting') return <AuthLoading />;
	if (status === 'unauthenticated') {
		const returnTo = `${location.pathname}${location.search}${location.hash}`;
		return <Navigate replace to={createLoginPath(returnTo)} />;
	}

	return <Outlet />;
}
