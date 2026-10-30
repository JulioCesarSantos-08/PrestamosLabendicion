
import { auth, db } from "./firebase.js";
import { repartoMovimiento } from "./desglose-abonos.js";
import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  addDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);
const categorias = [
  "Gasolina",
  "Mantenimiento de motos",
  "Sueldos y nómina",
  "Renta",
  "Luz y agua",
  "Internet y teléfono",
  "Papelería e insumos",
  "Seguros y trámites",
  "Otros"
];

const formato = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN"
});

let usuario = null;
let gastos = [];
let empleados = [];
let prestamos = [];
let pagos = [];
let gastoEditado = null;
let guardando = false;
let subscripciones = [];
let sesion = 0;

const dinero = centavos => formato.format(centavos / 100);

function hoy() {
  const partes = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "America/Mexico_City"
  }).formatToParts(new Date());

  const dato = tipo => partes.find(p => p.type === tipo)?.value;

  return `${dato("year")}-${dato("month")}-${dato("day")}`;
}

function centavos(valor) {
  const texto = String(valor).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(texto)) return null;

  const partes = texto.split(".");
  const entero = Number(partes[0]);
  const decimales = Number((partes[1] || "").padEnd(2, "0"));

  if (!Number.isSafeInteger(entero)) return null;

  const resultado = entero * 100 + decimales;

  return Number.isSafeInteger(resultado) &&
    resultado > 0 &&
    resultado <= 10000000000
      ? resultado
      : null;
}

function nodo(etiqueta, clase = "", texto = "") {
  const elemento = document.createElement(etiqueta);
  elemento.className = clase;
  elemento.textContent = texto;
  return elemento;
}

function mensaje(texto, error = false) {
  $("mensaje").textContent = texto;
  $("mensaje").style.color = error ? "#a13939" : "#34644e";
}

function fechaValida(valor) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor || "")) return false;
  const fecha = new Date(`${valor}T12:00:00Z`);
  return !Number.isNaN(fecha.getTime()) &&
    fecha.toISOString().slice(0, 10) === valor;
}

function llenarCategorias() {
  for (const categoria of categorias) {
    $("categoria").add(new Option(categoria, categoria));
    $("categoriaFiltro").add(new Option(categoria, categoria));
  }
}

function llenarEmpleados() {
  const seleccionado = $("empleadoId").value;
  $("empleadoId").replaceChildren(
    new Option("Sin empleado", "")
  );

  for (const empleado of empleados.sort((a, b) =>
    (a.nombre || "").localeCompare(b.nombre || "", "es")
  )) {
    $("empleadoId").add(
      new Option(empleado.nombre || empleado.id, empleado.id)
    );
  }

  $("empleadoId").value = seleccionado;
}

function nombreEmpleado(id) {
  return empleados.find(item => item.id === id)?.nombre || "";
}

function enPeriodo(fecha) {
  const desde = $("desde").value;
  const hasta = $("hasta").value;

  return fechaValida(fecha) &&
    (!desde || fecha >= desde) &&
    (!hasta || fecha <= hasta);
}

function listaFiltrada() {
  return gastos.filter(gasto => {
    if (!enPeriodo(gasto.fecha)) return false;

    const categoria = $("categoriaFiltro").value;
    const estado = $("estadoFiltro").value;

    if (categoria && gasto.categoria !== categoria) return false;
    if (estado !== "todos" && gasto.estado !== estado) return false;

    return true;
  }).sort((a, b) =>
    b.fecha.localeCompare(a.fecha) ||
    (b.creadoEn?.toMillis?.() || 0) -
    (a.creadoEn?.toMillis?.() || 0)
  );
}

function interesesPeriodo() {
  const mapa = new Map(prestamos.map(item => [item.id, item]));
  let total = 0;

  for (const pago of pagos) {
    if (!enPeriodo(pago.fechaPago)) continue;

    const prestamo = mapa.get(pago.prestamoId);
    if (!prestamo) continue;

    const desglose = repartoMovimiento(
      prestamo.capitalCentavos,
      prestamo.totalPactadoCentavos,
      pago.montoCentavos,
      pago.saldoPosteriorCentavos
    );

    if (desglose) {
      total += desglose.aInteresesCentavos;
    }
  }

  return total;
}

async function refrescarGastos() {
  try {
    const resultado = await getDocsFromServer(collection(db, "gastos"));

    gastos = resultado.docs.map(documento => ({
      ...documento.data(),
      id: documento.id
    }));

    actualizar();
    return true;
  } catch (error) {
    mensaje(
      `El gasto se guardó, pero no se pudo actualizar el historial: ${error.code || error.message}`,
      true
    );
    return false;
  }
}

