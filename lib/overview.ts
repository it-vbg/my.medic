import { CabinetError, type CabinetStore, type Overview } from "./cabinet.ts";

export async function getOverview(store: CabinetStore, cardId?: string | null): Promise<Overview> {
  const user = await store.currentUser();
  if (!user) throw new CabinetError("Войдите в аккаунт.", 401);
  const cards = await store.listCards();
  const active = cardId ? cards.find(card => card.id === cardId) : cards.find(card => card.relation === "self");
  if (!active) throw new CabinetError("Карта недоступна.", 404);
  const [documents, grants] = await Promise.all([
    store.documents(active.id),
    active.isOwner ? store.listGrants(active.id) : Promise.resolve([]),
  ]);
  return { user, cards, activeCardId: active.id, documents, grants };
}
