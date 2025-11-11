import axios from "axios";

/**
 * Envía cualquier mensaje a Gupshup (texto o multimedia)
 */
export async function sendToGupshup({
  source,
  destination,
  message,
  srcName = "TedLasso",
}) {
  const params = new URLSearchParams();
  params.append("channel", "whatsapp");
  params.append("source", source);
  params.append("destination", destination);
  params.append("message", JSON.stringify(message));
  params.append("src.name", srcName);

  try {
    if (!process.env.GUPSHUP_URL || !process.env.APIKEY_GUPSHUP) {
      throw new Error(
        "Faltan variables de entorno: GUPSHUP_URL o APIKEY_GUPSHUP"
      );
    }

    const resp = await axios.post(process.env.GUPSHUP_URL, params, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apikey: process.env.APIKEY_GUPSHUP,
      },
    });

    return resp.data;
  } catch (error) {
    console.log(`[ERROR]: ${error.message}`);
    return error.response?.data;
  }
}

/**
 * Enviar mensaje de texto
 */
export function sendText({ source, destination, text, context }) {
  const message = {
    type: "text",
    text,
    previewUrl: true,
  };

  return sendToGupshup({ source, destination, message });
}

/**
 * Enviar imagen
 */
export function sendImage({
  source,
  destination,
  caption,
  attachmentId,
  attachmentUrl,
  filename,
}) {
  // Construcción correcta según doc oficial Gupshup
  const message = {
    type: "image",
    caption: caption || filename || "",
  };

  if (attachmentUrl) {
    message.originalUrl = attachmentUrl;
    message.previewUrl = attachmentUrl;
  } else if (attachmentId) {
    const base = process.env.XCALLY_URL?.replace(/\/$/, "") || "";
    message.originalUrl = `${base}/files/${attachmentId}`;
    message.previewUrl = `${base}/files/${attachmentId}`;
  }

  return sendToGupshup({
    source,
    destination,
    message,
  });
}

export function sendDocument(
  source,
  destination,
  caption,
  attachmentId,
  attachmentUrl,
  filename
) {
  const message = {
    type: "file",
    caption: caption || "",
    filename: filename || "documento.pdf",
  };

  if (attachmentUrl) {
    message.originalUrl = attachmentUrl;
    message.previewUrl = attachmentUrl;
  } else if (attachmentId) {
    const base = process.env.XCALLY_URL?.replace(/\/$/, "") || "";
    message.originalUrl = `${base}/files/${attachmentId}`;
    message.previewUrl = `${base}/files/${attachmentId}`;
  }

  return sendToGupshup({
    source,
    destination,
    message,
  });
}
