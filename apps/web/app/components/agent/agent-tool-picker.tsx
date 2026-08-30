import {
	AgentEntityPicker,
	type PickerEntity,
} from '@web/components/agent/agent-entity-picker';

export type AgentToolOption = {
	name: string;
	group: string;
	description: string;
};

export function toolEntity(tool: AgentToolOption): PickerEntity {
	return {
		id: tool.name,
		label: tool.name,
		group: tool.group,
		...(tool.description ? { hint: tool.description } : {}),
	};
}

export function AgentToolPicker({
	tools,
	value,
	forced = [],
	onToggle,
}: {
	tools: readonly AgentToolOption[];
	value: readonly string[];
	/**
	 * Tools this turn grants regardless of the selection — today,
	 * `storageRead` while the draft mentions a file. Shown as checked and not
	 * toggleable, so the request that actually leaves is the one on screen.
	 */
	forced?: readonly string[];
	onToggle: (name: string) => void;
}) {
	return (
		<AgentEntityPicker
			entities={tools.map(toolEntity)}
			selected={value}
			forced={forced}
			noun="tools"
			groupsLabel="Categories"
			forcedHint="Auto — file mentioned"
			onSelect={onToggle}
		/>
	);
}
