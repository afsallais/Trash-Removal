/**
 * Trash-Removal notification backend.
 *
 * Triggers:
 *  - alerts/{alertId} created: notify devices registered to dutyPersonIndex.
 *  - alerts/{alertId} updated pending -> cancelled: notify the original recipient devices.
 *  - duties/{dueDate} updated incomplete -> complete: notify all registered household devices.
 *
 * Device documents are expected at devices/{FCM_TOKEN} and contain:
 *   token, personIndex, personName, platform
 *
 * The app uses stable person IDs in personIndex, not array positions.
 */
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");

initializeApp();

setGlobalOptions({
  region: "europe-west1",
  maxInstances: 10,
});

const db = getFirestore();
const messaging = getMessaging();
const DEVICES = "devices";
const JOBS = "notificationJobs";
const LOCK_MILLIS = 5 * 60 * 1000;

function asString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function chunks(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function getDeviceRecords(query) {
  const snapshot = await query.get();
  const records = [];
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const token = asString(data.token || doc.id).trim();
    if (token) records.push({ ref: doc.ref, token, data });
  });
  // A token may appear in multiple records due to older registrations.
  const seen = new Set();
  return records.filter((record) => {
    if (seen.has(record.token)) return false;
    seen.add(record.token);
    return true;
  });
}

async function removeInvalidTokens(records, responses) {
  const deletions = [];
  responses.forEach((response, index) => {
    if (response.success) return;
    const code = response.error && response.error.code;
    if (
      code === "messaging/registration-token-not-registered" ||
      code === "messaging/invalid-registration-token"
    ) {
      deletions.push(records[index].ref.delete().catch((error) => {
        logger.warn("Could not remove invalid FCM device token", error);
      }));
    } else {
      logger.warn("FCM send failed for a device", { code, message: response.error?.message });
    }
  });
  await Promise.all(deletions);
}

