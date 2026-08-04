import { AppBreadcrumb } from '@web/components/app-breadcrumb';
import { AppCommandPalette } from '@web/components/app-command-palette';
import { AppSidebar } from '@web/components/app-sidebar';
import { AuthLoading } from '@web/components/auth-loading';
import {
	SidebarInset,
	SidebarProvider,
	SidebarTrigger,
} from '@web/components/ui/sidebar';
import { TooltipProvider } from '@web/components/ui/tooltip';
import { useAuthStore } from '@web/lib/auth-store';
import { createLoginPath } from '@web/lib/session';
import { domAnimation, LazyMotion, m } from 'motion/react';
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
	return (
		<TooltipProvider>
			<SidebarProvider>
				<a
					href="#main-content"
					className="fixed top-3 left-3 z-50 -translate-y-20 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-transform focus:translate-y-0"
				>
					Skip to content
				</a>
				<AppSidebar />
				<SidebarInset id="main-content" tabIndex={-1} className="min-w-0">
					<header className="flex h-16 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
						<SidebarTrigger className="size-11 md:size-8" />
						<div className="min-w-0 flex-1">
							<AppBreadcrumb pathname={location.pathname} />
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
