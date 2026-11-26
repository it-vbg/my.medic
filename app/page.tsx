import { redirect } from "next/navigation";
import { AuthPanel, Cabinet } from "@/components/portal";
import { CabinetError } from "@/lib/cabinet";
import { getOverview } from "@/lib/overview";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Query = Promise<{ card?: string | string[]; view?: string | string[]; auth?: string | string[]; confirm?: string }>;

export default async function Page({ searchParams }: { searchParams: Query }) {
  const query = await searchParams;
  if (typeof query.confirm === "string" && /^[A-Za-z0-9_-]{43}$/.test(query.confirm)) {
    return <AuthPanel confirmationToken={query.confirm} />;
  }
  const card = typeof query.card === "string" ? query.card : null;
  try {
    const overview = await getOverview(await getStore(), card);
    return <Cabinet initial={overview} initialSection={query.view === "family" ? "family" : "documents"} />;
  } catch (error) {
    if (error instanceof CabinetError && error.status === 401) {
      const notice = query.auth === "expired" ? "Ссылка подтверждения недействительна. Зарегистрируйтесь повторно, чтобы получить новое письмо." : undefined;
      return <AuthPanel initialNotice={notice} />;
    }
    if (card && error instanceof CabinetError && [403, 404].includes(error.status)) redirect("/");
    throw error;
  }
}
