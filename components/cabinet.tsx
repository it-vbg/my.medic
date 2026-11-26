"use client";

import { BookHeart, ChevronDown, Files, Layers2, LogOut, RefreshCw, UsersRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import type { Overview } from "@/lib/cabinet";
import { CabinetDialog } from "./action-dialog";
import { Documents } from "./documents";
import { FamilyAccess, type ActionDialog } from "./family-access";
import { accountAction, Brand, cardRelation, errorText, initials, Message, RequestError, requestJson, Spinner, type Notice } from "./portal-ui";

type Section = "documents" | "family";
const navigation = [{ id: "documents", name: "Документы", icon: Files }, { id: "family", name: "Семейный доступ", icon: UsersRound }] as const;

function cabinetUrl(cardId: string, section: Section) {
  const params = new URLSearchParams({ card: cardId });
  if (section === "family") params.set("view", "family");
  return "/?" + params;
}

function writeUrl(cardId: string, section: Section, mode: "push" | "replace") {
  const path = cabinetUrl(cardId, section);
  if (window.location.pathname + window.location.search === path) return;
  if (mode === "push") window.history.pushState(null, "", path);
  else window.history.replaceState(window.history.state, "", path);
}

export function Cabinet({ initial, initialSection = "documents" }: { initial: Overview; initialSection?: Section }) {
  const [data, setData] = useState(initial);
  const [section, setSection] = useState<Section>(initialSection);
  const [targetId, setTargetId] = useState(initial.activeCardId);
  const [loading, setLoading] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<ActionDialog | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const selection = useRef(initial.activeCardId);
  const activeSection = useRef<Section>(initialSection);
  const currentDialog = useRef<ActionDialog | null>(null);
  const version = useRef(0);
  const fetching = useRef(false);
  const leaving = useRef(false);
  const ownId = initial.cards.find(card => card.relation === "self")?.id || initial.activeCardId;

  const showDialog = useCallback((next: ActionDialog | null) => {
    currentDialog.current = next;
    setDialog(next);
  }, []);

  const loadCard = useCallback(async (id: string, quiet = false) => {
    const request = ++version.current;
    const previous = selection.current;
    selection.current = id;
    fetching.current = true;
    setTargetId(id);
    if (previous !== id) {
      showDialog(null);
      setNotice(null);
    }
    if (!quiet) setLoading(true);
    setProblem("");
    try {
      let next: Overview;
      let lostAccess = false;
      try {
        next = await requestJson<Overview>("/api/cabinet?card=" + encodeURIComponent(id));
      } catch (error) {
        if (request !== version.current) return false;
        if (!(error instanceof RequestError) || (error.status !== 403 && error.status !== 404)) throw error;
        lostAccess = true;
        showDialog(null);
        setLoading(true);
        next = await requestJson<Overview>("/api/cabinet");
      }
      if (request !== version.current) return false;
      selection.current = next.activeCardId;
      setTargetId(next.activeCardId);
      setData(next);
      writeUrl(next.activeCardId, activeSection.current, "replace");
      if (lostAccess) setNotice({ kind: "info", text: "Выбранная карта больше недоступна. Открыта ваша личная карта." });
      return !lostAccess;
    } catch (error) {
      if (request !== version.current) return false;
      if (error instanceof RequestError && error.status === 401) {
        window.location.replace("/");
      } else {
        setProblem(errorText(error));
      }
      return false;
    } finally {
      if (version.current === request) {
        fetching.current = false;
        setLoading(false);
      }
    }
  }, [showDialog]);

  useEffect(() => {
    function syncAddress() {
      const params = new URLSearchParams(window.location.search);
      const nextSection = params.get("view") === "family" ? "family" : "documents";
      activeSection.current = nextSection;
      setSection(nextSection);
      showDialog(null);
      const id = params.get("card") || ownId;
      if (id !== selection.current) void loadCard(id);
      else writeUrl(id, nextSection, "replace");
    }
    function refreshAfterFocus() {
      if (!currentDialog.current && !fetching.current && !leaving.current) void loadCard(selection.current, true);
    }
    syncAddress();
    window.addEventListener("popstate", syncAddress);
    window.addEventListener("focus", refreshAfterFocus);
    window.addEventListener("pageshow", refreshAfterFocus);
    return () => {
      version.current++;
      window.removeEventListener("popstate", syncAddress);
      window.removeEventListener("focus", refreshAfterFocus);
      window.removeEventListener("pageshow", refreshAfterFocus);
    };
  }, [loadCard, ownId, showDialog]);

  function changeCard(id: string) {
    if (!id || id === selection.current) return;
    writeUrl(id, activeSection.current, "push");
    void loadCard(id);
  }

  function goTo(event: MouseEvent<HTMLAnchorElement>, next: Section) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (activeSection.current === next) return;
    showDialog(null);
    setNotice(null);
    activeSection.current = next;
    setSection(next);
    writeUrl(selection.current, next, "push");
    window.scrollTo(0, 0);
  }

  async function completed(nextId: string | null, message: string) {
    showDialog(null);
    const id = nextId || selection.current;
    if (nextId && nextId !== selection.current) writeUrl(nextId, activeSection.current, "push");
    const refreshed = await loadCard(id);
    if (refreshed && selection.current === id) setNotice({ kind: "success", text: message });
  }

  async function signOut() {
    if (leaving.current) return;
    leaving.current = true;
    setSigningOut(true);
    setNotice(null);
    try {
      await accountAction({ action: "logout" });
      version.current++;
      window.location.replace("/");
    } catch (error) {
      leaving.current = false;
      setSigningOut(false);
      setNotice({ kind: "error", text: errorText(error) });
    }
  }

  const card = data.cards.find(item => item.id === targetId);
  return (
    <div className="cabinet-shell">
      <a className="skip-link" href="#cabinet-content">Перейти к содержимому</a>
      <header className="app-header"><div className="app-header-in">
        <div className="app-brand"><Brand /></div>
        <nav className="app-nav" aria-label="Разделы кабинета">
          {navigation.map(item => <a key={item.id} href={cabinetUrl(targetId, item.id)} onClick={event => goTo(event, item.id)} aria-current={section === item.id ? "page" : undefined}><item.icon size={17} aria-hidden="true" />{item.name}</a>)}
        </nav>
        <div className="account-mini">
          <span className="account-avatar" aria-hidden="true">{initials(data.user.name)}</span>
          <span className="account-id" title={data.user.name + " · " + data.user.email}><span className="account-name">{data.user.name}</span><small className="account-mail">{data.user.email}</small></span>
          <span className="account-rule" />
          <button type="button" className="icon-action logout-button" title="Выйти из аккаунта" aria-label="Выйти из аккаунта" onClick={signOut} disabled={signingOut}>{signingOut ? <Spinner /> : <LogOut size={18} />}</button>
        </div>
      </div></header>
      <main className="cabinet-main" id="cabinet-content">
        <div className="profile-banner">
          <div className="profile-contours" aria-hidden="true" />
          <div className="profile-copy">
            <span className="profile-type"><BookHeart size={17} aria-hidden="true" />{card ? cardRelation(card) : "Медицинская карта"}</span>
            <p className="profile-name">{card?.name || "Загружаем карту…"}</p>
          </div>
          <div className="profile-switch">
            <Layers2 size={16} aria-hidden="true" /><span>Сменить карту</span><ChevronDown size={16} aria-hidden="true" />
            <select aria-label="Выбрать медицинскую карту" value={card?.id || ""} onChange={event => {
              if (event.target.value === "new-child") showDialog({ kind: "child" });
              else if (event.target.value === "enter-code") showDialog({ kind: "accept" });
              else changeCard(event.target.value);
            }} disabled={signingOut}>
              {!card && <option value="" disabled>Загружаем карту…</option>}
              <optgroup label="Доступные карты">{data.cards.map(item => <option key={item.id} value={item.id}>{item.name} — {cardRelation(item)}</option>)}</optgroup>
              <optgroup label="Добавить карту"><option value="new-child">Добавить карту ребёнка</option><option value="enter-code">Ввести код приглашения</option></optgroup>
            </select>
          </div>
        </div>
        {notice && <Message notice={notice} dismiss={() => setNotice(null)} />}
        {problem ? <div className="panel load-state"><Message notice={{ kind: "error", text: problem }} /><button type="button" className="button button-secondary" onClick={() => void loadCard(selection.current)}><RefreshCw size={16} /> Повторить</button></div>
          : (loading || !card || data.activeCardId !== targetId) ? <div className="panel load-state" role="status"><Spinner /> Загружаем карту…</div>
          : section === "documents" ? <Documents key={card.id} records={data.documents} openUpload={() => showDialog({ kind: "upload", card })} />
          : <FamilyAccess card={card} cards={data.cards} grants={data.grants} selectCard={changeCard} open={showDialog} />}
      </main>
      {dialog && <CabinetDialog dialog={dialog} close={() => showDialog(null)}
        completed={(id, message) => { if (currentDialog.current === dialog) void completed(id, message); }}
        invitationCreated={() => { if (currentDialog.current === dialog) void loadCard(selection.current, true); }} />}
    </div>
  );
}
