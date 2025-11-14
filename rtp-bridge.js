// rtp-bridge.js — LinkedIP µ-law v11 (suave, sin mordidas)
// • WS Realtime: g711_ulaw (8 kHz) — sin resampling, sin endian
// • Asterisk UnicastRTP: ulaw (PT=0) — 20 ms por paquete (160 bytes)
// • Pacing: 1 frame cada 20 ms (sin ráfagas)
// • Preroll: 60 ms de silencio al inicio del turno (3 frames 0xFF)
// • Post-roll: 40 ms de silencio al final del turno (2 frames 0xFF)
// • Marker bit (M=1) en el 1er frame de VOZ de cada turno
// • VAD del servidor suavizado
// • Limpieza robusta de bridge/unicast/rtp

require('dotenv').config();

const dgram = require('dgram');
const crypto = require('crypto');
const WebSocket = require('ws');
const AriClient = require('ari-client');

// ======= ENV =======
const {
  OPENAI_API_KEY,
  OPENAI_REALTIME_MODEL = 'gpt-4o-realtime-preview-2024-12-17',

  ARI_URL = 'http://127.0.0.1:8088',
  ARI_USER = 'ai',
  ARI_PASS = 'supersegura',
  ARI_APP  = 'ai-call',

  RTP_BIND_IP   = process.env.RTP_BIND_IP || '0.0.0.0',
  RTP_BIND_PORT = process.env.RTP_BIND_PORT ? parseInt(process.env.RTP_BIND_PORT, 10) : 0, // 0=dinámico

  // pacing (recomendado: true)
  PACE_RTP = (process.env.PACE_RTP || 'true').toLowerCase(),

  // tuning de preroll/post-roll (frames de 20 ms cada uno)
  PREROLL_FRAMES  = parseInt(process.env.PREROLL_FRAMES  || '3', 10), // 60 ms
  POSTROLL_FRAMES = parseInt(process.env.POSTROLL_FRAMES || '2', 10), // 40 ms

  DEBUG_BOOT_GREETING = (process.env.DEBUG_BOOT_GREETING || 'false').toLowerCase(),
} = process.env;

if (!OPENAI_API_KEY) {
  console.error('[fatal] Falta OPENAI_API_KEY en .env');
  process.exit(1);
}

// ======= UTIL =======
const now = () => new Date().toISOString();
const j = (err) => {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return JSON.stringify(
    { message: err.message, status: err.status, data: err.data, body: err.body, stack: err.stack },
    null, 2
  );
};
const log = (lvl, msg, obj) =>
  console[lvl](`[${now()}] [${lvl}] ${msg}${obj ? ' ' + (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)) : ''}`);

// ======= RTP CONSTS (G.711 µ-law 8 kHz) =======
const SAMPLE_RATE = 8000;
const BYTES_PER_SAMPLE = 1;
const FRAME_MS = 20;
const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 160
const FRAME_BYTES   = FRAME_SAMPLES * BYTES_PER_SAMPLE; // 160
const ENOUGH_BYTES_100MS = 800; // ~100 ms @ 8 kHz

// ======= WS / ARI =======
let ws = null;
let wsReady = false;
let ari = null;

// ======= Estado por llamada =======
let rtpSock = null;
let localRtpPort = null;
let outIp = null;
let outPort = null;
let learnedDest = false;
let OUT_PT = null;   // debe quedar 0 (PCMU), igual lo aprendemos
let seq = 0;
let ts  = 0;
let ssrc = 0;

let haveAnyAudio = false;
let lastAudioAt = 0;
let inputBytesAccum = 0;
let silenceTimer = null;
let responseInFlight = false;

// Talkspurt/pacing
let markerNext = true;      // M-bit en el primer frame de VOZ
let prerollSent = false;    // preroll de inicio enviado
let outResidual = Buffer.alloc(0); // <160 bytes pendientes
let txQueue = [];           // cola de frames de 160 B
let pacer = null;           // setInterval 20 ms
let playingNow = false;     // estamos reproduciendo (evita autoprompts mientras habla la IA)

