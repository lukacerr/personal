import { AuthLoading } from '@web/components/auth-loading';
import { Button } from '@web/components/ui/button';
import { useAuthStore } from '@web/lib/auth-store';
import { env } from '@web/lib/env';
import { createGoogleLoginUrl, getSafeReturnTo } from '@web/lib/session';
import { LogInIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router';

export function meta() {
	return [
		{ title: 'Sign in | Personal systems' },
		{
			name: 'description',
			content: "Sign in to Luka's personal operating system.",
		},
	];
}

export function LoginPanel({
	hasOAuthError,
	onSignIn,
}: {
	hasOAuthError: boolean;
	onSignIn: () => void;
}) {
	return (
		<main className="grid min-h-svh place-items-center bg-background px-6">
			<div className="flex w-full max-w-xs flex-col gap-4">
				{hasOAuthError ? (
					<p className="text-center text-sm text-destructive" role="alert">
						The sign-in response was invalid. Please try again.
					</p>
				) : null}
				<Button className="w-full" size="lg" onClick={onSignIn}>
					<LogInIcon data-icon="inline-start" aria-hidden="true" />
					Continue with Google
				</Button>
			</div>
		</main>
	);
}

export default function Login() {
	const [searchParams] = useSearchParams();
	const status = useAuthStore(({ status }) => status);
	const bootstrap = useAuthStore(({ bootstrap }) => bootstrap);
	const returnTo = getSafeReturnTo(searchParams.get('returnTo'));
	const hasOAuthError = searchParams.get('error') === 'oauth';

	useEffect(() => {
		if (status === 'booting') void bootstrap();
	}, [bootstrap, status]);

	if (status === 'booting') return <AuthLoading />;
	if (status === 'authenticated') return <Navigate replace to={returnTo} />;

	const signIn = () => {
		window.location.assign(
			createGoogleLoginUrl({
				apiUrl: env.VITE_API_URL,
				appOrigin: window.location.origin,
				returnTo,
			}),
		);
	};

	return <LoginPanel hasOAuthError={hasOAuthError} onSignIn={signIn} />;
}
