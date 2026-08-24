import { AGENT_PATH, clearAgentLocal } from '@web/lib/agent';
import { agentSnapshot, useAgentStore } from '@web/lib/agent-store';
import type { AppBreadcrumbItem } from '@web/lib/app-navigation';
import {
	type AppSystem,
	matchesCommandQuery,
	refreshIndexStore,
	type SystemCommand,
	systemPath,
} from '@web/lib/app-systems';
import { BotIcon } from 'lucide-react';

export const agentSystem: AppSystem = {
	key: 'agent',
	heading: 'Agent',
	icon: BotIcon,

	/**
	 * Agent keeps no local database, so nothing the shell watches would ever
	 * tell it the breadcrumb changed. The store reports for itself — only when
	 * the rows themselves move: a status flip changes nothing the shell shows.
	 */
	subscribe: (onChange) =>
		useAgentStore.subscribe((state, previous) => {
			if (state.threads !== previous.threads) onChange();
		}),

	refresh: refreshIndexStore(useAgentStore),

	// The palette queries conversation titles from every screen.
	refreshEverywhere: true,

	/**
	 * "New chat" first — the palette's action deep link — then recent
	 * conversations by title. The index already arrives ordered by recency, so
	 * matching in order is matching by recency.
	 */
	async searchCommands(query, limit) {
		if (limit < 1) return [];
		const commands: SystemCommand[] = [];
		if (matchesCommandQuery(query, 'New chat', 'agent conversation'))
			commands.push({
				id: 'create',
				label: 'New chat',
				detail: 'Agent',
				to: systemPath(AGENT_PATH, { new: '1' }),
			});
		for (const thread of agentSnapshot().threads) {
			if (commands.length >= limit) break;
			if (!matchesCommandQuery(query, thread.title)) continue;
			commands.push({
				id: thread.id,
				label: thread.title,
				to: systemPath(AGENT_PATH, { thread: thread.id }),
			});
		}
		return commands;
	},

	async loadBreadcrumbTrail(pathname, search): Promise<AppBreadcrumbItem[]> {
		if (pathname !== AGENT_PATH) return [];
		const selected = new URLSearchParams(search).get('thread');
		if (!selected) return [];

		const title = agentSnapshot().threads.find(
			(thread) => thread.id === selected,
		)?.title;
		return title ? [{ key: 'thread', label: title, icon: BotIcon }] : [];
	},

	/** Drop the local mirror and session-scoped server data on sign-out. */
	clearLocalData: async () => {
		useAgentStore.getState().reset();
		clearAgentLocal();
	},
};