function actualizar() {
  const activos = gastos.filter(gasto =>
    gasto.estado === "activo" && enPeriodo(gasto.fecha)
  );

  const egresos = activos.reduce(
    (suma, gasto) => suma + (gasto.importeCentavos || 0),
    0
  );

  const ingresos = interesesPeriodo();

  $("intereses").textContent = dinero(ingresos);
  $("totalGastos").textContent = dinero(egresos);
  $("resultado").textContent = dinero(ingresos - egresos);
  $("cantidad").textContent = String(activos.length);

  $("resultado").style.color =
    ingresos - egresos >= 0 ? "#176b49" : "#ac3939";

  const lista = $("lista");
  lista.replaceChildren();

  const visibles = listaFiltrada();

  if (!visibles.length) {
    lista.append(nodo(
      "p",
      "empty",
      "No hay gastos registrados con estos filtros."
    ));
    return;
  }

  for (const gasto of visibles) {
    const tarjeta = nodo(
      "article",
      "entry" + (gasto.estado === "anulado" ? " anulado" : "")
    );

    const informacion = nodo("div");
    informacion.append(nodo("h3", "", gasto.concepto));
    informacion.append(nodo(
      "p",
      "",
      `${gasto.categoria} · ${gasto.fecha} · ${gasto.medio}`
    ));

    const detalles = [
      nombreEmpleado(gasto.empleadoId),
      gasto.vehiculo,
      gasto.nota
    ].filter(Boolean).join(" · ");

    if (detalles) {
      informacion.append(nodo("p", "", detalles));
    }

    if (gasto.estado === "anulado") {
      informacion.append(nodo(
        "p",
        "",
        `ANULADO: ${gasto.motivoAnulacion || "Sin motivo"}`
      ));
    }

    const lateral = nodo("div");
    lateral.append(nodo(
      "strong",
      "",
      dinero(gasto.importeCentavos || 0)
    ));

    if (gasto.estado === "activo") {
      const botones = nodo("div", "entry-actions");

      const editar = nodo("button", "", "Editar");
      editar.type = "button";
      editar.addEventListener("click", () => abrir(gasto));

      const anular = nodo("button", "", "Anular");
      anular.type = "button";
      anular.addEventListener("click", () => anularGasto(gasto));

      botones.append(editar, anular);
      lateral.append(botones);
    }

    tarjeta.append(informacion, lateral);
    lista.append(tarjeta);
  }
}

function abrir(gasto = null) {
  gastoEditado = gasto;

  $("formGasto").reset();
  $("formError").textContent = "";

  $("tituloModal").textContent =
    gasto ? "Editar gasto" : "Registrar gasto";

  $("guardar").textContent =
    gasto ? "Guardar cambios" : "Guardar gasto";

  $("fecha").value = gasto?.fecha || hoy();
  $("concepto").value = gasto?.concepto || "";
  $("categoria").value = gasto?.categoria || categorias[0];
  $("importe").value = gasto
    ? (gasto.importeCentavos / 100).toFixed(2)
    : "";

  $("medio").value = gasto?.medio || "efectivo";
  $("empleadoId").value = gasto?.empleadoId || "";
  $("vehiculo").value = gasto?.vehiculo || "";
  $("nota").value = gasto?.nota || "";

  $("modal").hidden = false;
  document.body.style.overflow = "hidden";
}

function cerrar() {
  if (guardando) return;
  $("modal").hidden = true;
  document.body.style.overflow = "";
  gastoEditado = null;
}

async function guardar(evento) {
  evento.preventDefault();

  if (guardando || !usuario) return;

  const importe = centavos($("importe").value);
  const fecha = $("fecha").value;
  const concepto = $("concepto").value.trim();
  const categoria = $("categoria").value;
  const empleadoId = $("empleadoId").value;

  if (!importe || !fechaValida(fecha) || concepto.length < 3 ||
      !categorias.includes(categoria)) {
    $("formError").textContent =
      "Verifica concepto, fecha, categoría e importe.";
    return;
  }

  if (empleadoId && !empleados.some(e => e.id === empleadoId)) {
    $("formError").textContent =
      "Selecciona un empleado válido.";
    return;
  }

  const datos = {
    concepto,
    categoria,
    importeCentavos: importe,
    fecha,
    medio: $("medio").value,
    empleadoId,
    vehiculo: $("vehiculo").value.trim(),
    nota: $("nota").value.trim(),
    actualizadoEn: serverTimestamp(),
    actualizadoPor: usuario.uid
  };

  guardando = true;
  $("guardar").disabled = true;
  $("formError").textContent = "";

  try {
    if (gastoEditado) {
      if (gastoEditado.estado !== "activo") {
        throw new Error("No se puede editar un gasto anulado.");
      }

      await updateDoc(doc(db, "gastos", gastoEditado.id), datos);
      if (await refrescarGastos()) mensaje("Gasto actualizado correctamente.");
    } else {
      await addDoc(collection(db, "gastos"), {
        ...datos,
        estado: "activo",
        motivoAnulacion: "",
        creadoEn: serverTimestamp(),
        creadoPor: usuario.uid
      });

      if (await refrescarGastos()) mensaje("Gasto registrado correctamente.");
    }

    guardando = false;
    cerrar();
  } catch (error) {
    $("formError").textContent =
      error.code === "permission-denied"
        ? "Firebase rechazó el registro. Revisa los permisos de gastos."
        : `No se pudo guardar: ${error.message}`;
  } finally {
    guardando = false;
    $("guardar").disabled = false;
  }
}

