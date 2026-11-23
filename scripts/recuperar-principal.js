// Recupera la cuenta de un Administrador principal que perdió su celular (o su contraseña).
// Se ejecuta en TU computadora, con el .env apuntando a Supabase:
//   node scripts/recuperar-principal.js
// Genera una clave TOTP nueva, la reactiva y, si lo eliges, crea una contraseña temporal.
// Deja constancia en la bitácora. No es posible hacerlo desde la web.
require("dotenv").config();
const readline = require("readline/promises");
const bcrypt = require("bcrypt");
const pool = require("../src/js/db");
const { encryptSensitiveValue } = require("../src/js/config");
const { generateSecret, otpauthUri } = require("../src/js/totp");
const { temporaryPassword } = require("../src/js/routes-gestion");

const ROLE_PRINCIPAL = 4;
const STATE_ACTIVE = 2;

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => (await rl.question(question)).trim();

  const email = (await ask("Correo del Administrador principal: ")).toLowerCase();
  const confirmation = await ask('Escribe RECUPERAR para confirmar: ');
  const wantsPassword = (await ask("¿Generar también una contraseña temporal? (s/n): ")).toLowerCase() === "s";
  rl.close();

  if (confirmation !== "RECUPERAR") throw new Error("Confirmación incorrecta. No se hizo ningún cambio.");

  const [rows] = await pool.execute(
    `SELECT u.id_usuario, u.nombre_completo, u.password_hash, u.id_estado_cuenta,
            EXISTS (SELECT 1 FROM usuario_rol r WHERE r.id_usuario = u.id_usuario AND r.id_rol = ?) AS principal
     FROM usuario u WHERE u.correo = ?`,
    [ROLE_PRINCIPAL, email]
  );
  const account = rows[0];
  if (!account || !account.principal) throw new Error("La cuenta indicada no es un Administrador principal.");

  const secret = generateSecret();
  const [updated] = await pool.execute(
    `UPDATE totp_administrador
     SET secreto_cifrado = ?, ultimo_codigo_usado = NULL, intentos_fallidos = 0, bloqueado_hasta = NULL
     WHERE id_usuario = ?`,
    [encryptSensitiveValue(secret), account.id_usuario]
  );
  if (updated.affectedRows === 0) {
    await pool.execute(
      "INSERT INTO totp_administrador (id_usuario, secreto_cifrado) VALUES (?, ?)",
      [account.id_usuario, encryptSensitiveValue(secret)]
    );
  }

  // La cuenta vuelve a quedar activa, aunque hubiera estado bloqueada o inhabilitada.
  await pool.execute("UPDATE usuario SET id_estado_cuenta = ? WHERE id_usuario = ?", [STATE_ACTIVE, account.id_usuario]);

  let password = null;
  if (wantsPassword) {
    password = temporaryPassword();
    await pool.execute(
      "INSERT INTO historial_contrasena (id_usuario, password_hash) VALUES (?, ?)",
      [account.id_usuario, account.password_hash]
    );
    await pool.execute(
      "UPDATE usuario SET password_hash = ?, debe_cambiar_contrasena = TRUE WHERE id_usuario = ?",
      [await bcrypt.hash(password, 12), account.id_usuario]
    );
  }

  await pool.execute(
    "INSERT INTO bitacora (id_usuario, accion, entidad, id_entidad, detalle) VALUES (?, ?, 'usuario', ?, ?::jsonb)",
    [account.id_usuario, "RECUPERACION_PRINCIPAL", account.id_usuario,
      JSON.stringify({ via: "script", contrasena_restablecida: wantsPassword })]
  );

  console.log("\nCuenta del Administrador principal recuperada.");
  console.log(`Clave TOTP nueva (guárdala ahora, no se volverá a mostrar): ${secret}`);
  console.log(`URI para la app: ${otpauthUri(secret, email)}`);
  if (password) console.log(`Contraseña temporal (deberá cambiarla al entrar): ${password}`);
  console.log("");
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nNo se completó la recuperación: ${error.message}`);
  process.exit(1);
});
