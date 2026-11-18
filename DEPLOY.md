# Publicar CUIDARED: Supabase + Render + Vercel

Orden obligatorio: 1) Supabase, 2) Render, 3) Vercel.

## 1. Supabase (base de datos)

1. Entra a supabase.com, crea un proyecto y guarda la contraseña de la base.
2. Ve a **SQL Editor > New query**, pega todo el contenido de `supabase/schema.sql` y presiona **Run**.
3. Ve a **Connect > Session pooler** y copia la cadena de conexión. Reemplaza `[YOUR-PASSWORD]` por tu contraseña.

## 2. GitHub

1. Crea un repositorio privado nuevo (sin historial anterior).
2. Sube el contenido de esta carpeta. No subas `.env`: este proyecto ya lo excluye.

## 3. Render (backend)

1. Entra a render.com, **New > Web Service** y conecta el repositorio.
2. Configura:
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
3. En **Environment**, agrega estas variables:
   - `DATABASE_URL`: la cadena de Supabase del paso 1.
   - `SESSION_SECRET`, `PHONE_HMAC_SECRET`, `PHONE_ENCRYPTION_KEY`: valores nuevos (ver `.env.example`).
4. Crea el servicio. Cuando termine, Render te da una URL como `https://cuidared-xxxx.onrender.com`. Pruébala en el navegador.

## 4. Vercel (puerta pública)

1. Antes de subir, en `vercel.json` cambia `TU-APP.onrender.com` por tu URL de Render. Guarda y sube el cambio a GitHub.
2. Entra a vercel.com, **Add New > Project** e importa el repositorio.
3. Framework Preset: **Other**. Deja Build y Output vacíos y presiona **Deploy**.
4. Abre la URL `*.vercel.app` que te da Vercel. Esa es la página pública.

## Notas

- Render en plan gratis se duerme sin uso; la primera carga puede tardar un minuto.
- Las sesiones se guardan en memoria: si Render reinicia el servicio, los usuarios tendrán que volver a iniciar sesión.
- La base de datos nueva no trae usuarios. Crea las cuentas desde el registro.
- Para cambiar la contraseña de la base, hazlo en Supabase y actualiza `DATABASE_URL` en Render.
