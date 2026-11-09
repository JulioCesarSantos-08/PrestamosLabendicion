import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);
const fondoRef = doc(db, "configuracionFondo", "principal");
const moneda = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

let usuario = null;
let fondoActual = null;
let guardando = false;
let cancelarFondo = null;
let cancelarMovimientos = null;

const dinero = centavos => moneda.format(centavos / 100);

function centavos(valor) {
  const texto = String(valor).trim();

  if (!/^\d+(\.\d{1,2})?$/.test(texto)) return null;

  const partes = texto.split(".");
  const resultado = Number(partes[0]) * 100 +
    Number((partes[1] || "").padEnd(2, "0"));

  return Number.isSafeInteger(resultado) &&
    resultado > 0 &&
    resultado <= 1000000000000
    ? resultado
    : null;
}

function datosFondo(datos) {
  const inicial = datos.saldoInicialCentavos;
  const ajustes = datos.ajustesCapitalCentavos || 0;
  const disponible = datos.saldoDisponibleCentavos ?? inicial;
  const operativo = inicial + ajustes;
  const prestado = operativo - disponible;

  if (
    !Number.isSafeInteger(inicial) ||
    !Number.isSafeInteger(ajustes) ||
    !Number.isSafeInteger(disponible) ||
    !Number.isSafeInteger(operativo) ||
    operativo <= 0 ||
    disponible < 0 ||
    prestado < 0
  ) {
    throw new Error("Los saldos del fondo no son válidos.");
  }

  return { inicial, ajustes, disponible, operativo, prestado };
}

function mostrar(datos) {
  fondoActual = datosFondo(datos);

  $("ajustesFondo").hidden = false;
  $("historialFondo").hidden = false;

  $("capitalOperativo").textContent =
    dinero(fondoActual.operativo);

  $("saldoOperativo").textContent =
    dinero(fondoActual.disponible);

  $("capitalPrestado").textContent =
    dinero(fondoActual.prestado);

  previsualizar();
}

function previsualizar() {
  if (!fondoActual) return;

  const monto = centavos($("montoAjusteFondo").value);
  const retiro = $("tipoAjusteFondo").value === "retiro";

  if (monto === null) {
    $("vistaAjusteFondo").textContent =
      "Introduce un importe positivo para ver el resultado.";
    return;
  }

  if (retiro && monto > fondoActual.disponible) {
    $("vistaAjusteFondo").textContent =
      "No se puede retirar " + dinero(monto) +
      ". Solo hay " + dinero(fondoActual.disponible) +
      " disponibles. Hay " + dinero(fondoActual.prestado) +
      " de capital pendiente de recuperar.";
    return;
  }

  const cambio = retiro ? -monto : monto;

  $("vistaAjusteFondo").textContent =
    "Nuevo capital operativo: " +
    dinero(fondoActual.operativo + cambio) +
    ". Nuevo saldo disponible: " +
    dinero(fondoActual.disponible + cambio) + ".";
}

function mostrarHistorial(snapshot) {
  const contenedor = $("listaMovimientosFondo");
  contenedor.replaceChildren();

  if (snapshot.empty) {
    contenedor.textContent = "Aún no hay aportaciones ni retiros.";
    return;
  }

  for (const documento of snapshot.docs) {
    const movimiento = documento.data();
    const fila = document.createElement("div");

    fila.style.padding = "13px 0";
    fila.style.borderBottom = "1px solid #e1e8f1";

    const titulo = document.createElement("strong");
    titulo.textContent =
      (movimiento.tipo === "aporte" ? "Aportación: " : "Retiro: ") +
      dinero(movimiento.montoCentavos);

    const detalle = document.createElement("div");
    detalle.textContent = movimiento.nota || "Sin motivo";
    detalle.style.marginTop = "6px";

    const fecha = document.createElement("small");
    fecha.textContent = movimiento.creadoEn?.toDate
      ? movimiento.creadoEn.toDate().toLocaleString("es-MX")
      : "Sincronizando fecha";

    fila.append(titulo, detalle, fecha);
    contenedor.appendChild(fila);
  }
}

