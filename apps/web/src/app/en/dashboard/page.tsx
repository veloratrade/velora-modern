import type { Metadata } from "next";
import { DashboardPage } from "../../../features/dashboard/DashboardPage";
import { RequireSession } from "../../../lib/auth/session";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Dashboard | VELORA", robots: { index: false, follow: false }, alternates: { canonical: "https://veloratrade.ir/en/dashboard" } };
}

export default async function Page() {
  return (
    <RequireSession>
      <DashboardPage locale="en" />
    </RequireSession>
  );
}
