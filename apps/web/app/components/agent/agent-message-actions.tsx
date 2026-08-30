import { Badge } from '@web/components/ui/badge';
import { Button } from '@web/components/ui/button';
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from '@web/components/ui/tooltip';
import {
	formatDuration,
	formatTokenCount,
	tokensPerSecond,
} from '@web/lib/agent';
import { cn } from '@web/lib/utils';
import {
	CheckIcon,
	CopyIcon,
	CpuIcon,
	GaugeIcon,
	PencilIcon,
	RefreshCcwIcon,
	SplitIcon,
	TimerIcon,
	WrenchIcon,
	ZapIcon,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * The persisted numbers of one turn, read structurally so this component does
 * not have to move whenever the server records one more.
 */
export type AgentMessageStats = {
	/** `compaction` rows render as a divider, not as a reply. */
	kind?: 'compaction';
	model?: string;
	reasoning?: string;
	totalTokens?: number;
	outputTokens?: number;
	firstTokenMs?: number;
	durationMs?: number;
	tools?: string[];
	interrupted?: boolean;
	maxSteps?: number;
	temperature?: number;
};

function StatItem({
	icon: Icon,
	label,
	title,
}: {
	icon: typeof CpuIcon;
	label: string;
	title: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="flex items-center gap-1 whitespace-nowrap tabular-nums" />
				}
			>
				<Icon aria-hidden="true" className="size-3.5" />
				{label}
			</TooltipTrigger>
			<TooltipContent>{title}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The row under a message: copy it, and — for an answer — what produced it.
 *
 * It stays mounted rather than appearing on hover: on a touch screen there is
 * no hover, and a control that only exists for a mouse is a control half the
 * devices do not have. It is quiet enough (muted, small) to not compete with
 * the prose, and turns solid on hover or focus.
 */
export function AgentMessageActions({
	text,
	stats,
	modelLabel,
	align = 'start',
	className,
	onEdit,
	onRetry,
	onFork,
}: {
	/** What the clipboard receives; the row hides itself when there is nothing. */
	text: string;
	stats?: AgentMessageStats;
	/** The catalog's label for `stats.model`, which is an id the user never chose to read. */
	modelLabel?: string;
	align?: 'start' | 'end';
	className?: string;
	/** User messages only: rewrite this turn, dropping everything after it. */
	onEdit?: () => void;
	/** User messages only: resend this turn verbatim, dropping what followed. */
	onRetry?: () => void;
	/** Replies only: branch a new thread that ends at this reply. */
	onFork?: () => void;
}) {
	const [copied, setCopied] = useState(false);

	if (!text && !stats?.interrupted) return null;

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard access can be denied outright; the click deserves an answer.
			toast.error('Copying to the clipboard was blocked by the browser.');
		}
	}

	const speed = tokensPerSecond(stats?.outputTokens, stats?.durationMs);
	const tokens = formatTokenCount(stats?.totalTokens);
	const firstToken = formatDuration(stats?.firstTokenMs);

	return (
		<div
			className={cn(
				'flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs',
				align === 'end' && 'justify-end',
				className,
			)}
		>
			{text ? (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="max-sm:size-9"
					onClick={() => void copy()}
					aria-label={copied ? 'Copied' : 'Copy message'}
				>
					{copied ? (
						<CheckIcon aria-hidden="true" />
					) : (
						<CopyIcon aria-hidden="true" />
					)}
				</Button>
			) : null}

			{stats?.interrupted ? <Badge variant="outline">Interrupted</Badge> : null}

			{onEdit && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="max-sm:size-9"
					onClick={onEdit}
					aria-label="Edit message"
				>
					<PencilIcon aria-hidden="true" />
				</Button>
			)}
			{onRetry && (
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					className="max-sm:size-9"
					onClick={onRetry}
					aria-label="Retry from this message"
				>
					<RefreshCcwIcon aria-hidden="true" />
				</Button>
			)}
			{onFork && (
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="max-sm:size-9"
								onClick={onFork}
								aria-label="Fork conversation here"
							/>
						}
					>
						<SplitIcon aria-hidden="true" />
					</TooltipTrigger>
					<TooltipContent>
						New conversation with everything up to this reply
					</TooltipContent>
				</Tooltip>
			)}

			{stats?.model && (
				<StatItem
					icon={CpuIcon}
					label={`${modelLabel ?? stats.model}${
						stats.reasoning ? ` (${stats.reasoning})` : ''
					}`}
					title={
						stats.reasoning
							? `Model ${stats.model}, reasoning ${stats.reasoning}`
							: `Model ${stats.model}`
					}
				/>
			)}
			{speed !== undefined && (
				<StatItem
					icon={ZapIcon}
					label={`${speed.toFixed(1)} tok/sec`}
					title="Output tokens per second of generation"
				/>
			)}
			{tokens && (
				<StatItem
					icon={GaugeIcon}
					label={tokens}
					title={
						stats?.outputTokens === undefined
							? 'Total tokens of this turn'
							: `Total tokens of this turn, ${stats.outputTokens} of them generated`
					}
				/>
			)}
			{firstToken && (
				<StatItem
					icon={TimerIcon}
					label={`Time-to-first: ${firstToken}`}
					title="How long until the first token arrived"
				/>
			)}
			{stats?.tools && stats.tools.length > 0 && (
				/**
				 * The count, not the list: tool names are registry text of unbounded
				 * length, and spelling them out here wrapped the row into a second
				 * line. The names live in the tooltip.
				 */
				<StatItem
					icon={WrenchIcon}
					label={
						stats.tools.length === 1 ? '1 tool' : `${stats.tools.length} tools`
					}
					title={`Tools this turn was allowed to use: ${stats.tools.join(', ')}`}
				/>
			)}
			{stats?.maxSteps !== undefined && (
				<StatItem
					icon={GaugeIcon}
					label={`${stats.maxSteps} steps`}
					title={`Maximum of ${stats.maxSteps} model and tool steps`}
				/>
			)}
			{stats?.temperature !== undefined && (
				<StatItem
					icon={GaugeIcon}
					label={`temp ${stats.temperature}`}
					title={`Temperature ${stats.temperature}`}
				/>
			)}
		</div>
	);
}