onAuthStateChanged(auth, async sesion => {
  if (cancelarFondo) cancelarFondo();
  if (cancelarMovimientos) cancelarMovimientos();

  usuario = null;
  fondoActual = null;

  if (!sesion) return;

  try {
    const perfil = await getDoc(
      doc(db, "usuarios", sesion.uid)
    );

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) return;

    usuario = sesion;

    cancelarFondo = onSnapshot(
      fondoRef,
      snapshot => {
        if (!snapshot.exists()) return;

        try {
          mostrar(snapshot.data());
          $("mensajeAjusteFondo").textContent = "";
        } catch (error) {
          $("ajustesFondo").hidden = true;
          $("mensajeAjusteFondo").textContent = error.message;
        }
      },
      error => {
        $("mensajeAjusteFondo").textContent =
          "No se pudo consultar el fondo: " + error.message;
      }
    );

    cancelarMovimientos = onSnapshot(
      query(
        collection(db, "movimientosFondo"),
        orderBy("creadoEn", "desc"),
        limit(20)
      ),
      mostrarHistorial,
      error => {
        $("listaMovimientosFondo").textContent =
          "No se pudo consultar el historial: " + error.message;
      }
    );
  } catch (error) {
    $("mensajeAjusteFondo").textContent = error.message;
  }
});

$("montoAjusteFondo").addEventListener("input", previsualizar);
$("tipoAjusteFondo").addEventListener("change", previsualizar);

$("formAjusteFondo").addEventListener("submit", async evento => {
  evento.preventDefault();

  if (!usuario || guardando || !fondoActual) return;

  const tipo = $("tipoAjusteFondo").value;
  const monto = centavos($("montoAjusteFondo").value);
  const nota = $("notaAjusteFondo").value.trim();

  if (
    !["aporte", "retiro"].includes(tipo) ||
    monto === null ||
    nota.length < 5 ||
    nota.length > 150
  ) {
    $("mensajeAjusteFondo").textContent =
      "Comprueba el importe y escribe un motivo de 5 a 150 caracteres.";
    return;
  }

  if (tipo === "retiro" && monto > fondoActual.disponible) {
    $("mensajeAjusteFondo").textContent =
      "Fondos insuficientes para este retiro.";
    return;
  }

  const descripcion = tipo === "aporte" ? "AGREGAR" : "RETIRAR";

  if (!confirm(
    "¿Confirmas " + descripcion + " " + dinero(monto) +
    " del fondo de préstamos? El movimiento quedará registrado."
  )) return;

  guardando = true;
  $("guardarAjusteFondo").disabled = true;
  $("mensajeAjusteFondo").textContent = "";

  try {
    const movimientoRef = doc(collection(db, "movimientosFondo"));

    await runTransaction(db, async transaccion => {
      const snapshot = await transaccion.get(fondoRef);

      if (!snapshot.exists()) {
        throw new Error("El fondo todavía no existe.");
      }

      const actual = datosFondo(snapshot.data());
      const diferencia = tipo === "aporte" ? monto : -monto;

      if (tipo === "retiro" && monto > actual.disponible) {
        throw new Error(
          "No puedes retirar " + dinero(monto) +
          ". Disponible: " + dinero(actual.disponible) +
          ". Capital prestado pendiente: " + dinero(actual.prestado) + "."
        );
      }

      const nuevoCapital = actual.operativo + diferencia;
      const nuevoSaldo = actual.disponible + diferencia;
      const nuevosAjustes = actual.ajustes + diferencia;

      if (
        !Number.isSafeInteger(nuevoCapital) ||
        !Number.isSafeInteger(nuevoSaldo) ||
        !Number.isSafeInteger(nuevosAjustes) ||
        nuevoCapital <= 0 ||
        nuevoCapital > 1000000000000 ||
        nuevoSaldo < 0 ||
        nuevoSaldo > 1000000000000
      ) {
        throw new Error("El ajuste excede los límites del fondo.");
      }

      transaccion.set(movimientoRef, {
        tipo,
        montoCentavos: monto,
        saldoAnteriorCentavos: actual.disponible,
        saldoNuevoCentavos: nuevoSaldo,
        capitalAnteriorCentavos: actual.operativo,
        capitalNuevoCentavos: nuevoCapital,
        nota,
        creadoPor: usuario.uid,
        creadoEn: serverTimestamp()
      });

      transaccion.update(fondoRef, {
        saldoDisponibleCentavos: nuevoSaldo,
        ajustesCapitalCentavos: nuevosAjustes,
        ultimoAjusteFondoId: movimientoRef.id
      });
    });

    $("formAjusteFondo").reset();
    $("vistaAjusteFondo").textContent = "";
    $("mensajeAjusteFondo").textContent =
      "Movimiento registrado correctamente.";
  } catch (error) {
    $("mensajeAjusteFondo").textContent =
      error.code === "permission-denied"
        ? "Firebase rechazó el movimiento. Revisa las reglas."
        : error.message;
  } finally {
    guardando = false;
    $("guardarAjusteFondo").disabled = false;
  }
});
