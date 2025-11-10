// controllers/waController.js
import { sendText, sendImage } from "../services/wsp.service.js";

/**
 * Controlador principal:
 *  - Usa solo los datos del payload que XCALLY manda al Reply URL.
 *  - Identifica automáticamente si el mensaje es de texto o media (AttachmentId, attachmentUrl, url).
 *  - Determina correctamente el source (línea Gupshup) y el destination (usuario).
 */
export async function decideAndSend(req, res) {
  try {
    const b = req.body;

    // 🧩 Determinar origen y destino según el formato del payload de XCALLY
    const source = b.from || b.Contact?.phone || b.contact?.phone;
    const destination = b.Contact?.phone || b.contact?.phone || b.to || b.destination;

    // 🔍 Logs para depuración
    console.log(`[XCALLY PAYLOAD]`, JSON.stringify(b, null, 2));
    console.log(`[INFO] source=${source}, destination=${destination}`);

    // ⚠️ Validación básica
    if (!source || !destination) {
      return res.status(400).json({
        ok: false,
        message: "No se pudieron determinar los números (source y destination).",
        hint: "Verifica que XCALLY esté enviando 'from' y 'Contact.phone'.",
      });
    }

    // 🔎 Detección del tipo de mensaje
    const isMedia =
      !!b.AttachmentId ||
      !!b.attachmentId ||
      !!b.attachmentUrl ||
      !!b.url;
    const isText = !isMedia && typeof b.body === "string" && b.body.trim().length > 0;

    // 🟢 CASO 1: mensaje de texto
    if (isText) {
      console.log(`[FLOW] Enviando texto desde ${source} hacia ${destination}`);

      const text = b.body;
      const data = await sendText({
        source,            // desde el payload
        destination,       // desde el payload
        text,
        previewUrl: true,
        context: b.context, // si XCALLY lo manda
        srcName: process.env.SRC_NAME || "TedLasso",
      });

      return res.status(200).json({
        ok: true,
        flow: "xcally-inbound-text",
        data,
      });
    }

    // 🟠 CASO 2: mensaje con adjunto (imagen, audio, etc.)
    if (isMedia) {
      console.log(`[FLOW] Enviando media desde ${source} hacia ${destination}`);

      const attachmentId = b.AttachmentId || b.attachmentId;
      const caption = b.body || b.caption || "";
      const filename = b.filename || b.body || "file";
      const attachmentUrl = b.attachmentUrl || b.url;

      const data = await sendImage({
        source,
        destination,
        caption,
        attachmentId,
        filename,
        attachmentUrl,
        srcName: process.env.SRC_NAME || "TedLasso",
      });

      return res.status(200).json({
        ok: true,
        flow: "xcally-inbound-media",
        data,
      });
    }

    // 🚫 Si no se reconoce el tipo de mensaje
    return res.status(400).json({
      ok: false,
      message: "No se pudo determinar el tipo de mensaje (texto o media).",
      example: {
        text: {
          from: "18884050633",
          body: "Hola",
          Contact: { phone: "573053534911" },
        },
        media: {
          from: "18884050633",
          body: "Imagen de prueba",
          attachmentUrl: "https://upload.wikimedia.org/wikipedia/commons/3/3f/JPEG_example_flower.jpg",
          Contact: { phone: "573053534911" },
        },
      },
    });
  } catch (err) {
    console.error("[ERROR][decideAndSend]", err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      ok: false,
      message: err.message,
      response: err.response?.data || null,
    });
  }
}
