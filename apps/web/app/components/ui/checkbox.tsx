import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from '@web/lib/utils';
import { CheckIcon, MinusIcon } from 'lucide-react';

function Checkbox({
	className,
	indeterminate,
	...props
}: CheckboxPrimitive.Root.Props & { indeterminate?: boolean }) {
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			className={cn(
				'peer relative flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-transparent bg-input/90 outline-none transition-shadow after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground',
				className,
			)}
			checked={indeterminate || props.checked}
			aria-checked={indeterminate ? 'mixed' : props.checked}
			{...props}
		>
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
			>
				{indeterminate ? <MinusIcon /> : <CheckIcon />}
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
