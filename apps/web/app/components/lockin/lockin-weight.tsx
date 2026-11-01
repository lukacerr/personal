import { Card } from '@web/components/ui/card';
import {
	challengeDates,
	formatDay,
	type LockinLog,
	weightRatePerWeek,
	weightTrend,
} from '@web/lib/lockin';
import type { LockinWindow } from '@web/lib/lockin-api';
import { cn } from '@web/lib/utils';
import { ScaleIcon } from 'lucide-react';
import { useState } from 'react';

const WIDTH = 700;
const HEIGHT = 500;

const kgFormat = new Intl.NumberFormat('en-US', {
	minimumFractionDigits: 1,
	maximumFractionDigits: 2,
});
const formatKg = (kg: number) => `${kgFormat.format(kg)} kg`;
/** One decimal: a second one on an average is precision the scale never had. */
const formatAverage = (kg: number) => `${kg.toFixed(1)} kg`;
const signed = (value: number, unit: string) =>
	`${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)} ${unit}`;

/** Round-number gridlines that bracket the values with a little air. */
function axisTicks(values: number[]) {
	const low = Math.min(...values);
	const high = Math.max(...values);
	const span = Math.max(high - low, 1);
	const step = span <= 2 ? 0.5 : span <= 5 ? 1 : 2;
	const from = Math.floor((low - step / 2) / step) * step;
	const to = Math.ceil((high + step / 2) / step) * step;
	const ticks: number[] = [];
	for (let tick = from; tick <= to + 1e-9; tick += step)
		ticks.push(Math.round(tick * 10) / 10);
	return { ticks, from, to };
}

/**
 * Weight over time, as the eighth card of the habits grid: the same header,
 * the same big figure, and the plot where the others keep their day grid —
 * same footprint, so the grid closes on an even row.
 *
 * Tracked, not judged, so nothing is coloured as a success or a failure: the
 * dots are the noise, the line is the seven-day trend under them, and the x
 * axis is the whole challenge so the empty stretch ahead reads as time left.
 * The rate is a least-squares slope, not first-versus-last.
 *
 * The plot stretches to its box (`preserveAspectRatio="none"`), so strokes are
 * non-scaling and each dot is a zero-length round-capped line — the one mark
 * that stays round under a stretch. Labels, the hover guide and its tooltip
 * live in HTML, positioned by percentage, where nothing stretches.
 */
