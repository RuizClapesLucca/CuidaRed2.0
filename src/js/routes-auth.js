// Rutas de cuentas: registro, inicio/cierre de sesión y confirmación de registro.
const bcrypt = require("bcrypt");
const { redirectWithMessage, encryptSensitiveValue, hashPhone, admin2faEnabled, HOME_BY_ROLE } = require("./config");
const { disconnectUser } = require("./realtime");
const { requireRole, createRateLimiter } = require("./middleware");
const { sendRegistrationCode } = require("./codes");
const { restoreIfSuspensionEnded, STATE_SUSPENDED } = require("./sanciones");
const { sendMail } = require("./email");
const { reactivateAccount, expireDeletedAccount, DELETE_GRACE_DAYS, STATE_DELETED } = require("./routes-account");

// Reglas del bloqueo temporal por intentos fallidos de inicio de sesión.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MINUTES = 15;
const STATE_PENDING = 1;
const STATE_ACTIVE = 2;

// Hash de relleno: se compara cuando el usuario no existe para que la respuesta
// tarde lo mismo y no se pueda adivinar qué correos están registrados.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("relleno-sin-uso", 12);

// Limitan los intentos por IP en los formularios que no requieren sesión.
const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: "Demasiados intentos. Espera unos minutos para continuar.",
  redirectPage: "auth/iniciar-sesion.html"
});
const registerLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: "Demasiados registros desde esta conexión. Intenta más tarde.",
  redirectPage: "auth/registro.html"
});

// Verifica el formato AAAA-MM-DD, que la fecha exista de verdad y que la edad
// esté entre 18 y 120 años.
function isValidBirthDate(birthDate) {
  const text = String(birthDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return false;
  const today = new Date();
  const minimumBirthDate = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate()));
  const maximumAgeDate = new Date(Date.UTC(today.getUTCFullYear() - 120, today.getUTCMonth(), today.getUTCDate()));
  return date <= minimumBirthDate && date >= maximumAgeDate;
}

// La contraseña necesita entre 8 y 72 bytes (límite de bcrypt), una letra y un número.
function isValidNewPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    Buffer.byteLength(password, "utf8") <= 72 &&
    /\p{L}/u.test(password) &&
    /\d/.test(password)
  );
}

