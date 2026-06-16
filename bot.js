const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');

const AUTH_FOLDER = '/data/auth';
const PORT = process.env.PORT || 3000;

let currentQR = null;
let connectionStatus = 'Başlanır...';
let reconnectTimer = null; // <-- üst-üstə düşən reconnect-lərin qarşısını alır

// ---------- QR kodu brauzerdə göstərmək üçün sadə HTTP server ----------
http.createServer(async (req, res) => {
  if (currentQR) {
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head><meta http-equiv="refresh" content="20"></head>
          <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
            <h2>WhatsApp QR Kodu</h2>
            <img src="${qrImage}" />
            <p>Sayfa 20 saniyədə bir yenilənir. Skan et: WhatsApp > Linked Devices > Link a Device</p>
          </body>
        </html>
      `);
    } catch (e) {
      res.writeHead(500);
      res.end('QR yaradılarkən xəta: ' + e.message);
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head><meta http-equiv="refresh" content="5"></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
          <h2>Status: ${connectionStatus}</h2>
          <p>QR kod hazır deyil və ya artıq qoşulub. Səhifə 5 saniyədə bir yenilənir.</p>
        </body>
      </html>
    `);
  }
}).listen(PORT, () => console.log(`🌐 QR server işləyir, port: ${PORT}`));

// ---------- Reconnect-i yalnız BİR DƏFƏ planlaşdıran funksiya ----------
function scheduleReconnect() {
  if (reconnectTimer) return; // artıq planlanıb, ikincisini yaratma
  console.log('🔄 3 saniyəyə yenidən qoşulacaq...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot();
  }, 3000);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    version,
    markOnlineOnConnect: false,             // botu daim "online" göstərmir
    syncFullHistory: false,                 // köhnə tarixçəni çəkmir, yüngül olur
    browser: ['MeneviAddim', 'Chrome', '1.0.0'], // sabit cihaz adı
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      connectionStatus = 'QR kod hazırdır - skan et';
      console.log('==========================================');
      console.log('📱 QR KODU hazırdır - brauzerdə servis URL-inə gir');
      console.log('==========================================');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut; // 401
      connectionStatus = 'Bağlantı bağlandı...';
      console.log('⚠️ Bağlantı bağlandı. Status code:', statusCode);
      console.log('⚠️ Xəta detalları:', JSON.stringify(lastDisconnect?.error?.output?.payload || lastDisconnect?.error?.message || lastDisconnect?.error));

      if (loggedOut) {
        // 401 = logout və ya conflict -> yenidən qoşulmaq mənasızdır (loop yaranar)
        console.log('🔒 Logout/conflict aşkarlandı — yenidən qoşulmur. Yeni QR lazımdır.');
        currentQR = null;
        connectionStatus = 'Logout edilib - yenidən QR lazımdır (servisi restart et)';
      } else {
        scheduleReconnect();
      }
    } else if (connection === 'open') {
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      currentQR = null;
      connectionStatus = 'Qoşuldu ✅';
      console.log('✅ WhatsApp-a qoşuldu!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // ---------- Gələn mesajları izlə ----------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages?.[0];
    if (!msg?.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    console.log(`📩 Mesaj: "${text}" | Chat ID: ${from}`);

    if (text.trim() === '/test') {
      await sock.sendMessage(from, { text: `✅ Bot işləyir!\n\nBu çatın ID-si:\n${from}` });
    }
  });
}

startBot().catch((e) => {
  console.error('❌ startBot xətası:', e);
  scheduleReconnect();
});
console.log('🚀 Bot başladılır...');
