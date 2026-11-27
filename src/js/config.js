// Configuración y utilidades de seguridad compartidas por las rutas del servidor.
require("dotenv").config();

const crypto = require("crypto");

// Detiene la app con un mensaje claro si falta una variable en el .env,
// en lugar de arrancar con valores inseguros por defecto.
function required(name) {
  if (!process.env[name]) {
    throw new Error(`Falta la variable ${name} en el archivo .env`);
  }
  return process.env[name];
}

const sessionSecret = required("SESSION_SECRET");
const phoneHmacSecret = required("PHONE_HMAC_SECRET");
const phoneEncryptionKey = Buffer.from(required("PHONE_ENCRYPTION_KEY"), "utf8");

if (phoneEncryptionKey.length !== 32) {
  throw new Error("PHONE_ENCRYPTION_KEY debe tener exactamente 32 caracteres.");
}

// Cifra teléfonos y domicilios antes de guardarlos en la base de datos. AES-GCM aporta
// confidencialidad y autenticidad: una modificación del dato cifrado provoca
// un error al descifrarlo.
function encryptSensitiveValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", phoneEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

// Recupera un dato cifrado validando su etiqueta de autenticación. El valor
// vacío se trata como ausencia de dato para columnas opcionales.
function decryptSensitiveValue(value) {
  if (!value) return "";
  const encrypted = Buffer.from(value);
  // CAMBIO: datos viejos guardados en texto plano (sin IV ni etiqueta) se devuelven tal cual.
  if (encrypted.length < 28) return encrypted.toString("utf8");
  const iv = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const data = encrypted.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", phoneEncryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

// Cifra y descifra archivos (evidencias) con el mismo esquema AES-GCM.
function encryptBuffer(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", phoneEncryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
}

function decryptBuffer(value) {
  const encrypted = Buffer.from(value);
  const decipher = crypto.createDecipheriv("aes-256-gcm", phoneEncryptionKey, encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(12, 28));
  return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]);
}

// Genera una huella estable para buscar un teléfono sin guardar el número visible.
function hashPhone(phone) {
  return crypto.createHmac("sha256", phoneHmacSecret).update(phone).digest("hex");
}

// Redirige formularios HTML mostrando un mensaje de éxito o error.
function redirectWithMessage(response, page, type, message) {
  const query = new URLSearchParams({ [type]: message });
  response.redirect(`/${page}?${query.toString()}`);
}

// Ruta de inicio de cada rol. Es la única fuente de estos destinos: la usan el login,
// /api/session y los guardias de página, para que nunca se contradigan.
const HOME_BY_ROLE = {
  administrador: "/admin/usuarios.html",
  prestador: "/prestador/servicios.html",
  solicitante: "/solicitante/solicitar-servicio.html"
};

// URL pública del WebSocket de avisos (ej. wss://cuidared-xxxx.onrender.com/ws).
// Vacía en local: el cliente usa el mismo dominio que la página.
const realtimePublicUrl = (process.env.REALTIME_PUBLIC_URL || "").trim();

// Orígenes de página que pueden abrir el WebSocket (ej. https://tu-app.vercel.app),
// separados por comas. El propio dominio del servidor siempre está permitido.
const realtimeAllowedOrigins = (process.env.REALTIME_ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);

// Devuelve el origen (esquema + host) del WebSocket para la política CSP, por ejemplo
// "wss://cuidared-xxxx.onrender.com". Si la URL no es válida, no se agrega nada.
function realtimeConnectSource() {
  if (!realtimePublicUrl) return "";
  try {
    const url = new URL(realtimePublicUrl);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

module.exports = {
  required,
  HOME_BY_ROLE,
  realtimePublicUrl,
  realtimeAllowedOrigins,
  realtimeConnectSource,
  sessionSecret,
  encryptSensitiveValue,
  decryptSensitiveValue,
  encryptBuffer,
  decryptBuffer,
  hashPhone,
  redirectWithMessage,
  admin2faEnabled: process.env.ADMIN_2FA === "true"
};