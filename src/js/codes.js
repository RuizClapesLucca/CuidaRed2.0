// Códigos NIP de un solo uso. En la base solo se guarda un HMAC del código,
// nunca el código en claro. Cada código vence y tiene un máximo de intentos.
const crypto = require("crypto");
const { sendMail } = require("./email");

const MAX_ATTEMPTS = 3;
const REGISTRATION_MINUTES = 5;
const RECOVERY_MINUTES = 15;

function hashCode(purpose, userId, code) {
  return crypto
    .createHmac("sha256", process.env.PHONE_HMAC_SECRET)
    .update(`${purpose}:${userId}:${code}`)
    .digest("hex");
}

// Invalida los códigos anteriores del mismo propósito y crea uno nuevo.
async function issueCode(pool, userId, purpose, destination, minutes) {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  await pool.execute(
    "UPDATE codigo_verificacion SET usado = TRUE WHERE id_usuario = ? AND proposito = ? AND usado = FALSE",
    [userId, purpose]
  );
  await pool.execute(
    `INSERT INTO codigo_verificacion (id_usuario, proposito, codigo_hash, destino, fecha_expiracion)
     VALUES (?, ?, ?, ?, (NOW() AT TIME ZONE 'UTC') + make_interval(mins => ?::int))`,
    [userId, purpose, hashCode(purpose, userId, code), destination, minutes]
  );
  return code;
}

// Devuelve "ok", "invalid", "expired", "locked" o "missing".
async function checkCode(pool, userId, purpose, code) {
  const [rows] = await pool.execute(
    `SELECT id_codigo, codigo_hash, intentos,
            (fecha_expiracion <= (NOW() AT TIME ZONE 'UTC')) AS expirado
     FROM codigo_verificacion
     WHERE id_usuario = ? AND proposito = ? AND usado = FALSE
     ORDER BY id_codigo DESC
     LIMIT 1`,
    [userId, purpose]
  );
  const row = rows[0];
  if (!row) return "missing";
  if (row.expirado) return "expired";
  if (Number(row.intentos) >= MAX_ATTEMPTS) return "locked";

  const expected = Buffer.from(String(row.codigo_hash).trim(), "utf8");
  const actual = Buffer.from(hashCode(purpose, userId, code), "utf8");
  if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
    await pool.execute("UPDATE codigo_verificacion SET usado = TRUE WHERE id_codigo = ?", [row.id_codigo]);
    return "ok";
  }
  const attempts = Number(row.intentos) + 1;
  await pool.execute(
    "UPDATE codigo_verificacion SET intentos = ?, usado = ? WHERE id_codigo = ?",
    [attempts, attempts >= MAX_ATTEMPTS, row.id_codigo]
  );
  return attempts >= MAX_ATTEMPTS ? "locked" : "invalid";
}

async function sendRegistrationCode(pool, userId, email) {
  const code = await issueCode(pool, userId, "REGISTRO", email, REGISTRATION_MINUTES);
  return sendMail({
    to: email,
    subject: "Tu NIP de verificación de CUIDARED",
    text: `Tu NIP de verificación es ${code}. Vence en ${REGISTRATION_MINUTES} minutos. Si no solicitaste este registro, puedes ignorar este correo.`
  });
}

async function sendRecoveryCode(pool, userId, email) {
  const code = await issueCode(pool, userId, "RECUPERACION", email, RECOVERY_MINUTES);
  return sendMail({
    to: email,
    subject: "Restablecer tu contraseña de CUIDARED",
    text: `Tu NIP para restablecer la contraseña es ${code}. Vence en ${RECOVERY_MINUTES} minutos. Si no solicitaste este cambio, ignora este correo: tu contraseña no cambiará.`
  });
}

module.exports = { checkCode, sendRegistrationCode, sendRecoveryCode, issueCode, MAX_ATTEMPTS };
