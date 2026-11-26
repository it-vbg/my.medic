import { isIP } from "node:net";
import { createTransport } from "nodemailer";

function configuredUrl(field: "APP_URL" | "SMTP_URL") {
  try {
    const url = new URL(process.env[field] ?? "");
    if (url.hostname) return url;
  } catch { /* URL parser errors may include credentials. */ }
  throw new Error("Invalid " + field + " configuration");
}

function isLoopback(host: string) {
  return host.toLowerCase() === "localhost" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));
}

export async function sendConfirmationMail(email: string, token: string): Promise<void> {
  const app = configuredUrl("APP_URL");
  if (app.username || app.password || !(app.protocol === "https:" || (app.protocol === "http:" && isLoopback(app.hostname)))) {
    throw new Error("APP_URL must use HTTPS or loopback HTTP");
  }
  const link = new URL("/auth/confirm", app);
  link.searchParams.set("token", token);

  const smtp = configuredUrl("SMTP_URL");
  if (smtp.protocol !== "smtp:" && smtp.protocol !== "smtps:") throw new Error("SMTP_URL must use SMTP or SMTPS");
  const from = process.env.SMTP_FROM?.trim();
  if (!from || /[\r\n]/u.test(from)) throw new Error("Invalid SMTP_FROM configuration");
  const secure = smtp.protocol === "smtps:";
  try {
    const mail = createTransport({
      host: smtp.hostname.replace(/^\[|\]$/gu, ""),
      port: smtp.port ? Number(smtp.port) : secure ? 465 : 587,
      secure,
      requireTLS: !secure && !isLoopback(smtp.hostname),
      auth: smtp.username ? { user: decodeURIComponent(smtp.username), pass: decodeURIComponent(smtp.password) } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    await mail.sendMail({
      from, to: { name: "", address: email },
      subject: "Подтвердите почту для my.medic",
      text: [
        "Чтобы открыть свой кабинет my.medic, перейдите по ссылке и введите пароль, который вы указали при регистрации.",
        link.href,
        "Ссылка действует 24 часа. Если у вас уже есть кабинет, войдите с прежним паролем. Если вы не запрашивали регистрацию, проигнорируйте письмо.",
      ].join("\n\n"),
    });
  } catch {
    throw new Error("Could not deliver confirmation email");
  }
}
