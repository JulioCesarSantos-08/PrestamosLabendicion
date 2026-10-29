import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const monedaResumen = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

const resumen = id => document.getElementById(id);

let versionResumen = 0;
let prestamosResumen = null;
let saldosResumen = null;
let cerrarPrestamosResumen = null;
let cerrarSaldosResumen = null;

function cantidadValida(valor) {
  return Number.isSafeInteger(valor) && valor >= 0;
}

function mostrarImporte(id, valor) {
  const elemento = resumen(id);
  if (elemento) {
    elemento.textContent = monedaResumen.format(valor / 100);
  }
}

function mostrarNota(id, valor) {
  const elemento = resumen(id);
  if (elemento) elemento.textContent = valor;
}

function errorResumen(mensaje) {
  mostrarNota("resCapitalNota", mensaje);
  mostrarNota("resAbonosNota", "No se pudieron verificar los saldos");
  mostrarNota("resRendimientoNota", "Datos no disponibles");
  mostrarNota("resPendienteNota", "Datos no disponibles");

  ["resCapital", "resAbonos", "resRendimiento", "resPendiente"]
    .forEach(id => {
      const elemento = resumen(id);
      if (elemento) elemento.textContent = "—";
    });
}

function limpiarResumen() {
  if (cerrarPrestamosResumen) cerrarPrestamosResumen();
  if (cerrarSaldosResumen) cerrarSaldosResumen();

  cerrarPrestamosResumen = null;
  cerrarSaldosResumen = null;
  prestamosResumen = null;
  saldosResumen = null;
}

function pintarResumen() {
  if (!prestamosResumen || !saldosResumen) return;

  let capitalTotal = 0;
  let capitalCompleto = 0;
  let totalPactado = 0;
  let totalAbonado = 0;
  let totalPendiente = 0;
  let completos = 0;
  let incompletos = 0;

  for (const prestamo of prestamosResumen) {
    const capital = prestamo.capitalCentavos;
    const total = prestamo.totalPactadoCentavos;
    const saldo = saldosResumen.get(prestamo.id);
    const abonado = saldo ? saldo.abonadoCentavos : 0;

    if (cantidadValida(capital)) {
      capitalTotal += capital;
    }

    const completo =
      cantidadValida(capital) &&
      capital > 0 &&
      cantidadValida(total) &&
      total >= capital &&
      cantidadValida(abonado) &&
      abonado <= total;

    if (!completo) {
      incompletos++;
      continue;
    }

    completos++;
    capitalCompleto += capital;
    totalPactado += total;
    totalAbonado += abonado;
    totalPendiente += total - abonado;
  }

  mostrarImporte("resCapital", capitalTotal);
  mostrarImporte("resAbonos", totalAbonado);
  mostrarImporte("resRendimiento", totalPactado - capitalCompleto);
  mostrarImporte("resPendiente", totalPendiente);

  mostrarNota(
    "resCapitalNota",
    `${prestamosResumen.length} préstamos registrados`
  );

  mostrarNota(
    "resAbonosNota",
    `Abonos acumulados de ${completos} préstamos completos`
  );

  mostrarNota(
    "resRendimientoNota",
    "Rendimiento acordado, no ganancias cobradas"
  );

  mostrarNota(
    "resPendienteNota",
    incompletos
      ? `${incompletos} préstamo(s) sin datos completos excluidos`
      : "Todos los préstamos con datos completos"
  );
}

function conectarResumen(version) {
  cerrarPrestamosResumen = onSnapshot(
    collection(db, "prestamos"),
    snapshot => {
      if (version !== versionResumen) return;

      prestamosResumen = snapshot.docs.map(documento => ({
        id: documento.id,
        ...documento.data()
      }));

      pintarResumen();
    },
    error => {
      if (version !== versionResumen) return;
      errorResumen("No se pudieron consultar préstamos: " + error.code);
    }
  );

  cerrarSaldosResumen = onSnapshot(
    collection(db, "saldosPrestamo"),
    snapshot => {
      if (version !== versionResumen) return;

      saldosResumen = new Map(
        snapshot.docs.map(documento => [
          documento.id,
          documento.data()
        ])
      );

      pintarResumen();
    },
    error => {
      if (version !== versionResumen) return;
      errorResumen("No se pudieron consultar saldos: " + error.code);
    }
  );
}

onAuthStateChanged(auth, async usuario => {
  const version = ++versionResumen;
  limpiarResumen();

  if (!usuario) return;

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (version !== versionResumen) return;

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) {
      return;
    }

    conectarResumen(version);
  } catch (error) {
    if (version === versionResumen) {
      errorResumen("No se pudo comprobar el acceso: " + error.code);
    }
  }
});
