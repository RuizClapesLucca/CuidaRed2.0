// Gestión de administradores (solo el principal modifica), métricas y reportes técnicos.
const message = document.getElementById("message");
const showError = (error) => { message.textContent = error.message; };
let session = { principal: false, id: null };
let adminsCache = [];

function cell(text) {
  return `<td>${escapeHtml(text)}</td>`;
}

function renderAdmins() {
  const rows = adminsCache.map((admin) => {
    const canAct = session.principal && admin.id !== session.id && Number(admin.id_estado_cuenta) === 2;
    return `<tr>
      ${cell(admin.nombre_completo)}${cell(admin.correo)}
      ${cell(admin.principal ? "Principal" : "Administrador")}
      ${cell(admin.estado)}${cell(admin.con_2fa ? "Sí" : "No")}${cell(admin.debe_cambiar_contrasena ? "Sí" : "No")}
      <td>${canAct ? `<button class="btn-secondary act-admin" data-id="${admin.id}" data-action="inhabilitar">Inhabilitar</button>
        <button class="btn-secondary act-admin" data-id="${admin.id}" data-action="eliminar">Eliminar</button>
        ${admin.principal || !session.twoFactor ? "" : `<button class="btn-secondary act-admin" data-id="${admin.id}" data-action="regenerar">Regenerar 2FA</button>`}` : ""}</td>
    </tr>`;
  }).join("");
  document.getElementById("admin-list").innerHTML = `<table class="admin-table"><thead><tr>
    <th>Nombre</th><th>Correo</th><th>Rol</th><th>Estado</th><th>2FA</th><th>Cambio pendiente</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

async function loadAdmins() {
  const data = await apiJson("/api/admin/administradores");
  adminsCache = data.admins;
  renderAdmins();
}

async function init() {
  const sessionData = await apiJson("/api/session");
  session = { principal: Boolean(sessionData.user && sessionData.user.principal), id: sessionData.user && sessionData.user.id };
  document.getElementById("create-section").hidden = !session.principal;
  if (!sessionData.twoFactor) {
    for (const id of ["new-totp", "action-totp"]) {
      const input = document.getElementById(id);
      input.required = false;
      input.closest(".field").hidden = true;
    }
  }
  session.twoFactor = Boolean(sessionData.twoFactor);
  await loadAdmins();
}

init().catch(showError);

// Acciones de administrador: piden motivo y TOTP propio antes de ejecutarse.
document.getElementById("admin-list").addEventListener("click", (event) => {
  const button = event.target.closest(".act-admin");
  if (!button) return;
  const panel = document.getElementById("action-panel");
  const form = document.getElementById("action-form");
  form.dataset.id = button.dataset.id;
  form.dataset.action = button.dataset.action;
  const target = adminsCache.find((item) => String(item.id) === button.dataset.id);
  const labels = { eliminar: "Eliminar", inhabilitar: "Inhabilitar", regenerar: "Regenerar la clave TOTP de" };
  const name = target ? target.nombre_completo : "este administrador";
  document.getElementById("action-title").textContent = `${labels[button.dataset.action]} ${name}`;
  document.getElementById("action-reset-field").hidden = button.dataset.action !== "regenerar";
  panel.hidden = false;
  form.reset();
  panel.scrollIntoView({ behavior: "smooth" });
});

document.getElementById("action-cancel").addEventListener("click", () => {
  document.getElementById("action-panel").hidden = true;
});

document.getElementById("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!window.confirm("¿Confirmas esta acción? Quedará registrada en la bitácora.")) return;
  try {
    const data = await apiJson(`/api/admin/administradores/${form.dataset.id}/${form.dataset.action}`, {
      method: "POST",
      body: {
        motivo: document.getElementById("action-reason").value.trim(),
        totp: document.getElementById("action-totp").value,
        restablecer_contrasena: document.getElementById("action-reset").checked
      }
    });
    message.textContent = data.totp_clave
      ? `${data.message} Clave TOTP: ${data.totp_clave}${data.temporary_password ? ` · Contraseña temporal: ${data.temporary_password}` : ""}`
      : data.message;
    document.getElementById("action-panel").hidden = true;
    await loadAdmins();
  } catch (error) {
    showError(error);
  }
});

// Crear administrador: la contraseña temporal y la clave TOTP se muestran una sola vez.
document.getElementById("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const result = document.getElementById("create-result");
  try {
    const data = await apiJson("/api/admin/administradores", {
      method: "POST",
      body: {
        nombre: document.getElementById("new-name").value,
        correo: document.getElementById("new-email").value,
        telefono: document.getElementById("new-phone").value,
        fecha_nacimiento: document.getElementById("new-birth").value,
        totp: document.getElementById("new-totp").value
      }
    });
    result.hidden = false;
    result.textContent = `${data.message} Contraseña temporal: ${data.temporary_password}`;
    form.reset();
    await loadAdmins();
  } catch (error) {
    showError(error);
  }
});

// Métricas: totales y desglose mensual.
function renderSeries(title, rows) {
  if (rows === null) return `<p class="field-hint">${escapeHtml(title)}: no aplica con filtro de municipio.</p>`;
  if (!rows.length) return `<p>${escapeHtml(title)}: sin datos en el periodo.</p>`;
  const max = Math.max(...rows.map((row) => Number(row.total)));
  return `<h3 class="field-label">${escapeHtml(title)}</h3><table class="admin-table"><tbody>${
    rows.map((row) => `<tr><td>${escapeHtml(row.mes)}</td><td>${row.total}</td>
      <td><div style="background:var(--accent,#3b82f6);height:10px;width:${Math.round((Number(row.total) / max) * 100)}%"></div></td></tr>`).join("")
  }</tbody></table>`;
}

document.getElementById("metrics-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = new URLSearchParams();
  for (const [key, id] of [["desde", "m-desde"], ["hasta", "m-hasta"], ["municipio", "m-municipio"]]) {
    const value = document.getElementById(id).value.trim();
    if (value) params.set(key, value);
  }
  try {
    const data = await apiJson(`/api/admin/metricas?${params.toString()}`);
    const t = data.totales;
    document.getElementById("metrics-result").innerHTML = `
      <p><strong>Periodo:</strong> ${escapeHtml(data.desde)} a ${escapeHtml(data.hasta)}${data.municipio ? ` · ${escapeHtml(data.municipio)}` : ""}</p>
      <p>Servicios terminados: <strong>${t.servicios_terminados}</strong> · Incidencias: <strong>${t.incidencias}</strong> · Registros: <strong>${t.registros === null ? "—" : t.registros}</strong></p>
      ${renderSeries("Servicios terminados por mes", data.por_mes.servicios_terminados)}
      ${renderSeries("Incidencias por mes", data.por_mes.incidencias)}
      ${renderSeries("Registros por mes", data.por_mes.registros)}`;
  } catch (error) {
    showError(error);
  }
});

// Reportes técnicos del periodo.
document.getElementById("tickets-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const params = new URLSearchParams();
  for (const [key, id] of [["desde", "t-desde"], ["hasta", "t-hasta"], ["modulo", "t-modulo"]]) {
    const value = document.getElementById(id).value;
    if (value) params.set(key, value);
  }
  try {
    const data = await apiJson(`/api/admin/tickets?${params.toString()}`);
    document.getElementById("tickets-result").innerHTML = data.tickets.length
      ? `<table class="admin-table"><thead><tr><th>Ticket</th><th>Fecha</th><th>Módulo</th><th>Usuario</th><th>Descripción</th><th>Navegador</th><th>Captura</th></tr></thead><tbody>${
        data.tickets.map((item) => `<tr>
          <td>TEC-${item.id}</td>
          ${cell(new Date(item.fecha_reporte).toLocaleString("es-MX"))}${cell(item.modulo)}${cell(item.usuario)}
          <td>${escapeHtml(item.descripcion)}</td>${cell(item.navegador || "—")}
          <td>${item.tiene_captura ? `<a href="/api/admin/tickets/${item.id}/captura" target="_blank" rel="noopener">Ver captura</a>` : "—"}</td>
        </tr>`).join("")
      }</tbody></table>`
      : "<p>No hay reportes técnicos con esos criterios.</p>";
  } catch (error) {
    showError(error);
  }
});
