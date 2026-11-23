// Componente del módulo solicitante: creación, solicitudes activas, aceptadas,
// edición de horario y eliminación de solicitudes.
const form = document.getElementById("request-form");
const categorySelect = document.getElementById("id_categoria");
const requestList = document.getElementById("request-list");
const acceptedList = document.getElementById("accepted-list");
const finishedList = document.getElementById("finished-list");
const errorMessage = document.getElementById("error-message");
const successMessage = document.getElementById("success-message");
const dateInput = document.getElementById("fecha_programada");
const timeInput = document.getElementById("hora_programada");
const subcategoryField = document.getElementById("subcategory-field");
const subcategoryLabel = document.getElementById("subcategory-label");
const subcategorySelect = document.getElementById("subcategoria");
const categoryHelp = document.getElementById("category-help");
const serviceAddressField = document.getElementById("service-address-field");
const serviceAddressLabel = document.getElementById("service-address-label");
const routeFields = document.getElementById("route-fields");
const routeTitle = document.getElementById("route-title");
const originAddressFields = document.getElementById("origin-address-fields");
const destinationAddressFields = document.getElementById("destination-address-fields");
const shoppingAddressFields = document.getElementById("shopping-address-fields");
const categoryById = new Map();

const today = new Date();
dateInput.min = [
  today.getFullYear(),
  String(today.getMonth() + 1).padStart(2, "0"),
  String(today.getDate()).padStart(2, "0")
].join("-");

/**
 * Comprueba que la combinación de fecha y hora represente un momento futuro.
 * La validación evita publicar solicitudes que ya no pueden ser atendidas.
 */
function isFutureSchedule() {
  const scheduled = new Date(`${dateInput.value}T${timeInput.value}`);
  return !Number.isNaN(scheduled.getTime()) && scheduled > new Date();
}

/**
 * Convierte texto externo en texto seguro para insertarlo dentro de HTML.
 * Reemplaza caracteres como <, > y comillas para que la descripción de una
 * solicitud nunca sea interpretada como código por el navegador.
 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[character]));
}

function normalizeCategoryName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Carga en paralelo categorías, solicitudes activas y aceptadas.
 * Si alguna respuesta indica que la sesión no es válida, regresa al login;
 * si todas son correctas, actualiza el formulario y ambos listados.
 */
async function loadPage() {
  const [catalog, data, acceptedData, finishedData] = await Promise.all([
    requestJson("/api/catalogos"),
    requestJson("/api/solicitudes"),
    requestJson("/api/solicitudes/aceptadas"),
    requestJson("/api/solicitudes/aceptadas?estado=finalizadas")
  ]);
  categoryById.clear();
  catalog.categories.forEach((item) => categoryById.set(String(item.id), item));
  categorySelect.innerHTML = '<option value="">Selecciona una categoría</option>' +
    catalog.categories.map((item) => `<option value="${item.id}">${escapeHtml(item.nombre)}</option>`).join("");
  updateCategoryFields();
  renderRequests(data.requests.map(localizeSchedule));
  renderAcceptedRequests(acceptedData.requests.map(localizeSchedule));
  renderFinishedRequests(finishedData.requests.map(localizeSchedule));
}

async function refreshServiceLists() {
  const [acceptedData, finishedData] = await Promise.all([
    requestJson("/api/solicitudes/aceptadas"),
    requestJson("/api/solicitudes/aceptadas?estado=finalizadas")
  ]);
  renderAcceptedRequests(acceptedData.requests.map(localizeSchedule));
  renderFinishedRequests(finishedData.requests.map(localizeSchedule));
}

