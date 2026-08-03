import { Spinner } from '@web/components/ui/spinner';

export function AuthLoading({ label = 'Restoring your session' }) {
	return (
		<main className="grid min-h-svh place-items-center bg-background px-6">
			<div className="flex items-center gap-3 text-sm text-muted-foreground">
				<Spinner aria-hidden="true" />
				<span>{label}</span>
			</div>
		</main>
	);
}
