"use client";

import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { accountAction, Brand, errorText, Message, Spinner, type Notice } from "./portal-ui";

export function AuthPanel({ initialNotice, confirmationToken }: { initialNotice?: string; confirmationToken?: string }) {
  const [register, setRegister] = useState(false);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<Notice | null>(initialNotice ? { text: initialNotice, kind: "info" } : null);
  const submitting = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const title = confirmationToken ? "Подтверждение почты" : register ? "Создать аккаунт" : "Вход в кабинет";
  const description = confirmationToken ? "Введите пароль, который вы выбрали при регистрации."
    : register ? "Заведите личную медицинскую карту. Карты близких можно добавить позже." : "Введите почту и пароль, чтобы открыть свои медицинские карты.";
  const submitText = confirmationToken ? "Подтвердить почту" : register ? "Создать аккаунт" : "Войти";

  function changeMode(next: boolean) {
    if (submitting.current) return;
    setRegister(next);
    setPassword("");
    setVisible(false);
    setNotice(null);
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setNotice(null);
    let redirecting = false;
    try {
      const action: Record<string, string> = confirmationToken ? { action: "confirm", token: confirmationToken, password }
        : register ? { action: "register", name: name.trim(), email: email.trim(), password }
        : { action: "login", email: email.trim(), password };
      const result = await accountAction<{ confirmationRequired?: boolean }>(action);
      if (register && result.confirmationRequired) {
        setRegister(false);
        setVisible(false);
        setPassword("");
        setNotice({ kind: "info", text: "Проверьте почту. Откройте ссылку в письме и введите пароль, чтобы завершить регистрацию." });
      } else {
        redirecting = true;
        window.location.replace("/");
      }
    } catch (error) {
      setNotice({ kind: "error", text: errorText(error) });
    } finally {
      if (!redirecting) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <main className="auth-shell">
      <aside className="auth-cover" aria-label="О семейном кабинете">
        <div className="cover-brand"><Brand /></div>
        <div className="cover-copy">
          <p className="cover-heading">Медицинские карты<br />вашей семьи<span>.</span></p>
          <p className="cover-description">Сохраняйте анализы и обследования, чтобы легко найти оригинал перед приёмом у врача.</p>
        </div>
      </aside>
      <section className="auth-main" aria-labelledby="auth-heading">
        <div className="auth-alternate">
          {confirmationToken ? <a className="text-action" href="/">Ко входу <ArrowRight size={15} aria-hidden="true" /></a> : (
            <>
              <span>{register ? "Уже есть аккаунт?" : "Нет аккаунта?"}</span>
              <button className="text-action" type="button" disabled={busy} onClick={() => changeMode(!register)}>
                {register ? "Войти" : "Зарегистрироваться"} <ArrowRight size={15} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
        <div className="auth-body">
          <div className="auth-intro">
            <h1 id="auth-heading" ref={heading} tabIndex={-1}>{title}</h1>
            <p>{description}</p>
          </div>
          {notice && <Message notice={notice} />}
          <form className="auth-form" onSubmit={submit} aria-busy={busy}>
            {register && <label className="field" htmlFor="auth-name">
              <span>Ваше имя</span>
              <span className="input-wrap"><UserRound size={18} aria-hidden="true" /><input id="auth-name" name="name" autoComplete="name" placeholder="Имя и фамилия" value={name} onChange={event => setName(event.target.value)} required maxLength={100} disabled={busy} /></span>
            </label>}
            {!confirmationToken && <label className="field" htmlFor="auth-email">
              <span>Электронная почта</span>
              <span className="input-wrap"><Mail size={18} aria-hidden="true" /><input id="auth-email" type="email" name="email" autoComplete="email" placeholder="name@example.ru" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254} disabled={busy} /></span>
            </label>}
            <div className="field">
              <label htmlFor="auth-password">Пароль</label>
              <div className="input-wrap">
                <LockKeyhole size={18} aria-hidden="true" />
                <input id="auth-password" type={visible ? "text" : "password"} name="password" autoComplete={register ? "new-password" : "current-password"} placeholder={register ? "Не менее 10 символов" : "Введите пароль"} value={password} onChange={event => setPassword(event.target.value)} minLength={register ? 10 : undefined} maxLength={128} required disabled={busy} />
                <button type="button" className="icon-action password-toggle" disabled={busy} onClick={() => setVisible(!visible)} aria-label={visible ? "Скрыть пароль" : "Показать пароль"}>
                  {visible ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button className="button button-primary auth-submit" disabled={busy} type="submit">
              {busy ? "Подождите…" : submitText}
              {busy ? <Spinner /> : <ArrowRight size={19} aria-hidden="true" />}
            </button>
          </form>
          <p className="auth-privacy"><ShieldCheck size={19} aria-hidden="true" /><span>Вы сами решаете, кому открыть доступ к карте.</span></p>
        </div>
      </section>
    </main>
  );
}
