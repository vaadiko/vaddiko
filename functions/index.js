/**
 * VaadPlus — Cloud Functions
 *
 * verifyPlayPurchase:
 *   Callable function. The client (running inside the Play Store TWA) sends
 *   the purchaseToken it received from the Digital Goods API / Payment
 *   Request API after a Google Play subscription purchase. This function
 *   verifies the token against the real Google Play Developer API (server
 *   to server — this cannot be faked from the browser), acknowledges the
 *   purchase (required by Google within 3 days or it auto-refunds), and
 *   only then writes premiumUntil on the building document using the Admin
 *   SDK (which bypasses Firestore security rules).
 *
 * playRTDN:
 *   HTTP function that receives Real-time Developer Notifications from
 *   Google Play via Pub/Sub (renewals, cancellations, expirations) and
 *   keeps premiumUntil in sync automatically without the user opening the
 *   app. Optional but recommended — see the setup guide.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const { google } = require('googleapis');

admin.initializeApp();
setGlobalOptions({ region: 'us-central1' }); // change if your Firestore is elsewhere

const PACKAGE_NAME = 'com.vaadplus.app';
const SUPER_ADMIN_EMAIL = 'vaadplus100@gmail.com';

// Known subscription product IDs configured in Play Console.
// Add more here if you create monthly / other tiers later.
const KNOWN_SUBSCRIPTION_IDS = ['vaadplus_premium_yearly'];

async function getAndroidPublisher() {
  // Uses the Cloud Function's own runtime service account — no key file
  // needed, as long as that service account is granted access in Play
  // Console > Setup > API access (see setup guide).
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });
  const authClient = await auth.getClient();
  return google.androidpublisher({ version: 'v3', auth: authClient });
}

async function isAuthorizedForBuilding(uidEmail, buildingId) {
  const bSnap = await admin.firestore().doc(`buildings/${buildingId}`).get();
  if (!bSnap.exists) return { ok: false, reason: 'building-not-found' };
  const b = bSnap.data();
  const coAdmins = b.coAdmins || [];
  const ok =
    uidEmail === SUPER_ADMIN_EMAIL ||
    uidEmail === b.adminEmail ||
    coAdmins.includes(uidEmail);
  return { ok, building: b };
}

exports.verifyPlayPurchase = onCall(async (request) => {
  const { auth, data } = request;
  if (!auth || !auth.token || !auth.token.email) {
    throw new HttpsError('unauthenticated', 'יש להתחבר כדי לבצע רכישה');
  }

  const { buildingId, purchaseToken, subscriptionId } = data || {};
  if (!buildingId || !purchaseToken || !subscriptionId) {
    throw new HttpsError('invalid-argument', 'חסרים פרטי רכישה');
  }
  if (!KNOWN_SUBSCRIPTION_IDS.includes(subscriptionId)) {
    throw new HttpsError('invalid-argument', 'מזהה מנוי לא מוכר');
  }

  const authCheck = await isAuthorizedForBuilding(auth.token.email, buildingId);
  if (!authCheck.ok) {
    throw new HttpsError('permission-denied', 'אין הרשאה לבניין הזה');
  }

  // Idempotency: if we've already applied this exact purchase token, don't
  // re-charge/re-process it (e.g. if the client retries).
  const purchaseRef = admin
    .firestore()
    .doc(`buildings/${buildingId}/purchases/${purchaseToken}`);
  const existing = await purchaseRef.get();
  if (existing.exists && existing.data().applied) {
    const until = existing.data().premiumUntil;
    return { success: true, premiumUntil: until, alreadyApplied: true };
  }

  const androidpublisher = await getAndroidPublisher();

  let sub;
  try {
    const res = await androidpublisher.purchases.subscriptions.get({
      packageName: PACKAGE_NAME,
      subscriptionId,
      token: purchaseToken,
    });
    sub = res.data;
  } catch (e) {
    console.error('Play API verification failed', e.message);
    throw new HttpsError('internal', 'אימות מול Google Play נכשל');
  }

  // paymentState: 0 = pending, 1 = received, 2 = free trial, 3 = pending deferred upgrade/downgrade
  const validPaymentStates = [1, 2];
  if (!validPaymentStates.includes(sub.paymentState)) {
    throw new HttpsError('failed-precondition', 'התשלום טרם הושלם אצל Google');
  }

  const expiryMillis = parseInt(sub.expiryTimeMillis, 10);
  if (!expiryMillis || expiryMillis < Date.now()) {
    throw new HttpsError('failed-precondition', 'המנוי כבר פג תוקף');
  }

  // Acknowledge — required by Google within 3 days or the purchase is
  // automatically refunded and revoked.
  if (sub.acknowledgementState === 0) {
    try {
      await androidpublisher.purchases.subscriptions.acknowledge({
        packageName: PACKAGE_NAME,
        subscriptionId,
        token: purchaseToken,
        requestBody: {},
      });
    } catch (e) {
      // Not fatal — purchase is still valid, just log it.
      console.warn('Acknowledge failed (may already be acknowledged):', e.message);
    }
  }

  const premiumUntil = admin.firestore.Timestamp.fromMillis(expiryMillis);

  const batch = admin.firestore().batch();
  batch.set(
    admin.firestore().doc(`buildings/${buildingId}`),
    { premiumUntil },
    { merge: true }
  );
  batch.set(
    purchaseRef,
    {
      applied: true,
      subscriptionId,
      orderId: sub.orderId || null,
      expiryTimeMillis: expiryMillis,
      premiumUntil,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      verifiedBy: auth.token.email,
    },
    { merge: true }
  );
  await batch.commit();

  return { success: true, premiumUntil: premiumUntil.toDate().toISOString() };
});

/**
 * Real-time Developer Notifications handler.
 * Requires: Play Console > Setup > API access > enable Real-time developer
 * notifications and point them at a Pub/Sub topic, e.g. "play-rtdn".
 * This function should be subscribed to that same topic.
 *
 * Notification types of interest (subscriptionNotification.notificationType):
 *   2 = RENEWED, 3 = CANCELED, 12 = EXPIRED, 13 = REVOKED
 * On renewal we re-verify with the API (to get the fresh expiry) and update
 * premiumUntil automatically, without the admin needing to open the app.
 */
