import {
	AgentMentionPicker,
	isMentionOptionDisabled,
	type MentionOption,
	mentionOptions,
} from '@web/components/agent/agent-mention-picker';
import { AgentModelPicker } from '@web/components/agent/agent-model-picker';
import { AgentToolPicker } from '@web/components/agent/agent-tool-picker';
import { StoragePreview } from '@web/components/storage/storage-preview';
import { Button } from '@web/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@web/components/ui/dropdown-menu';
import { Input } from '@web/components/ui/input';
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@web/components/ui/popover';
import { Spinner } from '@web/components/ui/spinner';
import { Textarea } from '@web/components/ui/textarea';
import {
	type AgentSelection,
	reasoningForModel,
	temperatureForModel,
} from '@web/lib/agent';
import type { AgentCatalog } from '@web/lib/agent-api';
import {
	AGENT_UPLOAD_FOLDER,
	appendFileMentions,
	completeFileMention,
	draftMentionsFiles,
	type MentionState,
	mentionStateAt,
	splitFileMentions,
} from '@web/lib/agent-mentions';
import { AGENT_MAX_STEPS } from '@web/lib/agent-settings';
import { fileTypeIcon, formatBytes } from '@web/lib/storage';
import { getFileLink, type StoredFile } from '@web/lib/storage-api';
import { uploadStoredFiles } from '@web/lib/storage-file-upload';
import { useStorageStore } from '@web/lib/storage-store';
import type { UploadItem } from '@web/lib/storage-upload';
import {
	ArrowUpIcon,
	BrainIcon,
	ChevronDownIcon,
	EyeIcon,
	FileIcon,
	PaperclipIcon,
	PencilLineIcon,
	SlidersHorizontalIcon,
	SquareIcon,
	WrenchIcon,
	XIcon,
} from 'lucide-react';
import {
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import { toast } from 'sonner';

type ComposerStatus = 'ready' | 'submitted' | 'streaming' | 'error';

/** One row of the settings surface: what it sets on the left, the control on
 * the right. Every control carries its own accessible name, so the caption is a
 * heading for the eye and never a second label. */
function SettingRow({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4">
			<p className="font-medium text-muted-foreground text-xs">{label}</p>
			{children}
		</div>
	);
}

/**
 * The one input of the screen. The bordered container is the field; the
 * textarea inside is transparent so the whole box reads as one control.
 *
 * Outside the field stay exactly four icon affordances: the two triggers that
 * open the turn's selection — what writes the reply, and what it may use while
 * writing it — the attach button, and send/stop/pending. Everything the next
 * send depends on — model, reasoning, temperature, tools, step budget — lives
 * behind those two. Kept inline, each of those is text whose length belongs to
 * a registry meant to grow, so the row wrapped into two or three lines the
 * moment a label got long; with icon buttons its width is a constant.
 *
 * File mentions: `@` at a word start opens a typeahead above the field. The
 * query is typed into the textarea itself (`@f:…`), so focus never moves;
 * arrows and Enter are intercepted while the list is open. Uploads (attach,
 * drop, paste) land in the Agent folder and append `@f:<id>` tokens.
 *
 * Model and tools are two-pane pickers rather than plain menus: both lists are
 * registries meant to grow, and a flat menu of forty models is a scroll, not a
 * choice. Reasoning stays a menu — its levels are per-model and never more
 * than a handful, so a search field would be furniture.
 */
export function AgentComposer({
	value,
	status,
	busy: busyOverride,
	catalog,
	selection,
	error,
	editing,
	onChange,
	onSelectionChange,
	onSubmit,
	onStop,
	onCancelEdit,
}: {
	value: string;
	status: ComposerStatus;
	/** Synchronous work before the chat SDK flips its own status. */
	busy?: boolean;
	catalog: AgentCatalog;
	selection: AgentSelection;
	/** A failure creating the thread; the text stays right here, unsent. */
	error?: string;
	/**
	 * A sent message is being rewritten here: sending replaces every turn
	 * after it. Editing reuses this composer — mentions, attachments and the
	 * pickers all work in a rewrite — instead of a second, poorer editor.
	 */
	editing?: boolean;
	onChange: (value: string) => void;
	onSelectionChange: (next: AgentSelection) => void;
	onSubmit: () => void;
	onStop: () => void;
	onCancelEdit?: () => void;
}) {
	const inputId = useId();
	const maxStepsId = useId();
	const temperatureId = useId();
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [toolsOpen, setToolsOpen] = useState(false);
	const [reasoningOpen, setReasoningOpen] = useState(false);
	const [maxStepsText, setMaxStepsText] = useState(String(selection.maxSteps));
	const [temperatureText, setTemperatureText] = useState(
		selection.temperature === undefined ? '' : String(selection.temperature),
	);
	const busy =
		busyOverride ?? (status === 'submitted' || status === 'streaming');
	const canStop = status === 'submitted' || status === 'streaming';
	const model = catalog.models.find((entry) => entry.id === selection.model);
	const modelLabel = model?.label ?? 'Select model';

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	/** The latest draft, for async completions (uploads) that edit it. */
	const valueRef = useRef(value);
	valueRef.current = value;
	/** Caret to restore after a programmatic edit re-renders the textarea. */
	const pendingCaretRef = useRef<number | undefined>(undefined);
	const [mention, setMention] = useState<MentionState>();
	const [mentionDismissedAt, setMentionDismissedAt] = useState<number>();
	const [mentionIndex, setMentionIndex] = useState(0);
	const [uploads, setUploads] = useState<UploadItem[]>([]);
	const [uploadError, setUploadError] = useState<string>();
	const [attachBusy, setAttachBusy] = useState(false);
	const storageFiles = useStorageStore((state) => state.files);
	const storageStatus = useStorageStore((state) => state.status);
	const loadStorage = useStorageStore((state) => state.load);

	const mentionOpen =
		mention !== undefined && mention.at !== mentionDismissedAt;
	const options = useMemo(
		() => (mentionOpen && mention ? mentionOptions(mention, storageFiles) : []),
		[mentionOpen, mention, storageFiles],
	);

	/** Every keystroke re-derives the picker from the draft and the caret. */
	function syncMention(text: string, caret: number) {
		const next = mentionStateAt(text, caret);
		setMention(next);
		if (next === undefined) setMentionDismissedAt(undefined);
		setMentionIndex(0);
	}

	// The file list only matters while the picker is open; load it lazily.
	useEffect(() => {
		if (mentionOpen && storageStatus === 'idle') void loadStorage();
	}, [mentionOpen, storageStatus, loadStorage]);

	useLayoutEffect(() => {
		const caret = pendingCaretRef.current;
		if (caret === undefined) return;
		pendingCaretRef.current = undefined;
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.focus();
		textarea.setSelectionRange(caret, caret);
	});

	function applyEdit(text: string, caret: number) {
		onChange(text);
		pendingCaretRef.current = caret;
		syncMention(text, caret);
	}

	function pickMention(option: MentionOption) {
		if (!mention || isMentionOptionDisabled(option)) return;
		const caret =
			textareaRef.current?.selectionStart ?? valueRef.current.length;
		if (option.kind === 'namespace-files') {
			const text = `${valueRef.current.slice(0, mention.at)}@f:${valueRef.current.slice(caret)}`;
			applyEdit(text, mention.at + 3);
			return;
		}
		if (option.kind === 'file') {
			const completed = completeFileMention(
				valueRef.current,
				mention.at,
				caret,
				option.file.id,
			);
			applyEdit(completed.text, completed.caret);
		}
	}

	function moveMentionIndex(step: 1 | -1) {
		if (options.length === 0) return;
		let next = mentionIndex;
		for (let i = 0; i < options.length; i += 1) {
			next = (next + step + options.length) % options.length;
			const candidate = options[next];
			if (candidate && !isMentionOptionDisabled(candidate)) break;
		}
		setMentionIndex(next);
	}

	async function uploadFiles(selected: File[]) {
		if (selected.length === 0 || attachBusy) return;
		setUploadError(undefined);
		setAttachBusy(true);
		try {
			const stored = await uploadStoredFiles(
				selected,
				{ folder: AGENT_UPLOAD_FOLDER },
				setUploads,
			);
			if (stored.length > 0) {
				const text = appendFileMentions(
					valueRef.current,
					stored.map((file) => file.id),
				);
				applyEdit(text, text.length);
			}
			if (stored.length < selected.length)
				setUploadError(
					stored.length === 0
						? 'The files could not be uploaded. Try again.'
						: `${selected.length - stored.length} of ${selected.length} files could not be uploaded.`,
				);
		} catch {
			setUploadError(
				navigator.onLine
					? 'The files could not be uploaded. Try again.'
					: 'Attaching files requires a connection.',
			);
		} finally {
			setAttachBusy(false);
			setUploads([]);
		}
	}

	const transferring = uploads.filter(
		(item) => item.status === 'uploading' || item.status === 'pending',
	);

	/**
	 * One chip per mentioned file, so what the raw `@f:<id>` token names stays
	 * visible while typing. Removing a chip strips its tokens from the draft.
	 */
	const mentionedFiles = useMemo(() => {
		const ids: string[] = [];
		for (const segment of splitFileMentions(value))
			if (segment.kind === 'mention' && !ids.includes(segment.fileId))
				ids.push(segment.fileId);
		return ids.map((fileId) => ({
			fileId,
			file: storageFiles.find((file) => file.id === fileId),
		}));
	}, [value, storageFiles]);

	function removeMention(fileId: string) {
		const pattern = new RegExp(`@f:${fileId} ?`, 'gi');
		const text = valueRef.current.replaceAll(pattern, '');
		applyEdit(text, Math.min(text.length, valueRef.current.length));
	}

	const [previewId, setPreviewId] = useState<string>();
	const previewFile = previewId
		? storageFiles.find((file) => file.id === previewId)
		: undefined;

	async function downloadFile(file: StoredFile) {
		try {
			window.location.assign(await getFileLink(file.id, 'attachment'));
		} catch {
			toast.error(`“${file.name}” could not be downloaded.`);
		}
	}

	/**
	 * The widening the transport applies is mirrored here so it is visible:
	 * a draft that mentions a file sends `storageRead` whatever the selection
	 * says, and the picker shows that as a forced grant, not a surprise.
	 */
	const forcedTools =
		draftMentionsFiles(value) &&
		catalog.tools.some((tool) => tool.name === 'storageRead')
			? ['storageRead']
			: [];
	/** What the next turn may actually use, forced grants included. */
	const enabledTools = new Set([...selection.tools, ...forcedTools]).size;

	// A rewrite starts in this composer: put the caret at the end of the text.
	useLayoutEffect(() => {
		if (!editing) return;
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.focus();
		const end = textarea.value.length;
		textarea.setSelectionRange(end, end);
	}, [editing]);

	useEffect(
		() => setMaxStepsText(String(selection.maxSteps)),
		[selection.maxSteps],
	);
	useEffect(
		() =>
			setTemperatureText(
				selection.temperature === undefined
					? ''
					: String(selection.temperature),
			),
		[selection.temperature],
	);

	/**
	 * The AI SDK lets a tool describe itself with a function, so the contract
	 * types the description as a union. The picker shows text: narrow with a
	 * guard here — at the boundary — rather than asserting it away.
	 */
	const toolOptions = useMemo(
		() =>
			catalog.tools.map((tool) => ({
				name: tool.name,
				group: tool.group,
				description:
					typeof tool.description === 'string' ? tool.description : '',
			})),
		[catalog.tools],
	);

	function pickModel(id: string) {
		const next = catalog.models.find((entry) => entry.id === id);
		if (!next) return;
		// The level follows the model: a level both models accept survives the
		// switch, one the next model cannot express falls to its default, and a
		// model without a knob carries none at all.
		const reasoning = reasoningForModel(next, selection.reasoning);
		const temperature = temperatureForModel(
			next,
			reasoning,
			selection.temperature,
		);
		onSelectionChange({
			model: id,
			tools: selection.tools,
			maxSteps: selection.maxSteps,
			...(reasoning === undefined ? {} : { reasoning }),
			...(temperature === undefined ? {} : { temperature }),
		});
	}

	const temperatureCapability =
		model &&
		temperatureForModel(
			model,
			selection.reasoning,
			model.temperature?.default,
		) !== undefined
			? model.temperature
			: undefined;
	function toggleTool(name: string) {
		onSelectionChange({
			...selection,
			tools: selection.tools.includes(name)
				? selection.tools.filter((tool) => tool !== name)
				: [...selection.tools, name],
		});
	}

	/**
	 * The ceiling `AGENT_MAX_STEPS` and the catalog's temperature bounds are
	 * enforced here and nowhere else, so a second surface — if one is ever
	 * needed — renders these rather than its own copy of the rules. They sit in
	 * different popovers on purpose: a step budget is what the tools are
	 * allowed to cost, and belongs next to them.
	 */
	const maxStepsInput = () => (
		<label
			htmlFor={maxStepsId}
			className="flex items-center justify-between gap-4"
		>
			<span className="font-medium text-muted-foreground text-xs">
				Maximum steps
			</span>
			<Input
				id={maxStepsId}
				type="number"
				min={1}
				max={AGENT_MAX_STEPS}
				step={1}
				value={maxStepsText}
				onChange={(event) => {
					const text = event.currentTarget.value;
					setMaxStepsText(text);
					const value = Number(text);
					/**
					 * `max` only decorates a typed number, so the ceiling the API
					 * enforces is checked here too: a larger budget would be a 422.
					 */
					if (
						!/^\d+$/.test(text) ||
						!Number.isInteger(value) ||
						value < 1 ||
						value > AGENT_MAX_STEPS
					)
						return;
					onSelectionChange({ ...selection, maxSteps: value });
				}}
				onBlur={() => setMaxStepsText(String(selection.maxSteps))}
				className="h-8 w-16 rounded-md px-1.5 text-center tabular-nums max-sm:h-11"
			/>
		</label>
	);

	const temperatureInput = () =>
		temperatureCapability ? (
			<label
				htmlFor={temperatureId}
				className="flex items-center justify-between gap-4"
			>
				<span className="font-medium text-muted-foreground text-xs">
					Temperature
				</span>
				<Input
					id={temperatureId}
					type="number"
					min={temperatureCapability.min}
					max={temperatureCapability.max}
					step={temperatureCapability.step}
					placeholder="Default"
					value={temperatureText}
					onChange={(event) => {
						const text = event.currentTarget.value;
						setTemperatureText(text);
						const next = { ...selection };
						delete next.temperature;
						if (text === '') {
							onSelectionChange(next);
							return;
						}
						const value = Number(text);
						const steps =
							(value - temperatureCapability.min) / temperatureCapability.step;
						if (
							!Number.isFinite(value) ||
							value < temperatureCapability.min ||
							value > temperatureCapability.max ||
							Math.abs(steps - Math.round(steps)) > 1e-9
						)
							return;
						onSelectionChange({ ...next, temperature: value });
					}}
					onBlur={() =>
						setTemperatureText(
							selection.temperature === undefined
								? ''
								: String(selection.temperature),
						)
					}
					className="h-8 w-20 rounded-md px-1.5 text-center tabular-nums max-sm:h-11"
				/>
			</label>
		) : null;

	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
			onDragOver={(event) => {
				if (event.dataTransfer.types.includes('Files')) event.preventDefault();
			}}
			onDrop={(event) => {
				const files = [...event.dataTransfer.files];
				if (files.length === 0) return;
				event.preventDefault();
				void uploadFiles(files);
			}}
		>
			{editing && (
				<div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-1 text-muted-foreground text-xs">
					<PencilLineIcon aria-hidden="true" className="size-3.5 shrink-0" />
					<span className="flex-1">
						Editing a sent message — sending replaces every turn after it.
					</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={onCancelEdit}
					>
						Cancel
					</Button>
				</div>
			)}
			<div className="relative flex flex-col rounded-2xl border bg-background shadow-xs focus-within:ring-1 focus-within:ring-ring">
				{mentionOpen && (
					<AgentMentionPicker
						options={options}
						activeIndex={mentionIndex}
						loading={storageStatus === 'loading'}
						onPick={pickMention}
					/>
				)}
				<label htmlFor={inputId} className="sr-only">
					Message the agent
				</label>
				<Textarea
					id={inputId}
					ref={textareaRef}
					value={value}
					onChange={(event) => {
						onChange(event.target.value);
						syncMention(
							event.target.value,
							event.target.selectionStart ?? event.target.value.length,
						);
					}}
					onSelect={(event) => {
						const target = event.currentTarget;
						syncMention(target.value, target.selectionStart ?? 0);
					}}
					onPaste={(event) => {
						const files = [...event.clipboardData.files];
						if (files.length === 0) return;
						event.preventDefault();
						void uploadFiles(files);
					}}
					onKeyDown={(event) => {
						if (mentionOpen && mention) {
							if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
								event.preventDefault();
								moveMentionIndex(event.key === 'ArrowDown' ? 1 : -1);
								return;
							}
							if (event.key === 'Escape') {
								event.preventDefault();
								setMentionDismissedAt(mention.at);
								return;
							}
							if (event.key === 'Enter' && !event.shiftKey) {
								// Never a submit while the picker is up: Enter either
								// completes the mention or quietly dismisses an empty list.
								event.preventDefault();
								const active = options[mentionIndex];
								if (active && !isMentionOptionDisabled(active))
									pickMention(active);
								else setMentionDismissedAt(mention.at);
								return;
							}
						}
						if (event.key === 'Escape' && editing && onCancelEdit) {
							event.preventDefault();
							onCancelEdit();
							return;
						}
						if (
							event.key === 'Enter' &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							onSubmit();
						}
					}}
					placeholder="Message the agent…"
					className="field-sizing-content max-h-52 min-h-12 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
				/>

				{(mentionedFiles.length > 0 || transferring.length > 0) && (
					<div className="flex flex-wrap items-center gap-1.5 px-3 pb-1.5">
						{mentionedFiles.map(({ fileId, file }) => {
							const Icon = file ? fileTypeIcon(file.contentType) : FileIcon;
							const label = file?.name ?? `Unknown file ${fileId.slice(0, 8)}`;
							return (
								<span
									key={fileId}
									className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-1.5 text-xs"
								>
									<Icon aria-hidden="true" className="size-3.5 shrink-0" />
									<span className="min-w-0 truncate font-medium">{label}</span>
									{file && (
										<span className="shrink-0 text-muted-foreground">
											{formatBytes(file.size)}
										</span>
									)}
									{file && (
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="size-5"
											aria-label={`Preview ${label}`}
											onClick={() => setPreviewId(fileId)}
										>
											<EyeIcon aria-hidden="true" className="size-3.5" />
										</Button>
									)}
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="size-5"
										aria-label={`Remove ${label}`}
										onClick={() => removeMention(fileId)}
									>
										<XIcon aria-hidden="true" className="size-3.5" />
									</Button>
								</span>
							);
						})}
						{transferring.map((item) => (
							<span
								key={item.id}
								className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-dashed bg-muted/30 px-1.5 py-0.5 text-muted-foreground text-xs"
							>
								<Spinner aria-hidden="true" className="size-3.5 shrink-0" />
								<span className="min-w-0 truncate">{item.name}</span>
								<span className="shrink-0 tabular-nums">
									{Math.round(item.progress * 100)}%
								</span>
							</span>
						))}
					</div>
				)}

				<div className="flex min-w-0 items-center gap-1 px-2 pb-2">
					{/*
					 * Two surfaces, split by what a setting answers: what writes the
					 * reply (model, reasoning, temperature) and what it is allowed to
					 * do while writing it (tools, step budget). One popover held all
					 * five and grew a scroll the moment the model list became a
					 * browser; the step budget also belongs beside the tools that
					 * spend it.
					 *
					 * One surface at every width, each. A popover on desktop plus a
					 * sheet on mobile would be two open states for one control, and
					 * the shell already paid for that once: a breakpoint change
					 * between them leaves a backdrop on screen. Both triggers are
					 * icon-only and carry their setting in the accessible name — a
					 * visible label is the unbounded text this row was collapsed to
					 * get rid of.
					 */}
					<Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
						<PopoverTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="text-muted-foreground max-sm:size-11"
									aria-label={`Generation settings: ${modelLabel}`}
								/>
							}
						>
							<SlidersHorizontalIcon aria-hidden="true" />
						</PopoverTrigger>
						<PopoverContent
							align="start"
							side="top"
							className="w-[min(92vw,26rem)] gap-0 overflow-hidden p-0"
						>
							<PopoverHeader className="px-4 pt-4 pb-3">
								<PopoverTitle>Model</PopoverTitle>
								<PopoverDescription>
									Applies to the next message, not to the thread.
								</PopoverDescription>
							</PopoverHeader>

							<AgentModelPicker
								models={catalog.models}
								value={selection.model}
								onSelect={pickModel}
							/>

							<div className="grid gap-3 border-t p-4">
								{model && model.reasoning.levels.length > 0 && (
									<SettingRow label="Reasoning">
										<DropdownMenu
											open={reasoningOpen}
											onOpenChange={setReasoningOpen}
										>
											<DropdownMenuTrigger
												render={
													<Button
														type="button"
														variant="ghost"
														size="sm"
														className="gap-1 text-muted-foreground hover:text-foreground max-sm:h-11"
														aria-label="Reasoning level"
													/>
												}
											>
												<BrainIcon aria-hidden="true" />
												<span className="capitalize">
													{selection.reasoning}
												</span>
												<ChevronDownIcon aria-hidden="true" />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuRadioGroup
													value={selection.reasoning}
													onValueChange={(level) => {
														const reasoning = String(level);
														const temperature = temperatureForModel(
															model,
															reasoning,
															selection.temperature,
														);
														const next = { ...selection };
														delete next.temperature;
														onSelectionChange({
															...next,
															reasoning,
															...(temperature === undefined
																? {}
																: { temperature }),
														});
														setReasoningOpen(false);
													}}
												>
													{/* A Base UI group label has to sit inside a group. */}
													<DropdownMenuLabel>Reasoning</DropdownMenuLabel>
													{model.reasoning.levels.map((level) => (
														<DropdownMenuRadioItem key={level} value={level}>
															<span className="capitalize">{level}</span>
														</DropdownMenuRadioItem>
													))}
												</DropdownMenuRadioGroup>
											</DropdownMenuContent>
										</DropdownMenu>
									</SettingRow>
								)}

								{temperatureInput()}
							</div>
						</PopoverContent>
					</Popover>

					{toolOptions.length > 0 && (
						<Popover open={toolsOpen} onOpenChange={setToolsOpen}>
							<PopoverTrigger
								render={
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-muted-foreground max-sm:h-11"
										aria-label={`Tools and steps: ${enabledTools} of ${toolOptions.length}`}
									/>
								}
							>
								<WrenchIcon data-icon="inline-start" aria-hidden="true" />
								{enabledTools > 0 && (
									<span className="tabular-nums">{enabledTools}</span>
								)}
							</PopoverTrigger>
							<PopoverContent
								align="start"
								side="top"
								className="w-[min(92vw,26rem)] gap-0 overflow-hidden p-0"
							>
								<PopoverHeader className="px-4 pt-4 pb-3">
									<PopoverTitle>Tools</PopoverTitle>
									<PopoverDescription>
										Granted for the next message only.
									</PopoverDescription>
								</PopoverHeader>

								<AgentToolPicker
									tools={toolOptions}
									value={selection.tools}
									forced={forcedTools}
									onToggle={toggleTool}
								/>

								<div className="border-t p-4">{maxStepsInput()}</div>
							</PopoverContent>
						</Popover>
					)}

					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="sr-only"
						aria-label="Attach files (file input)"
						onChange={(event) => {
							void uploadFiles([...(event.target.files ?? [])]);
							event.target.value = '';
						}}
					/>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="text-muted-foreground max-sm:size-11"
						aria-label="Attach files"
						disabled={attachBusy}
						onClick={() => fileInputRef.current?.click()}
					>
						{attachBusy ? <Spinner /> : <PaperclipIcon aria-hidden="true" />}
					</Button>

					<div className="min-w-2 flex-1" />

					{canStop ? (
						<Button
							type="button"
							size="icon"
							variant="outline"
							className="max-sm:size-11"
							onClick={onStop}
							aria-label="Stop generating"
						>
							<SquareIcon aria-hidden="true" />
						</Button>
					) : busy ? (
						<Button
							type="button"
							size="icon"
							variant="outline"
							className="max-sm:size-11"
							disabled
							aria-label="Preparing message"
						>
							<Spinner />
						</Button>
					) : (
						<Button
							type="submit"
							size="icon"
							className="max-sm:size-11"
							disabled={value.trim().length === 0}
							aria-label="Send message"
						>
							<ArrowUpIcon aria-hidden="true" />
						</Button>
					)}
				</div>
			</div>

			{uploadError && (
				<p role="alert" className="px-1 text-destructive text-sm">
					{uploadError}
				</p>
			)}
			{error && <p className="px-1 text-destructive text-sm">{error}</p>}

			{previewFile && (
				<StoragePreview
					file={previewFile}
					onClose={() => setPreviewId(undefined)}
					onDownload={(file) => void downloadFile(file)}
				/>
			)}
		</form>
	);
}
