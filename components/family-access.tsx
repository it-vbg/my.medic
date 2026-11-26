import { ArrowRight, Baby, Check, KeyRound, Mail, Plus, ShieldCheck, UserRound, UserRoundPlus, UsersRound } from "lucide-react";
import type { Card, Grant } from "@/lib/cabinet";
import { cardRelation, initials } from "./portal-ui";

export type ActionDialog =
  | { kind: "upload" | "invite"; card: Card }
  | { kind: "child" | "accept" }
  | { kind: "revoke"; card: Card; grant: Grant };

type FamilyProps = {
  card: Card;
  cards: Card[];
  grants: Grant[];
  selectCard: (id: string) => void;
  open: (dialog: ActionDialog) => void;
};

export function FamilyAccess({ card, cards, grants, selectCard, open }: FamilyProps) {
  return (
    <section className="page-section" aria-labelledby="family-title">
      <div className="section-heading"><h1 id="family-title">Семейный доступ</h1></div>
      <div className="family-layout">
        <section className="panel family-panel access-panel" aria-labelledby="access-title">
          <div className="panel-heading"><span className="feature-icon"><ShieldCheck size={22} /></span><h2 id="access-title">Доступ к карте</h2></div>
          {card.isOwner ? <>
            <p>Вы можете дать близкому человеку право читать и добавлять документы в карту «{card.name}».</p>
            <div className="grant-list">
              {grants.map(grant => <div className="grant-row" key={grant.id}>
                <span className={"grant-avatar" + (grant.status === "active" ? " active" : "")}>{grant.status === "active" ? <UserRound size={17} /> : <Mail size={17} />}</span>
                <span className="grant-info"><strong>{grant.email}</strong><small>{grant.status === "active" ? "Доступ открыт" : "Приглашение ожидает принятия"}</small></span>
                <button type="button" className="text-action revoke-link" onClick={() => open({ kind: "revoke", card, grant })} aria-label={(grant.status === "active" ? "Отозвать доступ" : "Отменить приглашение") + " для " + grant.email}>{grant.status === "active" ? "Отозвать" : "Отменить"}</button>
              </div>)}
            </div>
            <button type="button" className="button button-primary" onClick={() => open({ kind: "invite", card })}><UserRoundPlus size={17} /> Пригласить близкого</button>
          </> : <p>Вы можете читать и добавлять документы в эту карту. Приглашениями и доступом управляет её владелец.</p>}
        </section>
        <section className="panel family-panel family-cards" aria-labelledby="cards-title">
          <div className="panel-heading"><span className="feature-icon warm"><UsersRound size={22} /></span><h2 id="cards-title">Доступные карты</h2></div>
          <ul className="family-card-list">
            {cards.map(item => {
              const active = item.id === card.id;
              const content = <>
                <span className={"small-avatar avatar-" + item.relation}>{item.relation === "child" ? <Baby size={19} /> : initials(item.name)}</span>
                <span className="card-person"><strong>{item.name}</strong><small>{cardRelation(item)}</small></span>
                {active ? <Check className="card-check" size={17} aria-label="Карта выбрана" /> : <ArrowRight className="card-arrow" size={16} aria-hidden="true" />}
              </>;
              return <li key={item.id}>{active ? <div className="family-card-row" aria-current="true">{content}</div> : <button type="button" className="family-card-row" onClick={() => selectCard(item.id)} aria-label={"Выбрать карту «" + item.name + "»"}>{content}</button>}</li>;
            })}
          </ul>
          <button type="button" className="button button-secondary" onClick={() => open({ kind: "child" })}><Plus size={17} /> Добавить карту ребёнка</button>
        </section>
        <section className="panel invitation-banner" aria-labelledby="invitation-title">
          <span className="feature-icon"><KeyRound size={23} /></span>
          <div><h2 id="invitation-title">Получили приглашение?</h2><p>Введите код, которым с вами поделился владелец карты.</p></div>
          <button type="button" className="text-action" onClick={() => open({ kind: "accept" })}>Ввести код <ArrowRight size={16} /></button>
        </section>
      </div>
    </section>
  );
}
