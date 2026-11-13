# Dashboard patch (apply to `index4.html`)

## 1. Keep a device mapped to the currently selected person

Find the existing `myPerson` change handler near the bottom of `index4.html`:

```js
document.getElementById("myPerson").addEventListener("change",e => {
  if(extraDutyBusy)return;
  selectedPerson = Number(e.target.value);
  extraWorkLoadRequestId++;
  localStorage.setItem("selectedPerson",String(selectedPerson));
  if(firebaseUser){
    updatePushButton();
    resetExtraWorkEditor();
    loadExtraDutyCount();
    loadExtraWorkHistory();
  }
});
```

Replace it with:

```js
document.getElementById("myPerson").addEventListener("change",e => {
  if(extraDutyBusy)return;
  selectedPerson = Number(e.target.value);
  extraWorkLoadRequestId++;
  localStorage.setItem("selectedPerson",String(selectedPerson));
  if(firebaseUser){
    updatePushButton();
    resetExtraWorkEditor();
    loadExtraDutyCount();
    loadExtraWorkHistory();

    // Refresh the FCM token-to-person mapping on this device.
    // Permission has already been granted, so this does not prompt again.
    if("Notification" in window && Notification.permission === "granted"){
      registerPushNotifications().catch(error =>
        console.warn("Could not update this device's notification recipient:", error)
      );
    }
  }
});
```

This ensures that if someone changes the selected household member on a phone,
the existing FCM token is re-associated with that person in `devices`.

## 2. Make the alert confirmation accurate

In `sendTrashFullAlert()`, find:

```js
showAlertStatus(`Alert sent to ${nameOf(dutyIndex)}.`, "ok");
```

Replace it with:

```js
showAlertStatus(`Alert recorded for ${nameOf(dutyIndex)}. Firebase is processing the push notification.`, "ok");
```

A Firestore write confirms that the alert was recorded; it does not itself prove
that a phone received the push notification.
