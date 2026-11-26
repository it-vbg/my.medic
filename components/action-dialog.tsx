import { Baby, Check, Clipboard, CloudUpload, KeyRound, Mail, ShieldMinus, UserRoundPlus } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { UploadFields } from "./documents";
import type { ActionDialog } from "./family-access";
import { accountAction, errorText, Message, Modal, requestJson, Spinner } from "./portal-ui";

type Props = {
  dialog: ActionDialog;
  close: () => void;
  completed: (cardId: string | null, message: string) => void;
  invitationCreated: () => void;
};

export function CabinetDialog({ dialog, close, completed, invitationCreated }: Props) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [invitation, setInvitation] = useState<{ code: string; email: string } | null>(null);
  const [copyState, setCopyState] = useState<"copied" | "manual" | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  const fieldId = useId();
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    if (dialog.kind === "upload" && !file) {
      setError("Выберите файл документа.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      switch (dialog.kind) {
        case "upload":
          form.set("cardId", dialog.card.id);
          form.set("file", file!);
          await requestJson("/api/documents", { method: "POST", body: form });
          if (live.current) completed(null, "Документ добавлен в карту «" + dialog.card.name + "».");
          break;
        case "child": {
          const result = await accountAction<{ cardId: string }>({ action: "createChild", name: String(form.get("name") || "").trim() });
          if (live.current) completed(result.cardId, "Карта ребёнка создана.");
          break;
        }
        case "invite": {
          const email = String(form.get("email") || "").trim();
          const result = await accountAction<{ code: string }>({ action: "invite", cardId: dialog.card.id, email });
          if (live.current) {
            setInvitation({ code: result.code, email });
            invitationCreated();
            requestAnimationFrame(() => codeInput.current?.focus());
          }
          break;
        }
        case "accept": {
          const result = await accountAction<{ cardId: string }>({ action: "accept", code: String(form.get("code") || "").trim() });
          if (live.current) completed(result.cardId, "Приглашение принято. Теперь вам доступны документы этой карты.");
          break;
        }
        case "revoke":
          await accountAction({ action: "revoke", cardId: dialog.card.id, grantId: dialog.grant.id });
          if (live.current) completed(null, dialog.grant.status === "active" ? "Доступ к карте отозван." : "Приглашение отменено.");
          break;
      }
    } catch (problem) {
      if (live.current) setError(errorText(problem));
    } finally {
      if (live.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  async function copyCode() {
    if (!invitation) return;
    try {
      await navigator.clipboard.writeText(invitation.code);
      if (live.current) setCopyState("copied");
    } catch {
      codeInput.current?.focus();
      codeInput.current?.select();
      if (live.current) setCopyState("manual");
    }
  }

  if (invitation) {
    return <Modal title="Приглашение готово" description={"Передайте код человеку с адресом " + invitation.email + ". Для доступа к карте ему нужно войти с этой почтой и ввести код в разделе «Семейный доступ»."} icon={<Mail size={24} />} busy={false} close={close}>
      <div className="dialog-form">
        <label className="field" htmlFor={fieldId}><span>Код приглашения</span><input id={fieldId} ref={codeInput} className="plain-input code-value" readOnly value={invitation.code} spellCheck={false} onFocus={event => event.currentTarget.select()} /></label>
        {copyState && <Message notice={copyState === "copied" ? { kind: "success", text: "Код скопирован." } : { kind: "info", text: "Код выделен. Скопируйте его вручную." }} />}
        <div className="modal-actions"><button type="button" className="button button-secondary" onClick={close}>Готово</button><button type="button" className="button button-primary" onClick={copyCode}>{copyState === "copied" ? <Check size={17} /> : <Clipboard size={17} />} Скопировать код</button></div>
      </div>
    </Modal>;
  }

  let title: string;
  let description: string;
  let label: string;
  let icon;
  switch (dialog.kind) {
    case "upload":
      title = "Загрузить документ"; description = "Документ будет сохранён в карте «" + dialog.card.name + "»."; label = "Загрузить"; icon = <CloudUpload size={24} />; break;
    case "child":
      title = "Карта ребёнка"; description = "Создайте отдельную медицинскую карту для анализов и обследований ребёнка."; label = "Создать карту"; icon = <Baby size={24} />; break;
    case "invite":
      title = "Пригласить близкого"; description = "Укажите почту человека, которому вы хотите открыть доступ к карте «" + dialog.card.name + "». Для него будет создан код приглашения."; label = "Создать приглашение"; icon = <UserRoundPlus size={24} />; break;
    case "accept":
      title = "Принять приглашение"; description = "Введите код от владельца карты. Используйте аккаунт с той почтой, на которую оформлено приглашение."; label = "Принять приглашение"; icon = <KeyRound size={24} />; break;
    case "revoke": {
      const active = dialog.grant.status === "active";
      title = active ? "Отозвать доступ?" : "Отменить приглашение?";
      description = active ? "Пользователь " + dialog.grant.email + " потеряет доступ к документам карты «" + dialog.card.name + "»." : "Приглашение для " + dialog.grant.email + " перестанет действовать.";
      label = active ? "Отозвать доступ" : "Отменить приглашение";
      icon = <ShieldMinus size={24} />;
      break;
    }
  }

  return <Modal title={title} description={description} icon={icon} busy={busy} close={close}>
    <form className="dialog-form" onSubmit={submit} aria-busy={busy}>
      {error && <Message notice={{ kind: "error", text: error }} />}
      {dialog.kind === "upload" && <UploadFields file={file} setFile={setFile} disabled={busy} />}
      {dialog.kind === "child" && <label className="field" htmlFor={fieldId}><span>Имя ребёнка</span><input id={fieldId} className="plain-input" name="name" autoComplete="off" placeholder="Имя и фамилия" maxLength={100} required disabled={busy} /></label>}
      {dialog.kind === "invite" && <label className="field" htmlFor={fieldId}><span>Электронная почта</span><input id={fieldId} className="plain-input" name="email" type="email" autoComplete="off" placeholder="name@example.ru" maxLength={254} required disabled={busy} /></label>}
      {dialog.kind === "accept" && <label className="field" htmlFor={fieldId}><span>Код приглашения</span><input id={fieldId} className="plain-input" name="code" autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Вставьте полученный код" maxLength={128} required disabled={busy} /></label>}
      <div className="modal-actions">
        <button type="button" className="button button-secondary" onClick={close} disabled={busy}>{dialog.kind === "revoke" ? "Оставить" : "Отмена"}</button>
        <button type="submit" className={"button " + (dialog.kind === "revoke" ? "button-danger" : "button-primary")} disabled={busy}>{busy && <Spinner />}{label}</button>
      </div>
    </form>
  </Modal>;
}
