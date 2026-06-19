// Envío de notificaciones push vía OneSignal (REST API).
// Env-gated: si faltan las llaves, se omite sin romper nada.
//
// Variables de entorno necesarias:
//   ONESIGNAL_APP_ID         (público; el mismo del front)
//   ONESIGNAL_REST_API_KEY   (SECRETO; solo backend)

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

// Targetea por "external id" = el $id del usuario en Appwrite (se setea con
// OneSignal.login(userId) en la app). Así no manejamos tokens de dispositivo.
async function sendPush(externalUserIds, { title, body, data } = {}) {
  const ids = (externalUserIds || []).filter(Boolean);

  if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
    console.log("OneSignal no configurado (faltan ONESIGNAL_*). Push omitido.");
    return null;
  }
  if (ids.length === 0) return null;

  try {
    const res = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        include_aliases: { external_id: ids },
        target_channel: "push",
        headings: { en: title, es: title },
        contents: { en: body, es: body },
        data: data || {},
      }),
    });
    const json = await res.json();
    if (json.errors) console.log("OneSignal errors:", JSON.stringify(json.errors));
    else console.log(`Push enviado a ${ids.length} usuario(s). id:`, json.id);
    return json;
  } catch (e) {
    console.log("sendPush error:", e.message);
    return null;
  }
}

module.exports = { sendPush };
