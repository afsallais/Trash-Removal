# Trash-Removal FCM backend

This folder adds Firebase Cloud Functions for the existing dashboard.

## No-Blaze option: GitHub Actions poller

The workflow at `.github/workflows/fcm-poll.yml` checks pending trash-full alerts every five minutes and sends them through FCM. It can send while recipients have closed the webpage, provided their browser/device supports background web push and is online. GitHub's schedule can be delayed, so delivery is not instant or guaranteed to happen exactly at the five-minute mark.

To enable it without deploying Cloud Functions:

1. In Google Cloud IAM, create a service account for this project with **Cloud Datastore User** (`roles/datastore.user`) and **Firebase Cloud Messaging API Admin** (`roles/firebasecloudmessaging.admin`) permissions.
2. Create a JSON key for that service account.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret**. Name it `FIREBASE_SERVICE_ACCOUNT_JSON` and paste the complete JSON key as the value. Do not commit or send this key in chat.
4. Open **Actions → Send pending push alerts** and select **Run workflow**. Confirm it succeeds, then test with a newly created trash-full alert.

The workflow uses the public repository's standard GitHub-hosted runner. GitHub Actions standard runners are free for public repositories. Firestore/FCM usage remains subject to their own free quotas and service limits.

This poller shares `notificationJobs/alert-created-{alertId}` idempotency records with the Cloud Functions implementation. Do not run two unrelated senders without that shared claim, or duplicate notifications can occur.

## Cloud Functions option

For event-driven delivery, deploy the Firebase functions on the Blaze plan. New `alerts/{alertId}` documents with `type: "trash_full"` and `status: "pending"` send a push to devices whose `personIndex` matches `dutyPersonIndex`. Cancellation and duty-completion notifications are also handled by the Cloud Functions.

The functions expect device records at `devices/{FCM_TOKEN}` with fields `token`, `personIndex`, `personName`, and `platform`. Person IDs must remain the stable IDs used in `dutyPersonIndex` and `personIndex` (not the current array position).

## Deploy Cloud Functions

1. Install Node.js 20 and Firebase CLI.
2. From the repository root run:
   `npm install -g firebase-tools`
   `firebase login`
   `firebase use trash-removal-27506`
3. Upgrade the Firebase project to the Blaze plan and attach a billing account if Firebase requires it for Cloud Functions deployment.
4. Run:
   `cd functions && npm install`
   `cd .. && firebase deploy --only functions`

The first deployment may ask to enable Cloud Build, Artifact Registry, Cloud Functions, Eventarc, and/or Cloud Run APIs. Review and approve the Firebase CLI prompts.

## Operational notes

- The configured Functions region is `europe-west1`. If the Firestore database is in a different region, consider deploying Functions near that database.
- Firebase Admin SDK is used only on trusted server workflows; never put service-account private keys in the public GitHub repository or client-side code.
- `notificationJobs` stores event processing state for duplicate/retry protection. Push delivery is not mathematically exactly-once: a process crash after FCM accepts a message but before the job is marked sent can cause a retry.
- Test with two separate devices/person registrations before relying on household alerts.
- This package does not alter existing Firestore data or security rules.
