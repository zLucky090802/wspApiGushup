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
  params.append("source", '18884050633');
  params.append("destination", '573053534911');
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
export function sendDocument({
    source,
    destination,
    caption,
    attachmentId,
    attachmentUrl,
    filename,
  }) {
    const message = {
        type: "file",
        caption: caption || "",
        filename: filename || "documento.pdf",
        url: attachmentUrl,          // <— clave para file
      };
  
    if (attachmentUrl) {
      // Para documentos: usa `url` (más compatible)
      message.url = attachmentUrl;
      // (Opcional) también puedes incluir estos por compatibilidad cruzada:
      // message.originalUrl = attachmentUrl;
      // message.previewUrl  = attachmentUrl;
    } else if (attachmentId) {
      // Si ya tienes el media subido/hosteado en XCALLY por ID:
      const base = process.env.XCALLY_URL?.replace(/\/$/, "") || "";
      message.url = `${base}/files/${attachmentId}`;
    }
  
    return sendToGupshup({ source, destination, message });
  }
  

  export function sendAudio({
    source,
    destination,
    attachmentUrl,   // URL pública al .mp3/.ogg/.m4a/.aac/.wav
    attachmentId,    // opcional: id de XCALLY (si no tienes URL)
    gupshupMediaId,  // opcional: id de media ya subido en Gupshup (si lo usas)
  }) {
    const message = { type: "audio" };
  
    if (gupshupMediaId) {
      // Si ya tienes el media subido en Gupshup
      message.id = gupshupMediaId;
    } else if (attachmentUrl) {
      // URL directa al audio
      message.url = attachmentUrl;
    } else if (attachmentId) {
      // Construye la URL desde XCALLY si sólo tienes el ID
      const base = process.env.XCALLY_URL?.replace(/\/$/, "") || "";
      message.url = `${base}/files/${attachmentId}`;
    } else {
      throw new Error("Falta attachmentUrl, attachmentId o gupshupMediaId para audio");
    }
  
    return sendToGupshup({ source, destination, message });
  }

  /**
 * Enviar video
 */
export function sendVideo({
    source,
    destination,
    caption,
    attachmentUrl,  // URL pública del mp4
    attachmentId,   // opcional: id en XCALLY si no tienes URL directa
    filename,       // opcional: por si quieres almacenar el nombre del archivo
  }) {
    const message = {
      type: "video",
      caption: caption || filename || "",
    };
  
    if (attachmentUrl) {
      // Caso como el curl de ejemplo: URL directa
      message.url = attachmentUrl;
      message.previewUrl = attachmentUrl;
    } else if (attachmentId) {
      // Caso en el que sólo tienes el ID de XCALLY
      const base = process.env.XCALLY_URL?.replace(/\/$/, "") || "";
      const fileUrl = `${base}/files/${attachmentId}`;
  
      message.url = fileUrl;
      message.previewUrl = fileUrl;
    } else {
      throw new Error("Falta attachmentUrl o attachmentId para video");
    }
  
    return sendToGupshup({
      source,
      destination,
      message,
    });
  }
  
  