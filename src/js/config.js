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
  const iv = encrypted.subarray(0, 12);
  const authTag = encrypted.subarray(12, 28);
  const data = encrypted.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", phoneEncryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
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

module.exports = {
  required,
  sessionSecret,
  encryptSensitiveValue,
  decryptSensitiveValue,
  hashPhone,
  redirectWithMessage
};