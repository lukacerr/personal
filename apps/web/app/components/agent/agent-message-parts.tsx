import { Reasoning } from '@web/components/agent/elements/reasoning';
import { Response } from '@web/components/agent/elements/response';
import { Shimmer } from '@web/components/agent/elements/shimmer';
import { Sources } from '@web/components/agent/elements/sources';
import { tavilyQuery, tavilySources } from '@web/lib/agent';
import type { AgentUIMessage } from '@web/lib/agent-api';
import { getToolOrDynamicToolName, isToolUIPart } from 'ai';

/**
 * One message's parts, dispatched by type. Tool inputs and outputs are read
 * through the guards in `lib/agent` — never casts — so a malformed or
 * unknown part renders as something quiet instead of crashing the transcript.
 */
export function AgentMessageParts({
	message,
	isStreaming,
}: {
	message: AgentUIMessage;
	/** Whether this message is the one the stream is still writing. */
	isStreaming: boolean;
}) {
	return (
		<div className="flex w-full min-w-0 flex-col gap-2">
			{message.parts.map((part, index) => {
				const key = `${message.id}-${index}`;

				if (part.type === 'text')
					return message.role === 'user' ? (
						// The user's words are not markdown: rendering them as such
						// would silently reformat what they actually typed.
						<p key={key} className="whitespace-pre-wrap break-words">
							{part.text}
						</p>
					) : (
						<Response key={key}>{part.text}</Response>
					);

				if (part.type === 'reasoning')
					return (
						<Reasoning
							key={key}
							text={part.text}
							isStreaming={isStreaming && part.state === 'streaming'}
						/>
					);

				if (isToolUIPart(part)) {
					const name = getToolOrDynamicToolName(part);
					if (name === 'tavily') {
						if (part.state === 'output-error')
							return (
								<p key={key} className="text-destructive text-sm">
									The web search failed: {part.errorText}
								</p>
							);
						if (part.state === 'output-available')
							return <Sources key={key} sources={tavilySources(part.output)} />;
						const query = tavilyQuery(part.input);
						return (
							<Shimmer key={key} className="text-sm">
								{query ? `Searching: ${query}…` : 'Searching the web…'}
							</Shimmer>
						);
					}
					// A tool this build does not know how to render still happened.
					return (
						<p key={key} className="text-muted-foreground text-sm">
							Ran {name}
						</p>
					);
				}

				return null;
			})}
		</div>
	);
}
