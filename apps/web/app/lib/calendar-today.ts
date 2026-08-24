import { todayLocalDate } from '@web/lib/calendar';
import { listenForReturnSignals } from '@web/lib/return-signals';
import { useEffect, useState } from 'react';

export function useTodayLocalDate() {
	const [today, setToday] = useState(() => todayLocalDate());

	useEffect(() => listenForReturnSignals(() => setToday(todayLocalDate())), []);

	return today;
}
