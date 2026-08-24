import type { AgentSettings } from '@web/lib/agent-api';
import { z } from 'zod';

export const AGENT_SETTINGS_KEY = 'personal-agent-settings:v1';

/**
 * The same ceiling the API enforces, duplicated because the web can only
 * import types from `@api`. A value above it is rejected at the HTTP boundary,
 * so the mirror must not hand the composer one it cannot send.
 */
export const AGENT_MAX_STEPS = 250;

/**
 * Everything here is a remembered choice, never a live request, so a budget
 * written before the ceiling existed is pinned to it rather than treated as
 * evidence the whole selection is corrupt — dropping it would also drop the
 * model and tools, which are still usable. The HTTP boundary does the
 * opposite and rejects: reinterpreting what a request asks for is not the
 * same job as reading back what this device already chose.
 */
const rememberedMaxSteps = z
	.number()
	.int()
	.positive()
	.transform((steps) => Math.min(steps, AGENT_MAX_STEPS));

const selectionSchema = z.object({
	model: z.string().min(1).max(128),
	reasoning: z.string().min(1).max(16).optional(),
	tools: z.array(z.string().min(1).max(64)).max(8),
	maxSteps: rememberedMaxSteps,
	temperature: z.number().optional(),
});

/**
 * The selection as it was stored in v1 view state, where the step count did not
 * exist yet. Exported because `readAgentLocal` reads the very same bytes: two
 * validators over one payload drift, and the looser one then reports a
 * selection the stricter one refuses to migrate.
 */
export const legacySelectionSchema = selectionSchema.extend({
	maxSteps: rememberedMaxSteps.optional(),
});

const settingsSchema = z.object({
	version: z.literal(1),
	selection: selectionSchema.optional(),
	titleModel: z.string().min(1).max(128).optional(),
	compactionModel: z.string().min(1).max(128).optional(),
});

type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {};

function withoutVersion(
	settings: z.infer<typeof settingsSchema>,
): AgentSettings {
	const result: AgentSettings = {};
	if (settings.selection) result.selection = settings.selection;
	if (settings.titleModel) result.titleModel = settings.titleModel;
	if (settings.compactionModel)
		result.compactionModel = settings.compactionModel;
	return result;
}

/** Reads the current mirror, falling back once to the selection in v1 view state. */
export function loadAgentSettings(
	storage: Pick<SettingsStorage, 'getItem'>,
	legacySelection?: unknown,
): AgentSettings {
	try {
		const raw = storage.getItem(AGENT_SETTINGS_KEY);
		if (raw) {
			const parsed = settingsSchema.safeParse(JSON.parse(raw));
			return parsed.success
				? withoutVersion(parsed.data)
				: DEFAULT_AGENT_SETTINGS;
		}
	} catch {
		// A blocked or corrupt mirror falls through to the legacy migration.
	}

	const migrated = legacySelectionSchema.safeParse(legacySelection);
	return migrated.success
		? { selection: { ...migrated.data, maxSteps: migrated.data.maxSteps ?? 5 } }
		: DEFAULT_AGENT_SETTINGS;
}

export function saveAgentSettings(
	storage: Pick<SettingsStorage, 'setItem'>,
	settings: AgentSettings,
) {
	try {
		storage.setItem(
			AGENT_SETTINGS_KEY,
			JSON.stringify({ version: 1, ...settings }),
		);
	} catch {
		// Best effort: local storage may be full or unavailable.
	}
}

export type AgentSettingsReconciliation = {
	settings: AgentSettings;
	push: boolean;
};

export function reconcileAgentSettings(
	shared: AgentSettings | null,
	local: AgentSettings,
): AgentSettingsReconciliation {
	if (shared !== null) return { settings: shared, push: false };
	return Object.keys(local).length > 0
		? { settings: local, push: true }
		: { settings: DEFAULT_AGENT_SETTINGS, push: false };
}