async function claimJob(jobId, metadata) {
  const ref = db.collection(JOBS).doc(jobId);
  const claimed = await db.runTransaction(async (tx) => {
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
  return claimed ? ref : null;
}

async function sendNotificationJob({ jobId, records, title, body, data, metadata }) {
  const jobRef = await claimJob(jobId, metadata);
  if (!jobRef) {
    logger.info("Notification job already handled or currently locked", { jobId });
    return { sentTokens: [], skipped: true };
  }

  if (!records.length) {
    await jobRef.set({
      status: "no_recipients",
      sentTokens: [],
      finishedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    return { sentTokens: [], skipped: false };
  }

  const sentTokens = [];
  try {
    for (const batch of chunks(records, 500)) {
      const response = await messaging.sendEachForMulticast({
        tokens: batch.map((record) => record.token),
        notification: { title, body },
        data: Object.fromEntries(
          Object.entries(data || {}).map(([key, value]) => [key, asString(value)])
        ),
        webpush: {
          notification: {
            title,
            body,
            tag: asString(data?.eventId || jobId),
            renotify: false,
          },
        },
      });
      response.responses.forEach((item, index) => {
        if (item.success) sentTokens.push(batch[index].token);
      });
      await removeInvalidTokens(batch, response.responses);
    }

    await jobRef.set({
      status: "sent",
      sentTokens,
      sentCount: sentTokens.length,
      finishedAt: FieldValue.serverTimestamp(),
      lastError: FieldValue.delete(),
    }, { merge: true });

    return { sentTokens, skipped: false };
  } catch (error) {
    await jobRef.set({
      status: "failed",
      lastError: asString(error.message, "FCM send failed"),
      failedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.error("Notification job failed", { jobId, error });
    throw error;
  }
}

/**
 * New trash-full alert -> only devices belonging to the assigned duty person.
 */
exports.notifyAssignedPersonOnTrashAlert = onDocumentCreated(
  { document: "alerts/{alertId}", retry: true },
  async (event) => {
    const alert = event.data?.data();
    if (!alert || alert.type !== "trash_full" || alert.status !== "pending") return;

    const personIndex = Number(alert.dutyPersonIndex);
    if (!Number.isFinite(personIndex)) {
      logger.warn("Trash alert has no valid dutyPersonIndex", { alertId: event.params.alertId });
      return;
    }

    const records = await getDeviceRecords(
      db.collection(DEVICES).where("personIndex", "==", personIndex)
    );
    const alertId = event.params.alertId;
    const result = await sendNotificationJob({
      jobId: `alert-created-${alertId}`,
      records,
      title: "🗑️ Trash is full",
      body: `You are on trash duty${alert.dueDate ? ` for ${alert.dueDate}` : ""}. Please take it out.`,
      data: { type: "trash_full", alertId, dueDate: alert.dueDate || "", eventId: `alert-${alertId}` },
      metadata: { eventType: "trash_full", alertId, personIndex },
    });

    if (!result.skipped) {
      await event.data.ref.set({
        push: {
          status: records.length ? "sent" : "no_recipients",
          recipientTokens: result.sentTokens,
          sentAt: FieldValue.serverTimestamp(),
        },
      }, { merge: true });
    }
  }
);

/**
 * Pending -> cancelled: notify the same devices that received the original alert.
 * If the create-trigger metadata was not written (for example, a rapid cancellation),
 * fall back to the currently registered devices for the assigned person.
 */
exports.notifyRecipientsOnAlertCancellation = onDocumentUpdated(
  { document: "alerts/{alertId}", retry: true },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after || before.status !== "pending" || after.status !== "cancelled") return;

    const alertId = event.params.alertId;
    let tokens = Array.isArray(before.push?.recipientTokens) ? before.push.recipientTokens : [];
    let records = [];

    if (tokens.length) {
      // The dashboard stores each device at devices/{FCM_TOKEN}; read those exact
      // documents so cancellation targets the original recipients, not new devices.
      for (const batch of chunks(tokens, 400)) {
        const snapshots = await Promise.all(
          batch.map((token) => db.collection(DEVICES).doc(token).get())
        );
        snapshots.forEach((snap, index) => {
          const token = batch[index];
          records.push({
            ref: snap.ref,
            token,
            data: snap.exists ? (snap.data() || {}) : {},
          });
        });
      }
    } else if (Number.isFinite(Number(after.dutyPersonIndex))) {
      records = await getDeviceRecords(
        db.collection(DEVICES).where("personIndex", "==", Number(after.dutyPersonIndex))
      );
    }

    await sendNotificationJob({
      jobId: `alert-cancelled-${alertId}`,
      records,
      title: "Trash alert cancelled",
      body: "The trash-full alert has been cancelled. No action is required.",
      data: { type: "trash_alert_cancelled", alertId, dueDate: after.dueDate || "", eventId: `alert-cancelled-${alertId}` },
      metadata: { eventType: "trash_alert_cancelled", alertId },
    });
  }
);

/**
 * Duty changes from incomplete to complete -> notify every registered household device.
 */
exports.notifyHouseholdOnDutyCompletion = onDocumentUpdated(
  { document: "duties/{dueDate}", retry: true },
  async (event) => {
    const before = event.data?.before.data() || {};
    const after = event.data?.after.data() || {};
    if (before.completed === true || after.completed !== true) return;

    const dueDate = event.params.dueDate;
    const records = await getDeviceRecords(db.collection(DEVICES));
    await sendNotificationJob({
      jobId: `duty-completed-${dueDate}`,
      records,
      title: "✓ Trash duty completed",
      body: `${asString(after.personName, "The assigned person")} completed the trash duty for ${dueDate}.`,
      data: {
        type: "duty_completed",
        dueDate,
        personName: asString(after.personName),
        eventId: `duty-completed-${dueDate}`,
      },
      metadata: { eventType: "duty_completed", dueDate },
    });
  }
);
