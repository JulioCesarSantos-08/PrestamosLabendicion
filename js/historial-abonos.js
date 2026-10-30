
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  where
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { repartoAcumulado, repartoMovimiento } from "./desglose-abonos.js";

const moneda = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

const dinero = valor => moneda.format((Number(valor) || 0) / 100);

let prestamos = [];
let autorizado = false;
let desuscribir = null;
let prestamoActual = null;

function elemento(etiqueta, clase = "", texto = null) {
  const nodo = document.createElement(etiqueta);
  if (clase) nodo.className = clase;
  if (texto !== null) nodo.textContent = String(texto);
  return nodo;
}

function fecha(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor || "")) {
    return "Sin fecha";
  }
  return valor.split("-").reverse().join("/");
}

function abrir(titulo) {
  document.getElementById("historialAbonosTitulo").textContent = titulo;
  document.getElementById("historialAbonosContenido").replaceChildren();
  document.getElementById("historialAbonosModal").hidden = false;
  document.body.style.overflow = "hidden";
}

function cerrar() {
  document.getElementById("historialAbonosModal").hidden = true;
  document.body.style.overflow = "";
}

function crearVentana() {
  const modal = elemento("div", "historial-abonos-overlay");
  modal.id = "historialAbonosModal";
  modal.hidden = true;

  modal.innerHTML = `
    <section class="historial-abonos-dialog" role="dialog" aria-modal="true" aria-labelledby="historialAbonosTitulo">
      <header class="historial-abonos-header">
        <div>
          <small>PRÉSTAMOS LA BENDICIÓN</small>
          <h2 id="historialAbonosTitulo">Historial de abonos</h2>
        </div>
        <button type="button" id="cerrarHistorialAbonos" aria-label="Cerrar">×</button>
      </header>
      <div id="historialAbonosContenido" class="historial-abonos-body"></div>
      <footer class="historial-abonos-footer">
        <button type="button" id="volverHistorialAbonos">Cerrar</button>
      </footer>
    </section>
  `;

  document.body.append(modal);

  document.getElementById("cerrarHistorialAbonos")
    .addEventListener("click", cerrar);

  document.getElementById("volverHistorialAbonos")
    .addEventListener("click", cerrar);

  modal.addEventListener("click", evento => {
    if (evento.target === modal) cerrar();
  });
}

function fila(etiqueta, valor) {
  const contenedor = elemento("div", "historial-abonos-fila");
  contenedor.append(
    elemento("span", "", etiqueta),
    elemento("strong", "", valor)
  );
  return contenedor;
}

