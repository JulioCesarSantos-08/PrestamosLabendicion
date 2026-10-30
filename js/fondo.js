import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  doc,
  getDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);
const referencia = doc(db, "configuracionFondo", "principal");

const moneda = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

let usuarioActual = null;
let cancelar = null;
let aperturaEnProceso = false;

function parsearCentavos(valor) {
  const texto = String(valor).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) return null;
  const partes = texto.split(".");
  const entero = Number(partes[0]);
  const decimales = Number((partes[1] || "").padEnd(2, "0"));
  const total = entero * 100 + decimales;

  return Number.isSafeInteger(total) && total > 0 &&
    total <= 1000000000000 ? total : null;
}

function mostrarFondo(datos) {
  $("cargando").hidden = true;
  $("sinFondo").hidden = !!datos;
  $("conFondo").hidden = !datos;

  if (datos) {
    $("capitalInicial").textContent =
      moneda.format(datos.saldoInicialCentavos / 100);

    $("fechaApertura").textContent = datos.abiertoEn?.toDate
      ? "Fecha de apertura: " +
        datos.abiertoEn.toDate().toLocaleString("es-MX")
      : "Fecha de apertura pendiente de sincronización";
  }
}

onAuthStateChanged(auth, async usuario => {
  if (cancelar) cancelar();
  cancelar = null;
  usuarioActual = null;

  if (!usuario) {
    location.replace("index.html");
    return;
  }

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (!perfil.exists() ||
        perfil.data().rol !== "admin" ||
        perfil.data().estado !== "activo") {
      location.replace("admin.html");
      return;
    }

    usuarioActual = usuario;

    cancelar = onSnapshot(
      referencia,
      resultado => {
        $("estado").textContent = "";
        mostrarFondo(resultado.exists() ? resultado.data() : null);
      },
      error => {
        $("cargando").hidden = true;
        $("estado").textContent =
          "No se pudo consultar el fondo: " + error.code +
          ". Revisa que hayas publicado las reglas.";
      }
    );
  } catch (error) {
    $("cargando").hidden = true;
    $("estado").textContent =
      "No se pudo verificar el acceso: " + error.message;
  }
});

$("formFondo").addEventListener("submit", async evento => {
  evento.preventDefault();

  if (aperturaEnProceso || !usuarioActual) return;

  const monto = parsearCentavos($("cantidad").value);

  if (monto === null) {
    $("errorFondo").textContent =
      "Ingresa un importe positivo válido con máximo dos decimales.";
    return;
  }

  const confirmado = confirm(
    "¿Confirmas la apertura del fondo por " +
    moneda.format(monto / 100) +
    "? Esta apertura solo puede registrarse una vez."
  );

  if (!confirmado) return;

  aperturaEnProceso = true;
  $("abrirFondo").disabled = true;
  $("errorFondo").textContent = "";

  try {
    await runTransaction(db, async transaccion => {
      const actual = await transaccion.get(referencia);

      if (actual.exists()) {
        throw new Error(
          "El fondo ya fue configurado y no puede abrirse nuevamente."
        );
      }

      transaccion.set(referencia, {
        saldoInicialCentavos: monto,
        abiertoEn: serverTimestamp(),
        creadoPor: usuarioActual.uid
      });
    });
  } catch (error) {
    $("errorFondo").textContent =
      error.code === "permission-denied"
        ? "Firebase rechazó la apertura. Verifica las reglas del fondo."
        : error.message;
  } finally {
    aperturaEnProceso = false;
    $("abrirFondo").disabled = false;
  }
});