function updateCategoryFields() {
  const category = categoryById.get(categorySelect.value);
  // La categoría controla si existe una subcategoría. Se mantiene el valor
  // anterior para que al cambiar de subcategoría no se borre accidentalmente
  // la selección mientras se reconstruyen las opciones del <select>.
  const normalizedCategoryName = normalizeCategoryName(category?.nombre);
  const optionsByCategory = {
    Acompañamiento: ["Acompañamiento doméstico", "Acompañamiento a exteriores"],
    Transporte: ["Traslado de un punto A a un punto B", "Acompañamiento a compras"]
  };
  let categoryKey = "";
  if (normalizedCategoryName === "acompanamiento") categoryKey = "Acompañamiento";
  if (normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado")) categoryKey = "Transporte";
  if (normalizedCategoryName === "mandados") categoryKey = "Mandados";
  // Obtiene las opciones permitidas para la categoría seleccionada.
  // Mandados no tiene subcategorías, por eso recibe una lista vacía.
  const options = category ? optionsByCategory[categoryKey] || [] : [];
  // Guarda la selección actual antes de reconstruir el <select>.
  const selectedSubcategory = subcategorySelect.value;
  // Solo se muestra y se vuelve obligatorio el campo cuando hay opciones.
  subcategoryField.hidden = options.length === 0;
  subcategorySelect.required = options.length > 0;
  // Reconstruye las opciones y escapa sus textos antes de insertarlos en HTML.
  subcategorySelect.innerHTML = '<option value="">Selecciona una opción</option>' +
    options.map((option) => `<option value="${escapeHtml(option)}">${escapeHtml(option)}</option>`).join("");
  // Conserva la selección si todavía es válida para la nueva categoría.
  subcategorySelect.value = options.includes(selectedSubcategory) ? selectedSubcategory : "";
  const isMandados = category && normalizedCategoryName === "mandados";
  const isTransfer = category && (normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado")) &&
    subcategorySelect.value === "Traslado de un punto A a un punto B";
  const isShopping = category && (normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado")) &&
    subcategorySelect.value === "Acompañamiento a compras";

  const isAccompaniment = category && normalizedCategoryName === "acompanamiento";
  const needsOrigin = isMandados || isTransfer || isShopping;
  const needsDestination = isMandados || isTransfer;

  // Cada modalidad tiene su propio cuestionario de domicilio. No se reutiliza
  // un solo bloque porque el usuario debe distinguir claramente el origen,
  // el destino y el supermercado.
  serviceAddressField.hidden = !isAccompaniment;
  routeFields.hidden = !needsOrigin;
  originAddressFields.hidden = !needsOrigin;
  destinationAddressFields.hidden = !needsDestination;
  shoppingAddressFields.hidden = !isShopping;
  serviceAddressLabel.textContent = isAccompaniment
    ? "Domicilio donde se realizará el acompañamiento" : "Domicilio";
  routeTitle.textContent = isShopping
    ? "Datos del traslado y compras" : "Datos del traslado";

  setAddressRequired(serviceAddressField, isAccompaniment);
  setAddressRequired(originAddressFields, needsOrigin);
  setAddressRequired(destinationAddressFields, needsDestination);
  setAddressRequired(shoppingAddressFields, isShopping);
  if (!isAccompaniment) clearAddressFields(serviceAddressField);
  if (!needsOrigin) clearAddressFields(originAddressFields);
  if (!needsDestination) clearAddressFields(destinationAddressFields);
  if (!isShopping) clearAddressFields(shoppingAddressFields);
  subcategoryLabel.textContent = category && (normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado"))
    ? "Tipo de transporte" : "Tipo de acompañamiento";
  if (options.length === 0) subcategorySelect.value = "";
  if (!category) {
    categoryHelp.textContent = "Selecciona un tipo de ayuda para ver sus indicaciones.";
    return;
  }
  if (normalizedCategoryName === "mandados") {
    categoryHelp.textContent = "Es un servicio de mensajería de un punto A a un punto B: el cliente ya adquirió, tramitó o es dueño del objeto. El repartidor solo lo recoge y entrega (por ejemplo, un paquete, llaves o un encargo ya pagado).";
  } else if (normalizedCategoryName === "transporte" || normalizedCategoryName.includes("traslado")) {
    categoryHelp.textContent = "Selecciona si es un traslado de punto A a punto B o acompañamiento para realizar compras, manteniendo a la persona acompañada y regresándola a casa.";
  } else {
    categoryHelp.textContent = "Describe si el acompañamiento será doméstico o a exteriores y qué apoyo necesitas.";
  }
}

// Activa required solo en los campos visibles de un bloque. El número interior
// se conserva opcional porque no todos los domicilios lo tienen.
function setAddressRequired(group, required) {
  group.querySelectorAll("input").forEach((input) => {
    input.required = required && !input.name.endsWith("_interior");
  });
}

// Limpia bloques ocultos para que sus valores no se envíen a otra modalidad
// cuando la persona cambia de categoría o subcategoría.
function clearAddressFields(group) {
  group.querySelectorAll("input").forEach((input) => {
    input.value = "";
  });
}

categorySelect.addEventListener("change", updateCategoryFields);
subcategorySelect.addEventListener("change", updateCategoryFields);

/**
 * Renderiza las solicitudes pendientes del solicitante.
 * Además del estado, agrega acciones para cambiar fecha/hora o borrar la
 * solicitud; los identificadores se guardan en data-* para llamar a la API.
 */
function renderRequests(requests) {
  document.getElementById("request-count").textContent = requests.length;
  requestList.innerHTML = requests.length
    ? requests.map((item) => `<article class="active-service-card">
        <div><span class="tag">${escapeHtml(item.categoria)}${item.subcategoria ? ` · ${escapeHtml(item.subcategoria)}` : ""}</span><h3>${escapeHtml(item.descripcion)}</h3>
        <p>Precio: $${escapeHtml(item.monto)} MXN ${item.tipo_tarifa === "hora" ? "por hora" : "por servicio"}</p>
        <p>${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)} · ${escapeHtml(item.municipio)}</p></div>
        <div class="card-actions"><span class="status-pill status-pill--waiting">${escapeHtml(item.estado)}</span>
        <button class="btn-secondary edit-request" type="button" data-id="${item.id}" data-date="${item.fecha}" data-time="${item.hora}">Cambiar fecha</button>
        <button class="btn-secondary postulations-request" type="button" data-id="${item.id}">Ver postulaciones</button>
        <button class="btn-secondary delete-request" type="button" data-id="${item.id}">Borrar</button></div>
      </article>`).join("")
    : "<p>Aún no has publicado solicitudes.</p>";
}

/**
 * Renderiza el historial de solicitudes aceptadas.
 * Se permite borrar una solicitud aceptada, pero nunca editar su horario.
 */
function renderAcceptedRequests(requests) {
  document.getElementById("accepted-count").textContent = requests.length;
  acceptedList.innerHTML = requests.length
    ? requests.map((item) => `<article class="active-service-card">
        <div><span class="tag">${escapeHtml(item.categoria)}</span><h3>${escapeHtml(item.descripcion)}</h3>
        <p>${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)} · ${escapeHtml(item.municipio)} · Prestador: ${escapeHtml(item.prestador)}</p></div>
        <p>Contacto: ${escapeHtml(item.contacto.nombre)} · ${escapeHtml(item.contacto.correo)} · ${escapeHtml(item.contacto.telefono)}</p>
        ${item.vehiculo ? `<p>Vehículo: ${escapeHtml(item.vehiculo.tipo)} · ${escapeHtml(item.vehiculo.color)} · Placas: ${escapeHtml(item.vehiculo.placas)} · ${escapeHtml(item.vehiculo.puertas)} puertas</p>` : ""}
        <div class="card-actions"><span class="status-pill ${item.iniciado ? "status-pill--progress" : "status-pill--waiting"}">${item.iniciado ? "En curso" : escapeHtml(item.estado)}</span>
        ${item.iniciado && !item.finalizado ? `<button class="btn-primary close-service" type="button" data-id="${item.servicio_id}">Marcar como terminado</button>` : ""}
        ${item.iniciado ? `<a class="btn-secondary" href="/reportar.html?servicio=${item.servicio_id}&volver=/solicitante/solicitar-servicio.html">Levantar incidencia</a>` : ""}
        <button class="btn-secondary delete-request" type="button" data-id="${item.id}">Cancelar solicitud</button></div>
      </article>`).join("")
    : "<p>Aún no tienes solicitudes aceptadas.</p>";
}

function renderFinishedRequests(requests) {
  document.getElementById("finished-count").textContent = requests.length;
  finishedList.innerHTML = requests.length
    ? requests.map((item) => `<article class="active-service-card">
        <div><span class="tag">${escapeHtml(item.categoria)}</span><h3>${escapeHtml(item.descripcion)}</h3>
        <p>${escapeHtml(item.fecha)} · ${escapeHtml(item.hora)} · ${escapeHtml(item.municipio)} · Prestador: ${escapeHtml(item.prestador)}</p>
        <p>Contacto: ${escapeHtml(item.contacto.nombre)} · ${escapeHtml(item.contacto.correo)} · ${escapeHtml(item.contacto.telefono)}</p>
        <a class="btn-secondary" href="/reportar.html?servicio=${item.servicio_id}&volver=/solicitante/solicitar-servicio.html">Levantar incidencia</a>
        ${item.vehiculo ? `<p>Vehículo: ${escapeHtml(item.vehiculo.tipo)} · ${escapeHtml(item.vehiculo.color)} · Placas: ${escapeHtml(item.vehiculo.placas)} · ${escapeHtml(item.vehiculo.puertas)} puertas</p>` : ""}</div>
        <div class="finished-service-rating">
          ${item.calificacion
            ? `<span class="received-rating">${"★".repeat(item.calificacion.estrellas)}${"☆".repeat(5 - item.calificacion.estrellas)}</span>
               <p>${escapeHtml(item.calificacion.comentario || "Sin comentario")}</p>`
            : `<form class="rating-form" data-id="${item.servicio_id}">
                 <p class="field-label">¿Cómo fue el trato del prestador?</p>
                 <div class="rating-stars" role="radiogroup" aria-label="Calificación de 1 a 5 estrellas">
                   ${[1, 2, 3, 4, 5].map((stars) => `<button class="rating-star" type="button" data-stars="${stars}" aria-label="${stars} estrellas">☆</button>`).join("")}
                 </div>
                 <textarea class="field-input rating-comment" maxlength="300" placeholder="Comentario opcional"></textarea>
                 <button class="btn-primary submit-rating" type="submit">Guardar calificación</button>
                 <p class="form-message form-message--error rating-error" role="alert"></p>
               </form>`}
        </div>
      </article>`).join("")
    : "<p>Aún no tienes tareas finalizadas.</p>";
}

/**
 * Atiende las acciones de las solicitudes pendientes.
 * Detecta si se pidió editar horario o borrar; muestra confirmación para borrar,
 * envía la operación al servidor y recarga los datos para mantener la vista actualizada.
 */
async function deleteRequest(button) {
  // La cancelación pide contraseña y motivo en su propia pantalla.
  window.location.href = `/solicitante/cancelar.html?id=${button.dataset.id}`;
}

// Se usa delegación de eventos porque las tarjetas se crean dinámicamente
// después de cada consulta a la API.
requestList.addEventListener("click", async (event) => {
  const editButton = event.target.closest(".edit-request");
  if (editButton) {
    const date = window.prompt("Nueva fecha (AAAA-MM-DD):", editButton.dataset.date);
    if (date === null) return;
    const time = window.prompt("Nueva hora (HH:MM):", editButton.dataset.time);
    if (time === null) return;
    errorMessage.textContent = "";
    try {
      await requestJson(`/api/solicitudes/${editButton.dataset.id}/horario`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localToUtcSchedule(date, time))
      });
    } catch (error) {
      errorMessage.textContent = error.message;
      return;
    }
    successMessage.textContent = "Fecha y hora actualizadas.";
    await loadPage();
    return;
  }
  const button = event.target.closest(".delete-request");
  if (button) await deleteRequest(button);
});

acceptedList.addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-request");
  if (button) await deleteRequest(button);
});

