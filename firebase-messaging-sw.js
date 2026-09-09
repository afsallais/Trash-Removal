importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js");

// Must match the firebaseConfig in index4.html exactly.
firebase.initializeApp({
  apiKey: "AIzaSyATlbBQsg6u4uLAfkq3vT9BOVpsLxz8wno",
  authDomain: "trash-removal-27506.firebaseapp.com",
  projectId: "trash-removal-27506",
  storageBucket: "trash-removal-27506.firebasestorage.app",
  messagingSenderId: "826302742550",
  appId: "1:826302742550:web:28dad8c55c892661597537",
});

const messaging = firebase.messaging();

// Fires when a push arrives while the site/app is closed or backgrounded.
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || "🗑️ Trash is full";
  const options = {
    body: payload?.notification?.body || "Please take out the trash.",
    // If you have an app icon hosted alongside index4.html, point to it here, e.g. "/icon-192.png"
  };
  self.registration.showNotification(title, options);
});
