const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const schedule = require('node-schedule');

// =====================================================
// AYARLAR — BURADAN DƏYİŞ
// =====================================================
const GROUP_JID = '120363428221467854@g.us';     // "Mənəvi Addım" qrupu

// Admin nömrəsi (botu öz telefonundan idarə edən əsas nömrə):
const ADMIN_NUMBER = '994507390019';
const ADMIN_JID = ADMIN_NUMBER + '@s.whatsapp.net';
const BACKUP_JID = ADMIN_JID;                    // həftəlik avtomatik backup bura gedir

// WhatsApp DM-lərdə göndərəni nömrə əvəzinə @lid (gizli ID) kimi göstərir.
// DİQQƏT: @lid bot HESABINA bağlıdır. Bot nömrəsini dəyişdiyin üçün KÖHNƏ @lid-lər keçərsizdir.
// Yeni bot qoşulandan sonra 507390019-dan bota mesaj yaz, logdakı "from: XXXX@lid"-i bura yaz:
const ADMIN_LIDS = [
   '190258612326413', // = 994507390019? — yeni bot qoşulandan sonra TƏSDİQLƏ və aktivləşdir
];

const ICAZE_COOLDOWN_DAYS = 21;                  // icazələr arası minimum gün (3 həftə)

const AUTH_FOLDER = '/data/auth';
const DB_FILE = '/data/data.json';
const SEED_FILE = path.join(__dirname, 'data.json'); // repo-dakı 100 tapşırıqlı fayl
const PORT = process.env.PORT || 3000;
// =====================================================

let sock = null;
let currentQR = null;
let connectionStatus = 'Başlanır...';
let reconnectTimer = null;

// ---------- DATABASE ----------
function ensureStructure(d) {
  d.options = d.options || [];
  d.members = d.members || {};
  d.weeklyLog = d.weeklyLog || [];
  d.lastWeekLog = d.lastWeekLog || [];
  d.assignmentPool = d.assignmentPool || [];
  return d;
}

