import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  doc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const campo = id => document.getElementById(id);

const moneda = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

let version = 0;
let cancelarFondo = null;

function dinero(centavos) {
  return moneda.format(centavos / 100);
}

function mostrarError(mensaje) {
  campo("fondoDisponible").textContent = "—";
  campo("fondoColocado").textContent = "—";
  campo("fondoEstado").textContent = mensaje;
  campo("fondoColocadoNota").textContent =
    "Consulta no disponible";
}

function mostrarFondo(datos) {
  if (!datos) {
    mostrarError("Pendiente de configurar fondo inicial");
    campo("fondoColocadoNota").textContent =
      "Sin fondo configurado";
    return;
  }

  const inicial = datos.saldoInicialCentavos + (datos.ajustesCapitalCentavos || 0);

  const disponible = datos.saldoDisponibleCentavos ??
    inicial;

  if (
    !Number.isSafeInteger(inicial) ||
    !Number.isSafeInteger(disponible) ||
    inicial < 0 ||
    disponible < 0
  ) {
    mostrarError("Los importes del fondo requieren revisión");
    return;
  }

  if (disponible > inicial) {
    mostrarError(
      "El fondo tiene movimientos no contemplados por este resumen"
    );
    return;
  }

  campo("fondoDisponible").textContent = dinero(disponible);
  campo("fondoColocado").textContent =
    dinero(inicial - disponible);

  campo("fondoEstado").textContent =
    "Capital disponible registrado en Firebase";

  campo("fondoColocadoNota").textContent =
    "Capital colocado neto desde la apertura";
}

function limpiar() {
  if (cancelarFondo) cancelarFondo();
  cancelarFondo = null;
}

onAuthStateChanged(auth, async usuario => {
  const numero = ++version;
  limpiar();

  if (!usuario) {
    mostrarError("Sin sesión");
    return;
  }

  try {
    const perfil = await getDoc(
      doc(db, "usuarios", usuario.uid)
    );

    if (numero !== version) return;

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) {
      mostrarError("Acceso no autorizado");
      return;
    }

    cancelarFondo = onSnapshot(
      doc(db, "configuracionFondo", "principal"),
      resultado => {
        if (numero !== version) return;

        mostrarFondo(
          resultado.exists() ? resultado.data() : null
        );
      },
      error => {
        if (numero !== version) return;

        mostrarError(
          "Error consultando el fondo: " +
          (error.code || error.message)
        );
      }
    );
  } catch (error) {
    if (numero !== version) return;

    mostrarError(
      "Error verificando acceso: " +
      (error.code || error.message)
    );
  }
});

