// Códigos TOTP (RFC 6238) para la verificación en dos pasos de administradores.
// Usa solo el módulo crypto de Node, sin dependencias adicionales.
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text).toUpperCase().replace(/=+$/, "")) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Secreto TOTP inválido.");
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function codeAt(secret, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = crypto.createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = hash[hash.length - 1] & 0x0f;
  const binary =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3];
  return String(binary % 1000000).padStart(6, "0");
}

// Devuelve { step, code } si el código es válido; null en otro caso.
// La ventana tolera un paso de desfase entre el reloj del servidor y el del teléfono.
function verifyTotp(secret, token, window = 1) {
  const text = String(token);
  if (!/^\d{6}$/.test(text)) return null;
  const current = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = codeAt(secret, current + offset);
    if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(text))) {
      return { step: current + offset, code: candidate };
    }
  }
  return null;
}

function otpauthUri(secret, account) {
  return `otpauth://totp/${encodeURIComponent(`CUIDARED:${account}`)}?secret=${secret}&issuer=CUIDARED`;
}

module.exports = { generateSecret, codeAt, verifyTotp, otpauthUri, base32Decode, base32Encode };