async function verRecibo(pago) {
  abrir("Comprobante de abono");

  const contenido = document.getElementById("historialAbonosContenido");
  contenido.textContent = "Consultando comprobante...";

  try {
    const referencia = doc(db, "recibosAbono", pago.id);
    const resultado = await getDoc(referencia);

    if (!resultado.exists()) {
      throw new Error("No se encontró el recibo de este pago.");
    }

    const recibo = resultado.data();
    contenido.replaceChildren();

    const encabezado = elemento("div", "historial-abonos-resumen");
    encabezado.append(
      elemento("span", "", "ABONO REGISTRADO"),
      elemento("strong", "", dinero(recibo.montoCentavos))
    );

    contenido.append(encabezado);
    contenido.append(fila("Cliente", recibo.clienteNombre));
    contenido.append(fila("Préstamo", recibo.folioPrestamo));
    contenido.append(fila("Folio del abono", pago.id));
    contenido.append(fila("Fecha", fecha(recibo.fechaPago)));
    contenido.append(fila("Método", recibo.medio));
    contenido.append(fila("Cobrador", recibo.cobradorNombre));

    const desgloseRecibo = prestamoActual
      ? repartoMovimiento(
          prestamoActual.capitalCentavos,
          prestamoActual.totalPactadoCentavos,
          recibo.montoCentavos,
          recibo.saldoPosteriorCentavos
        )
      : null;

    if (desgloseRecibo) {
      contenido.append(fila("A capital", dinero(desgloseRecibo.aCapitalCentavos)));
      contenido.append(fila("A intereses", dinero(desgloseRecibo.aInteresesCentavos)));
    }
    contenido.append(
      fila("Saldo posterior", dinero(recibo.saldoPosteriorCentavos))
    );

    if (recibo.nota) {
      contenido.append(fila("Observaciones", recibo.nota));
    }

    contenido.append(fila("Atención y aclaraciones", "Cualquier duda o inconveniente, comunicarse al 954 148 9953."));
    const acciones = elemento("div", "historial-abonos-acciones");

    const descargar = elemento("button", "", "Descargar recibo PDF");
    descargar.type = "button";

    descargar.addEventListener("click", () => {
      if (!window.jspdf?.jsPDF) {
        alert("No se pudo cargar el generador de PDF.");
        return;
      }

      const pdf = new window.jspdf.jsPDF();
      pdf.setFillColor(6, 29, 61);
      pdf.rect(0, 0, 210, 42, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(16);
      pdf.setTextColor(255, 255, 255);
      pdf.text("PRESTAMOS LA BENDICION", 105, 19, {
        align: "center"
      });
      pdf.setFontSize(10);
      pdf.text("COMPROBANTE DE ABONO", 105, 29, {
        align: "center"
      });

      const datos = [
        ["Cliente", recibo.clienteNombre],
        ["Prestamo", recibo.folioPrestamo],
        ["Folio de abono", pago.id],
        ["Fecha", fecha(recibo.fechaPago)],
        ["Metodo", recibo.medio],
        ["Cobrador", recibo.cobradorNombre],
        ["Saldo pendiente", dinero(recibo.saldoPosteriorCentavos)]
      ];

      let y = 57;

      for (const [etiqueta, valor] of datos) {
        pdf.setTextColor(90, 105, 125);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(9);
        pdf.text(etiqueta, 15, y);

        pdf.setTextColor(6, 29, 61);
        pdf.setFont("helvetica", "bold");

        const limpio = String(valor || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");

        const lineas = pdf.splitTextToSize(limpio, 93);
        pdf.text(lineas, 98, y);
        y += Math.max(12, lineas.length * 5 + 5);
      }

      pdf.setFillColor(6, 29, 61);
      pdf.roundedRect(15, y + 3, 180, 26, 3, 3, "F");
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(10);
      pdf.text("ABONO RECIBIDO", 21, y + 19);
      pdf.setTextColor(231, 196, 127);
      pdf.setFontSize(18);
      pdf.text(dinero(recibo.montoCentavos), 188, y + 19, {
        align: "right"
      });

      pdf.setTextColor(90, 105, 125);
      pdf.setFontSize(8);
      pdf.text("Dudas o inconvenientes: 954 148 9953", 105, 274, { align: "center" });
      pdf.save(`ABONO-${pago.id}.pdf`);
    });

    const regresar = elemento("button", "", "Volver a los abonos");
    regresar.type = "button";
    regresar.addEventListener("click", () => {
      if (prestamoActual) mostrarHistorial(prestamoActual);
    });

    acciones.append(descargar, regresar);
    contenido.append(acciones);
  } catch (error) {
    contenido.textContent = error.message;
  }
}

async function mostrarHistorial(prestamo) {
  prestamoActual = prestamo;
  abrir("Historial de abonos");

  const contenido = document.getElementById("historialAbonosContenido");
  contenido.textContent = "Consultando pagos registrados...";

  try {
    const [pagosSnapshot, saldoSnapshot] = await Promise.all([
      getDocs(query(
        collection(db, "pagos"),
        where("prestamoId", "==", prestamo.id)
      )),
      getDoc(doc(db, "saldosPrestamo", prestamo.id))
    ]);

    const pagos = pagosSnapshot.docs.map(documento => ({
      ...documento.data(),
      id: documento.id
    }));

    pagos.sort((a, b) => {
      const fechaA = a.creadoEn?.toMillis?.() || 0;
      const fechaB = b.creadoEn?.toMillis?.() || 0;
      return fechaB - fechaA;
    });

    const total = Number(prestamo.totalPactadoCentavos) || 0;

    const abonado = saldoSnapshot.exists()
      ? Number(saldoSnapshot.data().abonadoCentavos) || 0
      : 0;

    const pendiente = total - abonado;

    contenido.replaceChildren();

    contenido.append(
      fila("Cliente", prestamo.clienteNombre),
      fila("Folio del préstamo", prestamo.folio)
    );

    const resumen = elemento("div", "historial-abonos-resumen");
    resumen.append(
      elemento("span", "", `Total abonado · ${pagos.length} movimientos`),
      elemento("strong", "", dinero(abonado)),
      elemento("small", "", `Saldo pendiente: ${dinero(pendiente)}`)
    );

    contenido.append(resumen);

    const desgloseAcumulado = repartoAcumulado(
      prestamo.capitalCentavos,
      prestamo.totalPactadoCentavos,
      abonado
    );

    if (desgloseAcumulado) {
      contenido.append(fila(
        "Capital recuperado",
        dinero(desgloseAcumulado.capitalRecuperado)
      ));

      contenido.append(fila(
        "Intereses cobrados",
        dinero(desgloseAcumulado.interesesCobrados)
      ));

      contenido.append(fila(
        "Capital pendiente",
        dinero(desgloseAcumulado.capitalPendiente)
      ));

      contenido.append(fila(
        "Intereses pendientes",
        dinero(desgloseAcumulado.interesesPendientes)
      ));
    }

    if (!pagos.length) {
      contenido.append(
        elemento("p", "", "Este préstamo todavía no tiene abonos.")
      );
      return;
    }

    for (const pago of pagos) {
      const tarjeta = elemento("article", "historial-abonos-tarjeta");

      const encabezado = elemento("div", "historial-abonos-tarjeta-header");
      encabezado.append(
        elemento("strong", "", dinero(pago.montoCentavos)),
        elemento("span", "", fecha(pago.fechaPago))
      );

      const desgloseMovimiento = repartoMovimiento(
        prestamo.capitalCentavos,
        prestamo.totalPactadoCentavos,
        pago.montoCentavos,
        pago.saldoPosteriorCentavos
      );

      tarjeta.append(encabezado);

      if (desgloseMovimiento) {
        tarjeta.append(fila(
          "A capital",
          dinero(desgloseMovimiento.aCapitalCentavos)
        ));

        tarjeta.append(fila(
          "A intereses",
          dinero(desgloseMovimiento.aInteresesCentavos)
        ));
      }
      tarjeta.append(
        fila("Cobrador", pago.cobradorNombre || "No disponible")
      );
      tarjeta.append(
        fila("Medio", pago.medio || "No especificado")
      );
      tarjeta.append(
        fila("Saldo después", dinero(pago.saldoPosteriorCentavos))
      );

      const boton = elemento("button", "historial-abonos-boton", "Ver recibo");
      boton.type = "button";
      boton.addEventListener("click", () => verRecibo(pago));

      tarjeta.append(boton);
      contenido.append(tarjeta);
    }
  } catch (error) {
    contenido.textContent =
      "No se pudo cargar el historial: " + error.message;
  }
}

function colocarBotones() {
  if (!autorizado) return;

  for (const tarjeta of document.querySelectorAll(".loan-card")) {
    const acciones = tarjeta.querySelector(".loan-control-actions");

    if (!acciones || acciones.querySelector(".historial-abonos-boton")) {
      continue;
    }

    const folio = tarjeta.querySelector(".loan-folio")?.textContent?.trim();
    const prestamo = prestamos.find(item => item.folio === folio);

    if (!prestamo) continue;

    const boton = elemento(
      "button",
      "loan-control-button historial-abonos-boton",
      "Historial de abonos"
    );

    boton.type = "button";
    boton.addEventListener("click", () => mostrarHistorial(prestamo));
    acciones.append(boton);
  }
}

crearVentana();

const observador = new MutationObserver(() => colocarBotones());

const lista = document.getElementById("loanList");

if (lista) {
  observador.observe(lista, {
    childList: true,
    subtree: true
  });
}

onAuthStateChanged(auth, async usuario => {
  autorizado = false;
  prestamos = [];

  if (desuscribir) {
    desuscribir();
    desuscribir = null;
  }

  if (!usuario) return;

  try {
    const perfil = await getDoc(doc(db, "usuarios", usuario.uid));

    if (
      !perfil.exists() ||
      perfil.data().rol !== "admin" ||
      perfil.data().estado !== "activo"
    ) {
      return;
    }

    autorizado = true;

    desuscribir = onSnapshot(collection(db, "prestamos"), resultado => {
      prestamos = resultado.docs.map(item => ({
        id: item.id,
        ...item.data()
      }));

      colocarBotones();
    });
  } catch (error) {
    console.error("No se pudo cargar el historial:", error);
  }
});


