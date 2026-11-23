// Rutas del ciclo de vida de solicitudes: crear, consultar, editar, aceptar y borrar.
const bcrypt = require("bcrypt");
const { requireSession, requireRole } = require("./middleware");
const { sendMail } = require("./email");
const { decryptSensitiveValue, encryptSensitiveValue } = require("./config");
const { closeExpiredRequests, expirePostulations } = require("./services-lifecycle");

// Comprueba formato válido y que la fecha/hora todavía no hayan pasado.
function isFutureSchedule(date, time) {
  const value = new Date(`${date}T${time}:00Z`);
  return (
    !Number.isNaN(value.getTime()) &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(date)) &&
    /^\d{2}:\d{2}$/.test(String(time)) &&
    value > new Date()
  );
}

function readAddress(source, prefix = "") {
  // El mismo lector sirve para el domicilio principal y para los bloques
  // prefijados (origen_, destino_ y supermercado_), evitando validaciones
  // distintas para cada dirección.
  const field = (name) => String(source[prefix ? `${prefix}_${name}` : name] || "").trim();
  return {
    state: field("estado"),
    municipality: field("municipio"),
    colony: field("colonia"),
    street: field("calle"),
    exteriorNumber: field("numero_exterior"),
    interiorNumber: field("numero_interior"),
    postalCode: field("codigo_postal")
  };
}

// Comprueba el formato de un domicilio completo. El número interior es el
// único dato opcional; todos los demás campos identifican el lugar.
function isValidAddress(address, locationTextPattern, numberPattern) {
  return (
    address.state.length > 0 && address.state.length <= 60 && locationTextPattern.test(address.state) &&
    address.municipality.length > 0 && address.municipality.length <= 80 && locationTextPattern.test(address.municipality) &&
    address.colony.length > 0 && address.colony.length <= 100 && locationTextPattern.test(address.colony) &&
    address.street.length > 0 && address.street.length <= 120 && locationTextPattern.test(address.street) &&
    address.exteriorNumber.length > 0 && address.exteriorNumber.length <= 10 && numberPattern.test(address.exteriorNumber) &&
    (!address.interiorNumber || (address.interiorNumber.length <= 10 && numberPattern.test(address.interiorNumber))) &&
    /^\d{5}$/.test(address.postalCode)
  );
}

// Indica si el bloque de domicilio contiene al menos un dato.
// Sirve para rechazar direcciones enviadas para un tipo de servicio que no las necesita,
// aunque alguien las agregue manualmente a la petición sin usar el formulario.
function hasAddressData(address) {
  return Object.values(address).some(Boolean);
}

// Convierte los campos estructurados en una sola cadena para almacenarlos.
// Las columnas existentes de peticion almacenan cada dirección como un bloque.
function formatAddress(address) {
  return `${address.street} ${address.exteriorNumber}${address.interiorNumber ? ` interior ${address.interiorNumber}` : ""}, ${address.colony}, ${address.municipality}, ${address.state}, C.P. ${address.postalCode}`;
}

function readStoredText(value) {
  if (!value) return "";
  if (!Buffer.isBuffer(value)) return String(value);
  // MySQL devuelve VARBINARY como Buffer; primero se intenta el formato
  // cifrado heredado y, si no coincide, se interpreta como texto plano.
  try {
    return decryptSensitiveValue(value);
  } catch (error) {
    return value.toString("utf8");
  }
}

// Cifra un texto de domicilio antes de guardarlo. Los campos vacíos quedan en NULL.
function protectText(value) {
  return value ? encryptSensitiveValue(String(value)) : null;
}

function normalizeCategoryName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const START_GRACE_PERIOD_MINUTES = 10;