function loadData() {
  // Volume-da yoxdursa: repo-dakı seed-dən yarat (üzvlər boş), varsa heç vaxt üstündən yazma
  if (!fs.existsSync(DB_FILE)) {
    let seed = { options: [], members: {}, weeklyLog: [], lastWeekLog: [], assignmentPool: [] };
    try {
      if (fs.existsSync(SEED_FILE)) seed = ensureStructure(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
    } catch (e) { console.log('Seed oxuma xətası:', e.message); }
    seed.members = {};            // təmiz başlanğıc
    seed.weeklyLog = [];
    seed.assignmentPool = [];
    try { fs.mkdirSync(path.dirname(DB_FILE), { recursive: true }); } catch {}
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    console.log(`📦 data.json yaradıldı (${seed.options.length} tapşırıq, üzvlər boş).`);
    return seed;
  }
  const data = ensureStructure(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  // ÖZ-ÖZÜNƏ DÜZƏLMƏ: tapşırıqlar boşdursa, repo-dakı data.json-dan doldur (üzvlərə toxunmadan)
  if (data.options.length === 0 && fs.existsSync(SEED_FILE)) {
    try {
      const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
      if (seed.options && seed.options.length) {
        data.options = seed.options;
        saveData(data);
        console.log(`🔧 Tapşırıqlar boş idi — repo-dan ${data.options.length} tapşırıq yükləndi.`);
      }
    } catch (e) { console.log('Seed yükləmə xətası:', e.message); }
  }
  return data;
}

function saveData(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ---------- KÖMƏKÇİLƏR ----------
function send(jid, text) {
  if (!sock) return;
  return sock.sendMessage(jid, { text }).catch(e => console.log('Göndərmə xətası:', e.message));
}

function bareNumber(jid) {
  return (jid || '').split(':')[0].split('@')[0];
}

function buildPool(data) {
  if (data.assignmentPool.length === 0) {
    data.assignmentPool = [...Array(data.options.length).keys()];
    for (let i = data.assignmentPool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [data.assignmentPool[i], data.assignmentPool[j]] = [data.assignmentPool[j], data.assignmentPool[i]];
    }
  }
}

function assignOption(data, key, name) {
  if (!data.options.length) return null;
  if (!data.members[key]) {
    data.members[key] = { name, assignments: [], completed: [], pending: [], streak: 0, missedCount: 0, penalized: false, awaitingReason: false, awaitingPenalty: false, lastIcaze: null };
  }
  buildPool(data);
  let optionIndex = null;
  for (let i = 0; i < data.assignmentPool.length; i++) {
    const idx = data.assignmentPool[i];
    if (!data.members[key].assignments.includes(idx)) {
      optionIndex = idx;
      data.assignmentPool.splice(i, 1);
      break;
    }
  }
  if (optionIndex === null) {
    data.members[key].assignments = [];
    buildPool(data);
    optionIndex = data.assignmentPool.shift();
  }
  data.members[key].assignments.push(optionIndex);
  data.members[key].pending.push(optionIndex);
  return optionIndex;
}

function icazeQalanGun(member) {
  if (!member.lastIcaze) return 0;
  const kecenGun = (Date.now() - new Date(member.lastIcaze).getTime()) / (1000 * 60 * 60 * 24);
  if (kecenGun >= ICAZE_COOLDOWN_DAYS) return 0;
  return Math.ceil(ICAZE_COOLDOWN_DAYS - kecenGun);
}

async function sendBackup(targetJid) {
  try {
    await sock.sendMessage(targetJid, {
      document: fs.readFileSync(DB_FILE),
      fileName: 'data.json',
      mimetype: 'application/json',
    });
  } catch (e) { console.log('Backup xətası:', e.message); }
}

// =====================================================
// ÜZV ƏMRLƏRİ (DM-də işləyir)
// =====================================================
async function handleMemberMessage(jid, name, text) {
  const data = loadData();
  const member = data.members[jid];

  if (text === '/start') {
    if (!data.members[jid]) {
      data.members[jid] = { name, assignments: [], completed: [], pending: [], streak: 0, missedCount: 0, penalized: false, awaitingReason: false, awaitingPenalty: false, lastIcaze: null };
      saveData(data);
    }
    return send(jid,
      `Salam, ${name}! 🌙\n\n` +
      `Admin hər həftə Cümə günü tapşırıqları paylaşacaq.\n\n` +
      `Tapşırıq paylaşıldıqdan sonra:\n` +
      `• Burada /addim yazıb öz tapşırığını görə bilərsən\n` +
      `• Tapşırıq həmçinin qrupda da əks olunacaq\n\n` +
      `Tapşırığı tamamladıqda /etdim ✅\n` +
      `Tamamlaya bilmədikdə /etmedim ❌\n` +
      `İstirahət lazımdırsa /icaze 🏖 (minimum 3 həftədən bir)\n` +
      `Qoşulmaqdan çıxmaq istəsən /stop`);
  }

  if (text === '/stop') {
    if (!data.members[jid])
      return send(jid, 'Onsuz da qeydiyyatda deyilsən. Qoşulmaq üçün /start yaz.');
    const adi = data.members[jid].name || 'Üzv';
    delete data.members[jid];
    saveData(data);
    return send(jid, `👋 ${adi}, qeydiyyatdan çıxdın — daha tapşırıq almayacaqsan.\n\nFikrini dəyişsən, istənilən vaxt /start yazıb geri qayıda bilərsən. Allah razı olsun. 🤲`);
  }

  if (text === '/addim') {
    if (!member || member.pending.length === 0)
      return send(jid, '⏳ Hələ tapşırığın yoxdur. Admin tapşırıqları paylaşana qədər gözlə.');
    if (member.awaitingPenalty)
      return send(jid, `⚠️ Cəza tapşırığını yerinə yetirməlisən:\n\n*1 gün nafilə oruc tut* və ya *bir günün bir adama yetən yeməyi qədər sədəqə ver*\n\nEtdikdən sonra /etdim yaz.`);
    const idx = member.pending[member.pending.length - 1];
    return send(jid, `📋 Bu həftəki tapşırığın:\n\n*${data.options[idx]}*\n\nBitirdikdə /etdim ✅\nEdə bilmədikdə /etmedim ❌\nİstirahət lazımdırsa /icaze 🏖`);
  }

  if (text === '/icaze') {
    if (!member || member.pending.length === 0)
      return send(jid, '⏳ Aktiv tapşırığın yoxdur. İcazə yalnız aktiv tapşırıq olanda istifadə oluna bilər.');
    if (member.awaitingPenalty)
      return send(jid, `⚠️ Cəza tapşırığı gözləyirsən — icazə istifadə edə bilməzsən.\n\n*1 gün nafilə oruc tut* və ya *bir günün bir adama yetən yeməyi qədər sədəqə ver*, sonra /etdim yaz.`);
    if (member.awaitingReason)
      return send(jid, '❌ Artıq /etmedim yazmısan, bu həftə icazə istifadə edə bilməzsən. Səbəbini yaz (1, 2, 3 və ya 4).');
    const missedThisWeek = data.weeklyLog.some(l => l.jid === jid && l.result === 'missed');
    if (missedThisWeek)
      return send(jid, '❌ Bu həftə tapşırığı etmədiyini artıq bildirmisən — icazə istifadə edə bilməzsən.');
    const qalan = icazeQalanGun(member);
    if (qalan > 0)
      return send(jid, `⏳ İcazədən sonra minimum 3 həftə keçməlidir.\n\nNövbəti icazəyə qalan: *${qalan} gün*`);
    const idx = member.pending.pop();
    member.lastIcaze = new Date().toISOString();
    member.awaitingReason = false;
    data.weeklyLog.push({ jid, name: member.name, optionIndex: idx, result: 'icaze', streak: member.streak || 0, date: new Date().toISOString() });
    saveData(data);
    return send(jid, `🏖 İcazən qəbul edildi!\n\nBu həftəki tapşırıq sayılmayacaq və davamlılığın (*${member.streak || 0} həftə*) qorunur.\n\n⏳ Növbəti icazəni minimum *3 həftə* sonra istifadə edə bilərsən.`);
  }

  if (text === '/etdim') {
    if (!member || member.pending.length === 0)
      return send(jid, 'Aktiv tapşırığın yoxdur. /addim yazın.');
    if (member.awaitingReason || (member.missedCount > 0 && !member.awaitingPenalty))
      return send(jid, '❌ Bu həftə tapşırığı etmədiyini bildirmişdin. Növbəti həftə yeni tapşırıq veriləcək.');
    if (member.awaitingPenalty) {
      member.awaitingPenalty = false;
      member.penalized = false;
      member.missedCount = 0;
      member.streak = 0;
      saveData(data);
      send(GROUP_JID, `✅ *${member.name}* cəza tapşırığını yerinə yetirdi. Növbəti həftə yeni tapşırıq veriləcək. 💪`);
      return send(jid, '✅ Cəza tapşırığını tamamladın! Növbəti həftə yeni tapşırıq veriləcək. Allah qəbul etsin! 🤲');
    }
    const idx = member.pending.pop();
    member.completed.push(idx);
    member.streak = (member.streak || 0) + 1;
    member.missedCount = 0;
    member.penalized = false;
    member.awaitingReason = false;
    data.weeklyLog.push({ jid, name: member.name, optionIndex: idx, result: 'done', streak: member.streak, date: new Date().toISOString() });
    saveData(data);
    return send(jid, `✅ Əla! Tapşırığı tamamladın. Allah qəbul etsin! 🤲\n\n🔥 Davamlılıq: *${member.streak} həftə*`);
  }

  if (text === '/etmedim') {
    if (!member || member.pending.length === 0)
      return send(jid, 'Aktiv tapşırığın yoxdur. /addim yazın.');
    if (member.awaitingPenalty)
      return send(jid, `⚠️ Cəza tapşırığını hələ yerinə yetirməmisən!\n\n*1 gün nafilə oruc tut* və ya *bir günün bir adama yetən yeməyi qədər sədəqə ver*\n\nEtdikdən sonra /etdim yaz.`);
    member.missedCount = (member.missedCount || 0) + 1;
    member.streak = 0;
    if (member.missedCount === 1) {
      member.awaitingReason = true;
      saveData(data);
      return send(jid,
        `😔 Problem deyil, növbəti həftə yenə şansın var! 💪\n\n` +
        `Səbəbini bizimlə paylaş — qrupda hamı üçün faydalı olar:\n\n` +
        `1️⃣ Vaxtım olmadı\n2️⃣ Unutdum\n3️⃣ Çətin idi\n4️⃣ Başqa səbəb\n\n` +
        `Rəqəmi yaz (1, 2, 3 və ya 4)`);
    } else {
      member.awaitingPenalty = true;
      member.awaitingReason = false;
      const idx = member.pending[member.pending.length - 1];
      saveData(data);
      send(GROUP_JID,
        `⚠️ *${member.name}* bu tapşırığı ikinci dəfə ardıcıl yerinə yetirmədi.\n\n` +
        `📋 Tapşırıq: _${data.options[idx]}_\n\n` +
        `Cəza olaraq: *1 gün nafilə oruc tutmalı* və ya *bir günün bir adama yetən yeməyi qədər sədəqə verməlidir.*`);
      return send(jid,
        `❌ Bu tapşırığı ikinci dəfə yerinə yetirmədin.\n\n` +
        `Cəza olaraq:\n*1 gün nafilə oruc tut* və ya *bir günün bir adama yetən yeməyi qədər sədəqə ver*\n\n` +
        `Etdikdən sonra /etdim yaz.`);
    }
  }

  // Səbəb cavabı (yalnız /etmedim-dən sonra, rəqəm və ya mətn)
  if (member && member.awaitingReason && !text.startsWith('/')) {
    const reasons = { '1': 'Vaxtım olmadı', '2': 'Unutdum', '3': 'Çətin idi', '4': 'Başqa səbəb' };
    const reason = reasons[text] || text;
    const idx = member.pending[member.pending.length - 1];
    member.awaitingReason = false;
    data.weeklyLog.push({ jid, name: member.name, optionIndex: idx, result: 'missed', reason, streak: 0, date: new Date().toISOString() });
    saveData(data);
    send(GROUP_JID,
      `❌ *${member.name}* bu həftəki tapşırığı tamamlaya bilmədi.\n` +
      `📋 Tapşırıq: _${data.options[idx]}_\n💬 Səbəb: ${reason}\n\n` +
      `Növbəti həftə eyni tapşırıq yenə veriləcək. 💪`);
    return send(jid, '✅ Səbəbin qeyd edildi. Növbəti həftə yenə cəhd et! 💪');
  }

  // Qeydiyyatsız adam ilk dəfə (qeyri-əmr) yazanda — qısa yönləndirmə
  if (!member) {
    return send(jid, 'Salam! 🌙 Bu *Mənəvi Addım* botudur.\n\nQoşulmaq üçün /start yaz.\n(Sonradan çıxmaq istəsən /stop yazarsan.)');
  }
}

// =====================================================
// ADMIN ƏMRLƏRİ (öz nömrəndən "Özünə mesaj" və ya ikinci nömrədən DM)
// =====================================================
async function handleAdminCommand(text, replyJid) {
  if (text === '/admin') {
    send(replyJid,
      `🔧 *Admin Panel*\n\n` +
      `/addoption [mətn] — Tapşırıq əlavə et\n` +
      `/listoption — Bütün tapşırıqları gör\n` +
      `/deloption [nömrə] — Tapşırıq sil\n` +
      `/send — Qrupa tapşırıqları paylaş\n` +
      `/report — Həftəlik hesabat göndər\n` +
      `/members — Qeydiyyatlı üzvlər\n` +
      `/uzvsil [ad] — Üzvü siyahıdan sil\n` +
      `/backup — data.json ehtiyat nüsxəsini al\n` +
      `/reset — Yeni həftəyə sıfırla`);
    return true;
  }

  if (text.startsWith('/addoption ')) {
    const t = text.slice('/addoption '.length).trim();
    if (!t) { send(replyJid, '❌ Mətn yaz: /addoption Tapşırıq mətni'); return true; }
    const data = loadData();
    data.options.push(t);
    saveData(data);
    send(replyJid, `✅ Tapşırıq əlavə edildi (#${data.options.length}): ${t}`);
    return true;
  }

  if (text === '/listoption') {
    const data = loadData();
    if (!data.options.length) { send(replyJid, 'Heç bir tapşırıq yoxdur.'); return true; }
    let chunk = `📋 *Tapşırıq siyahısı (${data.options.length} ədəd):*\n\n`;
    for (let i = 0; i < data.options.length; i++) {
      const line = `${i + 1}. ${data.options[i]}\n`;
      if ((chunk + line).length > 3500) { send(replyJid, chunk); chunk = ''; }
      chunk += line;
    }
    if (chunk.trim()) send(replyJid, chunk);
    return true;
  }

  if (text.startsWith('/deloption ')) {
    const idx = parseInt(text.slice('/deloption '.length).trim()) - 1;
    const data = loadData();
    if (isNaN(idx) || idx < 0 || idx >= data.options.length) { send(replyJid, '❌ Yanlış nömrə.'); return true; }
    const removed = data.options.splice(idx, 1);
    saveData(data);
    send(replyJid, `🗑 Silindi: ${removed[0]}`);
    return true;
  }

  if (text === '/send') {
    try {
      await doWeeklySend();
      send(replyJid, '✅ Qrupa tapşırıqlar göndərildi!');
    } catch (e) {
      send(replyJid, '❌ Göndərilmədi. Səbəb: ' + e.message);
    }
    return true;
  }

  if (text === '/report') {
    await sendWeeklyReport();
    send(replyJid, '📊 Hesabat göndərildi.');
    return true;
  }

  if (text === '/members') {
    const data = loadData();
    const members = Object.entries(data.members);
    if (!members.length) { send(replyJid, 'Heç bir üzv yoxdur.'); return true; }
    const list = members.map(([id, m]) => {
      const qalan = icazeQalanGun(m);
      const icazeText = qalan > 0 ? ` | İcazə: ${qalan} gün sonra` : ' | İcazə: ✅';
      return `👤 ${m.name} — Davamlılıq: ${m.streak || 0} | Tamamlanan: ${(m.completed || []).length}${icazeText}`;
    }).join('\n');
    send(replyJid, `*Üzvlər (${members.length} nəfər):*\n\n${list}`);
    return true;
  }

  if (text.startsWith('/uzvsil ')) {
    const q = text.slice('/uzvsil '.length).trim().toLowerCase();
    if (!q) { send(replyJid, '❌ Ad yaz: /uzvsil Ad'); return true; }
    const data = loadData();
    const matches = Object.entries(data.members).filter(([id, m]) => (m.name || '').toLowerCase() === q);
    if (!matches.length) {
      send(replyJid, `❌ "${q}" adlı üzv tapılmadı. Dəqiq adları görmək üçün /members yaz.`);
      return true;
    }
    const adi = matches[0][1].name;
    matches.forEach(([id]) => delete data.members[id]);
    saveData(data);
    send(replyJid, `🗑 Silindi: "${adi}" (${matches.length} qeyd).`);
    return true;
  }

  if (text === '/reset') {
    const data = loadData();
    data.lastWeekLog = [...data.weeklyLog];
    data.weeklyLog = [];
    data.assignmentPool = [];
    for (const member of Object.values(data.members)) {
      member.assignments = [];
      member.pending = [];
      member.awaitingReason = false;
    }
    saveData(data);
    send(replyJid, '✅ Sıfırlandı. Yeni həftə başlayır!');
    return true;
  }

  if (text === '/backup') {
    await sendBackup(replyJid);
    send(replyJid, '💾 Ehtiyat nüsxə göndərildi (data.json).');
    return true;
  }

  return false; // tanınmayan əmr
}

// =====================================================
// CƏDVƏL FUNKSİYALARI
// =====================================================
async function doWeeklySend() {
  const data = loadData();
  if (!data.options.length) throw new Error('Tapşırıq siyahısı boşdur (data.json yoxlanmalıdır).');
  if (!Object.keys(data.members).length) throw new Error('Heç bir üzv qeydiyyatdan keçməyib — bota /start yazan yoxdur.');
  let mesaj = `🌙 *Salam Aleykum!* 🤲\n\n*Bu həftəki tapşırıqlar:*\n\n`;
  for (const [key, member] of Object.entries(data.members)) {
    if (member.awaitingPenalty) {
      mesaj += `👤 ${member.name}: ⚠️ _Cəza tapşırığı gözləyir_\n`;
      continue;
    }
    const optionIndex = assignOption(data, key, member.name);
    mesaj += `👤 ${member.name}: *${data.options[optionIndex]}*\n`;
  }
  mesaj += `\nTapşırığını görmək üçün bota şəxsi /addim yazın.\n` +
    `Tamamladıqda /etdim ✅, tamamlamadıqda /etmedim ❌\n\n` +
    `🏖 İstirahət lazımdırsa /icaze yazıb həmin həftə tapşırığı etməyə bilərsiniz (icazədən sonra minimum 3 həftə keçməlidir).`;
  await sock.sendMessage(GROUP_JID, { text: mesaj }); // xəta olsa yuxarı ötürülür
  saveData(data);
  console.log('✅ Həftəlik tapşırıqlar göndərildi');
}

async function sendWeeklyReport() {
  const data = loadData();

  // Heç cavab verməyənləri "etmədim" kimi qeyd et
  for (const [key, member] of Object.entries(data.members)) {
    if (member.pending.length > 0 && !member.awaitingPenalty) {
      const alreadyLogged = data.weeklyLog.some(l => l.jid === key);
      if (!alreadyLogged) {
        const idx = member.pending[member.pending.length - 1];
        member.missedCount = (member.missedCount || 0) + 1;
        member.streak = 0;
        if (member.missedCount >= 2) member.awaitingPenalty = true;
        data.weeklyLog.push({ jid: key, name: member.name, optionIndex: idx, result: 'missed', reason: 'Cavab vermədi', streak: 0, date: new Date().toISOString() });
      }
    }
  }

  const done = data.weeklyLog.filter(l => l.result === 'done');
  const missed = data.weeklyLog.filter(l => l.result === 'missed');
  const icaze = data.weeklyLog.filter(l => l.result === 'icaze');
  const penalized = Object.values(data.members).filter(m => m.awaitingPenalty);
  const doneSorted = [...done].sort((a, b) => (b.streak || 0) - (a.streak || 0));

  let report = `📊 *Həftəlik Hesabat*\n\n`;
  report += `✅ *Tamamlayanlar (${done.length}):*\n`;
  doneSorted.forEach(l => {
    const streakText = l.streak > 1 ? ` 🔥 ${l.streak} həftə ardıcıl` : '';
    report += `  • ${l.name}: _${data.options[l.optionIndex] || '?'}_${streakText}\n`;
  });
  if (icaze.length) {
    report += `\n🏖 *İcazəlilər (${icaze.length}):*\n`;
    icaze.forEach(l => { report += `  • ${l.name} — bu həftə icazədə idi (davamlılığı qorunur: ${l.streak} həftə)\n`; });
  }
  if (missed.length) {
    report += `\n❌ *Tamamlamayanlar (${missed.length}):*\n`;
    missed.forEach(l => {
      const reasonText = l.reason ? ` — Səbəb: ${l.reason}` : '';
      report += `  • ${l.name}: _${data.options[l.optionIndex] || '?'}_${reasonText}\n`;
    });
  }
  if (penalized.length) {
    report += `\n⚠️ *Cəzalılar (${penalized.length}):*\n`;
    penalized.forEach(m => { report += `  • ${m.name} — 2 dəfə ardıcıl yerinə yetirmədi\n`; });
  }
  const reasons = missed.filter(l => l.reason).map(l => l.reason);
  if (reasons.length) {
    const reasonCount = {};
    reasons.forEach(r => { reasonCount[r] = (reasonCount[r] || 0) + 1; });
    report += `\n📈 *Səbəb statistikası:*\n`;
    Object.entries(reasonCount).forEach(([r, c]) => { report += `  • ${r}: ${c} nəfər\n`; });
  }
  report += `\n📅 Növbəti Cümə tapşırıqlar yenilənəcək.`;

  try { await sock.sendMessage(GROUP_JID, { text: report }); } catch (e) { console.log('Hesabat xətası:', e.message); }

  data.lastWeekLog = [...data.weeklyLog];
  data.weeklyLog = [];
  data.assignmentPool = [];
  for (const member of Object.values(data.members)) {
    if (!member.awaitingPenalty) {
      member.assignments = [];
      member.pending = [];
    }
    member.awaitingReason = false;
  }
  saveData(data);

  // SIĞORTA: hesabatdan sonra avtomatik ehtiyat nüsxə ikinci nömrəyə
  await sendBackup(BACKUP_JID);
}

async function sendReminder() {
  const data = loadData();
  const pending = Object.values(data.members).filter(m => m.pending.length > 0 && !m.awaitingPenalty);
  if (!pending.length) return;
  const names = pending.map(m => `• ${m.name}`).join('\n');
  try {
    await sock.sendMessage(GROUP_JID, { text: `⏰ *Xatırlatma!*\n\nHəftənin son günüdür! Tapşırığını hələ tamamlamayan üzvlər:\n\n${names}\n\nTapşırığını bitirmək üçün son şansın! 💪` });
  } catch (e) { console.log('Xatırlatma xətası:', e.message); }
}

// =====================================================
// QR SERVER (brauzerdə QR göstərir)
// =====================================================
http.createServer(async (req, res) => {
  if (currentQR) {
    try {
      const qrImage = await QRCode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><meta http-equiv="refresh" content="20"></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;"><h2>WhatsApp QR Kodu</h2><img src="${qrImage}" /><p>Skan et: WhatsApp &gt; Linked Devices &gt; Link a Device</p></body></html>`);
    } catch (e) { res.writeHead(500); res.end('QR xətası: ' + e.message); }
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><meta http-equiv="refresh" content="5"></head><body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;"><h2>Status: ${connectionStatus}</h2><p>QR hazır deyil və ya qoşulub. Səhifə 5 saniyədə yenilənir.</p></body></html>`);
  }
}).listen(PORT, () => console.log(`🌐 QR server: port ${PORT}`));

// =====================================================
// RECONNECT QORUMASI
// =====================================================
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log('🔄 3 saniyəyə yenidən qoşulacaq...');
  reconnectTimer = setTimeout(() => { reconnectTimer = null; startBot(); }, 3000);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    version,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    browser: ['MeneviAddim', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
      connectionStatus = 'QR kod hazırdır - skan et';
      console.log('📱 QR KODU hazırdır - brauzerdə servis URL-inə gir');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      connectionStatus = 'Bağlantı bağlandı...';
      console.log('⚠️ Status code:', statusCode, '|', JSON.stringify(lastDisconnect?.error?.output?.payload || lastDisconnect?.error?.message || ''));
      if (loggedOut) {
        console.log('🔒 Logout/conflict — yenidən qoşulmur. Yeni QR lazımdır.');
        currentQR = null;
        connectionStatus = 'Logout edilib - yenidən QR lazımdır';
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return; // köhnə/tarixçə mesajlarını emal etmə
      const msg = messages?.[0];
      if (!msg?.message) return;

      const remoteJid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe;
      const isGroup = remoteJid.endsWith('@g.us');
      const senderJid = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
      const senderNum = bareNumber(senderJid);
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      if (!text) return;

      // Admin müəyyənləşdirmə (@lid əsaslı)
      const isPrimaryAdmin = fromMe && !isGroup;                              // botun öz hesabından ("Özünə mesaj")
      const isSecondAdmin = !fromMe && !isGroup && ADMIN_LIDS.includes(senderNum); // admin @lid-i ilə DM
      const isAdminMsg = isPrimaryAdmin || isSecondAdmin;

      console.log(`📩 "${text}" | from: ${senderJid} | grup: ${isGroup} | admin: ${isAdminMsg}`);

      if (isAdminMsg && text.startsWith('/')) {
        const handled = await handleAdminCommand(text, remoteJid);
        if (handled) return;
      }

      if (fromMe) return;   // botun öz mesajları (admin əmri deyilsə) — keç
      if (isGroup) return;  // qrupdakı adi söhbətə qarışma

      await handleMemberMessage(senderJid, msg.pushName || 'Üzv', text);
    } catch (e) {
      console.log('Mesaj emalı xətası:', e.message);
    }
  });
}

// =====================================================
// CƏDVƏLLƏR (Bakı vaxtı) — yalnız BİR DƏFƏ qurulur
// =====================================================
schedule.scheduleJob({ dayOfWeek: 5, hour: 12, minute: 0, tz: 'Asia/Baku' }, () => doWeeklySend().catch(e => console.log('Avtomatik paylama xətası:', e.message)));    // Cümə 12:00 — tapşırıq paylama
schedule.scheduleJob({ dayOfWeek: 4, hour: 10, minute: 0, tz: 'Asia/Baku' }, () => sendReminder().catch(e => console.log('Xatırlatma xətası:', e.message)));         // Cümə axşamı 10:00 — xatırlatma
schedule.scheduleJob({ dayOfWeek: 4, hour: 22, minute: 0, tz: 'Asia/Baku' }, () => sendWeeklyReport().catch(e => console.log('Hesabat xətası:', e.message)));        // Cümə axşamı 22:00 — hesabat

startBot().catch((e) => { console.error('❌ startBot xətası:', e); scheduleReconnect(); });
console.log('🚀 Bot başladılır...');