// Limpieza
let currentBridgeId = null;
let currentSipChanId = null;
let currentUnicastChanId = null;

// ======= WebSocket (OpenAI Realtime) =======
function connectWS() {
  return new Promise((resolve) => {
    const url = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;
    log('info', `Conectando WS -> ${url}`);

    ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1', // preview
      },
    });

    ws.on('open', () => {
      wsReady = true;
      log('info', '✅ WS conectado con OpenAI Realtime');

      // IMPORTANTE: cadenas; g711_ulaw soportado
      sendWS({
        type: 'session.update',
        session: {
          input_audio_format:  'g711_ulaw',
          output_audio_format: 'g711_ulaw',
          voice: 'alloy',
          // VAD más amigable (no corta sílabas)
          intructions:`LINKEDIP AI ASSISTANT PROMPT
Professional Voicebot Assistant for LinkedIP
GENERAL BEHAVIOR

Responses must always be brief, clear, and professional

Even for complex topics, reply with summarized key points (e.g., price, steps, solution)

Avoid repeating information, examples, or long explanations unless the user explicitly asks

Greet the user only once at the beginning. Do not greet again later in the conversation

Focus only on relevant information to reduce token usage

Always ask for and record early in the conversation:

Full name

Email address

Contact number

==================================================
UNIVERSAL HANDLING & SUMMARY LOGIC
Once the assistant receives the following:

Full name

Valid or auto-corrected email address (see below)

Contact number (optional but preferred)

A short description of the issue, request, or interest

Then, without asking additional questions, the assistant must:

Confirm follow-up with:

“Thanks. A team member will contact you shortly.”

Immediately generate the summary, using the standard format.

This behavior applies to:

Technical Support

Billing inquiries

Sales/product interest

General consultations

If any of the required data (name, email, or issue description) is missing:

Prompt the user for the missing data clearly and professionally

Only proceed to summary once enough information is collected

If reconstruction of the email fails, use “Email not recognized” in the summary


==================================================
Auto-Completion Rules for Email Addresses
When detecting a user-spoken or incomplete email address:

If the “@” symbol is missing → insert it between username and domain

If the domain is unclear or missing → default to @gmail.com

If user says “gmail com”, “dot com”, “at gmail”, etc., auto-convert to @gmail.com

Examples:

sofia gmail com → sofia@gmail.com

juanperez at outlook dot com → juanperez@outlook.com

carla at → carla@gmail.com

Once reconstructed, confirm:

“I detected your email as [corrected_email]. Is that correct? If not, please spell it out letter by letter.”

If the email cannot be reconstructed confidently, ask:

“I wasn’t able to capture your email clearly. Could you please repeat it letter by letter?”


==================================================

At the end of the conversation, your main goal is to generate a Markdown-format email summary based on the interaction.

Only generate this summary if one of the following is clearly detected:

Closure Triggers (conversation-ending conditions):
The user expresses clear intent to end, using phrases like:

“Thank you, that’s all”

“That’s everything I needed”

“I’m done for now”

“Bye”, “Goodbye”, “Nos vemos”, “Hasta luego”, “OK then”, “I’m good”, “All set”, “Eso es todo”, etc.

The user confirms service interest or resolution (e.g., agrees to a sales rep follow-up or confirms issue resolved)
AND does not ask any additional question in the next message or turn.

Do NOT end the session if the user only says:
“Thanks”, “Thank you”, “Gracias”

“OK”, “Got it”, “Perfect”

Any brief acknowledgment without closure intent

If unsure, ask:

“Would you like help with anything else before I summarize our conversation?”

Final Response Structure (when closure is confirmed):
When generating the final response, use this order:

Friendly and brief farewell message
Example:

Thank you for reaching out to LinkedIP. If you need anything else, don’t hesitate to contact us. Have a great day!

Then display the Markdown summary:
Whisper Transcript Summary  
Customer Name: [Full name]  
Phone: [Phone number or “Not provided”]  
Email: [Email address]  

Summarized Issue  
[Short summary of the user's request or problem]  

Related Product/Service  
[VoIP, XCALLY, Remote Staffing, etc.]  

When It Happened  
Received transcription: [Insert today’s date automatically in MM/DD/YYYY format]

Troubleshooting Already Tried  
[If mentioned by user]  

Additional Notes  
[Any other helpful details or context provided]

==================================================

ABOUT LINKEDIP (BRIEF DEFAULT INTRO)

When someone asks “What do you do?” or “What services do you offer?”, reply with:

Hello [Name], thank you for contacting LinkedIP.
We offer cloud-based solutions such as:

Telephony (VoIP, PBX, DIDs)

Omnichannel Contact Center (WhatsApp, social media, webchat)

Remote Agents (Staffing/BPO)

Video, SMS, cybersecurity, and integrations

Everything is unified in one platform with simple monthly pricing.
May I have your full name, email, and contact number to better assist you?



==================================================

MANDATORY CONTACT INFO

Always ask for and collect:

Full name

Email address

Mobile or contact number

Do not proceed to resolve requests without at least name and email.

Email Structure Validation and Autocompletion
If the user provides an email address with any of the following issues:

Missing the “@” symbol

Missing domain (e.g., only says “gmail”)

Missing or mispronounced “.com” (e.g., “gmailcom”, “gmail dot com”)

Mentions only the user part (e.g., “juanperez at”)

Uses phonetic versions of symbols or domains (“at”, “dot com”, “g mail”, etc.)

Then follow this process:

Apply phonetic replacements automatically
Replace phrases like:

“at”, “a t”, “arroba”, “aroba” → @

“dot com”, “punto com”, “kom”, “kum” → .com

Reconstruct the email if possible
Examples:

“juanperez gmail com” → juanperez@gmail.com

“sofia at outlook dot com” → sofia@outlook.com

If the domain is missing or unclear, default to:

@gmail.com

Politely confirm the result with the user

Example:
“I detected your email as juanperez@gmail.com. Is that correct? If not, please spell it out letter by letter.”

If the email cannot be reconstructed clearly, respond with:

“I wasn’t able to capture your email clearly. Could you please repeat it letter by letter?”

==================================================

PRICING RESPONSE LOGIC

-If the user asks about pricing, monthly cost, rates, or how much something costs — even indirectly — always respond using the Pricing Summary section below.

-Always treat messages like the following as pricing inquiries:
“pricing”, “prices”, “cost”, “how much”, “cuánto cuesta”, “precio”, “tarifas”, “fee”, “rate”, “plans”, “mensual”, “plans pls”, “pricing info”, “how much is it?”, “costo”

-When a pricing-related question is detected:

Respond with the appropriate pricing information clearly.

Then ask the user if they want to be contacted by a sales representative.

==================================================

PRICING SUMMARY
Unified Communications

$100/month for 3 users

$25/month per extra user

Volume/term discounts available

Omnichannel (XCALLY)

$500/month for 5 users

Remote Staffing / BPO

$1,500/month per agent (3-month min.)

DIDs & Numbers

Toll-Free: $25/month (1,000 mins)

Local: from $5/month

Intl: $10–$25/month (1 channel incl.)

Extra channel: +$25/month

SIP Trunks

Based on usage, per-minute or per-channel

AnyMeeting

$10/month (video), $50/month (webinars)

==================================================

SOLUTIONS, SERVICES & PRODUCTS

VoIP calls & SIP trunks (per-minute & per-channel)

Business phone systems & Cloud PBX

Local, toll-free, and international DIDs

IVRs & Mobile apps for voice/SMS

Predictive/progressive/power/preview dialers

SMS, MMS, eFax & video conferencing

WhatsApp Business, Instagram, Facebook messaging

Team chat, email & web chat

Conversational AI & automation

XCALLY Omnichannel Platform

Bria softphone, Cisco IP phones

CORO Cybersecurity

PortaOne Portabilling

Remote employees & staffing

Professional support & custom integrations

Telecom billing and WhatsApp API consultancy

==================================================

CORE VALUES

Service Excellence

Support and Diligence

Innovation

Tagline: Linking People With Digital

Vision: We believe business success relies on superior customer care via phone, instant messaging, video, and digital channels.

==================================================

CONTACT INFORMATION

Main: 1-800-969-0164

Local: 305-424-2400

Address: 2645 Executive Park Drive, Suite 319, Weston, FL 33331

Hours:

Mon–Fri: 9 AM – 5 PM EST

Sat: 10 AM – 1 PM EST

Sun & U.S. Holidays: Closed

==================================================

FOUNDERS & TEAM
Founders:

Rosa Garrido

Miguel Licero

Key Staff:

Fernando Ortega

Danie Espitia

Duver Vergara

Stephanie Cuevas

Valerie Vanegas

Heydy Gonzalez

Rosa Vergara

==================================================

HANDLING INQUIRIES

Sales
Ask:

Full name, company, phone, email

Solution needed? (UC, Omnichannel, BPO?)

How many users? (if UC/Omnichannel)

What kind of support? (if BPO)
Conclude:

“Thanks! A LinkedIP professional will contact you shortly.”

Technical Support
Ask:

Full name, company, email, phone (optional)

Product involved (PBX, XCALLY, integration, etc.)

Short description of the issue

Billing
Ask:

Full name, company, email

Phone (optional), invoice number (optional)

Reason for billing inquiry

==================================================

HANDLING COMMUNICATION ERRORS (FOR NON-NATIVE ENGLISH SPEAKERS)

Always try to identify at least one recognizable word in the user’s message, even if it's incomplete, mispronounced, or misspelled.

Use the recognized word to respond helpfully or ask a clarifying question.

Interpret and auto-correct common phonetic/spelling mistakes:
Example: “watsap” → “WhatsApp”, “menzaje” → “message”, “truncal” → “trunk”

If unclear, ask a polite clarification using the word you understood.
Example: “Did you mean ‘message’?” or “Is this about WhatsApp?”

Never interrupt or correct in a robotic tone.
Always respond with warmth and patience to ensure user comfort.

==================================================

PRONUNCIATION FLEXIBILITY

Be tolerant and understanding of foreign accents, especially Latin American or international speakers communicating in English.

Examples of what to handle naturally:
“hows moch” → “how much”
“preices” or “praices” → “prices”
“fesebook” → “Facebook”
“guatsap” or “watsap” → “WhatsApp”

If a word is pronounced or transcribed phonetically, map it to the most probable intended word.

If a sentence contains mixed English and Spanish (Spanglish), respond in English based on the English parts, and offer polite clarification if needed.

Always aim to understand and assist, even when grammar, pronunciation, or word structure is incorrect.

==================================================`,
          turn_detection: {
            type: 'server_vad',
            threshold: 0.33,
            prefix_padding_ms: 400,   // +colchón al inicio
            silence_duration_ms: 850, // cierra sin “morder” finales
          },
        },
      });

      if (!silenceTimer) silenceTimer = setInterval(scheduleTurnIfSilence, 200);
      resolve();
    });

    ws.on('message', handleWsMessage);
    ws.on('error', (e) => log('error', '[WS ERROR from OpenAI]', j(e)));
    ws.on('close', () => { wsReady = false; log('warn', 'WS cerrado'); });
  });
}

