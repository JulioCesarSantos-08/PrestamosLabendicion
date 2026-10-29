
import { auth, db } from "./firebase.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const $ = id => document.getElementById(id);

let registerMode = false;
let busy = false;
let registering = false;

function normalizeName(value) {
  return value
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("es-MX");
}

function showMessage(text, type = "error") {
  $("message").textContent = text;
  $("message").className = "message " + type;
}

function clearMessage() {
  $("message").textContent = "";
  $("message").className = "message hidden";
}

function setBusy(value) {
  busy = value;
  $("submitButton").disabled = value;
  $("submitButton").textContent = value
    ? "Procesando..."
    : registerMode
      ? "Crear cuenta"
      : "Iniciar sesión";
}

function changeMode(register) {
  registerMode = register;

  $("tabLogin").classList.toggle("active", !register);
  $("tabRegister").classList.toggle("active", register);
  $("nameField").classList.toggle("hidden", !register);
  $("confirmField").classList.toggle("hidden", !register);
  $("forgotButton").classList.toggle("hidden", register);

  $("formTitle").textContent = register
    ? "Crear cuenta"
    : "Bienvenido";

  $("formDescription").textContent = register
    ? "Regístrate para solicitar acceso al sistema."
    : "Ingresa tus credenciales para continuar.";

  $("fullName").required = register;
  $("fullName").minLength = 12;
  $("fullName").maxLength = 120;
  $("confirmPassword").required = register;

  $("password").autocomplete = register
    ? "new-password"
    : "current-password";

  $("authForm").reset();
  clearMessage();
  setBusy(false);
}

function showStatus(title, description, icon = "⌛") {
  $("authView").classList.add("hidden");
  $("statusView").classList.remove("hidden");
  $("statusTitle").textContent = title;
  $("statusDescription").textContent = description;
  $("statusIcon").textContent = icon;
  $("refreshButton").classList.remove("hidden");
}

function showAuth() {
  $("authView").classList.remove("hidden");
  $("statusView").classList.add("hidden");
}

function friendlyError(error) {
  const errors = {
    "auth/email-already-in-use": "Este correo ya está registrado. Inicia sesión.",
    "auth/invalid-email": "Ingresa un correo electrónico válido.",
    "auth/weak-password": "Utiliza una contraseña más segura.",
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/too-many-requests": "Demasiados intentos. Intenta más tarde.",
    "auth/network-request-failed": "No hay conexión con Firebase.",
    "permission-denied": "No tienes permisos para completar esta operación.",
    "auth/user-disabled": "Esta cuenta está deshabilitada."
  };

  return errors[error.code] ||
    error.message ||
    "Ocurrió un error inesperado.";
}

async function checkAccount(user) {
  if (!user) {
    showAuth();
    return;
  }

  const reference = doc(db, "usuarios", user.uid);
  const snapshot = await getDoc(reference);

  if (!snapshot.exists()) {
    window.location.replace("completar-perfil.html");
    return;
  }

  const data = snapshot.data();

  if (
    data.estado === "rechazado" ||
    data.estado === "deshabilitado"
  ) {
    await signOut(auth);
    showAuth();
    changeMode(false);
    showMessage("Tu cuenta no está autorizada para utilizar este sistema.");
    return;
  }

  if (data.estado !== "activo") {
    showStatus(
      "Esperando autorización",
      "Tu registro está pendiente. El administrador debe aprobar tu cuenta antes de que puedas acceder."
    );
    return;
  }

  if (data.rol === "admin") {
    window.location.replace("admin.html");
    return;
  }

  if (data.rol === "empleado") {
    window.location.replace("empleado.html");
    return;
  }

  showStatus(
    "Sin rol asignado",
    "El administrador todavía no ha asignado un rol a tu cuenta.",
    "🔒"
  );
}

$("fullName").addEventListener("input", event => {
  const input = event.target;
  const start = input.selectionStart;
  const end = input.selectionEnd;

  input.value = input.value.toLocaleUpperCase("es-MX");

  if (start !== null && end !== null) {
    input.setSelectionRange(start, end);
  }
});

$("tabLogin").addEventListener("click", () => {
  changeMode(false);
});

$("tabRegister").addEventListener("click", () => {
  changeMode(true);
});

$("authForm").addEventListener("submit", async event => {
  event.preventDefault();

  if (busy) return;

  const email = $("email").value.trim();
  const password = $("password").value;

  setBusy(true);
  clearMessage();

  try {
    if (registerMode) {
      const nombre = normalizeName($("fullName").value);

      if (nombre.length < 12) {
        throw new Error(
          "El nombre completo debe contener al menos 12 caracteres."
        );
      }

      if (nombre.length > 120) {
        throw new Error("El nombre es demasiado largo.");
      }

      if (password !== $("confirmPassword").value) {
        throw new Error("Las contraseñas no coinciden.");
      }

      registering = true;

      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      await updateProfile(credential.user, {
        displayName: nombre
      });

      await setDoc(
        doc(db, "usuarios", credential.user.uid),
        {
          uid: credential.user.uid,
          nombre,
          correo: credential.user.email,
          telefono: "",
          rol: "pendiente",
          estado: "pendiente",
          creadoEn: serverTimestamp()
        }
      );

      registering = false;

      await checkAccount(credential.user);
    } else {
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

      await checkAccount(credential.user);
    }
  } catch (error) {
    if (registering && auth.currentUser) {
      registering = false;
      showMessage(
        "Tu cuenta se creó, pero no se completó el perfil. Cierra sesión e inicia sesión nuevamente para completar tus datos."
      );
    } else {
      registering = false;
      showMessage(friendlyError(error));
    }
  } finally {
    setBusy(false);
  }
});

$("forgotButton").addEventListener("click", async () => {
  const email = $("email").value.trim();

  if (!email) {
    showMessage("Escribe primero tu correo electrónico.");
    return;
  }

  try {
    await sendPasswordResetEmail(auth, email);
    showMessage(
      "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.",
      "success"
    );
  } catch (error) {
    showMessage(friendlyError(error));
  }
});

$("refreshButton").addEventListener("click", async () => {
  if (!auth.currentUser) {
    showAuth();
    return;
  }

  try {
    await checkAccount(auth.currentUser);
  } catch (error) {
    showStatus(
      "No fue posible verificar tu cuenta",
      friendlyError(error),
      "⚠️"
    );
  }
});

$("logoutButton").addEventListener("click", async () => {
  await signOut(auth);
  showAuth();
  changeMode(false);
});

onAuthStateChanged(auth, async user => {
  if (registering) return;

  if (!user) {
    showAuth();
    return;
  }

  try {
    await checkAccount(user);
  } catch (error) {
    showStatus(
      "Error de verificación",
      friendlyError(error),
      "⚠️"
    );
  }
});

changeMode(false);
