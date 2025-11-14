// controllers/waController.js
import { sendText, sendImage, sendDocument } from '../services/wsp.service.js';
import { urlToPublicPdf } from '../utils/convertToPdf.js';

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','bmp']);
const norm = v => (String(v || '').match(/\d+/g) || []).join('');
const extOf = v => {
  if (!v) return null;
  const clean = String(v).split(/[?#]/)[0];
  const m = clean.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : null;
};

export async function decideAndSend(req, res) {
  try {
    const b = req.body;

    const source = norm(process.env.WSP_SOURCE || b.from);
    const destination = norm(
      b?.Contact?.phone || b?.contact?.phone || b?.to || b?.destination || ''
    );
    if (!source || !destination) {
      return res.status(400).json({ ok:false, message:'Faltan source o destination tras normalizar.' });
    }

    const hasMedia = !!b.AttachmentId || !!b.attachmentId || !!b.attachmentUrl || !!b.url;
    const isText = !hasMedia && typeof b.body === 'string' && b.body.trim().length > 0;

    // texto
    if (isText) {
      const data = await sendText({
        source, destination, text: b.body, previewUrl: true,
        srcName: process.env.SRC_NAME || 'TedLasso',
      });
      return res.status(200).json({ ok:true, flow:'text', data });
    }

    // media
    if (hasMedia) {
      const attachmentUrl = b.attachmentUrl || b.url;
      const filename      = b.filename || b.body || 'file';
      const caption       = b.body || b.caption || '';

      // si es imagen -> envíala como imagen (no convertir)
      const ext = extOf(attachmentUrl) || extOf(filename) || '';
      if (IMAGE_EXTS.has(ext)) {
        const data = await sendImage({
          source, destination, caption,
          attachmentUrl, filename,
          srcName: process.env.SRC_NAME || 'TedLasso',
        });
        return res.status(200).json({ ok:true, flow:'image', data });
      }

      // cualquier otro tipo -> convertir URL a PDF y enviar como file (url + filename)
      try {
        const { publicUrl, publicName } = await urlToPublicPdf(attachmentUrl, filename, req);
        const data = await sendDocument({
          source,
          destination,
          caption,
          attachmentUrl: publicUrl,       // <- URL del PDF servido por tu /static
          filename: publicName,           // <- nombre.pdf
          srcName: process.env.SRC_NAME || 'TedLasso',
        });
        return res.status(200).json({ ok:true, flow:'document-converted-pdf', data, pdfUrl: publicUrl });
      } catch (e) {
        return res.status(500).json({ ok:false, message:'Error convirtiendo a PDF', detail: e.message });
      }
    }

    return res.status(400).json({ ok:false, message:'No se determinó texto ni media.' });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      ok:false, message: err.message, response: err.response?.data || null
    });
  }
}
