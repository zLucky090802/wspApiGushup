// controllers/waController.js
import { sendText, sendImage, sendDocument, sendAudio } from "../services/wsp.service.js";
import { urlToPublicPdf } from "../utils/convertToPdf.js";

const IMAGE_EXTS = new Set(["jpg","jpeg","png","gif","bmp","webp"]);
const AUDIO_EXTS = new Set(["mp3","ogg","oga","opus","m4a","aac","wav"]);
const norm = v => (String(v || "").match(/\d+/g) || []).join("");
const extOf = (v) => {
  if (!v) return null;
  const clean = String(v).split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
};

export async function decideAndSend(req, res) {
  try {
    const b = req.body;

    // source: siempre tu WABA (si no, fallback a from)
    const source = norm(process.env.WSP_SOURCE || b.from);
    // destination: el usuario (Contact.phone, o to/destination)
    const destination = norm(
      b?.Contact?.phone || b?.contact?.phone || b?.to || b?.destination || ""
    );

    if (!source || !destination) {
      return res.status(400).json({
        ok:false,
        message:"Faltan source o destination tras normalizar."
      });
    }

    const hasMedia = !!b.AttachmentId || !!b.attachmentId || !!b.attachmentUrl || !!b.url;
    const isText = !hasMedia && typeof b.body === "string" && b.body.trim().length > 0;

    // 1) Texto
    if (isText) {
      const data = await sendText({
        source, destination,
        text: b.body,
        previewUrl: true,
        srcName: process.env.SRC_NAME || "TedLasso",
      });
      return res.status(200).json({ ok:true, flow:"text", data });
    }

    // 2) Media
    if (hasMedia) {
      const attachmentId  = b.AttachmentId || b.attachmentId;
      const attachmentUrl = b.attachmentUrl || b.url;
      const filename      = b.filename || b.body || "file";
      const caption       = b.body || b.caption || "";

      const ext = extOf(attachmentUrl) || extOf(filename) || "";

      // 2.a) Imagen
      if (IMAGE_EXTS.has(ext)) {
        const data = await sendImage({
          source, destination, caption,
          attachmentId, attachmentUrl, filename,
          srcName: process.env.SRC_NAME || "TedLasso",
        });
        return res.status(200).json({ ok:true, flow:"image", data });
      }

      // 2.b) Audio
      if (AUDIO_EXTS.has(ext)) {
        const data = await sendAudio({
          source, destination,
          attachmentId, attachmentUrl,
        });
        return res.status(200).json({ ok:true, flow:"audio", data });
      }

      // 2.c) Otros documentos → convertir a PDF y enviar como file
      const { publicUrl, publicName } = await urlToPublicPdf(attachmentUrl, filename, req);
      const data = await sendDocument({
        source, destination,
        caption,
        attachmentUrl: publicUrl,   // URL del PDF servido por /static
        filename: publicName,       // nombre.pdf
        srcName: process.env.SRC_NAME || "TedLasso",
      });
      return res.status(200).json({ ok:true, flow:"document-converted-pdf", data, pdfUrl: publicUrl });
    }

    // 3) No se pudo determinar
    return res.status(400).json({ ok:false, message:"No se determinó texto ni media." });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok:false, message: err.message, response: err.response?.data || null
    });
  }
}
