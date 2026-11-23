// Crea la cuenta de Administrador principal y su TOTP. Se ejecuta UNA vez desde tu
// computadora, con el .env apuntando a Supabase:
//   node scripts/crear-admin-principal.js
// Al terminar muestra la clave TOTP: agrégala en Google Authenticator o Authy.
require("dotenv").config();
const readline = require("readline/promises");
const bcrypt = require("bcrypt");
const pool = require("../src/js/db");
const { encryptSensitiveValue, hashPhone } = require("../src/js/config");
const { generateSecret, otpauthUri } = require("../src/js/totp");

const ROLE_PRINCIPAL = 4;
const STATE_ACTIVE = 2;
const SEX_PREFER_NOT_TO_SAY = 4;

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question) => (await rl.question(question)).trim();

  const name = (await ask("Nombre completo: ")).replace(/\s+/g, " ");
  const email = (await ask("Correo institucional: ")).toLowerCase();
  const phone = (await ask("Teléfono (10 dígitos): ")).replace(/\D/g, "");
  const birthDate = await ask("Fecha de nacimiento (AAAA-MM-DD): ");
  const password = await ask("Contraseña (mínimo 8, con letra y número): ");
  rl.close();

  if (name.length < 3) throw new Error("El nombre es demasiado corto.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("El correo no es válido.");
  if (!/^\d{10}$/.test(phone)) throw new Error("El teléfono debe tener 10 dígitos.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new Error("La fecha debe tener formato AAAA-MM-DD.");
  if (password.length < 8 || password.length > 72 || !/\p{L}/u.test(password) || !/\d/.test(password)) {
    throw new Error("La contraseña debe tener de 8 a 72 caracteres, con una letra y un número.");
  }

  const [existing] = await pool.execute(
    "SELECT 1 FROM usuario WHERE correo = ? OR telefono_hash = ?",
    [email, hashPhone(phone)]
  );
  if (existing.length > 0) throw new Error("Ya existe una cuenta con ese correo o teléfono.");

  const passwordHash = await bcrypt.hash(password, 12);
  const [user] = await pool.execute(
    `INSERT INTO usuario
      (nombre_completo, nombre_pila, correo, password_hash, telefono_cifrado, telefono_hash,
       id_sexo, fecha_nacimiento, id_estado_cuenta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, name.split(" ")[0], email, passwordHash, encryptSensitiveValue(phone),
      hashPhone(phone), SEX_PREFER_NOT_TO_SAY, birthDate, STATE_ACTIVE]
  );
  const userId = user.insertId;
  await pool.execute("INSERT INTO usuario_rol (id_usuario, id_rol) VALUES (?, ?)", [userId, ROLE_PRINCIPAL]);

  const secret = generateSecret();
  await pool.execute(
    "INSERT INTO totp_administrador (id_usuario, secreto_cifrado) VALUES (?, ?)",
    [userId, encryptSensitiveValue(secret)]
  );

  console.log("\nAdministrador principal creado.");
  console.log(`Clave TOTP (guárdala ahora, no se volverá a mostrar): ${secret}`);
  console.log(`URI para la app: ${otpauthUri(secret, email)}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(`\nNo se creó la cuenta: ${error.message}`);
  process.exit(1);
});