async function anularGasto(gasto) {
  const motivo = prompt(
    `Motivo para anular "${gasto.concepto}":`
  );

  if (motivo === null) return;

  if (motivo.trim().length < 5 || motivo.trim().length > 300) {
    mensaje("El motivo debe tener entre 5 y 300 caracteres.", true);
    return;
  }

  if (!confirm("¿Confirmas la anulación de este gasto?")) return;

  try {
    await updateDoc(doc(db, "gastos", gasto.id), {
      estado: "anulado",
      motivoAnulacion: motivo.trim(),
      actualizadoPor: usuario.uid,
      actualizadoEn: serverTimestamp()
    });

    mensaje("Gasto anulado. Se conserva en el historial.");
  } catch (error) {
    mensaje(`No fue posible anular: ${error.message}`, true);
  }
}

function exportarCSV() {
  const columnas = [
    "Fecha",
    "Concepto",
    "Categoría",
    "Importe",
    "Medio",
    "Empleado",
    "Vehículo",
    "Estado",
    "Nota",
    "Motivo de anulación"
  ];

  const filas = listaFiltrada().map(gasto => [
    gasto.fecha,
    gasto.concepto,
    gasto.categoria,
    (gasto.importeCentavos / 100).toFixed(2),
    gasto.medio,
    nombreEmpleado(gasto.empleadoId),
    gasto.vehiculo,
    gasto.estado,
    gasto.nota,
    gasto.motivoAnulacion
  ]);

  const escapar = valor =>
    `"${String(valor ?? "").replace(/"/g, '""')}"`;

  const csv = [columnas, ...filas]
    .map(fila => fila.map(escapar).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const enlace = document.createElement("a");
  enlace.href = url;
  enlace.download = "Gastos-La-Bendicion.csv";
  enlace.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function cancelarEscuchas() {
  for (const cancelar of subscripciones) cancelar();
  subscripciones = [];
}

llenarCategorias();

$("nuevoGasto").addEventListener("click", () => abrir());
$("cancelar").addEventListener("click", cerrar);
$("formGasto").addEventListener("submit", guardar);
$("exportar").addEventListener("click", exportarCSV);

for (const id of ["desde", "hasta", "categoriaFiltro", "estadoFiltro"]) {
  $(id).addEventListener("change", actualizar);
}

$("limpiar").addEventListener("click", () => {
  $("desde").value = "";
  $("hasta").value = "";
  $("categoriaFiltro").value = "";
  $("estadoFiltro").value = "activo";
  actualizar();
});

onAuthStateChanged(auth, async cuenta => {
  const version = ++sesion;
  cancelarEscuchas();

  usuario = null;
  gastos = [];
  pagos = [];
  prestamos = [];
  empleados = [];

  $("app").hidden = true;
  $("cargando").hidden = false;

  if (!cuenta) {
    location.replace("index.html");
    return;
  }

  try {
    const perfil = await getDoc(doc(db, "usuarios", cuenta.uid));

    if (version !== sesion) return;

    if (!perfil.exists() ||
        perfil.data().rol !== "admin" ||
        perfil.data().estado !== "activo") {
      location.replace("index.html");
      return;
    }

    usuario = cuenta;

    const escuchar = (nombre, convertir) => {
      const cancelar = onSnapshot(
        collection(db, nombre),
        resultado => {
          if (version !== sesion) return;

          const documentos = resultado.docs.map(documento => ({
            ...documento.data(),
            id: documento.id
          }));

          convertir(documentos);
          actualizar();
        },
        error => {
          mensaje(
            `No fue posible consultar ${nombre}: ${error.message}`,
            true
          );
        }
      );

      subscripciones.push(cancelar);
    };

    escuchar("gastos", documentos => {
      gastos = documentos;
    });

    escuchar("usuarios", documentos => {
      empleados = documentos.filter(u => u.rol === "empleado");
      llenarEmpleados();
    });

    escuchar("prestamos", documentos => {
      prestamos = documentos;
    });

    escuchar("pagos", documentos => {
      pagos = documentos;
    });

    $("cargando").hidden = true;
    $("app").hidden = false;
    actualizar();
  } catch (error) {
    $("cargando").textContent =
      `No se pudo verificar el acceso: ${error.message}`;
  }
});