// Registra en Express todos los endpoints relacionados con autenticación.
function registerRoutes(app, pool) {
  // Valida los datos y crea usuario y rol en la BD.
  app.post("/api/registro", registerLimiter, async (request, response) => {
    const {
      nombre_completo: name,
      correo: email,
      password,
      telefono: phone,
      id_sexo: sexId,
      fecha_nacimiento: birthDate,
      rol: selectedRole,
      curp,
      domicilio,
      contacto_emergencia_nombre: emergencyName,
      contacto_emergencia_telefono: emergencyPhone,
      tipo_vehiculo: vehicleType,
      color_vehiculo: vehicleColor,
      placas_vehiculo: vehiclePlates,
      puertas_vehiculo: vehicleDoors
    } = request.body;
    const normalizedName = String(name || "").trim().replace(/\s+/g, " ");
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedPhone = String(phone || "").replace(/\D/g, "");
    const numericSexId = Number(sexId);
    const roleId = selectedRole === "prestador" ? 2 : selectedRole === "solicitante" ? 1 : 0;
    const normalizedCurp = String(curp || "").trim().toUpperCase();
    const normalizedAddress = String(domicilio || "").trim();
    const normalizedEmergencyName = String(emergencyName || "").trim();
    const normalizedEmergencyPhone = String(emergencyPhone || "").replace(/\D/g, "");
    const normalizedVehicleType = String(vehicleType || "").trim();
    const normalizedVehicleColor = String(vehicleColor || "").trim();
    const normalizedVehiclePlates = String(vehiclePlates || "").trim().toUpperCase();
    const numericVehicleDoors = Number(vehicleDoors);
    const hasVehicle = String(request.body.cuenta_con_coche || "") === "si";

    if (
      normalizedName.length < 3 ||
      normalizedName.length > 100 ||
      !/^\p{L}[\p{L}\s.'-]*$/u.test(normalizedName)
    ) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Escribe tu nombre completo usando solo letras.");
    }
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Escribe un correo electrónico válido.");
    }
    if (!isValidNewPassword(password)) {
      return redirectWithMessage(
        response,
        "auth/registro.html",
        "error",
        "La contraseña debe tener de 8 a 72 caracteres, con al menos una letra y un número."
      );
    }
    if (!/^\d{10}$/.test(normalizedPhone)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "El teléfono debe tener exactamente 10 dígitos.");
    }
    if (![1, 2, 3, 4].includes(numericSexId)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Selecciona una opción de sexo.");
    }
    if (![1, 2].includes(roleId)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Selecciona si participarás como solicitante o prestador.");
    }
    if (!isValidBirthDate(birthDate)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Debes tener al menos 18 años para crear una cuenta.");
    }
    if (roleId === 2 && !/^[A-Z0-9]{18}$/.test(normalizedCurp)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "La CURP debe tener 18 caracteres.");
    }
    if (
      roleId === 2 &&
      (normalizedAddress.length < 10 ||
        normalizedAddress.length > 250 ||
        normalizedEmergencyName.length < 3 ||
        normalizedEmergencyName.length > 120 ||
        !/^\d{10}$/.test(normalizedEmergencyPhone) ||
        !["si", "no"].includes(String(request.body.cuenta_con_coche || "")) ||
        (hasVehicle && (
          normalizedVehicleType.length < 2 ||
          normalizedVehicleType.length > 60 ||
          normalizedVehicleColor.length < 2 ||
          normalizedVehicleColor.length > 40 ||
          !/^[A-Z0-9 -]{5,10}$/.test(normalizedVehiclePlates) ||
          !Number.isInteger(numericVehicleDoors) ||
          numericVehicleDoors < 2 ||
          numericVehicleDoors > 6
        )))
    ) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Completa correctamente los datos del prestador.");
    }

    let connection;
    try {
      connection = await pool.getConnection();
      await connection.beginTransaction();
      const [existingUsers] = await connection.execute(
        "SELECT id_usuario FROM usuario WHERE correo = ? LIMIT 1",
        [normalizedEmail]
      );
      if (existingUsers.length > 0) {
        await connection.rollback();
        return redirectWithMessage(response, "auth/registro.html", "error", "El correo electrónico ya está registrado.");
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const [result] = await connection.execute(
        `INSERT INTO usuario
          (nombre_completo, nombre_pila, correo, password_hash, telefono_cifrado,
           telefono_hash, id_sexo, fecha_nacimiento)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          normalizedName,
          normalizedName.split(" ")[0],
          normalizedEmail,
          passwordHash,
          encryptSensitiveValue(normalizedPhone),
          hashPhone(normalizedPhone),
          numericSexId,
          birthDate
        ]
      );
      await connection.execute("INSERT INTO usuario_rol (id_usuario, id_rol) VALUES (?, ?)", [
        result.insertId,
        roleId
      ]);
      if (roleId === 2) {
        await connection.execute(
          `INSERT INTO perfil_prestador
            (id_usuario, descripcion, tarifa_sugerida, curp_cifrada, domicilio_cifrado,
             contacto_emergencia_nombre, contacto_emergencia_telefono_cifrado,
             cuenta_con_coche, tipo_vehiculo, color_vehiculo, placas_vehiculo_cifrada, puertas_vehiculo)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            result.insertId,
            "Perfil de prestador",
            50,
            encryptSensitiveValue(normalizedCurp),
            encryptSensitiveValue(normalizedAddress),
            normalizedEmergencyName,
            encryptSensitiveValue(normalizedEmergencyPhone),
            hasVehicle,
            hasVehicle ? normalizedVehicleType : null,
            hasVehicle ? normalizedVehicleColor : null,
            hasVehicle ? encryptSensitiveValue(normalizedVehiclePlates) : null,
            hasVehicle ? numericVehicleDoors : null
          ]
        );
      }
      await connection.commit();
      // La cuenta queda pendiente hasta confirmar el NIP enviado al correo.
      request.session.pendingVerificationUserId = result.insertId;
      try {
        await sendRegistrationCode(pool, result.insertId, normalizedEmail);
      } catch (error) {
        console.error("No fue posible generar el NIP de registro:", error);
      }
      return redirectWithMessage(response, "auth/verificar-nip.html", "success", "Te enviamos un NIP de 6 dígitos a tu correo.");
    } catch (error) {
      if (connection) {
        await connection.rollback();
      }
      if (error.code === "23505") {
        return redirectWithMessage(response, "auth/registro.html", "error", "El correo o teléfono ya está registrado.");
      }
      console.error("Error al registrar usuario:", error);
      return response.status(500).send("No fue posible completar el registro.");
    } finally {
      if (connection) {
        connection.release();
      }
    }
  });

  // Permite que un prestador agregue o actualice su vehículo después del registro.
  app.post("/api/prestador/vehiculo", requireRole("prestador"), async (request, response) => {
    const vehicleType = String(request.body.tipo_vehiculo || "").trim();
    const vehicleColor = String(request.body.color_vehiculo || "").trim();
    const vehiclePlates = String(request.body.placas_vehiculo || "").trim().toUpperCase();
    const vehicleDoors = Number(request.body.puertas_vehiculo);

    if (
      vehicleType.length < 2 ||
      vehicleType.length > 60 ||
      vehicleColor.length < 2 ||
      vehicleColor.length > 40 ||
      !/^[A-Z0-9 -]{5,10}$/.test(vehiclePlates) ||
      !Number.isInteger(vehicleDoors) ||
      vehicleDoors < 2 ||
      vehicleDoors > 6
    ) {
      return redirectWithMessage(
        response,
        "prestador/registrar-vehiculo.html",
        "error",
        "Completa correctamente los datos del vehículo."
      );
    }

    try {
      const [result] = await pool.execute(
        `UPDATE perfil_prestador
         SET cuenta_con_coche = TRUE,
             tipo_vehiculo = ?,
             color_vehiculo = ?,
             placas_vehiculo_cifrada = ?,
             puertas_vehiculo = ?
         WHERE id_usuario = ? AND activo = TRUE`,
        [
          vehicleType,
          vehicleColor,
          encryptSensitiveValue(vehiclePlates),
          vehicleDoors,
          request.session.user.id
        ]
      );
      if (result.affectedRows === 0) {
        const [profiles] = await pool.execute(
          "SELECT id_perfil FROM perfil_prestador WHERE id_usuario = ? AND activo = TRUE LIMIT 1",
          [request.session.user.id]
        );
        if (profiles.length > 0) {
          return redirectWithMessage(
            response,
            "prestador/registrar-vehiculo.html",
            "success",
            "El vehículo se registró correctamente."
          );
        }
        return redirectWithMessage(
          response,
          "prestador/registrar-vehiculo.html",
          "error",
          "No fue posible encontrar un perfil de prestador activo."
        );
      }
      return redirectWithMessage(
        response,
        "prestador/registrar-vehiculo.html",
        "success",
        "El vehículo se registró correctamente."
      );
    } catch (error) {
      console.error("Error al registrar vehículo:", error);
      return response.status(500).send("No fue posible registrar el vehículo.");
    }
  });

  // Busca por correo o teléfono, compara bcrypt y crea la sesión con el rol.
  // Controla el bloqueo por intentos fallidos y la recuperación de cuentas borradas.
  app.post("/api/login", loginLimiter, async (request, response) => {
    const identifier = String(request.body.correo || "").trim();
    const password = request.body.password;
    const normalizedEmail = identifier.toLowerCase();
    const normalizedPhone = identifier.replace(/\D/g, "");

    if (
      !identifier ||
      identifier.length > 254 ||
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128 ||
      (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) &&
        !/^\d{10}$/.test(normalizedPhone))
    ) {
      return redirectWithMessage(
        response,
        "auth/iniciar-sesion.html",
        "error",
        "Ingresa un correo o teléfono válido y una contraseña de al menos 8 caracteres."
      );
    }

    try {
      // La consulta trae también las cuentas borradas o desactivadas para poder
      // decidir aquí si se recuperan o se rechazan.
      const [users] = await pool.execute(
        `SELECT id_usuario, nombre_completo, correo, password_hash, id_estado_cuenta,
                intentos_fallidos,
                (bloqueado_hasta IS NOT NULL AND bloqueado_hasta > (NOW() AT TIME ZONE 'UTC')) AS bloqueada,
                (fecha_eliminacion IS NOT NULL
                 AND fecha_eliminacion > (NOW() AT TIME ZONE 'UTC') - make_interval(days => ?::int)) AS en_gracia
         FROM usuario
         WHERE correo = ? OR telefono_hash = ?
         LIMIT 1`,
        [DELETE_GRACE_DAYS, normalizedEmail, hashPhone(normalizedPhone)]
      );
      const user = users[0];
      const passwordMatches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PASSWORD_HASH);

      if (user && user.bloqueada) {
        return redirectWithMessage(
          response,
          "auth/iniciar-sesion.html",
          "error",
          "Demasiados intentos fallidos. Intenta de nuevo en unos minutos."
        );
      }
      if (!user || !passwordMatches) {
        if (user) {
          // Al llegar al máximo de intentos se bloquea la cuenta unos minutos.
          await pool.execute(
            `UPDATE usuario
             SET intentos_fallidos = CASE WHEN intentos_fallidos + 1 >= ?::int THEN 0 ELSE intentos_fallidos + 1 END,
                 bloqueado_hasta = CASE WHEN intentos_fallidos + 1 >= ?::int
                   THEN (NOW() AT TIME ZONE 'UTC') + make_interval(mins => ?::int)
                   ELSE bloqueado_hasta END
             WHERE id_usuario = ?`,
            [LOGIN_MAX_ATTEMPTS, LOGIN_MAX_ATTEMPTS, LOGIN_LOCK_MINUTES, user.id_usuario]
          );
          if (Number(user.intentos_fallidos) + 1 >= LOGIN_MAX_ATTEMPTS) {
            sendMail({
              to: user.correo,
              subject: "Tu cuenta de CUIDARED fue bloqueada temporalmente",
              text: `Detectamos ${LOGIN_MAX_ATTEMPTS} intentos fallidos al iniciar sesión. Tu cuenta quedará bloqueada ${LOGIN_LOCK_MINUTES} minutos. Si no fuiste tú, cambia tu contraseña cuando puedas.`
            });
          }
        }
        return redirectWithMessage(response, "auth/iniciar-sesion.html", "error", "Correo o contraseña incorrectos.");
      }

      // Desde aquí la contraseña es correcta. Se revisa el estado de la cuenta.
      const stateId = Number(user.id_estado_cuenta);
      if (stateId === STATE_PENDING) {
        // La contraseña es correcta, pero falta verificar el correo: se envía un NIP nuevo.
        request.session.pendingVerificationUserId = user.id_usuario;
        await sendRegistrationCode(pool, user.id_usuario, user.correo);
        return redirectWithMessage(response, "auth/verificar-nip.html", "error", "Debes verificar tu correo. Te enviamos un NIP nuevo.");
      }
      if (stateId === STATE_DELETED) {
        if (!user.en_gracia) {
          await expireDeletedAccount(pool, user.id_usuario);
          return redirectWithMessage(
            response,
            "auth/iniciar-sesion.html",
            "error",
            `Esta cuenta fue eliminada hace más de ${DELETE_GRACE_DAYS} días y ya no se puede recuperar.`
          );
        }
        // Dentro del plazo de gracia, iniciar sesión recupera la cuenta.
        await reactivateAccount(pool, user.id_usuario);
      } else if (stateId === STATE_SUSPENDED) {
        const status = await restoreIfSuspensionEnded(pool, user.id_usuario);
        if (!status.restored) {
          return redirectWithMessage(
            response,
            "auth/iniciar-sesion.html",
            "error",
            `Tu cuenta está suspendida hasta ${new Date(status.until).toLocaleString("es-MX")}.`
          );
        }
      } else if (stateId !== STATE_ACTIVE) {
        return redirectWithMessage(
          response,
          "auth/iniciar-sesion.html",
          "error",
          "Esta cuenta no está disponible. Contacta al soporte de CUIDARED."
        );
      }

      await pool.execute(
        "UPDATE usuario SET intentos_fallidos = 0, bloqueado_hasta = NULL WHERE id_usuario = ?",
        [user.id_usuario]
      );
      const [roles] = await pool.execute(
        `SELECT ur.id_rol, r.nombre FROM usuario_rol ur
         JOIN cat_rol r ON r.id_rol = ur.id_rol
         WHERE ur.id_usuario = ? ORDER BY ur.id_rol`,
        [user.id_usuario]
      );
      const roleIds = roles.map((item) => Number(item.id_rol));
      const role = roleIds.some((id) => id === 3 || id === 4)
        ? "administrador"
        : roleIds.includes(2) ? "prestador" : "solicitante";

      // Los administradores confirman un código TOTP antes de abrir sesión.
      if (role === "administrador" && admin2faEnabled) {
        const [totpRows] = await pool.execute(
          "SELECT 1 FROM totp_administrador WHERE id_usuario = ?",
          [user.id_usuario]
        );
        if (totpRows.length === 0) {
          return redirectWithMessage(response, "auth/iniciar-sesion.html", "error", "Tu cuenta de administrador no tiene 2FA configurado. Contacta al administrador principal.");
        }
        await new Promise((resolve, reject) => {
          request.session.regenerate((error) => (error ? reject(error) : resolve()));
        });
        request.session.pendingAdmin = { id: user.id_usuario, principal: roleIds.includes(4) };
        return response.redirect("/auth/verificar-totp.html");
      }

      // Se crea una sesión nueva al iniciar sesión para evitar la fijación de sesión.
      await new Promise((resolve, reject) => {
        request.session.regenerate((error) => (error ? reject(error) : resolve()));
      });
      request.session.user = { id: user.id_usuario, name: user.nombre_completo, role };
      if (role === "administrador") {
        const [flags] = await pool.execute(
          "SELECT debe_cambiar_contrasena FROM usuario WHERE id_usuario = ?",
          [user.id_usuario]
        );
        request.session.user.principal = roleIds.includes(4);
        request.session.user.mustChange = Boolean(flags[0] && flags[0].debe_cambiar_contrasena);
      }
      // Un administrador con contraseña temporal debe cambiarla antes de entrar a su módulo.
      return response.redirect(request.session.user.mustChange ? "/auth/cambiar-contrasena.html" : HOME_BY_ROLE[role]);
    } catch (error) {
      console.error("Error al iniciar sesión:", error);
      return response.status(500).send("No fue posible iniciar sesión.");
    }
  });

  // Informa al frontend si existe una sesión activa y su usuario básico.
  // Incluye "home", la ruta de inicio del rol, para que el menú enlace al módulo correcto.
  app.get("/api/session", (request, response) => {
    const user = request.session.user || null;
    response.json({
      authenticated: Boolean(user),
      user,
      home: user ? HOME_BY_ROLE[user.role] || null : null,
      twoFactor: admin2faEnabled
    });
  });

  // Entrega una sola vez el rol guardado después del registro.
  app.get("/api/registro-confirmacion", (request, response) => {
    const role = request.session.registrationRole;
    delete request.session.registrationRole;
    if (!role) {
      return response.status(404).json({ message: "No hay un registro reciente." });
    }
    return response.json({ role });
  });

  // Destruye la sesión y vuelve a la página principal.
  app.get("/api/logout", (request, response) => {
    const userId = request.session.user && request.session.user.id;
    request.session.destroy((error) => {
      if (error) {
        console.error("Error al cerrar sesión:", error);
        return response.status(500).send("No fue posible cerrar sesión.");
      }
      // Cierra los avisos abiertos de esta sesión en todas las pestañas.
      if (userId) disconnectUser(userId);
      response.redirect("/Modulo1.html");
    });
  });
}

module.exports = { registerRoutes };