// Cancela (no borra) servicios aceptados que nunca comenzaron después de la ventana
// de gracia. Se conserva el registro para la auditoría y las relaciones de la BD.
async function removeExpiredUnstartedServices(pool) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [expiredServices] = await connection.execute(
      `SELECT s.id_peticion, s.id_postulacion
       FROM servicio s
       JOIN peticion p ON p.id_peticion = s.id_peticion
       WHERE p.id_estado_peticion = 2
         AND COALESCE(s.confirmado_prestador, FALSE) = FALSE
         AND (p.fecha_programada + p.hora_programada)
             <= ((NOW() AT TIME ZONE 'UTC') - INTERVAL '10 minutes')
       FOR UPDATE`
    );
    for (const service of expiredServices) {
      await connection.execute(
        "UPDATE peticion SET id_estado_peticion = 4, fecha_cancelacion = (NOW() AT TIME ZONE 'UTC') WHERE id_peticion = ?",
        [service.id_peticion]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

// Registra los endpoints de solicitudes y los conecta con MySQL.
function registerRequestRoutes(app, pool) {
  // Devuelve únicamente categorías activas para el formulario.
  app.get("/api/catalogos", requireSession, async (request, response) => {
    try {
      const [categories] = await pool.execute(
        "SELECT id_categoria AS id, nombre FROM cat_categoria WHERE activa = TRUE ORDER BY nombre"
      );
      return response.json({ categories });
    } catch (error) {
      console.error("Error al consultar catálogos:", error);
      return response.status(500).json({ message: "No fue posible cargar los catálogos." });
    }
  });

  // El solicitante califica una sola vez al prestador de un servicio terminado.
  app.post("/api/servicios/:id/calificacion", requireSession, requireRole("solicitante"), async (request, response) => {
    const serviceId = Number(request.params.id);
    const stars = Number(request.body.estrellas);
    const comment = String(request.body.comentario || "").trim();
    if (
      !Number.isInteger(serviceId) ||
      serviceId <= 0 ||
      !Number.isInteger(stars) ||
      stars < 1 ||
      stars > 5 ||
      comment.length > 300
    ) {
      return response.status(400).json({ message: "La calificación no es válida." });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [services] = await connection.execute(
        `SELECT s.id_servicio, pp.id_usuario AS prestador
         FROM servicio s
         JOIN peticion p ON p.id_peticion = s.id_peticion
         JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE s.id_servicio = ? AND p.id_buscador = ? AND p.id_estado_peticion = 3
         LIMIT 1
         FOR UPDATE`,
        [serviceId, request.session.user.id]
      );
      if (services.length === 0) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró un servicio terminado para calificar." });
      }
      const service = services[0];
      await connection.execute(
        `INSERT INTO calificacion
          (id_servicio, id_evaluador, id_evaluado, estrellas, comentario)
         VALUES (?, ?, ?, ?, ?)`,
        [service.id_servicio, request.session.user.id, service.prestador, stars, comment || null]
      );
      await connection.execute(
        `INSERT INTO reputacion (id_usuario, total_estrellas, total_evaluaciones)
         VALUES (?, ?, 1)
         ON CONFLICT (id_usuario) DO UPDATE SET
           total_estrellas = reputacion.total_estrellas + EXCLUDED.total_estrellas,
           total_evaluaciones = reputacion.total_evaluaciones + 1`,
        [service.prestador, stars]
      );
      await connection.commit();
      return response.json({ message: "Calificación guardada." });
    } catch (error) {
      await connection.rollback();
      if (error.code === "23505") {
        return response.status(409).json({ message: "Este servicio ya fue calificado." });
      }
      console.error("Error al guardar calificación:", error);
      return response.status(500).json({ message: "No fue posible guardar la calificación." });
    } finally {
      connection.release();
    }
  });

  // Devuelve el promedio y los comentarios visibles recibidos por el prestador.
  app.get("/api/prestador/reputacion", requireSession, requireRole("prestador"), async (request, response) => {
    try {
      const [summaryRows] = await pool.execute(
        `SELECT COALESCE(r.servicios_terminados, 0) AS servicios_terminados,
                COALESCE(r.total_evaluaciones, 0) AS total_evaluaciones,
                COALESCE(r.promedio, 0) AS promedio
         FROM usuario u
         LEFT JOIN reputacion r ON r.id_usuario = u.id_usuario
         WHERE u.id_usuario = ?`,
        [request.session.user.id]
      );
      const [comments] = await pool.execute(
        `SELECT c.estrellas, c.comentario, c.fecha_calificacion,
                u.nombre_completo AS evaluador
         FROM calificacion c
         JOIN usuario u ON u.id_usuario = c.id_evaluador
         WHERE c.id_evaluado = ? AND c.visible = TRUE
         ORDER BY c.fecha_calificacion DESC`,
        [request.session.user.id]
      );
      return response.json({
        summary: summaryRows[0] || { servicios_terminados: 0, total_evaluaciones: 0, promedio: 0 },
        comments
      });
    } catch (error) {
      console.error("Error al consultar reputación:", error);
      return response.status(500).json({ message: "No fue posible consultar la reputación." });
    }
  });

  // Valida y crea una solicitud junto con su zona dentro de una transacción.
  app.post("/api/solicitudes", requireSession, requireRole("solicitante"), async (request, response) => {
    const {
      id_categoria: categoryId, descripcion,
      monto, tipo_tarifa: rateType, subcategoria,
      fecha_programada: scheduledDate, hora_programada: scheduledTime,
      ...fields
    } = request.body;
    const numericCategoryId = Number(categoryId);
    const numericAmount = Number(monto);
    const normalizedRateType = String(rateType || "");
    const normalizedSubcategory = String(subcategoria || "").trim();
    const normalizedDescription = String(descripcion || "").trim();
    const serviceAddress = readAddress(fields);
    const originAddress = readAddress(fields, "origen");
    const destinationAddress = readAddress(fields, "destino");
    const shoppingAddress = readAddress(fields, "supermercado");
    const locationTextPattern = /^[\p{L}\d][\p{L}\d\s.'-]*$/u;
    const numberPattern = /^[\p{L}\d-]+$/u;

    // La validación del navegador mejora la experiencia, pero no es una
    // medida de seguridad: cualquier cliente puede enviar una petición HTTP
    // manual. Por eso el servidor repite las reglas antes de tocar la BD.
    if (
      !Number.isInteger(numericCategoryId) ||
      normalizedDescription.length < 10 || normalizedDescription.length > 500 ||
      !Number.isFinite(numericAmount) || numericAmount < 50 || numericAmount > 5000 ||
      !["servicio", "hora"].includes(normalizedRateType) ||
      !isFutureSchedule(scheduledDate, scheduledTime)
    ) {
      return response.status(400).json({
        message: "Completa correctamente el domicilio, el tipo de tarifa, el monto y la fecha futura."
      });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [categories] = await connection.execute(
        "SELECT id_categoria, nombre FROM cat_categoria WHERE id_categoria = ? AND activa = TRUE",
        [numericCategoryId]
      );
      if (categories.length === 0) {
        await connection.rollback();
        return response.status(400).json({ message: "La categoría seleccionada no es válida." });
      }
      const categoryName = categories[0].nombre;
      const normalizedCategoryName = normalizeCategoryName(categoryName);
      const validSubcategories = {
        Acompañamiento: ["Acompañamiento doméstico", "Acompañamiento a exteriores"],
        Transporte: ["Traslado de un punto A a un punto B", "Acompañamiento a compras"]
      };
      const categoryKey = normalizedCategoryName === "acompanamiento"
        ? "Acompañamiento"
        : normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado")
          ? "Transporte"
          : normalizedCategoryName === "mandados" ? "Mandados" : "";
      const validSubcategory = validSubcategories[categoryKey]
        ? validSubcategories[categoryKey].includes(normalizedSubcategory)
        : !normalizedSubcategory;
      if (!validSubcategory) {
        await connection.rollback();
        return response.status(400).json({ message: "Selecciona una subcategoría válida para acompañamiento." });
      }
      const needsRoute = categoryKey === "Mandados" ||
        (categoryKey === "Transporte" && normalizedSubcategory === "Traslado de un punto A a un punto B");
      const needsShoppingAddress = categoryKey === "Transporte" &&
        normalizedSubcategory === "Acompañamiento a compras";
      const primaryAddress = needsRoute || needsShoppingAddress ? originAddress : serviceAddress;
      // La zona de búsqueda de prestadores se basa en el origen del traslado.
      // En acompañamiento se basa en el domicilio donde ocurrirá el servicio.
      const hasRequiredAddresses =
        isValidAddress(primaryAddress, locationTextPattern, numberPattern) &&
        (!needsRoute || isValidAddress(destinationAddress, locationTextPattern, numberPattern)) &&
        (!needsShoppingAddress || isValidAddress(shoppingAddress, locationTextPattern, numberPattern));
      // Se valida la combinación completa y no solo cada campo por separado.
      // Así se impide guardar un origen en un acompañamiento o una dirección
      // de supermercado en un servicio que no es de compras.
      if (
        !hasRequiredAddresses ||
        (!needsRoute && !needsShoppingAddress && hasAddressData(originAddress)) ||
        (!needsRoute && hasAddressData(destinationAddress)) ||
        (!needsShoppingAddress && hasAddressData(shoppingAddress))
      ) {
        await connection.rollback();
        return response.status(400).json({ message: "Completa las direcciones correspondientes al tipo de servicio." });
      }
      await connection.execute(
        "INSERT INTO cat_zona (estado, municipio) VALUES (?, ?) ON CONFLICT (estado, municipio) DO NOTHING",
        [primaryAddress.state, primaryAddress.municipality]
      );
      const [zones] = await connection.execute(
        "SELECT id_zona FROM cat_zona WHERE estado = ? AND municipio = ?",
        [primaryAddress.state, primaryAddress.municipality]
      );
      const [result] = await connection.execute(
        `INSERT INTO peticion
          (id_buscador, id_categoria, subcategoria, descripcion, id_zona, colonia,
           calle_cifrada, numero_exterior_cifrado, numero_interior_cifrado,
           codigo_postal, direccion_cifrada, direccion_origen_cifrada,
           direccion_destino_cifrada, direccion_supermercado_cifrada,
           monto, tipo_tarifa, fecha_programada, hora_programada)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.session.user.id, numericCategoryId, normalizedSubcategory, normalizedDescription,
          zones[0].id_zona, primaryAddress.colony,
          protectText(primaryAddress.street),
          protectText(primaryAddress.exteriorNumber),
          protectText(primaryAddress.interiorNumber),
          primaryAddress.postalCode,
          protectText(formatAddress(primaryAddress)),
          needsRoute ? protectText(formatAddress(originAddress)) : null,
          needsRoute ? protectText(formatAddress(destinationAddress)) : null,
          needsShoppingAddress ? protectText(formatAddress(shoppingAddress)) : null,
          numericAmount, normalizedRateType, scheduledDate, scheduledTime
        ]
      );
      await connection.commit();
      return response.status(201).json({ id: result.insertId });
    } catch (error) {
      await connection.rollback();
      console.error("Error al publicar solicitud:", error);
      return response.status(500).json({ message: "No fue posible publicar la solicitud." });
    } finally {
      connection.release();
    }
  });

  // Lista solicitudes pendientes y vigentes según el rol de la sesión.
  app.get("/api/solicitudes", requireSession, async (request, response) => {
    try {
      await expirePostulations(pool);
      // La primera posición es el id del prestador (postulación propia); el solicitante no la usa.
      const params = [request.session.user.id];
      let where = "p.id_estado_peticion = 1";
      if (request.session.user.role === "solicitante") {
        where += " AND p.id_buscador = ?";
        params.push(request.session.user.id);
      }
      const [requests] = await pool.execute(
        `SELECT p.id_peticion AS id, p.descripcion, p.colonia, p.monto,
                p.tipo_tarifa, p.subcategoria,
                (SELECT po.id_postulacion FROM postulacion po
                 JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
                 WHERE po.id_peticion = p.id_peticion AND pp.id_usuario = ? AND po.id_estado_postulacion = 1
                 LIMIT 1) AS mi_postulacion,
                TO_CHAR(p.fecha_programada, 'YYYY-MM-DD') AS fecha,
                LEFT(p.hora_programada::text, 5) AS hora,
                c.nombre AS categoria, z.estado AS estado_zona, z.municipio,
                u.nombre_completo AS solicitante, e.nombre AS estado
         FROM peticion p
         JOIN cat_categoria c ON c.id_categoria = p.id_categoria
         JOIN cat_zona z ON z.id_zona = p.id_zona
         JOIN usuario u ON u.id_usuario = p.id_buscador
         JOIN cat_estado_peticion e ON e.id_estado_peticion = p.id_estado_peticion
         WHERE ${where} AND (p.fecha_programada + p.hora_programada) > (NOW() AT TIME ZONE 'UTC')
         ORDER BY p.fecha_creacion DESC`,
        params
      );
      return response.json({ requests });
    } catch (error) {
      console.error("Error al consultar solicitudes:", error);
      return response.status(500).json({ message: "No fue posible consultar las solicitudes." });
    }
  });

  // Los detalles se reservan al prestador y leen las direcciones solo
  // después de comprobar que la solicitud está disponible o fue aceptada por él.
  app.get("/api/solicitudes/:id/detalles", requireSession, requireRole("prestador"), async (request, response) => {
    const requestId = Number(request.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return response.status(400).json({ message: "La solicitud no es válida." });
    }
    try {
      const [rows] = await pool.execute(
        `SELECT p.id_peticion AS id, p.descripcion, p.direccion_cifrada,
                p.calle_cifrada, p.numero_exterior_cifrado, p.numero_interior_cifrado,
                p.codigo_postal, p.colonia, p.direccion_origen_cifrada,
                p.direccion_destino_cifrada, p.direccion_supermercado_cifrada,
                z.estado, z.municipio,
                u.nombre_completo AS solicitante
         FROM peticion p
         JOIN cat_zona z ON z.id_zona = p.id_zona
         JOIN usuario u ON u.id_usuario = p.id_buscador
         LEFT JOIN servicio s ON s.id_peticion = p.id_peticion
         LEFT JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         LEFT JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         WHERE p.id_peticion = ?
           AND (p.id_estado_peticion = 1 OR pp.id_usuario = ?)
         LIMIT 1`,
        [requestId, request.session.user.id]
      );
      if (rows.length === 0) {
        return response.status(404).json({ message: "No se encontraron detalles para esta solicitud." });
      }
      const item = rows[0];
      // Las solicitudes antiguas pueden no tener las nuevas columnas. El
      // domicilio principal conserva un respaldo para que sigan funcionando.
      const street = readStoredText(item.calle_cifrada || item.direccion_cifrada);
      const exteriorNumber = readStoredText(item.numero_exterior_cifrado);
      const interiorNumber = item.numero_interior_cifrado
        ? ` interior ${readStoredText(item.numero_interior_cifrado)}`
        : "";
      const mainAddress = `${street}${exteriorNumber ? ` ${exteriorNumber}` : ""}${interiorNumber}, ${item.colonia}, ${item.municipio}, ${item.estado}, C.P. ${item.codigo_postal || ""}`;
      const route = item.direccion_origen_cifrada
        // Estas columnas solo existen para Mandados y Traslado, por eso se
        // agregan al texto de detalles únicamente cuando fueron guardadas.
        ? `Inicio: ${readStoredText(item.direccion_origen_cifrada)}. Destino: ${readStoredText(item.direccion_destino_cifrada)}`
        : "";
      const shoppingAddress = item.direccion_supermercado_cifrada
        ? `Supermercado: ${readStoredText(item.direccion_supermercado_cifrada)}`
        : "";
      return response.json({
        id: item.id,
        solicitante: item.solicitante,
        descripcion: item.descripcion,
        domicilio: route || shoppingAddress ? "" : mainAddress,
        inicio: item.direccion_origen_cifrada
          ? readStoredText(item.direccion_origen_cifrada)
          : "",
        destino: item.direccion_destino_cifrada
          ? readStoredText(item.direccion_destino_cifrada)
          : "",
        supermercado: item.direccion_supermercado_cifrada
          ? readStoredText(item.direccion_supermercado_cifrada)
          : ""
      });
    } catch (error) {
      console.error("Error al consultar detalles de solicitud:", error);
      return response.status(500).json({ message: "No fue posible consultar los detalles." });
    }
  });

  // Lista servicios aceptados del solicitante o del prestador actual. El filtro
  // cambia según el rol para que cada persona vea únicamente sus relaciones.
  app.get("/api/solicitudes/aceptadas", requireSession, async (request, response) => {
    try {
      await removeExpiredUnstartedServices(pool);
      await closeExpiredRequests(pool);
      const statusId = request.query.estado === "finalizadas" ? 3 : 2;
      const params = [statusId, request.session.user.id];
      const roleFilter = request.session.user.role === "prestador"
        ? "pp.id_usuario = ?" : "p.id_buscador = ?";
      const [rows] = await pool.execute(
        `SELECT p.id_peticion AS id, s.id_servicio, p.descripcion, p.colonia, p.monto,
                p.tipo_tarifa, p.subcategoria,
                TO_CHAR(p.fecha_programada, 'YYYY-MM-DD') AS fecha,
                LEFT(p.hora_programada::text, 5) AS hora,
                c.nombre AS categoria, z.estado AS estado_zona, z.municipio,
                u.nombre_completo AS solicitante, u.correo AS solicitante_correo,
                u.telefono_cifrado AS solicitante_telefono,
                e.nombre AS estado,
                prestador.nombre_completo AS prestador, prestador.correo AS prestador_correo,
                prestador.telefono_cifrado AS prestador_telefono,
                s.confirmado_prestador, s.fecha_terminado,
                cal.estrellas AS calificacion_estrellas,
                cal.comentario AS calificacion_comentario,
                pp.cuenta_con_coche, pp.tipo_vehiculo, pp.color_vehiculo,
                pp.placas_vehiculo_cifrada, pp.puertas_vehiculo
         FROM peticion p
         JOIN cat_categoria c ON c.id_categoria = p.id_categoria
         JOIN cat_zona z ON z.id_zona = p.id_zona
         JOIN usuario u ON u.id_usuario = p.id_buscador
         JOIN cat_estado_peticion e ON e.id_estado_peticion = p.id_estado_peticion
         JOIN servicio s ON s.id_peticion = p.id_peticion
         JOIN postulacion po ON po.id_postulacion = s.id_postulacion
         JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
         JOIN usuario prestador ON prestador.id_usuario = pp.id_usuario
         LEFT JOIN calificacion cal
           ON cal.id_servicio = s.id_servicio
          AND cal.id_evaluador = p.id_buscador
          AND cal.id_evaluado = prestador.id_usuario
         WHERE p.id_estado_peticion = ?
           AND ${roleFilter}
         ORDER BY p.fecha_programada ASC, p.hora_programada ASC`,
        params
      );
      const isProvider = request.session.user.role === "prestador";
      const requests = rows.map((item) => {
        const {
          solicitante_telefono: requesterPhone,
          prestador_telefono: providerPhone,
          placas_vehiculo_cifrada: vehiclePlates,
          cuenta_con_coche: hasVehicle,
          tipo_vehiculo: vehicleType,
          color_vehiculo: vehicleColor,
          puertas_vehiculo: vehicleDoors,
          ...publicItem
        } = item;
        return {
          ...publicItem,
          servicio_id: item.id_servicio,
          iniciado: Boolean(item.confirmado_prestador),
          finalizado: Boolean(item.fecha_terminado),
          contacto: {
            nombre: isProvider ? item.solicitante : item.prestador,
            correo: isProvider ? item.solicitante_correo : item.prestador_correo,
            telefono: readStoredText(isProvider ? requesterPhone : providerPhone)
          },
          calificacion: item.calificacion_estrellas
            ? {
                estrellas: item.calificacion_estrellas,
                comentario: item.calificacion_comentario || ""
              }
            : null,
          vehiculo: (normalizeCategoryName(item.categoria) === "transporte"
            || normalizeCategoryName(item.categoria).includes("traslado")
            || normalizeCategoryName(item.subcategoria).includes("traslado")
            || normalizeCategoryName(item.subcategoria) === "acompanamiento a compras") && hasVehicle
            ? {
                tipo: vehicleType,
                color: vehicleColor,
                placas: readStoredText(vehiclePlates),
                puertas: vehicleDoors
              }
            : null
        };
      });
      return response.json({ requests });
    } catch (error) {
      console.error("Error al consultar solicitudes aceptadas:", error);
      return response.status(500).json({ message: "No fue posible consultar las solicitudes aceptadas." });
    }
  });

  // Devuelve un servicio del prestador actual y bloquea sus cambios de estado.
  async function getProviderService(connection, serviceId, userId) {
    const [rows] = await connection.execute(
      `SELECT s.id_servicio, s.id_postulacion, s.confirmado_prestador, p.id_peticion,
              p.id_estado_peticion,
              TO_CHAR(p.fecha_programada, 'YYYY-MM-DD') AS fecha_programada,
              LEFT(p.hora_programada::text, 5) AS hora_programada
       FROM servicio s
       JOIN peticion p ON p.id_peticion = s.id_peticion
       JOIN postulacion po ON po.id_postulacion = s.id_postulacion
       JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
       WHERE s.id_servicio = ? AND pp.id_usuario = ?
       FOR UPDATE`,
      [serviceId, userId]
    );
    return rows[0];
  }

  // El prestador puede iniciar el servicio únicamente cuando llega la fecha y hora.
  app.post("/api/servicios/:id/iniciar", requireSession, requireRole("prestador"), async (request, response) => {
    const serviceId = Number(request.params.id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      return response.status(400).json({ message: "El servicio no es válido." });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const service = await getProviderService(connection, serviceId, request.session.user.id);
      if (!service) {
        await connection.rollback();
        return response.status(404).json({ message: "No se encontró el servicio." });
      }
      if (service.id_estado_peticion !== 2) {
        await connection.rollback();
        return response.status(409).json({ message: "El servicio no está disponible para iniciar." });
      }
      if (new Date(`${service.fecha_programada}T${service.hora_programada}Z`) > new Date()) {
        await connection.rollback();
        return response.status(409).json({ message: "Aún no llega la fecha y hora del servicio." });
      }
      const startDeadline = new Date(`${service.fecha_programada}T${service.hora_programada}Z`);
      // El inicio solo se permite desde la hora programada hasta diez minutos
      // después; la limpieza periódica elimina los servicios que exceden ese plazo.
      startDeadline.setMinutes(startDeadline.getMinutes() + START_GRACE_PERIOD_MINUTES);
      if (new Date() > startDeadline) {
        await connection.rollback();
        return response.status(409).json({ message: "El tiempo para iniciar el servicio ya terminó." });
      }
      await connection.execute(
        "UPDATE servicio SET confirmado_prestador = TRUE WHERE id_servicio = ?",
        [serviceId]
      );
      await connection.commit();
      return response.json({ message: "Servicio iniciado." });
    } catch (error) {
      await connection.rollback();
      console.error("Error al iniciar servicio:", error);
      return response.status(500).json({ message: "No fue posible iniciar el servicio." });
    } finally {
      connection.release();
    }
  });

  // Cambia solo fecha y hora de una solicitud pendiente propiedad del solicitante.
  // La condición id_estado_peticion = 1 impide editar una solicitud aceptada.
  app.patch("/api/solicitudes/:id/horario", requireSession, requireRole("solicitante"), async (request, response) => {
    const requestId = Number(request.params.id);
    const scheduledDate = String(request.body.fecha_programada || "");
    const scheduledTime = String(request.body.hora_programada || "");
    if (!Number.isInteger(requestId) || requestId <= 0 || !isFutureSchedule(scheduledDate, scheduledTime)) {
      return response.status(400).json({ message: "La fecha y hora deben ser futuras y válidas." });
    }
    try {
      const [result] = await pool.execute(
        `UPDATE peticion SET fecha_programada = ?, hora_programada = ?
         WHERE id_peticion = ? AND id_buscador = ? AND id_estado_peticion = 1`,
        [scheduledDate, scheduledTime, requestId, request.session.user.id]
      );
      if (result.affectedRows === 0) {
        return response.status(409).json({ message: "Solo puedes editar solicitudes propias que sigan pendientes." });
      }
      return response.json({ message: "Fecha y hora actualizadas." });
    } catch (error) {
      console.error("Error al actualizar horario de solicitud:", error);
      return response.status(500).json({ message: "No fue posible actualizar la fecha y hora." });
    }
  });

  // El solicitante puede borrar solicitudes propias pendientes o aceptadas.
  // En las aceptadas se eliminan primero las relaciones dependientes para
  // respetar las claves foráneas y hacer que desaparezcan para ambos roles.
  app.delete("/api/solicitudes/:id", requireSession, requireRole("solicitante"), async (request, response) => {
    const requestId = Number(request.params.id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return response.status(400).json({ message: "La solicitud no es válida." });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [petitions] = await connection.execute(
        `SELECT id_estado_peticion,
                ((fecha_programada + hora_programada) < ((NOW() AT TIME ZONE 'UTC') + INTERVAL '2 hours')) AS dentro_de_dos_horas
         FROM peticion
         WHERE id_peticion = ? AND id_buscador = ? AND id_estado_peticion IN (1, 2)
         FOR UPDATE`,
        [requestId, request.session.user.id]
      );
      if (petitions.length === 0) {
        await connection.rollback();
        return response.status(409).json({ message: "Solo puedes borrar solicitudes propias pendientes o aceptadas." });
      }
      // Cancelar exige la contraseña. Un servicio aceptado se cancela solo con más de 2 horas
      // de anticipación y con una explicación; si falta menos, debe levantarse una incidencia.
      const body = request.body || {};
      const password = body.password;
      if (typeof password !== "string" || password.length < 8 || password.length > 128) {
        await connection.rollback();
        return response.status(400).json({ message: "Escribe tu contraseña para cancelar." });
      }
      const [accounts] = await connection.execute(
        "SELECT password_hash FROM usuario WHERE id_usuario = ?",
        [request.session.user.id]
      );
      if (!accounts[0] || !(await bcrypt.compare(password, accounts[0].password_hash))) {
        await connection.rollback();
        return response.status(403).json({ message: "Contraseña incorrecta. Cancelación no procesada." });
      }
      const wasAccepted = Number(petitions[0].id_estado_peticion) === 2;
      if (wasAccepted && petitions[0].dentro_de_dos_horas) {
        await connection.rollback();
        return response.status(409).json({
          message: "No se puede cancelar un servicio programado dentro de las próximas 2 horas. Debe levantar una incidencia."
        });
      }
      const explanation = String(body.comentario || "").trim();
      if (wasAccepted && (explanation.length < 10 || explanation.length > 250)) {
        await connection.rollback();
        return response.status(400).json({ message: "Explica el motivo de la cancelación (10 a 250 caracteres)." });
      }
      let providerEmail = null;
      if (wasAccepted) {
        const [providers] = await connection.execute(
          `SELECT u.correo FROM servicio s
           JOIN postulacion po ON po.id_postulacion = s.id_postulacion
           JOIN perfil_prestador pp ON pp.id_perfil = po.id_perfil
           JOIN usuario u ON u.id_usuario = pp.id_usuario
           WHERE s.id_peticion = ?`,
          [requestId]
        );
        providerEmail = providers[0] ? providers[0].correo : null;
      }
      // Se conserva el registro: la solicitud pasa a Cancelado y el motivo queda guardado.
      const reasonId = Number(request.body.id_motivo || 1);
      const comment = String(request.body.comentario || "").trim().slice(0, 300);
      const [reasons] = await connection.execute(
        "SELECT id_motivo FROM cat_motivo_cancelacion WHERE id_motivo = ?",
        [reasonId]
      );
      if (reasons.length === 0) {
        await connection.rollback();
        return response.status(400).json({ message: "Selecciona un motivo de cancelación válido." });
      }
      await connection.execute(
        "UPDATE peticion SET id_estado_peticion = 4, fecha_cancelacion = (NOW() AT TIME ZONE 'UTC') WHERE id_peticion = ?",
        [requestId]
      );
      await connection.execute(
        "UPDATE postulacion SET id_estado_postulacion = 5, fecha_decision = (NOW() AT TIME ZONE 'UTC') WHERE id_peticion = ? AND id_estado_postulacion = 1",
        [requestId]
      );
      await connection.execute(
        "INSERT INTO cancelacion (id_peticion, id_usuario, id_motivo, comentario) VALUES (?, ?, ?, ?)",
        [requestId, request.session.user.id, reasonId, comment || null]
      );
      await connection.commit();
      if (providerEmail) {
        sendMail({
          to: providerEmail,
          subject: "Una solicitud aceptada fue cancelada",
          text: `El solicitante canceló una solicitud que tenías aceptada. Motivo: ${explanation}`
        });
      }
      return response.status(204).send();
    } catch (error) {
      await connection.rollback();
      console.error("Error al borrar solicitud:", error);
      return response.status(500).json({ message: "No fue posible borrar la solicitud." });
    } finally {
      connection.release();
    }
  });
}

module.exports = { registerRequestRoutes };
