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
import { useAuthStore } from '@web/lib/auth-store';
import { clearLocalNotes } from '@web/lib/notes-db';
import { LogOutIcon } from 'lucide-react';
import { NavLink, useLocation } from 'react-router';

export function AppSidebar() {
	const clearSession = useAuthStore(({ clearSession }) => clearSession);
	const { isMobile, setOpenMobile } = useSidebar();
	const { pathname } = useLocation();
	const signOut = async () => {
		await clearLocalNotes();
		clearSession();
	};

	return (
		<Sidebar collapsible="offcanvas">
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton
							size="lg"
							render={<NavLink to="/" />}
							onClick={() => {
								if (isMobile) setOpenMobile(false);
							}}
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
											render={<NavLink to={path} end={path === '/'} />}
											onClick={() => {
												if (isMobile) setOpenMobile(false);
											}}
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
