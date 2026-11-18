// Componente del módulo prestador: búsqueda, detalle, aceptación y seguimiento
// de solicitudes disponibles y de servicios aceptados.
const requestList = document.getElementById("request-list");
const acceptedList = document.getElementById("accepted-list");
const finishedList = document.getElementById("finished-list");
const search = document.getElementById("search");
let requests = [];
let availabilityTimer;
// La interfaz usa el mismo plazo que valida el servidor para ocultar a tiempo
// los servicios que nunca fueron iniciados.
const START_GRACE_PERIOD_MS = 10 * 60 * 1000;

/**
 * Escapa valores recibidos de la API antes de construir tarjetas HTML.
 * Esto mantiene las especificaciones como texto y evita que una descripción
 * maliciosa se ejecute como HTML o JavaScript.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));
}

function renderMapAddress(label, address) {
  if (!address) return "";
  const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return `<a class="request-details__address" href="${mapUrl}" target="_blank" rel="noopener noreferrer">
    <strong>${label}</strong>
    <span>${escapeHtml(address)}</span>
    <span class="request-details__map-action">Abrir en Google Maps</span>
  </a>`;
}

/**
 * Filtra las solicitudes disponibles usando categoría, descripción y municipio.
 * El filtro solo afecta la presentación local; la autorización y la selección
 * de solicitudes siguen siendo responsabilidad del servidor.
 */
function renderRequests() {
  const query = search.value.trim().toLowerCase();
  const visible = requests.filter((item) =>
    [item.categoria, item.descripcion, item.municipio].some((value) =>
      String(value).toLowerCase().includes(query)
    )
  );
  requestList.innerHTML = visible.length
    ? visible.map((item) => `<article class="request-card" data-id="${item.id}">
        <span class="tag">${escapeHtml(item.categoria)}${item.subcategoria ? ` · ${escapeHtml(item.subcategoria)}` : ""}</span>
        <p class="request-meta">Precio: $${escapeHtml(item.monto)} MXN ${item.tipo_tarifa === "hora" ? "por hora" : "por servicio"}</p>
        <p class="request-meta">${escapeHtml(item.municipio)} · ${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)}</p>
        <div class="request-details" hidden></div>
        <button class="btn-secondary details-request" type="button" data-id="${item.id}">Detalles</button>
        <button class="btn-primary accept-request" type="button" data-id="${item.id}">Aceptar solicitud</button>
      </article>`).join("")
    : "<p>No hay solicitudes disponibles con ese criterio.</p>";
}

/**
 * Carga solicitudes disponibles y aceptadas en paralelo.
 * Si la sesión ya no es válida redirige al login; de lo contrario actualiza
 * ambas pestañas con los resultados de la API.
 */
async function loadRequests() {
  const [data, acceptedData, finishedData] = await Promise.all([
    requestJson("/api/solicitudes"),
    requestJson("/api/solicitudes/aceptadas"),
    requestJson("/api/solicitudes/aceptadas?estado=finalizadas")
  ]);
  requests = data.requests.map(localizeSchedule);
  renderRequests();
  renderAcceptedRequests(acceptedData.requests.map(localizeSchedule));
  renderFinishedRequests(finishedData.requests.map(localizeSchedule));
  requestJson("/api/prestador/reputacion")
    .then(renderReputation)
    .catch((error) => {
      document.getElementById("error-message").textContent =
        error.message || "No fue posible cargar la reputación.";
    });
  if (availabilityTimer) window.clearTimeout(availabilityTimer);
  const nextService = acceptedData.requests.map(localizeSchedule)
    .filter((item) => !item.iniciado)
    .map((item) => new Date(`${item.fecha}T${item.hora}`).getTime() + START_GRACE_PERIOD_MS)
    .filter((time) => time > Date.now())
    .sort((first, second) => first - second)[0];
  if (nextService) {
    availabilityTimer = window.setTimeout(
      () => loadRequests().catch((error) => {
        document.getElementById("error-message").textContent = error.message || "No fue posible actualizar los servicios.";
      }),
      Math.min(nextService - Date.now(), 2147483647)
    );
  }
}

/**
 * Renderiza una tarjeta de servicio con detalles bajo demanda y acciones de ciclo
 * de vida. El servidor vuelve a validar la fecha y los permisos.
 */
