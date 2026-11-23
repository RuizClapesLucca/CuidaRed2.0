// Componente del módulo de administración: lista cuentas de solicitantes y
// prestadores y permite desactivarlas con un motivo. Todo el contenido que llega
// de la API se inserta con textContent para que nunca se interprete como HTML.
const userList = document.getElementById("user-list");
const searchInput = document.getElementById("search");
const errorMessage = document.getElementById("error-message");
const successMessage = document.getElementById("success-message");
const previousButton = document.getElementById("previous-page");
const nextButton = document.getElementById("next-page");
const pageLabel = document.getElementById("page-label");
const dialog = document.getElementById("deactivate-dialog");
const form = document.getElementById("deactivate-form");
const dialogTarget = document.getElementById("deactivate-target");
const dialogError = document.getElementById("deactivate-error");
const reasonInput = document.getElementById("deactivate-reason");
const submitButton = document.getElementById("deactivate-submit");
// Estado 6 es Inhabilitada: esas cuentas ya no se pueden desactivar otra vez.
const DISABLED_STATE_ID = 6;
let currentPage = 1;
let selectedUser = null;
let searchTimer;

// Crea una celda de tabla con texto plano.
function createCell(text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  return cell;
}

// Dibuja una fila por usuario, con el botón de desactivar en la última celda.
function renderUsers(users) {
  userList.replaceChildren();
  if (users.length === 0) {
    const row = document.createElement("tr");
    const cell = createCell("No se encontraron usuarios.");
    cell.colSpan = 5;
    row.appendChild(cell);
    userList.appendChild(row);
    return;
  }
  users.forEach((user) => {
    const row = document.createElement("tr");
    row.append(createCell(user.nombre_completo), createCell(user.correo), createCell(user.tipo), createCell(user.estado));
    const actionCell = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-danger btn-danger--small";
    button.textContent = "Desactivar cuenta";
    button.disabled = Number(user.id_estado_cuenta) === DISABLED_STATE_ID;
    button.addEventListener("click", () => openDialog(user));
    actionCell.appendChild(button);
    row.appendChild(actionCell);
    userList.appendChild(row);
  });
}

// Consulta la página actual de usuarios aplicando el texto de búsqueda.
async function loadUsers() {
  errorMessage.textContent = "";
  try {
    const query = new URLSearchParams({ q: searchInput.value.trim(), pagina: String(currentPage) });
    const { users, hasMore } = await requestJson(`/api/admin/usuarios?${query.toString()}`);
    renderUsers(users);
    previousButton.disabled = currentPage === 1;
    nextButton.disabled = !hasMore;
    pageLabel.textContent = `Página ${currentPage}`;
  } catch (error) {
    if (error.status === 401) {
      window.location.href = "/auth/iniciar-sesion.html";
      return;
    }
    errorMessage.textContent = error.message;
  }
}

function openDialog(user) {
  selectedUser = user;
  dialogTarget.textContent = `${user.nombre_completo} (${user.correo})`;
  dialogError.textContent = "";
  reasonInput.value = "";
  submitButton.disabled = false;
  submitButton.textContent = "Desactivar cuenta";
  dialog.showModal();
}

// Búsqueda con una pequeña espera para no consultar en cada tecla.
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    currentPage = 1;
    loadUsers();
  }, 300);
});
previousButton.addEventListener("click", () => {
  currentPage -= 1;
  loadUsers();
});
nextButton.addEventListener("click", () => {
  currentPage += 1;
  loadUsers();
});
document.getElementById("deactivate-cancel").addEventListener("click", () => dialog.close());

// Valida el motivo en el navegador y después envía la desactivación al servidor.
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  dialogError.textContent = "";
  const reason = reasonInput.value.trim().replace(/\s+/g, " ");
  if (reason.length < 10 || reason.length > 250) {
    dialogError.textContent = "El motivo debe tener entre 10 y 250 caracteres.";
    reasonInput.focus();
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = "Desactivando...";
  try {
    const result = await requestJson(`/api/admin/usuarios/${encodeURIComponent(selectedUser.id)}/desactivar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motivo: reason })
    });
    dialog.close();
    successMessage.textContent = result.message;
    loadUsers();
  } catch (error) {
    dialogError.textContent = error.message;
    submitButton.disabled = false;
    submitButton.textContent = "Desactivar cuenta";
  }
});

loadUsers();
