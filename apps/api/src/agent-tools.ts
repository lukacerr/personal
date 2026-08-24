import { env } from '@api/env';
import { type TavilyClient, tavily } from '@tavily/core';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';

/**
 * Exported so tests exercise the exact schema the model is constrained by,
 * instead of re-declaring the bounds next to the asserts.
 */
export const tavilyInputSchema = z.object({
	query: z.string().min(1).max(400),
	searchDepth: z.enum(['basic', 'advanced']).default('basic'),
	maxResults: z.number().int().min(1).max(8).default(5),
});

export type TavilySearchInput = z.infer<typeof tavilyInputSchema>;

/**
 * What the tool hands back to the model — and what the web renders as
 * sources. Kept to the fields both consumers need so a Tavily response
 * reshaping upstream stays contained here.
 */
export type TavilySearchOutput = {
	query: string;
	results: { title: string; url: string; content: string; score: number }[];
};

/**
 * Test seam. Tests set `tavilyOverride.execute` and restore it to
 * `undefined`; the suite never reaches Tavily's API.
 */
export const tavilyOverride: {
	execute?: (input: TavilySearchInput) => Promise<TavilySearchOutput>;
} = {};

/** Lazy so importing the registry never constructs the HTTP client. */
let client: TavilyClient | undefined;

async function searchTavily(
	input: TavilySearchInput,
): Promise<TavilySearchOutput> {
	client ??= tavily({ apiKey: env.TAVILY_API_KEY });
	const response = await client.search(input.query, {
		searchDepth: input.searchDepth,
		maxResults: input.maxResults,
	});
	return {
		query: input.query,
		results: response.results.map((result) => ({
			title: result.title,
			url: result.url,
			content: result.content,
			score: result.score,
		})),
	};
}

/**
 * Every tool the agent can be granted, by the name the chat request uses.
 * Adding a capability is one entry here; the catalog endpoint and the web
 * toggle derive from this object.
 */
export const AGENT_TOOLS = {
	tavily: tool({
		description:
			'Search the web for current information. Returns relevant pages with title, URL and a content snippet.',
		inputSchema: tavilyInputSchema,
		execute: (input) => (tavilyOverride.execute ?? searchTavily)(input),
	}),
} satisfies ToolSet;

export type AgentToolName = keyof typeof AGENT_TOOLS;

/** What the catalog endpoint publishes. */
export function agentToolCatalog() {
	return Object.entries(AGENT_TOOLS).map(([name, entry]) => ({
		name,
		description: entry.description ?? '',
	}));
}

/**
 * Resolves the request's `tools` list against the registry. Only the returned
 * `tools` reach `streamText`; unknown names are reported so the router can
 * reject them instead of silently granting less than the client asked for.
 */
export function pickTools(names: readonly string[]) {
	const tools: ToolSet = {};
	const unknown: string[] = [];
	for (const name of names) {
		if (name in AGENT_TOOLS) tools[name] = AGENT_TOOLS[name as AgentToolName];
		else unknown.push(name);
	}
	return { tools, unknown };
}
