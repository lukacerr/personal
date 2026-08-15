import {
	PointerActivationConstraints,
	PointerSensor,
	type Sensors,
} from '@dnd-kit/dom';

/**
 * The pointer sensor every drag surface shares, told apart from a scroll: a
 * touch waits out a long press so the list can still be flicked, while a
 * mouse only needs a few pixels of intent. Passed to `DragDropProvider` as
 * its `sensors` prop; keeping one copy keeps the two layouts from drifting
 * on what starts a drag.
 */
export function dragSensors(defaults: Sensors): Sensors {
	return [
		...defaults.filter((sensor) => sensor !== PointerSensor),
		PointerSensor.configure({
			activationConstraints(event) {
				return event.pointerType === 'touch'
					? [
							new PointerActivationConstraints.Delay({
								value: 250,
								tolerance: 6,
							}),
						]
					: [new PointerActivationConstraints.Distance({ value: 6 })];
			},
		}),
	];
}
