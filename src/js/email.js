// Envío de correos. Orden de preferencia:
//   1) Brevo por API HTTPS  (BREVO_API_KEY)  -> funciona en Render gratis
//   2) Resend por API HTTPS (RESEND_API_KEY)
//   3) SMTP con nodemailer (SMTP_USER/SMTP_PASS). OJO: Render en plan gratis
//      bloquea los puertos SMTP (25/465/587), por eso allí da "Connection timeout".
const nodemailer = require("nodemailer");

const IS_PRODUCTION = process.env.NODE_ENV === "production";
let transporter; // undefined = todavía no se revisa; null = SMTP sin configurar

function getTransporter() {
  if (transporter !== undefined) return transporter;
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return transporter;
}

function parseFrom(value) {
  // Acepta "Nombre <correo@dominio>" o solo "correo@dominio".
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value || "");
  return match
    ? { name: match[1].replace(/^"|"$/g, "") || "CUIDARED", email: match[2] }
    : { name: "CUIDARED", email: String(value || "").trim() };
}

async function postJson(url, headers, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

// Nunca lanza error: un fallo de correo no debe tumbar el flujo del usuario.
async function sendMail({ to, subject, text }) {
  const fromRaw = process.env.MAIL_FROM || process.env.SMTP_USER || process.env.BREVO_SENDER;
  try {
    if (process.env.BREVO_API_KEY) {
      const from = parseFrom(fromRaw);
      await postJson("https://api.brevo.com/v3/smtp/email", { "api-key": process.env.BREVO_API_KEY }, {
        sender: { name: from.name, email: from.email },
        to: [{ email: to }],
        subject,
        textContent: text
      });
      return true;
    }
    if (process.env.RESEND_API_KEY) {
      await postJson("https://api.resend.com/emails", { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, {
        from: fromRaw || "CUIDARED <onboarding@resend.dev>",
        to: [to],
        subject,
        text
      });
      return true;
    }
  } catch (error) {
    console.error("No fue posible enviar el correo (API):", error.message);
    return false;
  }

  const mailer = getTransporter();
  if (!mailer) {
    if (IS_PRODUCTION) {
      console.error(`Correo no enviado (SMTP sin configurar): ${subject}`);
    } else {
      console.warn(`[DESARROLLO] Correo para ${to} | ${subject}\n${text}`);
    }
    return false;
  }
  try {
    await mailer.sendMail({
      from: fromRaw,
      to,
      subject,
      text
    });
    return true;
  } catch (error) {
    console.error("No fue posible enviar el correo:", error.message);
    return false;
  }
}

module.exports = { sendMail };