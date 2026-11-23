// Envío de correos con nodemailer (Gmail con contraseña de aplicación u otro SMTP).
// Si SMTP no está configurado, en desarrollo el contenido se muestra en la consola
// para poder probar el flujo sin correo; en producción solo se registra el aviso.
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
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return transporter;
}

// Nunca lanza error: un fallo de correo no debe tumbar el flujo del usuario.
async function sendMail({ to, subject, text }) {
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
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
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
