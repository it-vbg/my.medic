import { CircleAlert, CircleCheck, Info, LoaderCircle, X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import type { Card } from "@/lib/cabinet";

export class RequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new RequestError("Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.", 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    throw new RequestError(body?.error || "Не удалось выполнить запрос. Попробуйте ещё раз.", response.status);
  }
  return body as T;
}

export function accountAction<T = { ok: true }>(data: Record<string, string>) {
  return requestJson<T>("/api/cabinet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export function errorText(error: unknown) {
  return error instanceof RequestError ? error.message : "Не удалось выполнить действие. Попробуйте ещё раз.";
}

export function cardRelation(card: Card) {
  if (card.relation === "self") return "Личная карта";
  if (card.relation === "child") return "Карта ребёнка";
  return "Карта супруга";
}

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join("").toLocaleUpperCase("ru");
}

export function Brand() {
  return (
    <span className="brand" aria-label="my.medic">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
      <span aria-hidden="true">my<span className="brand-dot">.</span>medic</span>
    </span>
  );
}

export type Notice = { text: string; kind: "success" | "info" | "error" };

export function Message({ notice, dismiss }: { notice: Notice; dismiss?: () => void }) {
  const Icon = notice.kind === "error" ? CircleAlert : notice.kind === "success" ? CircleCheck : Info;
  return (
    <div className={"message message-" + notice.kind} role={notice.kind === "error" ? "alert" : "status"}>
      <Icon size={18} aria-hidden="true" />
      <span>{notice.text}</span>
      {dismiss && <button type="button" className="icon-action message-dismiss" onClick={dismiss} aria-label="Скрыть сообщение"><X size={16} /></button>}
    </div>
  );
}

export function Spinner() {
  return <LoaderCircle className="spinner" size={18} aria-hidden="true" />;
}

export function Modal({ title, description, icon, busy, close, children }: {
  title: string;
  description?: string;
  icon: ReactNode;
  busy: boolean;
  close: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined}
      onCancel={event => { event.preventDefault(); if (!busy) close(); }}
      onPointerDown={event => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={event => { if (!busy && backdropPress.current && event.target === event.currentTarget) close(); }}>
      <div className="modal-inner">
        <div className="modal-top">
          <span className="feature-icon">{icon}</span>
          <button type="button" className="icon-action dialog-close" aria-label="Закрыть окно" disabled={busy} onClick={close}><X size={19} /></button>
        </div>
        <h2 id={titleId}>{title}</h2>
        {description && <p className="modal-description" id={descriptionId}>{description}</p>}
        {children}
      </div>
    </dialog>
  );
}