finishedList.addEventListener("click", (event) => {
  const star = event.target.closest(".rating-star");
  if (!star) return;
  const formElement = star.closest(".rating-form");
  formElement.querySelectorAll(".rating-star").forEach((item) => {
    item.textContent = Number(item.dataset.stars) <= Number(star.dataset.stars) ? "★" : "☆";
  });
  formElement.dataset.stars = star.dataset.stars;
});

finishedList.addEventListener("submit", async (event) => {
  const ratingForm = event.target.closest(".rating-form");
  if (!ratingForm) return;
  event.preventDefault();
  const stars = Number(ratingForm.dataset.stars);
  const error = ratingForm.querySelector(".rating-error");
  if (!stars) {
    error.textContent = "Selecciona una calificación de estrellas.";
    return;
  }
  const submitButton = ratingForm.querySelector(".submit-rating");
  submitButton.disabled = true;
  error.textContent = "";
  try {
    await requestJson(`/api/servicios/${ratingForm.dataset.id}/calificacion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        estrellas: stars,
        comentario: ratingForm.querySelector(".rating-comment").value.trim()
      })
    });
    await loadPage();
  } catch (requestError) {
    error.textContent = requestError.message;
    submitButton.disabled = false;
  }
});

/**
 * Intercepta el formulario de creación.
 * Ejecuta primero la validación HTML5, envía los datos como JSON y muestra el
 * mensaje del servidor sin recargar la página completa.
 */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMessage.textContent = "";
  successMessage.textContent = "";
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if (!isFutureSchedule()) {
    errorMessage.textContent = "Selecciona una fecha y hora futuras.";
    return;
  }
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await requestJson("/api/solicitudes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), ...localToUtcSchedule(dateInput.value, timeInput.value) })
    });
  } catch (error) {
    if (error.status === 401) {
      window.location.href = "/auth/iniciar-sesion.html";
      return;
    }
    errorMessage.textContent = error.message;
    submitButton.disabled = false;
    return;
  }
  form.reset();
  updateCategoryFields();
  submitButton.disabled = false;
  successMessage.textContent = "Solicitud publicada. Ya puede ser consultada por los prestadores.";
  loadPage().catch((error) => {
    if (error.status === 401) {
      window.location.href = "/auth/iniciar-sesion.html";
      return;
    }
    errorMessage.textContent = "La solicitud se publicó, pero no fue posible actualizar la lista.";
  });
});

/**
 * Inicializa el módulo del solicitante y centraliza el error de carga.
 * El catch evita que un fallo de red deje la pantalla sin explicación para el usuario.
 */
loadPage().catch((error) => {
  if (error.status === 401) {
    window.location.href = "/auth/iniciar-sesion.html";
    return;
  }
  errorMessage.textContent = "No fue posible cargar el módulo.";
});

window.setInterval(() => {
  refreshServiceLists().catch((error) => {
    if (error.status === 401) {
      window.location.href = "/auth/iniciar-sesion.html";
      return;
    }
    errorMessage.textContent = "No fue posible actualizar el estado de los servicios.";
  });
}, 15000);

/**
 * Configura la navegación de las tres secciones: creación, activas y aceptadas.
 * Solo un panel queda visible a la vez y aria-selected se actualiza para
 * lectores de pantalla y para identificar la pestaña seleccionada.
 */
document.querySelectorAll(".module-tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".module-tab").forEach((item) => {
      item.classList.remove("is-active");
      item.setAttribute("aria-selected", "false");
    });
    document.querySelectorAll(".module-panel").forEach((panel) => panel.classList.remove("is-active"));
    button.classList.add("is-active");
    button.setAttribute("aria-selected", "true");
    document.getElementById(button.dataset.tab).classList.add("is-active");
  });
});

/**
 * Muestra u oculta las postulaciones de una solicitud propia. Cada postulación
 * se acepta o rechaza desde aquí; el servidor vuelve a validar cada decisión.
 */
async function togglePostulations(button) {
  const card = button.closest("article");
  const existing = card.querySelector(".postulations-panel");
  if (existing) {
    existing.remove();
    return;
  }
  const panel = document.createElement("div");
  panel.className = "postulations-panel";
  panel.textContent = "Cargando postulaciones...";
  card.appendChild(panel);
  try {
    const data = await requestJson(`/api/solicitudes/${button.dataset.id}/postulaciones`);
    if (data.postulations.length === 0) {
      panel.textContent = "Todavía no hay postulaciones para esta solicitud.";
      return;
    }
    panel.innerHTML = data.postulations.map((item) => `<div class="postulation-item">
      <p><strong>${escapeHtml(item.prestador)}</strong> · ${escapeHtml(item.calificacion)}</p>
      <p>Tarifa propuesta: $${escapeHtml(item.tarifa_propuesta)} MXN</p>
      ${item.mensaje ? `<p>${escapeHtml(item.mensaje)}</p>` : ""}
      <p class="field-hint">Estado: ${escapeHtml(item.estado)}</p>
      ${item.estado_id === 1 ? `<div class="card-actions">
        <button class="btn-primary accept-postulation" type="button" data-id="${item.id}">Aceptar</button>
        <button class="btn-secondary reject-postulation" type="button" data-id="${item.id}">Rechazar</button>
      </div>` : ""}
    </div>`).join("");
  } catch (error) {
    panel.textContent = error.message;
  }
}

requestList.addEventListener("click", async (event) => {
  const postulationsButton = event.target.closest(".postulations-request");
  if (postulationsButton) {
    togglePostulations(postulationsButton);
    return;
  }
  const acceptButton = event.target.closest(".accept-postulation");
  const rejectButton = event.target.closest(".reject-postulation");
  if (!acceptButton && !rejectButton) return;
  const target = acceptButton || rejectButton;
  const action = acceptButton ? "aceptar" : "rechazar";
  if (action === "aceptar" && !window.confirm("¿Aceptar esta postulación? Las demás se cerrarán.")) return;
  target.disabled = true;
  try {
    await requestJson(`/api/postulaciones/${target.dataset.id}/${action}`, { method: "POST" });
    successMessage.textContent = action === "aceptar" ? "Postulación aceptada." : "Postulación rechazada.";
    await loadPage();
  } catch (error) {
    errorMessage.textContent = error.message;
    target.disabled = false;
  }
});

// Marca el servicio como terminado desde la sección de aceptadas.
acceptedList.addEventListener("click", async (event) => {
  const closeButton = event.target.closest(".close-service");
  if (!closeButton) return;
  closeButton.disabled = true;
  try {
    const data = await requestJson(`/api/servicios/${closeButton.dataset.id}/finalizar`, { method: "POST" });
    successMessage.textContent = data.message;
    await loadPage();
  } catch (error) {
    errorMessage.textContent = error.message;
    closeButton.disabled = false;
  }
});
