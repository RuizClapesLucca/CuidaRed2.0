// Rutas de cuentas: registro, inicio/cierre de sesión y confirmación de registro.
const bcrypt = require("bcrypt");
const { redirectWithMessage, encryptSensitiveValue, hashPhone } = require("./config");
const { requireRole } = require("./middleware");

// Verifica que la persona tenga por lo menos 18 años.
function isValidBirthDate(birthDate) {
  const date = new Date(`${birthDate}T00:00:00`);
  const today = new Date();
  const minimumBirthDate = new Date(
    today.getFullYear() - 18,
    today.getMonth(),
    today.getDate()
  );
  return !Number.isNaN(date.getTime()) && date <= minimumBirthDate;
}

// Registra en Express todos los endpoints relacionados con autenticación.
function registerRoutes(app, pool) {
  // Valida los datos y crea usuario y rol en la BD.
  app.post("/api/registro", async (request, response) => {
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

    if (!name || name.trim().length < 3) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Escribe tu nombre completo.");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return redirectWithMessage(response, "auth/registro.html", "error", "Escribe un correo electrónico válido.");
    }
    if (typeof password !== "string" || password.length < 8) {
      return redirectWithMessage(response, "auth/registro.html", "error", "La contraseña debe tener al menos 8 caracteres.");
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
          name.trim(),
          name.trim().split(/\s+/)[0],
          normalizedEmail,
          passwordHash,
          normalizedPhone,
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
      request.session.registrationRole = roleId === 2 ? "prestador" : "solicitante";
      return redirectWithMessage(response, "auth/registro-exitoso.html", "success", "Registro exitoso.");
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
  app.post("/api/login", async (request, response) => {
    const identifier = String(request.body.correo || "").trim();
    const password = request.body.password;
    const normalizedEmail = identifier.toLowerCase();
    const normalizedPhone = identifier.replace(/\D/g, "");

    if (
      !identifier ||
      typeof password !== "string" ||
      password.length < 8 ||
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
      const [users] = await pool.execute(
        `SELECT id_usuario, nombre_completo, password_hash
         FROM usuario
         WHERE (correo = ? OR telefono_hash = ?) AND id_estado_cuenta IN (1, 2)
         LIMIT 1`,
        [normalizedEmail, hashPhone(normalizedPhone)]
      );
      const user = users[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return redirectWithMessage(response, "auth/iniciar-sesion.html", "error", "Correo o contraseña incorrectos.");
      }

      const [roles] = await pool.execute(
        `SELECT ur.id_rol, r.nombre FROM usuario_rol ur
         JOIN cat_rol r ON r.id_rol = ur.id_rol
         WHERE ur.id_usuario = ? ORDER BY ur.id_rol`,
        [user.id_usuario]
      );
      const role = roles.some((item) => Number(item.id_rol) === 2) ? "prestador" : "solicitante";
      request.session.user = { id: user.id_usuario, name: user.nombre_completo, role };
      return response.redirect(
        role === "prestador" ? "/prestador/servicios.html" : "/solicitante/solicitar-servicio.html"
      );
    } catch (error) {
      console.error("Error al iniciar sesión:", error);
      return response.status(500).send("No fue posible iniciar sesión.");
    }
  });

  // Informa al frontend si existe una sesión activa y su usuario básico.
  app.get("/api/session", (request, response) => {
    response.json({
      authenticated: Boolean(request.session.user),
      user: request.session.user || null
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
    request.session.destroy((error) => {
      if (error) {
        console.error("Error al cerrar sesión:", error);
        return response.status(500).send("No fue posible cerrar sesión.");
      }
      response.redirect("/Modulo1.html");
    });
  });
}

module.exports = { registerRoutes };
