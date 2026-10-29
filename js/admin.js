
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);

let currentUser = null;
let users = [];
let unsubscribe = null;
let ready = false;
let sessionVersion = 0;

function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    $("toast").classList.remove("show");
  }, 3500);
}

function closeMenu() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.remove("show");
}

function page(name) {
  document.querySelectorAll(".page").forEach(element => {
    element.hidden = element.id !== name;
  });

  document.querySelectorAll(".nav").forEach(element => {
    element.classList.toggle(
      "active",
      element.dataset.page === name
    );
  });

  const titles = {
    inicio: "Resumen general",
    usuarios: "Gestión de empleados",
    prestamos: "Préstamos",
    cobranza: "Cobranza",
    reportes: "Reportes financieros"
  };

  $("pageTitle").textContent = titles[name] || "Administración";

  closeMenu();
}

document.querySelectorAll(".nav").forEach(button => {
  button.addEventListener("click", () => {
    page(button.dataset.page);
  });
});

$("goUsers").addEventListener("click", () => {
  page("usuarios");
});

$("menuButton").addEventListener("click", () => {
  $("sidebar").classList.add("open");
  $("overlay").classList.add("show");
});

$("overlay").addEventListener("click", closeMenu);

$("logout").addEventListener("click", async () => {
  try {
    await signOut(auth);
    location.replace("index.html");
  } catch (error) {
    toast("No se pudo cerrar sesión: " + error.message);
  }
});

function make(tag, className = "", content) {
  const element = document.createElement(tag);

  if (className) {
    element.className = className;
  }

  if (content !== undefined) {
    element.textContent = String(content);
  }

  return element;
}

function action(label, className, handler) {
  const button = make("button", "action " + className, label);

  button.type = "button";
  button.addEventListener("click", handler);

  return button;
}

function render() {
  if (!currentUser) return;

  const pending = users.filter(user => {
    return user.estado === "pendiente";
  }).length;

  const active = users.filter(user => {
    return user.estado === "activo" &&
      user.rol === "empleado";
  }).length;

  const disabled = users.filter(user => {
    return ["deshabilitado", "rechazado"].includes(user.estado);
  }).length;

  $("totalUsers").textContent = users.length;
  $("activeUsers").textContent = active;
  $("pendingUsers").textContent = pending;
  $("disabledUsers").textContent = disabled;
  $("pendingCount").textContent = pending || "";
  $("pendingCount").hidden = pending === 0;

  const search = $("searchUsers")
    .value
    .trim()
    .toLocaleUpperCase("es-MX");

  const filter = $("filterUsers").value;

  const filtered = users.filter(user => {
    const nombre = (user.nombre || "")
      .toLocaleUpperCase("es-MX");

    const correo = (user.correo || "")
      .toLocaleUpperCase("es-MX");

    const telefono = user.telefono || "";

    const matches =
      nombre.includes(search) ||
      correo.includes(search) ||
      telefono.includes(search);

    return matches &&
      (filter === "todos" || user.estado === filter);
  });

  $("usersSubtitle").textContent =
    filtered.length + " registros encontrados";

  const container = $("usersList");
  container.replaceChildren();

  if (!filtered.length) {
    container.append(
      make("p", "", "No se encontraron usuarios.")
    );
    return;
  }

  for (const user of filtered) {
    const row = make("div", "user-row");

    const avatar = make(
      "div",
      "user-avatar",
      (user.nombre || "?").charAt(0)
    );

    const info = make("div", "user-info");

    info.append(
      make("strong", "", user.nombre || "SIN NOMBRE")
    );

    info.append(
      make(
        "small",
        "",
        user.correo || user.telefono || "Sin contacto"
      )
    );

    const statusText =
      (user.estado || "Sin estado").toUpperCase() +
      " · " +
      (user.rol || "Sin rol").toUpperCase();

    info.append(
      make(
        "span",
        "status " + (user.estado || ""),
        statusText
      )
    );

    const actions = make("div", "user-actions");

    if (
      user.uid !== currentUser.uid &&
      user.rol !== "admin"
    ) {
      if (user.estado !== "activo") {
        actions.append(
          action("Aprobar", "approve", () => {
            changeStatus(user, "activo", "empleado");
          })
        );
      }

      if (user.estado === "activo") {
        actions.append(
          action("Deshabilitar", "danger", () => {
            changeStatus(user, "deshabilitado", "empleado");
          })
        );
      }

      if (user.estado !== "rechazado") {
        actions.append(
          action("Rechazar", "danger", () => {
            changeStatus(user, "rechazado", "pendiente");
          })
        );
      }
    }

    row.append(avatar, info, actions);
    container.append(row);
  }
}

