import { CabinetError } from "@/lib/cabinet";
import { json, problem, readJson } from "@/lib/http";
import { emailField, passwordField, requireSameOrigin, textField } from "@/lib/input";
import { getOverview } from "@/lib/overview";
import { getStore } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return json(await getOverview(await getStore(), new URL(request.url).searchParams.get("card")));
  } catch (error) { return problem(error); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const data = await readJson(request);
    const store = await getStore();
    if (!["login", "register", "logout"].includes(String(data.action)) && !await store.currentUser()) {
      throw new CabinetError("Войдите в аккаунт.", 401);
    }
    const getCardId = () => textField(data.cardId, "Карта", 100);
    switch (data.action) {
      case "register": {
        const result = await store.signUp(textField(data.name, "Имя", 100), emailField(data.email), passwordField(data.password, true));
        return json({ ok: true, ...result }, 201);
      }
      case "login":
        await store.signIn(emailField(data.email), passwordField(data.password, false));
        break;
      case "logout":
        await store.signOut();
        break;
      case "createChild":
        return json({ ok: true, cardId: await store.addChild(textField(data.name, "Имя ребёнка", 100)) }, 201);
      case "invite":
        return json({ ok: true, code: await store.invite(getCardId(), emailField(data.email)) }, 201);
      case "accept":
        return json({ ok: true, cardId: await store.accept(textField(data.code, "Код приглашения", 128)) });
      case "revoke":
        await store.revoke(getCardId(), textField(data.grantId, "Приглашение", 100));
        break;
      default: throw new CabinetError("Неизвестное действие.");
    }
    return json({ ok: true });
  } catch (error) { return problem(error); }
}