function sendWS(msg) {
  if (wsReady && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleWsMessage(data) {
  try {
    const evt = JSON.parse(data.toString());

    // === Audio OUT del modelo (µ-law crudo 8 kHz) ===
    if ((evt.type === 'response.output_audio.delta' || evt.type === 'response.audio.delta') &&
        (evt.audio || evt.delta)) {
      const base64 = evt.audio || evt.delta;
      const chunk = Buffer.from(base64, 'base64'); // g711 µ-law @ 8 kHz
      enqueueUlawFrames(chunk);
      playingNow = true;
      return;
    }

    // Texto incremental (debug)
    if ((evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') ||
        (evt.type === 'response.text.delta' && typeof evt.delta === 'string')) {
      log('debug', `[TXT] ${evt.delta}`);
      return;
    }

    // Cierre de audio: añade post-roll (2 frames por defecto)
    if (evt.type === 'response.audio.done' || evt.type === 'response.output_audio.done') {
      if (outResidual.length > 0) {
        const pad = Buffer.alloc(FRAME_BYTES - outResidual.length, 0xFF);
        enqueueUlawFrames(pad);
        outResidual = Buffer.alloc(0);
      }
      if (POSTROLL_FRAMES > 0) {
        const post = Buffer.alloc(FRAME_BYTES * POSTROLL_FRAMES, 0xFF);
        enqueueUlawFrames(post);
      }
      log('debug', 'WS evt: response.audio.done');
      // playingNow se pondrá a false cuando vacíe la cola
      return;
    }

    if (evt.type === 'input_audio_buffer.committed') log('debug', 'input_audio_buffer.committed');
    if (evt.type === 'response.created')             log('info',  'response.created');
    if (evt.type === 'response.completed' || evt.type === 'response.done') log('info', 'response.done');
    if (evt.type === 'error')                        log('error', '[WS ERROR from OpenAI]', JSON.stringify(evt, null, 2));

  } catch (e) {
    log('error', 'Error parseando WS', j(e));
  }
}

// ======= RTP SOCKET =======
async function initRtpSocket() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => { log('error', `RTP socket error: ${j(err)}`); reject(err); });

    sock.on('listening', () => {
      const addr = sock.address();
      localRtpPort = addr.port;
      log('info', `RTP escuchando en ${RTP_BIND_IP}:${localRtpPort}`);
      resolve(sock);
    });

    sock.on('message', (buf, rinfo) => {
      if (!learnedDest) {
        outIp = rinfo.address;
        outPort = rinfo.port;
        learnedDest = true;
        log('info', `Destino RTP aprendido -> ${outIp}:${outPort}`);
      }
      if (buf.length <= 12) return;

      if (OUT_PT === null) {
        OUT_PT = buf[1] & 0x7f;
        log('info', `Payload Type aprendido desde Asterisk: ${OUT_PT}`); // esperado: 0 (PCMU)
      }

      // µ-law: sube el payload tal cual al WS
      const payload = buf.subarray(12);

      haveAnyAudio = true;
      inputBytesAccum += payload.length; // 1 byte por muestra @ 8k
      lastAudioAt = Date.now();

      sendWS({
        type: 'input_audio_buffer.append',
        audio: payload.toString('base64'),
      });
    });

    sock.bind({ address: RTP_BIND_IP, port: RTP_BIND_PORT });
  });
}