async function changeStatus(user, estado, rol) {
  if (!currentUser) return;

  const labels = {
    activo: "APROBAR",
    deshabilitado: "DESHABILITAR",
    rechazado: "RECHAZAR"
  };

  const operation = labels[estado];

  if (!operation) return;

  if (
    user.uid === currentUser.uid ||
    user.rol === "admin"
  ) {
    toast("No puedes modificar esta cuenta.");
    return;
  }

  const confirmed = confirm(
    "¿Deseas " +
    operation +
    " la cuenta de " +
    user.nombre +
    "?"
  );

  if (!confirmed) return;

  try {
    await updateDoc(doc(db, "usuarios", user.uid), {
      estado,
      rol,
      actualizadoEn: serverTimestamp(),
      actualizadoPor: currentUser.uid
    });

    toast("Cuenta actualizada correctamente.");
  } catch (error) {
    toast(
      "No se pudo actualizar la cuenta: " +
      error.message
    );
  }
}

const requestedPage = new URLSearchParams(location.search).get("seccion");

if (["usuarios", "prestamos", "cobranza", "reportes"].includes(requestedPage)) {
  page(requestedPage);
}

$("searchUsers").addEventListener("input", render);

$("filterUsers").addEventListener("change", render);

async function verifyAdmin(user) {
  const reference = doc(db, "usuarios", user.uid);
  const snapshot = await getDoc(reference);

  if (!snapshot.exists()) {
    location.replace("index.html");
    return false;
  }

  const data = snapshot.data();

  if (
    data.estado !== "activo" ||
    data.rol !== "admin"
  ) {
    location.replace("index.html");
    return false;
  }

  currentUser = user;

  const name = data.nombre || "ADMINISTRADOR";

  $("sideName").textContent = name;
  $("welcomeName").textContent = name.split(" ")[0];

  return true;
}

onAuthStateChanged(auth, async user => {
  const version = ++sessionVersion;

  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  if (!user) {
    $("app").hidden = true;
    location.replace("index.html");
    return;
  }

  try {
    const authorized = await verifyAdmin(user);

    if (version !== sessionVersion || !authorized) {
      return;
    }

    unsubscribe = onSnapshot(
      collection(db, "usuarios"),
      snapshot => {
        if (version !== sessionVersion) return;

        users = snapshot.docs.map(documentSnapshot => ({
          ...documentSnapshot.data(),
          uid: documentSnapshot.id
        }));

        const self = users.find(profile => {
          return profile.uid === currentUser.uid;
        });

        if (
          !self ||
          self.estado !== "activo" ||
          self.rol !== "admin"
        ) {
          $("app").hidden = true;
          location.replace("index.html");
          return;
        }

        if (!ready) {
          ready = true;
          $("loading").hidden = true;
          $("app").hidden = false;
        }

        render();
      },
      error => {
        $("app").hidden = true;
        $("loading").hidden = false;

        $("loading").querySelector("p").textContent =
          "NO SE PUDO CARGAR LA INFORMACIÓN";

        toast(
          "Error al consultar usuarios: " +
          error.message
        );
      }
    );
  } catch (error) {
    $("app").hidden = true;
    $("loading").hidden = false;

    $("loading").querySelector("p").textContent =
      "NO SE PUDO VERIFICAR EL ACCESO";

    toast(error.message);
  }
});
