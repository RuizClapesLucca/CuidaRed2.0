// Borrado de cuenta desde cualquier módulo. Pide motivo y contraseña, y llama a
// /api/cuenta/borrar. La cuenta queda desactivada 30 días y se recupera al iniciar sesión.
(function () {
  const button = document.getElementById("delete-account-button");
  if (!button) return;

  function buildDialog(reasons) {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px";

    const form = document.createElement("form");
    form.className = "auth-card";
    form.style.cssText = "max-width:420px;width:100%";

    const title = document.createElement("h2");
    title.className = "auth-title";
    title.textContent = "Borrar cuenta";

    const info = document.createElement("p");
    info.className = "form-section-subtitle";
    info.textContent = "Tendrás 30 días para recuperarla iniciando sesión. Después de ese plazo ya no podrá recuperarse.";

    const error = document.createElement("p");
    error.className = "form-message form-message--error";
    error.id = "delete-error";
    error.setAttribute("role", "alert");

    const reasonField = document.createElement("div");
    reasonField.className = "field";
    const reasonLabel = document.createElement("label");
    reasonLabel.className = "field-label";
    reasonLabel.htmlFor = "delete-reason";
    reasonLabel.textContent = "Motivo";
    const select = document.createElement("select");
    select.className = "field-input";
    select.id = "delete-reason";
    select.required = true;
    reasons.forEach((reason) => {
      const option = document.createElement("option");
      option.value = String(reason.id);
      option.textContent = reason.nombre;
      select.appendChild(option);
    });
    reasonField.append(reasonLabel, select);

    const passwordField = document.createElement("div");
    passwordField.className = "field";
    const passwordLabel = document.createElement("label");
    passwordLabel.className = "field-label";
    passwordLabel.htmlFor = "delete-password";
    passwordLabel.textContent = "Contraseña";
    const passwordInput = document.createElement("input");
    passwordInput.className = "field-input";
    passwordInput.id = "delete-password";
    passwordInput.type = "password";
    passwordInput.required = true;
    passwordInput.minLength = 8;
    passwordInput.maxLength = 128;
    passwordInput.autocomplete = "current-password";
    passwordField.append(passwordLabel, passwordInput);

    const actions = document.createElement("div");
    actions.className = "form-actions";
    const submit = document.createElement("button");
    submit.className = "btn-primary";
    submit.type = "submit";
    submit.textContent = "Borrar mi cuenta";
    const cancel = document.createElement("button");
    cancel.className = "auth-link";
    cancel.type = "button";
    cancel.textContent = "Cancelar";
    actions.append(submit, cancel);

    form.append(title, info, error, reasonField, passwordField, actions);
    overlay.appendChild(form);

    cancel.addEventListener("click", () => overlay.remove());
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.textContent = "";
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }
      submit.disabled = true;
      submit.textContent = "Borrando...";
      try {
        const response = await fetch("/api/cuenta/borrar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: passwordInput.value, id_motivo: Number(select.value) })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (response.status === 401) {
            window.location.href = "/auth/iniciar-sesion.html";
            return;
          }
          throw new Error(data.message || "No fue posible borrar la cuenta.");
        }
        window.location.href = data.redirect || "/Modulo1.html";
      } catch (failure) {
        error.textContent = failure.message;
        submit.disabled = false;
        submit.textContent = "Borrar mi cuenta";
      }
    });
    return overlay;
  }

  button.addEventListener("click", async () => {
    try {
      const response = await fetch("/api/motivos-baja");
      if (response.status === 401) {
        window.location.href = "/auth/iniciar-sesion.html";
        return;
      }
      const data = await response.json();
      const dialog = buildDialog(data.reasons || []);
      document.body.appendChild(dialog);
      dialog.querySelector("input").focus();
    } catch (error) {
      window.alert("No fue posible abrir el borrado de cuenta. Intenta de nuevo.");
    }
  });
})();
