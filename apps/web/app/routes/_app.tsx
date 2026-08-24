import { AppAvailabilityBadges } from '@web/components/app-availability-badges';
import { AppBreadcrumb } from '@web/components/app-breadcrumb';
import { AppCommandPalette } from '@web/components/app-command-palette';
import { AppEnvironmentBadge } from '@web/components/app-environment-badge';
import { AppSidebar } from '@web/components/app-sidebar';
import { AuthLoading } from '@web/components/auth-loading';
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from '@web/components/ui/sidebar';
import { Toaster } from '@web/components/ui/sonner';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { rememberAppLocation, useStartupRedirect } from '@web/lib/app-location';
import { useAuthStore } from '@web/lib/auth-store';
import { useApiHealth, usePwaAvailability } from '@web/lib/availability';
import { env } from '@web/lib/env';
import { createLoginPath } from '@web/lib/session';
import { useSystemRefresh } from '@web/lib/system-refresh';
import { domAnimation, LazyMotion, m } from 'motion/react';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';

export default function AuthenticatedLayout() {
	const status = useAuthStore(({ status }) => status);
	const bootstrap = useAuthStore(({ bootstrap }) => bootstrap);
	const location = useLocation();
	const pwaAvailability = usePwaAvailability();
	const apiHealth = useApiHealth();
	const startupRedirect = useStartupRedirect(
		`${location.pathname}${location.search}`,
		window.localStorage,
	);

	// Coming back to a machine left open re-pulls whatever screen is on it. No
	// timer and no poll: with nobody touching the app it makes no requests at all.
	useSystemRefresh(
		location.pathname,
		location.search,
		status === 'authenticated',
	);

	useEffect(() => {
		if (status === 'booting') void bootstrap();
	}, [bootstrap, status]);

	useEffect(() => {
		if (startupRedirect) return;
		rememberAppLocation(
			window.localStorage,
			`${location.pathname}${location.search}${location.hash}`,
		);
	}, [location.hash, location.pathname, location.search, startupRedirect]);

	if (status === 'booting') return <AuthLoading />;
	if (status === 'unauthenticated') {
		const returnTo = `${location.pathname}${location.search}${location.hash}`;
		return <Navigate replace to={createLoginPath(returnTo)} />;
	}
	if (startupRedirect) return <Navigate replace to={startupRedirect} />;
	return (
		<TooltipProvider>
			<SidebarProvider>
				<Toaster position="bottom-right" />
				<a
					href="#main-content"
					className="fixed top-3 left-3 z-50 -translate-y-20 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform focus:translate-y-0"
				>
					Skip to content
				</a>
				<AppSidebar />
				<SidebarInset id="main-content" tabIndex={-1} className="min-w-0">
					{/* Pinned to the viewport: the breadcrumb and the environment badge are
					    orientation, and orientation that scrolls away is none. Screen
					    toolbars that pin themselves sit below it with `top-16`. */}
					<header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 overflow-hidden border-b bg-background px-4 sm:gap-3 sm:px-6">
						<SidebarTrigger className="size-11 md:size-8" />
						<div className="min-w-0 flex-1">
							<AppBreadcrumb
								pathname={location.pathname}
								search={location.search}
							/>
						</div>
						<div className="flex shrink-0 items-center gap-1 sm:gap-2">
							<AppEnvironmentBadge environment={env.VITE_ENV} />
							<AppAvailabilityBadges
								pwaAvailability={pwaAvailability}
								apiHealth={apiHealth}
							/>
						</div>
						<AppCommandPalette />
					</header>
					<LazyMotion features={domAnimation} strict>
						<m.div
							key={location.pathname}
							className="flex min-h-0 flex-1 flex-col"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
							transition={{ duration: 0.16, ease: 'easeOut' }}
						>
							<Outlet />
						</m.div>
					</LazyMotion>
				</SidebarInset>
			</SidebarProvider>
		</TooltipProvider>
	);
}