// ======= Cola + pacing µ-law =======
function enqueueUlawFrames(chunk) {
  if (!learnedDest || OUT_PT === null || !rtpSock) return;

  // 1) Preroll (una sola vez por turno)
  if (!prerollSent && PREROLL_FRAMES > 0) {
    const silence = Buffer.alloc(FRAME_BYTES * PREROLL_FRAMES, 0xFF);
    for (let off = 0; off < silence.length; off += FRAME_BYTES) {
      txQueue.push(silence.subarray(off, off + FRAME_BYTES)); // M=0
    }
    prerollSent = true;
  }

  // 2) Particiona en frames de 160 B, conservando residual
  let data = outResidual.length ? Buffer.concat([outResidual, chunk]) : chunk;
  let offset = 0, queued = 0;
  while (offset + FRAME_BYTES <= data.length) {
    txQueue.push(data.subarray(offset, offset + FRAME_BYTES));
    offset += FRAME_BYTES;
    queued += FRAME_BYTES;
  }
  outResidual = data.subarray(offset);

  if (queued > 0) log('debug', `🧃 Encolados ${queued} bytes µ-law`);

  // 3) Arranca el pacer si no está
  if (PACE_RTP === 'true' && !pacer) startPacer();
  if (PACE_RTP !== 'true') flushQueueNow();
}

