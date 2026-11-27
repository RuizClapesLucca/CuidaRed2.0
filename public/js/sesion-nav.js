// Navegación según la sesión. Tres tareas, sin tocar el contenido de cada página:
// 1. Marca el enlace de la página actual (is-active y aria-current) en el menú.
// 2. Muestra u oculta los enlaces según si hay sesión:
//    [data-guest-only] solo sin sesión; [data-auth-only] solo con sesión.
// 3. Enlaza [data-home-link] al inicio del rol del usuario (fuente: /api/session).
(() => {
  // La raíz y /Modulo1.html son la misma página.
  const normalizePath = (path) => (path === "/" || path === "/Modulo1.html" ? "/Modulo1.html" : path);
  const currentPath = normalizePath(location.pathname);

  // Los enlaces de ancla (#seccion) no son páginas distintas, por eso se omiten.
  function markActiveLinks() {
    document.querySelectorAll(".header-nav a[href]").forEach((link) => {
      const target = new URL(link.getAttribute("href"), location.origin);
      if (target.hash) return;
      if (normalizePath(target.pathname) === currentPath) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "page");
      }
    });
  }

  // Ajusta los enlaces según la sesión. Si la consulta falla, se dejan los enlaces de invitado.
  async function applySession() {
    let data;
    try {
      const response = await fetch("/api/session", { credentials: "same-origin" });
      data = await response.json();
    } catch {
      return;
    }
    const user = data && data.authenticated ? data.user : null;

    document.querySelectorAll("[data-guest-only]").forEach((element) => {
      element.hidden = Boolean(user);
    });
    document.querySelectorAll("[data-auth-only]").forEach((element) => {
      element.hidden = !user;
    });
    if (user && data.home) {
      document.querySelectorAll("[data-home-link]").forEach((element) => {
        element.setAttribute("href", data.home);
      });
    }
  }

  markActiveLinks();
  applySession();
})();
