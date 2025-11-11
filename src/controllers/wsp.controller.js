// controllers/waController.js
import { sendText, sendImage, sendDocument } from "../services/wsp.service.js";

const IMAGE_EXTS = new Set(["jpg","jpeg","png","gif","bmp","png"]);
const DOC_EXTS   = new Set(["pdf","doc","docx","xls","xlsx","ppt","pptx","csv","txt","rtf","zip","rar","7z","json","xml"]);

const norm = v => (String(v || "").match(/\d+/g) || []).join(""); // solo dígitos
const extOf = (v) => {
  if (!v) return null;
  const clean = String(v).split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
};

export async function decideAndSend(req, res) {
  try {
    const b = req.body;

    // ✅ source: primero ENV, si no existe usa el 'from' del payload
    const source = norm(process.env.WSP_SOURCE || b.from);

    // ✅ destination: del contacto/usuario
    const destination = norm(
      b?.Contact?.phone ||
      b?.contact?.phone ||
      b?.to ||
      b?.destination ||
      ""               // no usar 'from' aquí para no invertir roles
    );

    console.log("[ENV] WSP_SOURCE raw:", process.env.WSP_SOURCE);
    console.log("[INFO] src/dst (norm):", source, destination);

    if (!source || !destination) {
      return res.status(400).json({
        ok: false,
        message: "Faltan source o destination tras normalizar.",
        hint: "Revisa .env (WSP_SOURCE sin comillas/espacios) o envía Contact.phone en el payload."
      });
    }

    const hasMedia =
      !!b.AttachmentId || !!b.attachmentId || !!b.attachmentUrl || !!b.url;

    const isText = !hasMedia && typeof b.body === "string" && b.body.trim().length > 0;

    if (isText) {
      const data = await sendText({
        source,
        destination,
        text: b.body,
        previewUrl: true,
        context: b.context,
        srcName: process.env.SRC_NAME || "TedLasso",
      });
      return res.status(200).json({ ok: true, flow: "text", data });
    }

    if (hasMedia) {
      const attachmentId  = b.AttachmentId || b.attachmentId;
      const attachmentUrl = b.attachmentUrl || b.url;
      const filename      = b.filename || b.body || "file";
      const caption       = b.body || b.caption || "";

      const ext = extOf(attachmentUrl) || extOf(filename) || null;
      const kind = ext
        ? (IMAGE_EXTS.has(ext) ? "image" : (DOC_EXTS.has(ext) ? "document" : "unknown"))
        : "unknown";

      if (kind === "image") {
        const data = await sendImage({
          source, destination, caption, attachmentId, attachmentUrl, filename,
          srcName: process.env.SRC_NAME || "TedLasso",
        });
        return res.status(200).json({ ok: true, flow: "image", data });
      }

      const data = await sendDocument({
        source, destination, caption, attachmentId, attachmentUrl, filename,
        srcName: process.env.SRC_NAME || "TedLasso",
      });
      return res.status(200).json({ ok: true, flow: kind === "document" ? "document" : "media-unknown->document", data });
    }

    return res.status(400).json({ ok: false, message: "No se determinó texto ni media." });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok:false, message: err.message, response: err.response?.data || null
    });
  }
}
