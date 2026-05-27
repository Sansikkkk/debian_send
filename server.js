const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || ''; // dacă e gol, se detectează automat din request
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const META_DIR = path.join(__dirname, 'meta');
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const EXPIRY_MS = 24 * 60 * 60 * 1000;   // 24 ore

// Charset pentru ID scurt (fără caractere confuze: 0/O, 1/l/I)
const ID_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const ID_LENGTH = 8;

function generateId() {
  const bytes = crypto.randomBytes(ID_LENGTH);
  return Array.from(bytes).map(b => ID_CHARS[b % ID_CHARS.length]).join('');
}

function getBaseUrl(req) {
  if (BASE_URL) return BASE_URL;
  return `${req.protocol}://${req.get('host')}`;
}

// Creează directoarele necesare
[UPLOAD_DIR, META_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Multer config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = generateId();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // Sanitizare nume fișier (protecție directory traversal)
    const safeName = path.basename(file.originalname);
    if (safeName !== file.originalname || file.originalname.includes('..')) {
      return cb(new Error('Nume fișier invalid.'));
    }
    cb(null, true);
  }
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Upload endpoint ---
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Niciun fișier primit.' });
  }

  const fileId = path.parse(req.file.filename).name;
  const meta = {
    originalName: path.basename(req.file.originalname), // sanitizat
    storedName: req.file.filename,
    mimetype: req.file.mimetype,
    size: req.file.size,
    uploadedAt: Date.now(),
    expiresAt: Date.now() + EXPIRY_MS,
    downloaded: false
  };

  fs.writeFileSync(path.join(META_DIR, `${fileId}.json`), JSON.stringify(meta));

  res.json({
    downloadUrl: `${getBaseUrl(req)}/download/${fileId}`,
    fileId,
    expiresIn: '24 ore sau la prima descărcare'
  });
});

// --- Download page endpoint ---
app.get('/download/:id', (req, res) => {
  const id = req.params.id;

  // Validare ID (8 caractere alfanumerice)
  if (!/^[a-z2-9]{8}$/.test(id)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }

  const metaPath = path.join(META_DIR, `${id}.json`);
  if (!fs.existsSync(metaPath)) {
    return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  }

  const meta = JSON.parse(fs.readFileSync(metaPath));

  if (meta.downloaded || Date.now() > meta.expiresAt) {
    deleteFile(id);
    return res.status(410).sendFile(path.join(__dirname, 'public', '410.html'));
  }

  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// --- File info API (folosit de download.html) ---
app.get('/api/info/:id', (req, res) => {
  const id = req.params.id;

  if (!/^[a-z2-9]{8}$/.test(id)) {
    return res.status(404).json({ error: 'ID invalid.' });
  }

  const metaPath = path.join(META_DIR, `${id}.json`);
  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'Fișier inexistent sau expirat.' });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath));

  if (meta.downloaded || Date.now() > meta.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'Fișier expirat sau deja descărcat.' });
  }

  const remaining = Math.max(0, meta.expiresAt - Date.now());
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);

  res.json({
    name: meta.originalName,
    size: meta.size,
    mimetype: meta.mimetype,
    expiresIn: `${hours}h ${minutes}m`,
    uploadedAt: meta.uploadedAt
  });
});

// --- Actual file download ---
app.get('/api/download/:id', (req, res) => {
  const id = req.params.id;

  if (!/^[a-z2-9]{8}$/.test(id)) {
    return res.status(404).json({ error: 'ID invalid.' });
  }

  const metaPath = path.join(META_DIR, `${id}.json`);
  if (!fs.existsSync(metaPath)) {
    return res.status(404).json({ error: 'Fișier inexistent.' });
  }

  const meta = JSON.parse(fs.readFileSync(metaPath));

  if (meta.downloaded || Date.now() > meta.expiresAt) {
    deleteFile(id);
    return res.status(410).json({ error: 'Fișier expirat.' });
  }

  const filePath = path.join(UPLOAD_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Fișier lipsă de pe server.' });
  }

  // Marchează ca descărcat ÎNAINTE de a trimite
  meta.downloaded = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta));

  res.setHeader('Content-Disposition', `attachment; filename="${meta.originalName}"`);
  res.setHeader('Content-Type', meta.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', meta.size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);

  fileStream.on('close', () => {
    // Șterge după descărcare completă
    setTimeout(() => deleteFile(id), 5000);
  });
});

// --- Helper: șterge fișier + meta ---
function deleteFile(id) {
  const metaPath = path.join(META_DIR, `${id}.json`);
  let storedName = null;

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath));
    storedName = meta.storedName;
  } catch (_) {}

  if (storedName) {
    const filePath = path.join(UPLOAD_DIR, storedName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
}

// --- Cleanup periodic: șterge fișiere expirate (rulează la fiecare oră) ---
setInterval(() => {
  console.log('[Cleanup] Verific fișiere expirate...');
  const files = fs.readdirSync(META_DIR).filter(f => f.endsWith('.json'));
  let count = 0;
  files.forEach(file => {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(META_DIR, file)));
      if (Date.now() > meta.expiresAt || meta.downloaded) {
        const id = path.parse(file).name;
        deleteFile(id);
        count++;
      }
    } catch (_) {}
  });
  if (count > 0) console.log(`[Cleanup] Șters ${count} fișier(e) expirate.`);
}, 60 * 60 * 1000);

// --- Error handler pentru multer ---
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Fișierul depășește limita de 500 MB.' });
  }
  console.error(err);
  res.status(500).json({ error: err.message || 'Eroare internă.' });
});

app.listen(PORT, () => {
  console.log(`✅ Server pornit: ${BASE_URL}`);
  console.log(`   Upload dir : ${UPLOAD_DIR}`);
  console.log(`   Max size   : 500 MB`);
  console.log(`   Expiry     : 24 ore / prima descărcare`);
});
