// Carga las variables de configuración desde el archivo de entorno para que
// las credenciales no tengan que escribirse directamente en el código.
require("dotenv").config();

const { Pool, types } = require("pg");

// PostgreSQL devuelve los BIGINT como texto. Los convertimos a número para que
// los IDs se comporten igual que antes con MySQL.
types.setTypeParser(20, (value) => Number(value));
// DATE llega como texto "AAAA-MM-DD" para poder combinarlo con la hora sin errores de zona.
types.setTypeParser(1082, (value) => value);

// Detiene la app con un mensaje claro si falta una variable en el entorno.
function required(name) {
  if (!process.env[name]) {
    throw new Error(`Falta la variable ${name}. Configúrala en el archivo .env o en Render.`);
  }
  return process.env[name];
}

// Supabase exige conexión cifrada. DB_SSL=false solo sirve para una base local.
const pool = new Pool({
  connectionString: required("DATABASE_URL"),
  ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  max: 10
});

// Las rutas escriben los parámetros como "?" (estilo MySQL). PostgreSQL usa $1, $2...
// Esta función hace la conversión respetando lo que va entre comillas simples.
function toPgSql(sql) {
  let output = "";
  let index = 0;
  let insideQuote = false;
  for (const character of sql) {
    if (character === "'") insideQuote = !insideQuote;
    if (character === "?" && !insideQuote) {
      index += 1;
      output += `$${index}`;
    } else {
      output += character;
    }
  }
  return output;
}

// Ejecuta una consulta y devuelve la misma forma que usaban las rutas:
// - SELECT: [filas]
// - INSERT/UPDATE/DELETE: [{ insertId, affectedRows }]
async function runQuery(client, sql, params = []) {
  let text = toPgSql(sql);
  const isInsert = /^\s*INSERT\b/i.test(text);
  if (isInsert && !/\bRETURNING\b/i.test(text)) {
    text += " RETURNING *";
  }
  const result = await client.query(text, params);

  if (/^\s*SELECT\b/i.test(text)) {
    return [result.rows];
  }
  const firstRow = result.rows[0];
  const insertId = firstRow ? Object.values(firstRow)[0] : undefined;
  return [{ insertId, affectedRows: result.rowCount, rows: result.rows }];
}

// Pide una conexión dedicada para transacciones.
async function getConnection() {
  const client = await pool.connect();
  return {
    execute: (sql, params) => runQuery(client, sql, params),
    beginTransaction: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: () => client.query("ROLLBACK"),
    release: () => client.release()
  };
}

module.exports = {
  execute: (sql, params) => runQuery(pool, sql, params),
  getConnection
};
