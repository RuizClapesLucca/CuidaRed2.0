// Aplica el tema guardado en todas las páginas. Se carga al inicio del <body>, antes del contenido,
// para que no haya parpadeo. Si es la primera visita, usa el tema del sistema.
(() => {
  const saved = window.localStorage.getItem("cuidared-theme");
  const prefersDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const dark = saved ? saved === "dark" : prefersDark;
  document.body.classList.toggle("theme-dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