function startPacer() {
  pacer = setInterval(() => {
    if (!rtpSock || !learnedDest || OUT_PT === null) return;

    // Solo 1 frame por tick para no generar ráfagas
    const frame = txQueue.shift();
    if (frame) {
      sendOneRtpFrameUlaw(frame);
    } else {
      // cola vacía: ya terminó la locución
      playingNow = false;
    }
  }, FRAME_MS);
}

function stopPacer() {
  if (pacer) { clearInterval(pacer); pacer = null; }
  txQueue = [];
}

function flushQueueNow() {
  let sent = 0;
  while (txQueue.length) {
    sendOneRtpFrameUlaw(txQueue.shift());
    sent += FRAME_BYTES;
  }
  if (sent > 0) log('debug', `🔊 Enviados ${sent} bytes µ-law (sin pacing) a ${outIp}:${outPort} (PT=${OUT_PT})`);
}

function sendOneRtpFrameUlaw(frame) {
  if (!frame || frame.length !== FRAME_BYTES) return;

  const hdr = Buffer.alloc(12);
  hdr[0] = 0x80; // V=2,P=0,X=0,CC=0
  hdr[1] = ((markerNext ? 0x80 : 0x00) | (OUT_PT & 0x7f)); // M-bit en primer frame de VOZ
  hdr.writeUInt16BE((seq = (seq + 1) & 0xffff), 2);
  hdr.writeUInt32BE(ts, 4);
  hdr.writeUInt32BE(ssrc, 8);
  ts = (ts + FRAME_SAMPLES) >>> 0;

  rtpSock.send(Buffer.concat([hdr, frame]), outPort, outIp);

  if (markerNext) markerNext = false;
}

