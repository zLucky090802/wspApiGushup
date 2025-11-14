// src/utils/convertToPdf.js
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TMP_DIR    = path.join(PUBLIC_DIR, 'tmp');

async function ensureDirs() {
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

function safeName(s, fallback = 'file') {
  return (String(s || fallback).replace(/[^\w.\-]/g, '_')) || fallback;
}

export async function downloadToTmp(attachmentUrl, filenameFallback = 'file') {
  await ensureDirs();

  const urlNoQuery = String(attachmentUrl).split(/[?#]/)[0];
  const ext = (urlNoQuery.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const baseName = safeName(filenameFallback);
  const inName = ext ? `${baseName}.${ext}` : baseName;   // p.ej. sample.docx
  const inPath = path.join(TMP_DIR, inName);

  const resp = await axios.get(attachmentUrl, {
    responseType: 'stream',
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
    validateStatus: s => s >= 200 && s < 400, // permite 3xx para seguir redirects
  });

  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(inPath);
    resp.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });

  return inPath;
}

export async function convertToPdf(inputPath, sofficePath = process.env.SOFFICE_PATH || 'soffice')
 {
  await ensureDirs();
  await execFileAsync(sofficePath, [
    '--headless', '--norestore', '--nolockcheck',
    '--convert-to', 'pdf',
    '--outdir', TMP_DIR,
    inputPath,
  ]);
  const outPath = path.join(
    TMP_DIR,
    `${path.basename(inputPath, path.extname(inputPath))}.pdf`
  );
  const st = await fsp.stat(outPath).catch(() => null);
  if (!st || st.size <= 0) throw new Error('La conversión a PDF no generó salida.');
  return outPath;
}

// convierte una URL cualquiera a PDF y devuelve URL pública absoluta
export async function urlToPublicPdf(attachmentUrl, filename, req, sofficePath = 'soffice') {
  // 1) si la URL ya es http(s) a TU server /static, mapea a disco directo (sin descargar por red)
  const host = `${req.protocol}://${req.get('host')}`;
  let inputPath;
  if (attachmentUrl?.startsWith(`${host}/static/`)) {
    const rel = attachmentUrl.split('/static/')[1];
    inputPath = path.join(PUBLIC_DIR, rel);
  } else {
    // 2) descarga a tmp
    inputPath = await downloadToTmp(attachmentUrl, filename || 'file');
  }

  // 3) si ya es pdf, usa tal cual; si no, convierte
  const ext = path.extname(inputPath).toLowerCase();
  let pdfPath = inputPath;
  if (ext !== '.pdf') {
    pdfPath = await convertToPdf(inputPath, sofficePath);
  }

  // 4) construye URL pública absoluta para el PDF
  const relIdx = pdfPath.lastIndexOf(`${path.sep}public${path.sep}`);
  if (relIdx === -1) throw new Error('El PDF resultante no está bajo /public');
  const rel = pdfPath.slice(relIdx + `${path.sep}public${path.sep}`.length).replace(/\\/g, '/');
  const publicUrl = `${host}/static/${rel}`; // absoluta
  const publicName = path.basename(pdfPath);
  return { publicUrl, publicName };
}
