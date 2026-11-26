import { CabinetError } from "@/lib/cabinet";
import { json, problem } from "@/lib/http";
import { multipartLimit, parseUpload, readLimited, requireSameOrigin, textField } from "@/lib/input";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const store = await getStore();
    if (!await store.currentUser()) throw new CabinetError("Войдите в аккаунт.", 401);
    const type = request.headers.get("content-type") ?? "";
    if (!type.startsWith("multipart/form-data;")) throw new CabinetError("Выберите файл.", 415);
    const body = await readLimited(request, multipartLimit);
    let form: FormData;
    try { form = await new Response(body, { headers: { "Content-Type": type } }).formData(); }
    catch { throw new CabinetError("Не удалось прочитать данные загрузки."); }
    const id = await store.upload(textField(form.get("cardId"), "Карта", 100), await parseUpload(form));
    return json({ ok: true, id }, 201);
  } catch (error) { return problem(error); }
}
