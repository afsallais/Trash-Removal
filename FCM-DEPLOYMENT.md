# Trash-Removal FCM backend

This folder adds Firebase Cloud Functions for the existing dashboard.

## What it does

- New `alerts/{alertId}` with `type: "trash_full"` and `status: "pending"`:
  sends a push to devices whose `personIndex` matches `dutyPersonIndex`.
- Alert transition `pending` -> `cancelled`:
  sends a cancellation push to the original recipient devices.
- Duty transition to `completed: true`:
  sends a completion push to all registered household devices.
- Invalid/unregistered FCM tokens are removed from `devices`.

The functions expect device records at `devices/{token}` with fields:
`token`, `personIndex`, `personName`, `platform`.

The dashboard already writes this shape. Person IDs must remain the stable IDs used in
`dutyPersonIndex` and `personIndex` (not the current array position).

## Deploy

1. Install Node.js 20 and Firebase CLI.
2. From the repository root run:
   `npm install -g firebase-tools`
   `firebase login`
   `firebase use trash-removal-27506`
3. Upgrade the Firebase project to the Blaze plan and attach a billing account if Firebase
   requires it for Cloud Functions deployment.
4. Run:
   `cd functions && npm install`
   `cd .. && firebase deploy --only functions`

The first deployment may ask to enable Cloud Build, Artifact Registry, Cloud Functions,
Eventarc, and/or Cloud Run APIs. Review and approve the Firebase CLI prompts.

## Important operational notes

- The configured Functions region is `europe-west1`. If your Firestore database is in a
  different region, consider deploying Functions near that database.
- Firebase Admin SDK is used only on the trusted server; never place service-account
  private keys in the public GitHub repository.
- `notificationJobs` stores event processing state for duplicate/retry protection.
  Push delivery is not mathematically exactly-once: a process crash after FCM accepts a
  message but before the job is marked sent can cause a retry. The job lock and event
  IDs reduce ordinary duplicate sends.
- Test with two separate devices/person registrations before relying on household alerts.
- This package does not alter existing Firestore data or security rules.
