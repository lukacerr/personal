import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/**
 * An epoch-ms timestamp as a person reads one in a list: today's entries by
 * their time, everything older by its date. Shared by Storage's Uploaded
 * column and Credentials' Updated line.
 */
export function timestampLabel(timestamp: number) {
	const date = new Date(timestamp);
	return date.toDateString() === new Date().toDateString()
		? `Today, ${timeFormat.format(date)}`
		: dateFormat.format(date);
}
