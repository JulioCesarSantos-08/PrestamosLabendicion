
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

const moneda = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

const $ = id => document.getElementById(id);

let version = 0;
let cancelarPrestamos = null;
let cancelarSaldos = null;
let cancelarGastos = null;
let prestamos = null;
let saldos = null;
let gastos = null;

function dinero(centavos) {
  return moneda.format(centavos / 100);
}

function importeValido(valor) {
  return Number.isSafeInteger(valor) && valor >= 0;
}

function distribuir(capital, total, abonado) {
  const recuperado = Number(
    (
      BigInt(abonado) * BigInt(capital) +
      BigInt(total) / 2n
    ) / BigInt(total)
  );

  return {
    capitalRecuperado: recuperado,
    interesesCobrados: abonado - recuperado,
    capitalPendiente: capital - recuperado,
    interesesPendientes: total - capital - (abonado - recuperado)
  };
}

function calcular() {
  if (!prestamos || !saldos || !gastos) return null;

  const resultado = {
    capitalEntregado: 0,
    capitalRecuperado: 0,
    interesesCobrados: 0,
    capitalPendiente: 0,
    interesesPendientes: 0,
    rendimientoPactado: 0,
    totalAbonado: 0,
    saldoPendiente: 0,
    gastosOperativos: 0,
    cantidadGastos: 0,
    resultadoOperativo: 0,
    incompletos: 0,
    validos: 0
  };

  for (const gasto of gastos) {
    const importe = gasto.importeCentavos;
    const estado = typeof gasto.estado === "string"
      ? gasto.estado.toLowerCase()
      : "activo";

    if (
      importeValido(importe) &&
      estado !== "anulado" &&
      estado !== "cancelado" &&
      estado !== "eliminado"
    ) {
      resultado.gastosOperativos += importe;
      resultado.cantidadGastos++;
    }
  }

  for (const prestamo of prestamos) {
    const capital = prestamo.capitalCentavos;
    const total = prestamo.totalPactadoCentavos;
    const saldo = saldos.get(prestamo.id);
    const abonado = saldo ? saldo.abonadoCentavos : 0;

    if (importeValido(capital)) {
      resultado.capitalEntregado += capital;
    }

    if (
      !importeValido(capital) ||
      capital <= 0 ||
      !importeValido(total) ||
      total < capital ||
      !importeValido(abonado) ||
      abonado > total
    ) {
      resultado.incompletos++;
      continue;
    }

    const desglose = distribuir(capital, total, abonado);

    resultado.validos++;
    resultado.capitalRecuperado += desglose.capitalRecuperado;
    resultado.interesesCobrados += desglose.interesesCobrados;
    resultado.capitalPendiente += desglose.capitalPendiente;
    resultado.interesesPendientes += desglose.interesesPendientes;
    resultado.rendimientoPactado += total - capital;
    resultado.totalAbonado += abonado;
    resultado.saldoPendiente += total - abonado;
  }

  resultado.resultadoOperativo =
    resultado.interesesCobrados - resultado.gastosOperativos;

  return resultado;
}

function pintarImporte(id, valor) {
  if ($(id)) $(id).textContent = dinero(valor);
}

function pintarTexto(id, valor) {
  if ($(id)) $(id).textContent = valor;
}

function pintar() {
  const datos = calcular();
  if (!datos) return;

  pintarImporte("contCapital", datos.capitalEntregado);
  pintarImporte("contRecuperado", datos.capitalRecuperado);
  pintarImporte("contIntereses", datos.interesesCobrados);
  pintarImporte("contGastos", datos.gastosOperativos);
  pintarImporte("contResultadoOperativo", datos.resultadoOperativo);
  pintarImporte("contCapitalPendiente", datos.capitalPendiente);
  pintarImporte("contInteresesPendientes", datos.interesesPendientes);
  pintarImporte("contSaldo", datos.saldoPendiente);

  pintarImporte("contReporteRecuperado", datos.capitalRecuperado);
  pintarImporte("contReporteIntereses", datos.interesesCobrados);
  pintarImporte("contReporteCapitalPendiente", datos.capitalPendiente);
  pintarImporte("contReporteInteresesPendientes", datos.interesesPendientes);

  pintarTexto(
    "contNota",
    `${datos.validos} préstamos con datos completos. ` +
    `${datos.incompletos} registros requieren revisión. ` +
    `${datos.cantidadGastos} gasto(s) activos integrados al resumen.`
  );

  pintarTexto(
    "contReporteNota",
    `Desglose proporcional de ${datos.validos} préstamos completos. ` +
    `${datos.incompletos} excluidos por datos incompletos.`
  );
}

function limpiar() {
  if (cancelarPrestamos) cancelarPrestamos();
  if (cancelarSaldos) cancelarSaldos();
  if (cancelarGastos) cancelarGastos();

  cancelarPrestamos = null;
  cancelarSaldos = null;
  cancelarGastos = null;
  prestamos = null;
  saldos = null;
  gastos = null;
}

function mensajeError(mensaje) {
  pintarTexto("contNota", mensaje);
  pintarTexto("contReporteNota", mensaje);
}

function conectar(numero) {
  cancelarPrestamos = onSnapshot(
    collection(db, "prestamos"),
    resultado => {
      if (numero !== version) return;

      prestamos = resultado.docs.map(documento => ({
        id: documento.id,
        ...documento.data()
      }));

      pintar();
    },
    error => {
      if (numero === version) {
        mensajeError("Error consultando préstamos: " + error.message);
      }
    }
  );

  cancelarSaldos = onSnapshot(
    collection(db, "saldosPrestamo"),
    resultado => {
      if (numero !== version) return;

      saldos = new Map(
        resultado.docs.map(documento => [
          documento.id,
          documento.data()
        ])
      );

      pintar();
    },
    error => {
      if (numero === version) {
        mensajeError("Error consultando saldos: " + error.message);
      }
    }
  );

  cancelarGastos = onSnapshot(
    collection(db, "gastos"),
    resultado => {
      if (numero !== version) return;

      gastos = resultado.docs.map(documento => ({
        id: documento.id,
        ...documento.data()
      }));

      pintar();
    },
    error => {
      if (numero === version) {
        mensajeError("Error consultando gastos: " + error.message);
      }
    }
  );
}

onAuthStateChanged(auth, async usuario => {
  const numero = ++version;
  limpiar();

  if (!usuario) return;

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (numero !== version) return;

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) {
      return;
    }

    conectar(numero);
  } catch (error) {
    if (numero === version) {
      mensajeError("Error de acceso: " + error.message);
    }
  }
});

