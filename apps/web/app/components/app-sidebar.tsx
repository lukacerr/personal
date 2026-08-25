import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarRail,
	useSidebar,
} from '@web/components/ui/sidebar';
import { appNavigation } from '@web/lib/app-navigation';
import {
	clearLocalSystemData,
	getSystemDataRevision,
	loadSystemSummaries,
	type SystemSummaryRow,
	subscribeToSystemData,
} from '@web/lib/app-systems';
import { useAuthStore } from '@web/lib/auth-store';
import { useLiveQuery } from 'dexie-react-hooks';
import { LogOutIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { NavLink, useLocation } from 'react-router';
import { toast } from 'sonner';

/**
 * One weight for every value, whatever it says.
 *
 * A summary reports; it does not raise its voice. A row that needs to say
 * something is wrong says it in words — Notes writes "Failed" — because colour
 * alone is not a message anyone can read out loud.
 */
const DETAIL_CLASS = 'shrink-0 text-xs tabular-nums text-sidebar-foreground/60';

/**
 * What every system currently has to say, in sidebar order.
 *
 * The shell learns nothing about any solution here: it asks the registry and
 * renders two row shapes — one that leads somewhere and one that is only a
 * reading. Which of the two a row is comes from the row itself.
 *
 * Resolved from a single `useLiveQuery`, exactly as the breadcrumb and the
 * palette are, so Dexie-backed systems track their own tables and the two
 * store-backed ones report through `subscribeToSystemData`.
 */
function SystemSummaries({ onNavigate }: { onNavigate: () => void }) {
	const { isMobile, open, openMobile } = useSidebar();
	// A collapsed sidebar stays in the DOM, so without this every system would
	// keep answering questions whose answers nobody can see.
	const visible = isMobile ? openMobile : open;
	const systemRevision = useSyncExternalStore(
		subscribeToSystemData,
		getSystemDataRevision,
		getSystemDataRevision,
	);
	const groups = useLiveQuery(
		() => (visible ? loadSystemSummaries() : Promise.resolve([])),
		[visible, systemRevision],
		[],
	);

	return groups.map(({ system, summary }) => {
		const labelId = `system-summary-${system.key}`;
		const Icon = system.icon;
		// Narrowed rather than asserted, so `to` is a string for the `NavLink`
		// without the render path claiming anything the row did not say.
		const links = summary.rows.filter(
			(row): row is SystemSummaryRow & { to: string } => row.to !== undefined,
		);
		const readings = summary.rows.filter((row) => row.to === undefined);

		return (
			<SidebarGroup key={system.key} role="group" aria-labelledby={labelId}>
				<SidebarGroupLabel id={labelId} className="gap-2">
					<Icon aria-hidden="true" />
					{system.heading}
				</SidebarGroupLabel>
				<SidebarGroupContent>
					{links.length > 0 && (
						<SidebarMenu>
							{links.map((row) => (
								<SidebarMenuItem key={row.key}>
									<SidebarMenuButton
										render={<NavLink to={row.to} />}
										onClick={onNavigate}
									>
										<span className="min-w-0 flex-1 truncate" title={row.label}>
											{row.label}
										</span>
										{row.detail && (
											<span className={DETAIL_CLASS}>{row.detail}</span>
										)}
									</SidebarMenuButton>
								</SidebarMenuItem>
							))}
						</SidebarMenu>
					)}
					{/*
					 * Label/value pairs are a description list, whatever they describe.
					 *
					 * The row carries `min-w-0` of its own, and `truncate` on the label
					 * is not enough without it. A `flex-1` child makes its flex parent's
					 * min-content width the child's *full* text width, and a grid item
					 * may not shrink below min-content while its `min-width` is `auto` —
					 * so one long title widened the shared column, and `SidebarContent`
					 * scrolled every detail in the group out of sight, including the
					 * ones beside short titles. The link rows escape this by being
					 * `w-full` buttons, which are never sized by their content.
					 */}
					{readings.length > 0 && (
						<dl className="grid gap-1 px-3 py-1">
							{readings.map((row) => (
								<div className="flex min-w-0 items-center gap-2" key={row.key}>
									<dt className="min-w-0 flex-1 truncate" title={row.label}>
										{row.label}
									</dt>
									<dd className={DETAIL_CLASS}>{row.detail}</dd>
								</div>
							))}
						</dl>
					)}
				</SidebarGroupContent>
			</SidebarGroup>
		);
	});
}

export function AppSidebar() {
	const clearSession = useAuthStore(({ clearSession }) => clearSession);
	const { isMobile, setOpenMobile } = useSidebar();
	const { pathname } = useLocation();
	const closeOnMobile = () => {
		if (isMobile) setOpenMobile(false);
	};
	const signOut = async () => {
		try {
			await clearLocalSystemData();
		} catch {
			// Signing out must still happen, but leaving data behind on a device
			// being handed back is worth saying out loud, at the point of action.
			toast.error('Some local data could not be cleared from this device.');
		} finally {
			clearSession();
		}
	};

	return (
		<Sidebar collapsible="offcanvas">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							render={<NavLink to="/" />}
							onClick={closeOnMobile}
						>
							<span className="grid size-8 shrink-0 place-items-center rounded-xl bg-primary font-heading text-xs font-semibold text-primary-foreground">
								L
							</span>
							<span className="flex min-w-0 flex-col leading-tight">
								<span className="truncate font-heading font-semibold">
									Personal
								</span>
								<span className="truncate text-xs text-muted-foreground">
									Private workspace
								</span>
							</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>

			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Systems</SidebarGroupLabel>
					<SidebarGroupContent>
						<nav aria-label="Primary">
							<SidebarMenu>
								{appNavigation.map(({ icon: Icon, label, path }) => (
									<SidebarMenuItem key={path}>
										<SidebarMenuButton
											isActive={pathname === path}
											// `end` unconditionally, so NavLink's own matching agrees
											// with the exact comparison above. It used to be reserved
											// for the entry at `/`, which no longer exists: every
											// system keeps its state in the query string, so none of
											// these paths is ever a prefix of the open route.
											render={<NavLink to={path} end />}
											onClick={closeOnMobile}
										>
											<Icon aria-hidden="true" />
											<span>{label}</span>
										</SidebarMenuButton>
									</SidebarMenuItem>
								))}
							</SidebarMenu>
						</nav>
					</SidebarGroupContent>
				</SidebarGroup>
				<SystemSummaries onNavigate={closeOnMobile} />
			</SidebarContent>

			<SidebarFooter>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton onClick={() => void signOut()}>
							<LogOutIcon aria-hidden="true" />
							<span>Sign out</span>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarFooter>
			<SidebarRail />
		</Sidebar>
	);
}