export function LockinWeightCard({
	window,
	log,
	today,
}: {
	window: LockinWindow;
	log: LockinLog;
	today: string;
}) {
	const [hovered, setHovered] = useState<number>();

	const dates = challengeDates(window);
	const trend = weightTrend(window, log, today);
	const weighed = trend.filter(
		(point): point is typeof point & { kg: number } => point.kg !== null,
	);
	const first = weighed[0];
	const latest = weighed.at(-1);
	const rate = weightRatePerWeek(trend);
	const change = first && latest ? latest.kg - first.kg : undefined;

	const values = trend.flatMap((point) =>
		[point.kg, point.average].filter((kg): kg is number => kg !== null),
	);
	const { ticks, from, to } = axisTicks(values.length > 0 ? values : [80]);
	const xShare = (index: number) => (index + 0.5) / dates.length;
	const yShare = (kg: number) => (to - kg) / (to - from || 1);
	const x = (date: string) => xShare(dates.indexOf(date)) * WIDTH;
	const y = (kg: number) => yShare(kg) * HEIGHT;

	const path = (points: Array<{ date: string; kg: number }>) =>
		points
			.map(
				(point, index) =>
					`${index === 0 ? 'M' : 'L'}${x(point.date).toFixed(1)},${y(point.kg).toFixed(1)}`,
			)
			.join(' ');
	const averages = trend.flatMap((point) =>
		point.average === null ? [] : [{ date: point.date, kg: point.average }],
	);
	const todayIndex = dates.indexOf(today);
	const hoveredPoint = hovered === undefined ? undefined : trend[hovered];
	// Top and bottom only: the card is small, and the tooltip carries the rest.
	const labelled = [ticks[0], ticks.at(-1)].filter(
		(tick): tick is number => tick !== undefined,
	);

	return (
		<Card size="sm" className="h-full gap-3 px-3 @lg:px-4">
			<div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
				<h3 className="flex items-center gap-2 font-medium">
					<ScaleIcon aria-hidden className="size-4 text-muted-foreground" />
					Weight
				</h3>
				<span className="text-muted-foreground text-xs">Tracked</span>
			</div>

			<div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
				<div className="flex flex-col gap-0.5">
					<p className="flex items-baseline gap-1.5">
						<span className="font-mono font-semibold text-2xl tabular-nums @lg:text-3xl">
							{latest ? kgFormat.format(latest.kg) : '—'}
						</span>
						<span className="text-muted-foreground text-sm">kg</span>
					</p>
					<p className="text-muted-foreground text-xs">
						{first && change !== undefined ? (
							<>
								<span className="font-mono tabular-nums">
									{signed(change, 'kg')}
								</span>{' '}
								since {formatDay(first.date).replace(/^\w+ /, '')}
							</>
						) : (
							'No weigh-ins yet'
						)}
					</p>
				</div>
				{rate !== undefined ? (
					<span className="font-mono text-sm tabular-nums">
						{signed(rate, 'kg/wk')}
					</span>
				) : null}
			</div>

			<div className="relative mt-auto h-18 w-full">
				<svg
					role="img"
					aria-label={
						first && latest
							? `Weight from ${formatKg(first.kg)} on ${formatDay(first.date)} to ${formatKg(latest.kg)} on ${formatDay(latest.date)}`
							: 'No weigh-ins yet'
					}
					viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
					preserveAspectRatio="none"
					className="absolute inset-0 size-full overflow-visible"
				>
					{ticks.map((tick) => (
						<line
							key={tick}
							x1={0}
							x2={WIDTH}
							y1={y(tick)}
							y2={y(tick)}
							className="stroke-border"
							strokeWidth={1}
							vectorEffect="non-scaling-stroke"
						/>
					))}
					{todayIndex >= 0 ? (
						<line
							x1={xShare(todayIndex) * WIDTH}
							x2={xShare(todayIndex) * WIDTH}
							y1={0}
							y2={HEIGHT}
							className="stroke-muted-foreground/50"
							strokeWidth={1}
							strokeDasharray="3 3"
							vectorEffect="non-scaling-stroke"
						/>
					) : null}
					<path
						d={path(averages)}
						fill="none"
						className="stroke-chart-1"
						strokeWidth={2.5}
						strokeLinejoin="round"
						strokeLinecap="round"
						vectorEffect="non-scaling-stroke"
					/>
					{weighed.map((point) => {
						const active = trend.indexOf(point) === hovered;
						return (
							<line
								key={point.date}
								x1={x(point.date)}
								x2={x(point.date)}
								y1={y(point.kg)}
								y2={y(point.kg)}
								className={active ? 'stroke-foreground' : 'stroke-chart-3'}
								strokeWidth={active ? 10 : 6}
								strokeLinecap="round"
								vectorEffect="non-scaling-stroke"
							/>
						);
					})}
				</svg>

				{labelled.map((tick) => (
					<span
						key={tick}
						aria-hidden
						className="pointer-events-none absolute left-0 -translate-y-1/2 bg-card pr-1 font-mono text-[10px] text-muted-foreground tabular-nums"
						style={{ top: `${yShare(tick) * 100}%` }}
					>
						{tick % 1 === 0 ? tick : tick.toFixed(1)}
					</span>
				))}

				{weighed.length === 0 ? (
					<p className="absolute inset-0 flex items-center justify-center text-center text-muted-foreground text-xs">
						The first weigh-in sets the start.
					</p>
				) : (
					<div
						aria-hidden
						className="absolute inset-0"
						onPointerMove={(event) => {
							const box = event.currentTarget.getBoundingClientRect();
							const index = Math.floor(
								((event.clientX - box.left) / box.width) * dates.length,
							);
							setHovered(
								index >= 0 && index < trend.length ? index : undefined,
							);
						}}
						onPointerLeave={() => setHovered(undefined)}
					>
						{hoveredPoint && hovered !== undefined ? (
							<>
								<span
									className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40"
									style={{ left: `${xShare(hovered) * 100}%` }}
								/>
								<span
									className={cn(
										'pointer-events-none absolute top-0 z-10 flex flex-col gap-0.5 whitespace-nowrap rounded-lg bg-popover px-2.5 py-1.5 text-xs shadow-md ring-1 ring-foreground/10',
										xShare(hovered) > 0.5
											? '-translate-x-[calc(100%+0.5rem)]'
											: 'translate-x-2',
									)}
									style={{ left: `${xShare(hovered) * 100}%` }}
								>
									<span className="font-medium">
										{formatDay(hoveredPoint.date)}
									</span>
									<span className="font-mono tabular-nums">
										{hoveredPoint.kg === null
											? 'No weigh-in'
											: formatKg(hoveredPoint.kg)}
									</span>
									{hoveredPoint.average !== null ? (
										<span className="font-mono text-muted-foreground tabular-nums">
											7-day {formatAverage(hoveredPoint.average)}
										</span>
									) : null}
								</span>
							</>
						) : null}
					</div>
				)}
			</div>

			{/*
			 * The same numbers as a table, for whoever cannot see the plot. Hidden
			 * through a wrapper: a table ignores `sr-only`'s 1px width and pushes
			 * the page sideways.
			 */}
			<div className="sr-only">
				<table>
					<caption>Weigh-ins</caption>
					<thead>
						<tr>
							<th scope="col">Day</th>
							<th scope="col">Weight</th>
							<th scope="col">7-day average</th>
						</tr>
					</thead>
					<tbody>
						{weighed.map((point) => (
							<tr key={point.date}>
								<td>{formatDay(point.date)}</td>
								<td>{formatKg(point.kg)}</td>
								<td>
									{point.average === null ? '' : formatAverage(point.average)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Card>
	);
}
