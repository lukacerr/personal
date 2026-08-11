import { APP_DEFAULT_PATH } from '@web/lib/app-navigation';
import { Navigate } from 'react-router';

/**
 * The root is a destination, not a screen.
 *
 * Only reached when the layout had no remembered location to restore — that
 * redirect runs first and this never renders — so this is the fresh-start case
 * and it goes to the default system. `replace` keeps `/` out of history: left
 * there, going back would land on it again and bounce straight forward.
 */
export default function Index() {
	return <Navigate replace to={APP_DEFAULT_PATH} />;
}
