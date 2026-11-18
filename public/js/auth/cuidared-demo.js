(function () {
  // Componente de demostración local: simula usuarios y sesiones con localStorage.
  // Claves usadas para guardar usuarios y sesión en el almacenamiento del navegador.
  const USERS_KEY = "cuidared-demo-users";
  const SESSION_KEY = "cuidared-demo-session";

  // Recupera los usuarios registrados en la demostración local.
  function getUsers() {
    return JSON.parse(localStorage.getItem(USERS_KEY) || "[]");
  }

  // Registra un usuario demo y crea su sesión inicial.
  function register(user) {
    const email = String(user.email || "").trim().toLowerCase();
    const users = getUsers();
    if (users.some((item) => item.email === email)) {
      return { ok: false, message: "Este correo ya tiene una cuenta demo." };
    }
    const newUser = {
      name: String(user.name || "").trim(),
      email,
      password: String(user.password || ""),
      role: user.role
    };
    users.push(newUser);
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
    localStorage.setItem(SESSION_KEY, JSON.stringify({ name: newUser.name, role: newUser.role }));
    return { ok: true, role: newUser.role };
  }

  // Busca las credenciales y crea una sesión demo cuando son correctas.
  function login(email, password) {
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const user = getUsers().find((item) => item.email === normalizedEmail && item.password === password);
    if (!user) {
      return { ok: false, message: "Correo o contraseña incorrectos. Si aún no tienes cuenta, regístrate primero." };
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ name: user.name, role: user.role }));
    return { ok: true, role: user.role };
  }

  // Devuelve la sesión demo actualmente almacenada.
  function getSession() {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  }

  // Elimina la sesión local y regresa al inicio.
  function logout() {
    localStorage.removeItem(SESSION_KEY);
    window.location.href = "/Modulo1.html";
  }

  window.CuidaredDemo = { register, login, getSession, logout };
})();
