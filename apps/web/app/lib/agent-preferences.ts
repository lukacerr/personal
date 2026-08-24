import {
	createViewPreferences,
	DEFAULT_VIEW_PREFERENCES,
	type ViewPreferenceSize,
	type ViewPreferences,
} from '@web/lib/view-preferences';

export type AgentPreferenceSize = ViewPreferenceSize;
export type AgentPreferences = ViewPreferences;

/**
 * Its own key, deliberately not shared with Notes even though the
 * implementation is: a conversation and a document are read differently — one is
 * a column of turns, the other a page — and every system in this app already
 * owns its view preferences.
 */
export const AGENT_PREFERENCES_KEY = 'personal-agent-view:v1';
export const DEFAULT_AGENT_PREFERENCES: AgentPreferences =
	DEFAULT_VIEW_PREFERENCES;

const agentPreferences = createViewPreferences(AGENT_PREFERENCES_KEY);

export const loadAgentPreferences = agentPreferences.load;
export const saveAgentPreferences = agentPreferences.save;
export const useAgentPreferences = agentPreferences.usePreferences;