exports.playRTDN = onMessagePublished('play-rtdn', async (event) => {
  try {
    const payload = JSON.parse(
      Buffer.from(event.data.message.data, 'base64').toString('utf8')
    );
    const notif = payload.subscriptionNotification;
    if (!notif) return; // could be a test/other notification type, ignore

    const androidpublisher = await getAndroidPublisher();
    const res = await androidpublisher.purchases.subscriptions.get({
      packageName: PACKAGE_NAME,
      subscriptionId: notif.subscriptionId,
      token: notif.purchaseToken,
    });
    const sub = res.data;

    // Find which building this purchase token belongs to.
    const purchaseQuery = await admin
      .firestore()
      .collectionGroup('purchases')
      .where('subscriptionId', '==', notif.subscriptionId)
      .get();

    const match = purchaseQuery.docs.find((d) => d.id === notif.purchaseToken);
    if (!match) {
      console.warn('RTDN: no matching purchase found for token', notif.purchaseToken);
      return;
    }
    const buildingRef = match.ref.parent.parent; // buildings/{buildingId}

    const REVOKED_OR_EXPIRED = [12, 13];
    if (REVOKED_OR_EXPIRED.includes(notif.notificationType)) {
      await buildingRef.set({ premiumUntil: admin.firestore.Timestamp.now() }, { merge: true });
      return;
    }

    const expiryMillis = parseInt(sub.expiryTimeMillis, 10);
    if (expiryMillis) {
      await buildingRef.set(
        { premiumUntil: admin.firestore.Timestamp.fromMillis(expiryMillis) },
        { merge: true }
      );
    }
  } catch (e) {
    console.error('RTDN handling failed', e);
  }
});