// ======= CONTROL DE TURNOS =======
function enoughAudio() { return inputBytesAccum >= ENOUGH_BYTES_100MS; }

function scheduleTurnIfSilence() {
  // No dispares prompts si la IA está hablando o hay cola de salida
  if (playingNow || txQueue.length > 0 || responseInFlight) return;

  if (!haveAnyAudio || !enoughAudio()) return;
  const SIL_MS = 850; // combina con session.update
  if (Date.now() - lastAudioAt > SIL_MS) {
    createResponse('Entendido. ¿En qué puedo ayudarte? Responde de forma breve en español.');
  }
}

function createResponse(text) {
  if (!wsReady || responseInFlight) return;

  if (haveAnyAudio && inputBytesAccum >= ENOUGH_BYTES_100MS) {
    sendWS({ type: 'input_audio_buffer.commit' });
    inputBytesAccum = 0;
    haveAnyAudio = false;
  } else {
    log('warn', 'Omito commit: aún no hay suficiente audio en buffer');
  }

  // nuevo talkspurt
  markerNext = true;     // M=1 en el primer frame de VOZ
  prerollSent = false;   // preroll al empezar
  outResidual = Buffer.alloc(0);
  playingNow = false;

  responseInFlight = true;
  sendWS({
    type: 'response.create',
    response: {
      modalities: ['audio', 'text'],
      instructions: text,
      audio: { voice: 'alloy', format: 'g711_ulaw' },
    },
  });
  setTimeout(() => { responseInFlight = false; }, 2000);
}