function renderAcceptedRequests(accepted) {
  document.getElementById("accepted-count").textContent = accepted.length;
  acceptedList.innerHTML = accepted.length
    ? accepted.map((item) => {
      const scheduledTime = new Date(`${item.fecha}T${item.hora}`);
      const now = new Date();
      const startDeadline = new Date(scheduledTime.getTime() + START_GRACE_PERIOD_MS);
      const canStart = scheduledTime <= now && now <= startDeadline;
      return `<article class="active-service-card service-card" data-service-id="${item.servicio_id}">
        <div><span class="tag">${escapeHtml(item.categoria)}${item.subcategoria ? ` · ${escapeHtml(item.subcategoria)}` : ""}</span><h3>${escapeHtml(item.descripcion)}</h3>
        <p>Precio: $${escapeHtml(item.monto)} MXN ${item.tipo_tarifa === "hora" ? "por hora" : "por servicio"}</p>
        <p>${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)} · ${escapeHtml(item.municipio)} · Solicitante: ${escapeHtml(item.solicitante)}</p></div>
        <p>Contacto: ${escapeHtml(item.contacto.nombre)} · ${escapeHtml(item.contacto.correo)} · ${escapeHtml(item.contacto.telefono)}</p>
        ${item.vehiculo ? `<p>Vehículo: ${escapeHtml(item.vehiculo.tipo)} · ${escapeHtml(item.vehiculo.color)} · Placas: ${escapeHtml(item.vehiculo.placas)} · ${escapeHtml(item.vehiculo.puertas)} puertas</p>` : ""}
        <div class="request-details accepted-details" hidden></div>
        <div class="card-actions">
          <span class="status-pill status-pill--progress">${item.iniciado ? "En curso" : "Por empezar"}</span>
          <button class="btn-secondary accepted-details-button" type="button" data-id="${item.id}">Detalles</button>
          <button class="btn-secondary start-service" type="button" data-id="${item.servicio_id}" ${item.iniciado || !canStart ? "disabled" : ""}>Iniciar</button>
          <button class="btn-primary finish-service" type="button" data-id="${item.servicio_id}" ${item.iniciado ? "" : "disabled"}>Finalizar</button>
        </div>
      </article>`;
    }).join("")
    : "<p>Aún no has aceptado solicitudes.</p>";
}

function renderFinishedRequests(finished) {
  document.getElementById("finished-count").textContent = finished.length;
  finishedList.innerHTML = finished.length
    ? finished.map((item) => `<article class="active-service-card service-card">
        <div><span class="tag">${escapeHtml(item.categoria)}${item.subcategoria ? ` · ${escapeHtml(item.subcategoria)}` : ""}</span><h3>${escapeHtml(item.descripcion)}</h3>
        <p>${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)} · ${escapeHtml(item.municipio)} · Solicitante: ${escapeHtml(item.solicitante)}</p>
        ${item.vehiculo ? `<p>Vehículo: ${escapeHtml(item.vehiculo.tipo)} · ${escapeHtml(item.vehiculo.color)} · Placas: ${escapeHtml(item.vehiculo.placas)} · ${escapeHtml(item.vehiculo.puertas)} puertas</p>` : ""}
        <div class="request-details accepted-details" hidden></div></div>
        <div class="card-actions">
          <span class="status-pill status-pill--success">Finalizada</span>
          <button class="btn-secondary accepted-details-button" type="button" data-id="${item.id}">Detalles</button>
          ${item.calificacion
            ? `<span class="received-rating">${"★".repeat(item.calificacion.estrellas)}${"☆".repeat(5 - item.calificacion.estrellas)} (${item.calificacion.estrellas}/5)</span>`
            : "<span class=\"field-hint\">Aún no hay calificación</span>"}
        </div>
      </article>`).join("")
    : "<p>Aún no tienes tareas finalizadas.</p>";
}

function renderReputation(data) {
  const summary = data.summary;
  const comments = data.comments;
  document.getElementById("reputation-content").innerHTML = `
    <h2 class="section-title">Mi reputación</h2>
    <p class="reputation-average">${escapeHtml(summary.promedio)} / 5 estrellas</p>
    <p class="field-hint">${escapeHtml(summary.total_evaluaciones)} calificaciones · ${escapeHtml(summary.servicios_terminados)} servicios terminados</p>
    <div class="reputation-comments">
      ${comments.length
        ? comments.map((comment) => `<article class="reputation-comment">
            <strong>${"★".repeat(comment.estrellas)}${"☆".repeat(5 - comment.estrellas)}</strong>
            <p>${escapeHtml(comment.comentario || "Sin comentario")}</p>
            <span class="field-hint">Por ${escapeHtml(comment.evaluador)}</span>
          </article>`).join("")
        : "<p>Aún no has recibido calificaciones.</p>"}
    </div>`;
}

