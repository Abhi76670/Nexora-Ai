import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyC9aK71zlNi1CILe4ojfQrkZfZlNhU70M4",
  authDomain: "nexora-ai-34dae.firebaseapp.com",
  projectId: "nexora-ai-34dae",
  storageBucket: "nexora-ai-34dae.firebasestorage.app",
  messagingSenderId: "1044967268625",
  appId: "1:1044967268625:web:3666a4f6c0ce2f2f31ecb0"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
