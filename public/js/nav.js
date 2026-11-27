// Menú hamburguesa: en pantallas pequeñas el encabezado de los módulos se despliega desde un botón.
(() => {
  const header = document.querySelector(".site-header");
  const nav = header && header.querySelector(".header-nav");
  if (!nav || header.querySelector(".nav-toggle")) return;

  const toggle = document.createElement("button");
  toggle.className = "nav-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-label", "Abrir menú");
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = "<span></span><span></span><span></span>";
  header.insertBefore(toggle, nav);

  toggle.addEventListener("click", () => {
    const open = header.classList.toggle("nav-open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Cerrar menú" : "Abrir menú");
  });
})();