async function loadRequestDetails(button) {
  const card = button.closest(".service-card");
  const details = card.querySelector(".accepted-details");
  if (!details.hidden) {
    details.hidden = true;
    button.textContent = "Detalles";
    return;
  }
  button.disabled = true;
  try {
    const item = await requestJson(`/api/solicitudes/${button.dataset.id}/detalles`);
    details.innerHTML = `
      <div class="request-details__summary">
        <p><strong>Solicitante:</strong> ${escapeHtml(item.solicitante)}</p>
        <p><strong>Necesita:</strong> ${escapeHtml(item.descripcion)}</p>
      </div>
      <div class="request-details__addresses">
        ${renderMapAddress("Domicilio del acompañamiento", item.domicilio)}
        ${renderMapAddress("Dirección de inicio", item.inicio)}
        ${renderMapAddress("Dirección final", item.destino)}
        ${renderMapAddress("Dirección del supermercado", item.supermercado)}
      </div>`;
    details.hidden = false;
    button.textContent = "Ocultar detalles";
  } catch (error) {
    document.getElementById("error-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function updateService(button, action) {
  button.disabled = true;
  try {
    await requestJson(`/api/servicios/${button.dataset.id}/${action}`, { method: "POST" });
    await loadRequests();
  } catch (error) {
    document.getElementById("error-message").textContent = error.message;
    button.disabled = false;
  }
}

/**
 * Procesa el botón "Aceptar solicitud".
 * Deshabilita temporalmente el botón para evitar dobles envíos, delega la
 * operación al servidor y vuelve a cargar ambas listas tras una aceptación exitosa.
 */
requestList.addEventListener("click", async (event) => {
  const detailsButton = event.target.closest(".details-request");
  if (detailsButton) {
    // Los detalles se solicitan bajo demanda para no cargar direcciones
    // privadas de todas las solicitudes desde el primer listado.
    const card = detailsButton.closest(".request-card");
    const details = card.querySelector(".request-details");
    if (!details.hidden) {
      details.hidden = true;
      detailsButton.textContent = "Detalles";
      return;
    }
    detailsButton.disabled = true;
    try {
      const item = await requestJson(`/api/solicitudes/${detailsButton.dataset.id}/detalles`);
      details.innerHTML = `
        <div class="request-details__summary">
          <p><strong>Solicitante:</strong> ${escapeHtml(item.solicitante)}</p>
          <p><strong>Necesita:</strong> ${escapeHtml(item.descripcion)}</p>
        </div>
        <div class="request-details__addresses">
          ${renderMapAddress("Domicilio del acompañamiento", item.domicilio)}
          ${renderMapAddress("Dirección de inicio", item.inicio)}
          ${renderMapAddress("Dirección final", item.destino)}
          ${renderMapAddress("Dirección del supermercado", item.supermercado)}
        </div>`;
      details.hidden = false;
      detailsButton.textContent = "Ocultar detalles";
    } catch (error) {
      document.getElementById("error-message").textContent = error.message;
    } finally {
      detailsButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest(".accept-request");
  if (!button) return;
  // El botón se bloquea mientras termina la transacción para evitar dos
  // aceptaciones simultáneas de la misma solicitud.
  button.disabled = true;
  try {
    await requestJson(`/api/solicitudes/${button.dataset.id}/aceptar`, { method: "POST" });
  } catch (error) {
    document.getElementById("error-message").textContent = error.message;
    button.disabled = false;
    return;
  }
  await loadRequests();
});

[acceptedList, finishedList].forEach((list) => {
  list.addEventListener("click", (event) => {
    const detailsButton = event.target.closest(".accepted-details-button");
    if (detailsButton) {
      loadRequestDetails(detailsButton);
      return;
    }
    const startButton = event.target.closest(".start-service");
    if (startButton) {
      updateService(startButton, "iniciar");
      return;
    }
    const finishButton = event.target.closest(".finish-service");
    if (finishButton) updateService(finishButton, "finalizar");
  });
});

// Vuelve a renderizar cuando cambia el criterio de búsqueda.
search.addEventListener("input", renderRequests);
/**
 * Inicializa el módulo del prestador y muestra un mensaje si la API no responde.
 */
loadRequests().catch((error) => {
  if (error.status === 401) {
    window.location.href = "/auth/iniciar-sesion.html";
    return;
  }
  document.getElementById("error-message").textContent = "No fue posible cargar las solicitudes.";
});

/**
 * Cambia entre solicitudes disponibles y solicitudes aceptadas.
 * Mantiene un solo panel visible y conserva los contadores de cada sección.
 */
document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab-button").forEach((item) => item.classList.remove("is-active"));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.remove("is-active"));
    button.classList.add("is-active");
    document.getElementById(button.dataset.tab).classList.add("is-active");
  });
});
