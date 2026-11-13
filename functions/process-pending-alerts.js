/**
 * GitHub Actions fallback for Spark projects.
 *
 * Runs on a schedule, finds pending trash-full alerts, and sends FCM messages
 * from a trusted environment. Never put the service-account key in the repo.
 */
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const PROJECT_ID = "trash-removal-27506";
const DEVICES = "devices";
const JOBS = "notificationJobs";
const LOCK_MILLIS = 5 * 60 * 1000;

function init() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON GitHub Actions secret.");
  const serviceAccount = JSON.parse(raw);
  initializeApp({ credential: cert(serviceAccount), projectId: PROJECT_ID });
}

function asString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function getDeviceRecords(personIndex) {
  const snapshot = await getFirestore().collection(DEVICES)
    .where("personIndex", "==", personIndex)
    .get();
  const records = [];
  const seen = new Set();
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const token = asString(data.token || doc.id).trim();
    if (token && !seen.has(token)) {
      seen.add(token);
      records.push({ ref: doc.ref, token });
    }
  });
  return records;
}

async function claimJob(jobId, metadata) {
  const ref = getFirestore().collection(JOBS).doc(jobId);
  const claimed = await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const current = snap.data() || {};
      if (current.status === "sent" || current.status === "no_recipients") return false;
      const lockedAt = current.lockedAt instanceof Timestamp ? current.lockedAt.toMillis() : 0;
      if (current.status === "sending" && Date.now() - lockedAt < LOCK_MILLIS) return false;
    }
    tx.set(ref, {
      ...metadata,
      status: "sending",
      lockedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      attempts: FieldValue.increment(1),
    }, { merge: true });
    return true;
  });
  return { ref, claimed };
}

async function removeInvalidTokens(records, responses) {
  const deletions = [];
  responses.forEach((response, index) => {
    if (response.success) return;
    const code = response.error && response.error.code;
    if (code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token") {
      deletions.push(records[index].ref.delete().catch(() => {}));
    } else {
      console.error("FCM send failed for a device:", code || "unknown");
    }
  });
  await Promise.all(deletions);
}

async function sendAlert(alertDoc) {
  const alert = alertDoc.data() || {};
  if (alert.type !== "trash_full" || alert.status !== "pending") return;
  const personIndex = Number(alert.dutyPersonIndex);
  if (!Number.isFinite(personIndex)) {
    console.error("Skipping alert with invalid dutyPersonIndex:", alertDoc.id);
    return;
  }

  const alertId = alertDoc.id;
  const jobId = `alert-created-${alertId}`;
  const { ref: jobRef, claimed } = await claimJob(jobId, {
    eventType: "trash_full",
    alertId,
    personIndex,
  });

  if (!claimed) {
    const job = await jobRef.get();
    const jobData = job.data() || {};
    if (jobData.status === "sent" || jobData.status === "no_recipients") {
      await alertDoc.ref.set({
        push: {
          status: jobData.status,
          recipientTokens: Array.isArray(jobData.sentTokens) ? jobData.sentTokens : [],
          sentAt: jobData.finishedAt || FieldValue.serverTimestamp(),
        },
      }, { merge: true });
    }
    return;
  }

  const records = await getDeviceRecords(personIndex);
  if (!records.length) {
    await jobRef.set({
      status: "no_recipients",
      sentTokens: [],
      finishedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await alertDoc.ref.set({
      push: { status: "no_recipients", recipientTokens: [], sentAt: FieldValue.serverTimestamp() },
    }, { merge: true });
    console.log("Alert has no registered recipient devices:", alertId);
    return;
  }

  const sentTokens = [];
  try {
    const dueDate = asString(alert.dueDate);
    for (const batch of chunks(records, 500)) {
      const title = "🗑️ Trash is full";
      const body = `You are on trash duty${dueDate ? ` for ${dueDate}` : ""}. Please take it out.`;
      const response = await getMessaging().sendEachForMulticast({
        tokens: batch.map((record) => record.token),
        notification: { title, body },
        data: {
          type: "trash_full",
          alertId,
          dueDate,
          eventId: `alert-${alertId}`,
        },
        webpush: {
          notification: { title, body, tag: `alert-${alertId}`, renotify: false },
        },
      });
      response.responses.forEach((item, index) => {
        if (item.success) sentTokens.push(batch[index].token);
      });
      await removeInvalidTokens(batch, response.responses);
    }

    await jobRef.set({
      status: sentTokens.length ? "sent" : "failed",
      sentTokens,
      sentCount: sentTokens.length,
      finishedAt: FieldValue.serverTimestamp(),
      lastError: sentTokens.length ? FieldValue.delete() : "FCM returned no successful deliveries",
    }, { merge: true });
    await alertDoc.ref.set({
      push: {
        status: sentTokens.length ? "sent" : "failed",
        recipientTokens: sentTokens,
        sentAt: FieldValue.serverTimestamp(),
      },
    }, { merge: true });
    console.log("Processed trash alert:", alertId, "successful deliveries:", sentTokens.length);
  } catch (error) {
    await jobRef.set({
      status: "failed",
      lastError: asString(error.message, "FCM send failed"),
      failedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    console.error("Failed to process trash alert:", alertId, error.message);
    throw error;
  }
}

async function main() {
  init();
  const alerts = await getFirestore().collection("alerts")
    .where("status", "==", "pending")
    .get();
  let processed = 0;
  for (const doc of alerts.docs) {
    if (doc.data()?.type !== "trash_full") continue;
    await sendAlert(doc);
    processed += 1;
  }
  console.log("Pending trash-full alerts checked:", processed);
}

main().catch((error) => {
  console.error("Push poller failed:", error.message);
  process.exitCode = 1;
});
