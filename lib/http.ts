import { CabinetError } from "./cabinet";
import { readLimited } from "./input";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function problem(error: unknown) {
  if (error instanceof CabinetError) return json({ error: error.message }, error.status);
  console.error("Cabinet operation failed", error instanceof Error ? error.name : "unknown");
  return json({ error: "Не удалось выполнить операцию. Попробуйте ещё раз." }, 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new CabinetError("Ожидается JSON.", 415);
  }
  const bytes = await readLimited(request, 16 * 1024);
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* Report the same input error for malformed bodies. */ }
  throw new CabinetError("Некорректный запрос.");
}
