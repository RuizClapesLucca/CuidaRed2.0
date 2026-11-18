// Componente de confirmación: consulta el rol recién registrado y personaliza el mensaje.
// La confirmación usa una sesión temporal del servidor para saber qué rol se
// acaba de registrar sin exponer datos personales en la URL.
fetch("/api/registro-confirmacion")
  .then((response) => {
    // Convierte una respuesta HTTP no exitosa en un error manejable.
    if (!response.ok) {
      throw new Error("No hay confirmación disponible");
    }
    return response.json();
  })
  .then(({ role }) => {
    // Explica al usuario cuál será su siguiente paso según su rol.
    document.getElementById("confirmation-message").textContent =
      role === "prestador"
        ? "Tu cuenta como prestador fue creada. Inicia sesión para ver solicitudes de servicio."
        : "Tu cuenta como solicitante fue creada. Inicia sesión para publicar una solicitud de servicio.";
  })
  .catch(() => {
    // Conserva un mensaje útil si la confirmación no está disponible.
    document.getElementById("confirmation-message").textContent =
      "Tu cuenta fue creada correctamente. Inicia sesión para continuar.";
  });
