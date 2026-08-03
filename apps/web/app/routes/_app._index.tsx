import { Button } from '@web/components/ui/button';
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@web/components/ui/card';
import { useAuthStore } from '@web/lib/auth-store';
import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
	LogOutIcon,
	SaladIcon,
} from 'lucide-react';

const systems = [
	{
		icon: CalendarDaysIcon,
		title: 'Calendar',
		description: 'Time, plans and the shape of the week.',
	},
	{
		icon: ChartNoAxesCombinedIcon,
		title: 'Finances',
		description: 'Accounts, movement and personal decisions.',
	},
	{
		icon: SaladIcon,
		title: 'Nutrition',
		description: 'Meals, calories and long-term signals.',
	},
	{
		icon: BotIcon,
		title: 'Agents',
		description: 'Automations connected to the whole system.',
	},
];

export function meta() {
	return [
		{ title: 'Personal systems' },
		{
			name: 'description',
			content: "Luka's personal operating system.",
		},
	];
}

export default function Home() {
	const clearSession = useAuthStore(({ clearSession }) => clearSession);

	return (
		<main className="min-h-svh bg-muted/35">
			<header className="border-b bg-background">
				<div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5 lg:px-10">
					<div className="flex items-center gap-3">
						<span className="grid size-8 place-items-center rounded-full bg-primary font-heading text-xs font-semibold text-primary-foreground">
							L
						</span>
						<div>
							<p className="font-heading text-sm font-semibold">
								Personal systems
							</p>
							<p className="text-xs text-muted-foreground">Private workspace</p>
						</div>
					</div>
					<Button variant="ghost" size="sm" onClick={clearSession}>
						<LogOutIcon data-icon="inline-start" aria-hidden="true" />
						Sign out
					</Button>
				</div>
			</header>

			<div className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-12 lg:px-10 lg:py-16">
				<section className="flex flex-col gap-3">
					<p className="font-heading text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
						Overview / 01
					</p>
					<h1 className="max-w-2xl font-heading text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-5xl">
						Everything personal, connected.
					</h1>
					<p className="max-w-xl text-base leading-7 text-muted-foreground">
						The foundation is online. Each system will become available here as
						it is built.
					</p>
				</section>

				<section aria-labelledby="systems-heading">
					<h2 id="systems-heading" className="sr-only">
						Personal systems
					</h2>
					<div className="grid gap-4 sm:grid-cols-2">
						{systems.map(({ icon: Icon, title, description }, index) => (
							<Card
								key={title}
								className="min-h-48 justify-between shadow-none"
							>
								<CardHeader>
									<div className="mb-8 flex items-center justify-between text-muted-foreground">
										<Icon aria-hidden="true" />
										<span className="font-heading text-[0.65rem] tracking-[0.18em]">
											0{index + 1}
										</span>
									</div>
									<CardTitle>{title}</CardTitle>
									<CardDescription>{description}</CardDescription>
								</CardHeader>
								<CardContent>
									<p className="text-xs font-medium tracking-[0.14em] text-muted-foreground uppercase">
										Planned
									</p>
								</CardContent>
							</Card>
						))}
					</div>
				</section>
			</div>
		</main>
	);
}
