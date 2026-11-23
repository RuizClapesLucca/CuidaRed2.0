-- Migración beta de CUIDARED (PostgreSQL / Supabase).
-- Ejecutar UNA vez en Supabase > SQL Editor > New query > Run.
-- Es segura de repetir: usa IF NOT EXISTS, ON CONFLICT y no borra datos.
BEGIN;

-- Evidencias de reportes: contenido cifrado guardado en la base (sin buckets externos).
ALTER TABLE "evidencia" ADD COLUMN IF NOT EXISTS "contenido_cifrado" bytea;
ALTER TABLE "evidencia" ADD COLUMN IF NOT EXISTS "nombre_original" varchar(120);

-- Cuentas que existían antes de la verificación por correo se dan por verificadas.
-- Las cuentas nuevas quedan en "Pendiente de verificación" (1) hasta confirmar el NIP.
UPDATE "usuario" SET "id_estado_cuenta" = 2 WHERE "id_estado_cuenta" = 1;

-- Catálogos de la auditoría QA. Si ya existen (como en schema.sql) no hace nada.
INSERT INTO "cat_estado_cuenta" ("id_estado_cuenta", "nombre") VALUES
  (5, 'Eliminada') ON CONFLICT DO NOTHING;
INSERT INTO "cat_estado_peticion" ("id_estado_peticion", "nombre") VALUES
  (3, 'Terminado'), (4, 'Cancelado') ON CONFLICT DO NOTHING;
INSERT INTO "cat_estado_postulacion" ("id_estado_postulacion", "nombre") VALUES
  (3, 'Rechazada') ON CONFLICT DO NOTHING;
INSERT INTO "cat_estado_reporte" ("id_estado_reporte", "nombre") VALUES
  (1, 'Pendiente'), (2, 'En revisión'), (3, 'Resuelto'), (4, 'Desestimado') ON CONFLICT DO NOTHING;
INSERT INTO "cat_rol" ("id_rol", "nombre") VALUES
  (3, 'Administrador'), (4, 'Administrador principal') ON CONFLICT DO NOTHING;
INSERT INTO "cat_motivo_cancelacion" ("id_motivo", "nombre") VALUES
  (1, 'Ya no necesito el apoyo'), (2, 'Encontré otra opción'),
  (3, 'Cambió mi horario'), (4, 'Otro') ON CONFLICT DO NOTHING;
INSERT INTO "cat_motivo_reporte" ("id_motivo", "nombre") VALUES
  (1, 'Inasistencia'), (2, 'Conducta inapropiada'), (3, 'Cobro indebido'),
  (4, 'Incumplimiento'), (5, 'Otro') ON CONFLICT DO NOTHING;
INSERT INTO "cat_motivo_moderacion" ("id_motivo", "nombre") VALUES
  (1, 'Contenido ofensivo'), (2, 'Datos de contacto expuestos'),
  (3, 'Servicio no permitido'), (4, 'Otro') ON CONFLICT DO NOTHING;
INSERT INTO "cat_tipo_medida" ("id_tipo_medida", "nombre") VALUES
  (1, 'Advertencia'), (2, 'Suspensión temporal'), (3, 'Baja permanente') ON CONFLICT DO NOTHING;

-- Postulaciones: tarifa propuesta y mensaje de hasta 250 caracteres.
ALTER TABLE "postulacion" ADD COLUMN IF NOT EXISTS "tarifa_propuesta" numeric(10,2);
ALTER TABLE "postulacion" DROP CONSTRAINT IF EXISTS "chk_postulacion_tarifa";
ALTER TABLE "postulacion" ADD CONSTRAINT "chk_postulacion_tarifa"
  CHECK ("tarifa_propuesta" IS NULL OR "tarifa_propuesta" BETWEEN 50.00 AND 5000.00);
ALTER TABLE "postulacion" ALTER COLUMN "mensaje" TYPE varchar(250);
INSERT INTO "cat_estado_postulacion" ("id_estado_postulacion", "nombre") VALUES
  (6, 'Expirada') ON CONFLICT DO NOTHING;

-- La aceptación directa anterior dejaba la postulación en "Enviada" aunque el servicio existía.
UPDATE "postulacion" po SET "id_estado_postulacion" = 2
FROM "servicio" s
WHERE s."id_postulacion" = po."id_postulacion" AND po."id_estado_postulacion" = 1;

-- Cierre del servicio: cada parte confirma; si no responde, se cierra a las 24 h.
ALTER TABLE "servicio" ADD COLUMN IF NOT EXISTS "cierre_prestador" boolean NOT NULL DEFAULT false;
ALTER TABLE "servicio" ADD COLUMN IF NOT EXISTS "cierre_buscador" boolean NOT NULL DEFAULT false;

-- Reportes técnicos: la descripción acepta desde 10 caracteres (como indica QA).
ALTER TABLE "ticket_error" DROP CONSTRAINT IF EXISTS "chk_ticket_desc";
ALTER TABLE "ticket_error" ADD CONSTRAINT "chk_ticket_desc" CHECK (char_length("descripcion") >= 10);

-- Administradores creados por el principal: deben cambiar la contraseña temporal al entrar.
ALTER TABLE "usuario" ADD COLUMN IF NOT EXISTS "debe_cambiar_contrasena" boolean NOT NULL DEFAULT false;

-- Reportes técnicos con captura de pantalla cifrada (JPG o PNG, máximo 5 MB).
ALTER TABLE "ticket_error" ADD COLUMN IF NOT EXISTS "captura_cifrada" bytea;
ALTER TABLE "ticket_error" ADD COLUMN IF NOT EXISTS "captura_tipo_mime" varchar(20);
ALTER TABLE "ticket_error" ADD COLUMN IF NOT EXISTS "captura_nombre" varchar(120);

COMMIT;

-- Después de esto, crea el Administrador principal desde tu computadora:
--   node scripts/crear-admin-principal.js
