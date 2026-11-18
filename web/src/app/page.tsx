import { redirect } from 'next/navigation';
// Legacy `/` is the 1 MB marketing landing page (deferred — see migration map §2.3).
// Until it is ported, the app root sends users to the dashboard (session guard
// redirects unauthenticated visitors to /login, matching legacy behaviour).
export default function Root() {
  redirect('/dashboard/');
}