// ======= Limpieza robusta =======
async function cleanupCall(reason) {
  log('info', `🧹 Limpieza por llamada (${reason || 'desconocido'})`);

  try {
    if (currentUnicastChanId) await ari.channels.hangup({ channelId: currentUnicastChanId }).catch(()=>{});
    if (currentSipChanId)     await ari.channels.hangup({ channelId: currentSipChanId }).catch(()=>{});
    if (currentBridgeId)      await ari.bridges.destroy({ bridgeId: currentBridgeId }).catch(()=>{});
  } catch (e) {
    log('warn', 'Error limpiando ARI', j(e));
  }

  try {
    stopPacer();
    if (rtpSock) { rtpSock.close(); rtpSock = null; localRtpPort = null; }
  } catch (e) {
    log('warn', 'Error cerrando RTP socket', j(e));
  }

  // Reset estado
  learnedDest = false;
  outIp = null; outPort = null; OUT_PT = null;
  seq = 0; ts = 0; ssrc = 0;
  haveAnyAudio = false; inputBytesAccum = 0; lastAudioAt = 0;
  outResidual = Buffer.alloc(0); txQueue = [];
  markerNext = true; prerollSent = false; playingNow = false;
  currentBridgeId = null; currentSipChanId = null; currentUnicastChanId = null;
}

// ======= ARI =======
async function connectARI() {
  return new Promise((resolve, reject) => {
    AriClient.connect(ARI_URL, ARI_USER, ARI_PASS, (err, client) => {
      if (err) { log('error', 'Fallo conectando ARI ' + j(err)); return reject(err); }
      ari = client;
      log('info', '✅ Conectado a ARI');

      ari.on('StasisStart', onStasisStart);
      ari.on('StasisEnd', onStasisEnd);
      ari.start(ARI_APP);
      resolve();
    });
  });
}

async function onStasisStart(event, channel) {
  // Ignora el propio UnicastRTP
  if (channel?.name?.startsWith('UnicastRTP/')) {
    log('debug', `Ignorando StasisStart de canal ${channel.name}`);
    return;
  }

  // Reset por si quedó algo
  await cleanupCall('preparar nueva llamada');

  try {
    const chanId = channel?.id;
    if (!chanId) { log('error', 'StasisStart sin canal válido: ' + j(event)); return; }
    currentSipChanId = chanId;

    // 1) Socket RTP
    rtpSock = await initRtpSocket();

    // 2) Bridge mixing + SIP
    const bridge = await ari.bridges.create({ type: 'mixing' });
    currentBridgeId = bridge.id;
    await bridge.addChannel({ channel: chanId });
    log('info', `Bridge ${bridge.id} listo con canal SIP ${chanId}`);

    // 3) Originamos UnicastRTP µ-law
    const endpoint = `UnicastRTP/127.0.0.1:${localRtpPort}`;
    const unicast = await ari.channels.originate({
      endpoint,
      app: ARI_APP,
      appArgs: 'media',
      formats: 'ulaw', // µ-law @ 8 kHz
    });
    currentUnicastChanId = unicast.id;
    await bridge.addChannel({ channel: unicast.id });
    log('info', `UnicastRTP ${unicast.id} añadido al bridge ${bridge.id}`);

    if (DEBUG_BOOT_GREETING === 'true') {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (OUT_PT !== null) {
          clearInterval(iv);
          log('info', '🗣️ Enviando saludo inicial (PT aprendido).');
          createResponse('Hola, estás en LinkedIP. ¿En qué puedo ayudarte? Responde de forma breve en español.');
        } else if (Date.now() - t0 > 3000) {
          clearInterval(iv);
          log('warn', 'No se aprendió PT a tiempo; omito saludo inicial.');
        }
      }, 100);
    }
  } catch (e) {
    log('error', 'Error en StasisStart handler: ' + j(e));
  }
}

async function onStasisEnd(event, channel) {
  const id = channel?.id;
  const name = channel?.name || '';
  log('info', `Fin de llamada para canal ${id} (${name})`);
  await cleanupCall(`StasisEnd de ${name || id}`);
}

// ======= MAIN =======
(async () => {
  try {
    await connectARI();
    await connectWS();
  } catch (e) {
    log('error', 'Fallo al iniciar: ' + j(e));
    process.exit(1);
  }
})();