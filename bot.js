const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');

// =============================================
// CONFIG - BURAYA BOTUN WHATSAPP NÖMRƏSİNİ YAZ
// Format: ölkə kodu + nömrə, + işarəsiz, boşluqsuz
// Məsələn Azərbaycan: 994501234567
// =============================================
const PHONE_NUMBER = '994507390019';
// =============================================

const AUTH_FOLDER = '/data/auth';

let pairingRequested = false;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  // Qeydiyyatdan keçməyibsə - pairing kodu istə
  if (!sock.authState.creds.registered && !pairingRequested) {
    pairingRequested = true;
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER);
        console.log('==========================================');
        console.log('🔑 PAIRING CODE:', code);
        console.log('WhatsApp > Linked Devices > Link a Device > "Link with phone number instead" > bu kodu yaz');
        console.log('==========================================');
      } catch (e) {
        console.log('Pairing code xətası:', e.message);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('⚠️ Bağlantı bağlandı. Yenidən qoşulma:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp-a qoşuldu!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Gələn mesajları izlə - ID-ləri tapmaq üçün
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    console.log(`📩 Mesaj: "${text}" | Chat ID: ${from}`);

    if (text.trim() === '/test') {
      await sock.sendMessage(from, { text: `✅ Bot işləyir!\n\nBu çatın ID-si:\n${from}` });
    }
  });
}

startBot();
console.log('🚀 Bot başladılır...');
