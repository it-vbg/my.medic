import { cookies, headers } from "next/headers";
import path from "node:path";
import { createLocalStore } from "./local-store";
import { getPostgresPool } from "./postgres";
import { createPostgresAuth } from "./postgres-auth";
import { createPostgresCards } from "./postgres-cards";
import { sendConfirmationMail } from "./confirmation-mail";
import type { Session } from "./credentials";
import type { CabinetStore } from "./cabinet";

export async function getStore(): Promise<CabinetStore> {
  const [jar, incoming] = await Promise.all([cookies(), headers()]);
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(incoming.get("host") ?? "");
  const secure = process.env.APP_URL?.startsWith("https://") || incoming.get("x-forwarded-proto") === "https"
    || (process.env.NODE_ENV === "production" && !loopback);
  const session: Session = {
    get: () => jar.get("my_medic_session")?.value,
    set: (token) => jar.set("my_medic_session", token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 30 * 86400 }),
    clear: () => jar.delete("my_medic_session"),
  };
  if (process.env.MY_MEDIC_STORAGE === "sqlite") {
    return createLocalStore(process.env.MY_MEDIC_DATA_DIR || path.join(process.cwd(), ".my-medic"), session);
  }
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL for PostgreSQL or select MY_MEDIC_STORAGE=sqlite.");
  const pool = getPostgresPool(process.env.DATABASE_URL);
  return { ...createPostgresAuth(pool, session, sendConfirmationMail), ...createPostgresCards(pool, session) };
}
