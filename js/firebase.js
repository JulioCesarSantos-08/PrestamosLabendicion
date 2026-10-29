import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAB4LkaYqBTzD9NWV2xPlaX4DFEtn5K4UM",
  authDomain: "opticasdelacosta-17a37.firebaseapp.com",
  databaseURL: "https://opticasdelacosta-17a37-default-rtdb.firebaseio.com",
  projectId: "opticasdelacosta-17a37",
  storageBucket: "opticasdelacosta-17a37.firebasestorage.app",
  messagingSenderId: "516115884632",
  appId: "1:516115884632:web:f379571dab4744918af82d"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { app, auth, db };
