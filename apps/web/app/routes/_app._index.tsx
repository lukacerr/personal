import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@web/components/ui/card';
import {
	BotIcon,
	CalendarDaysIcon,
	ChartNoAxesCombinedIcon,
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
		title: 'Finance',
		description: 'Accounts, movement and personal decisions.',
	},
	{
		icon: SaladIcon,
		title: 'Nutrition',
		description: 'Meals, calories and long-term signals.',
	},
	{
		icon: BotIcon,
		title: 'Agent',
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
	return (
		<div className="flex flex-1 bg-muted/35">
			<div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-5 py-10 sm:px-8 sm:py-12 lg:px-12 lg:py-16">
				<section className="flex flex-col gap-3">
					<p className="font-heading text-xs font-semibold tracking-[0.2em] text-muted-foreground uppercase">
						Overview / 01
					</p>
					<h1 className="max-w-2xl font-heading text-4xl font-semibold tracking-[-0.04em] text-balance sm:text-5xl">
						Everything personal, connected!
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
		</div>
	);
}
