// Panel de incidencias: lista, detalle con evidencias y resolución del reporte.
const message = document.getElementById("message");
const list = document.getElementById("report-list");
const detail = document.getElementById("report-detail");
const filterForm = document.getElementById("filter-form");

function showError(error) {
  message.textContent = error.message;
}

async function loadReports() {
  message.textContent = "";
  const query = new URLSearchParams({
    estado: filterForm.estado.value,
    desde: filterForm.desde.value,
    hasta: filterForm.hasta.value
  });
  for (const [key, value] of [...query.entries()]) {
    if (!value) query.delete(key);
  }
  try {
    const data = await apiJson(`/api/admin/reportes?${query.toString()}`);
    list.innerHTML = data.reports.length
      ? `<table class="admin-table"><thead><tr><th>Folio</th><th>Fecha</th><th>Motivo</th><th>Reportante</th><th>Reportado</th><th>Estado</th><th>Evidencias</th><th></th></tr></thead><tbody>${
        data.reports.map((item) => `<tr>
          <td>#${item.id}</td>
          <td>${escapeHtml(new Date(item.fecha_reporte).toLocaleDateString("es-MX"))}</td>
          <td>${escapeHtml(item.motivo)}</td>
          <td>${escapeHtml(item.reportante)}</td>
          <td>${escapeHtml(item.reportado)}</td>
          <td>${escapeHtml(item.estado)}</td>
          <td>${item.evidencias}</td>
          <td><button class="btn-secondary view-report" type="button" data-id="${item.id}">Ver</button></td>
        </tr>`).join("")
      }</tbody></table>`
      : "<p>No hay reportes con esos criterios.</p>";
  } catch (error) {
    showError(error);
  }
}

async function showReport(id) {
  message.textContent = "";
  try {
    const data = await apiJson(`/api/admin/reportes/${id}`);
    const r = data.report;
    const evidences = data.evidences.length
      ? data.evidences.map((item) => `<li><a href="/api/admin/evidencias/${item.id}" target="_blank" rel="noopener">${escapeHtml(item.nombre_original)}</a> (${escapeHtml(item.tipo_mime)}, ${Math.round(item.tamano_bytes / 1024)} KB)</li>`).join("")
      : "<li>Sin evidencias adjuntas.</li>";
    const open = Number(r.id_estado_reporte) === 1 || Number(r.id_estado_reporte) === 2;
    detail.hidden = false;
    detail.innerHTML = `
      <article class="auth-card">
        <h2 class="field-label">Reporte #${r.id} · ${escapeHtml(r.motivo)}</h2>
        <p>Servicio #${r.id_servicio} · Estado: ${escapeHtml(r.estado)}</p>
        <p><strong>Reportante:</strong> ${escapeHtml(r.reportante)} (${escapeHtml(r.reportante_correo)})</p>
        <p><strong>Reportado:</strong> ${escapeHtml(r.reportado)} (${escapeHtml(r.reportado_correo)})</p>
        <p><strong>Descripción:</strong> ${escapeHtml(r.descripcion)}</p>
        <p><strong>Evidencias:</strong></p>
        <ul>${evidences}</ul>
        ${r.resolucion ? `<p><strong>Resolución:</strong> ${escapeHtml(r.resolucion)}</p>` : ""}
        ${open ? `<form id="resolve-form" data-id="${r.id}">
          <div class="field"><label class="field-label" for="accion">Decisión</label>
            <select class="field-input" id="accion" name="accion" required>
              <option value="desestimar">Desestimar (sin sanción)</option>
              <option value="advertir">Advertir al usuario reportado</option>
              <option value="suspender">Suspender al usuario reportado</option>
              <option value="eliminar">Eliminar reporte duplicado (sin medidas)</option>
            </select></div>
          <div class="field"><label class="field-label" for="dias">Días de suspensión (solo si suspendes, 1 a 30)</label>
            <input class="field-input" id="dias" name="dias" type="number" min="1" max="30"></div>
          <div class="field"><label class="field-label" for="justificacion">Justificación</label>
            <textarea class="field-input field-textarea" id="justificacion" name="justificacion" minlength="10" maxlength="500" required></textarea></div>
          <div class="form-actions"><button class="btn-primary" type="submit">Resolver reporte</button></div>
        </form>` : "<p>Este reporte ya fue resuelto.</p>"}
      </article>`;
    detail.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    showError(error);
  }
}

filterForm.addEventListener("submit", (event) => {
  event.preventDefault();
  loadReports();
});

list.addEventListener("click", (event) => {
  const button = event.target.closest(".view-report");
  if (button) showReport(button.dataset.id);
});

detail.addEventListener("submit", async (event) => {
  if (event.target.id !== "resolve-form") return;
  event.preventDefault();
  const form = event.target;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  const action = form.accion.value;
  if (!window.confirm("¿Confirmas esta decisión? Quedará registrada en la bitácora.")) return;
  try {
    const data = await apiJson(`/api/admin/reportes/${form.dataset.id}/resolver`, {
      method: "POST",
      body: {
        accion: action,
        justificacion: form.justificacion.value.trim(),
        dias: action === "suspender" ? Number(form.dias.value) : 0
      }
    });
    message.textContent = data.message;
    detail.hidden = true;
    loadReports();
  } catch (error) {
    showError(error);
  }
});

loadReports();
