'use strict';
require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const mysql       = require('mysql2/promise');
const multer      = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;
const ENV  = process.env.NODE_ENV || 'production';

/* ════════════════════════════════════════════════════════════
   SECURITY & PERFORMANCE MIDDLEWARE
════════════════════════════════════════════════════════════ */
// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// Gzip compression (reduces response size ~70%)
app.use(compression());

// Request logging
app.use(morgan(ENV === 'production' ? 'combined' : 'dev'));

// CORS — allow the frontend domains only
const ALLOWED_ORIGINS = [
  'http://www.learnwithadarsh.site',
  'http://learnwithadarsh.site',
  'https://www.learnwithadarsh.site',
  'https://learnwithadarsh.site',
  'http://localhost:3000',
  'null'                          // local file:// opens
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400                   // preflight cache 24h
}));

// Trust proxy (ALB sets X-Forwarded-For)
app.set('trust proxy', 1);

// Rate limiting — separate limits for API vs heavy routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,            // 1 minute
  max: 120,                       // 120 req/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' }
});
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,                        // 10 uploads/min per IP
  message: { error: 'Upload rate limit exceeded.' }
});

app.use('/api', apiLimiter);
app.use('/api/upload', uploadLimiter);

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/* ════════════════════════════════════════════════════════════
   AWS SDK v3 — S3 (uses EC2 IAM Role automatically)
════════════════════════════════════════════════════════════ */
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });

/* ════════════════════════════════════════════════════════════
   FILE UPLOAD — multer (memory, 10MB limit, images only)
════════════════════════════════════════════════════════════ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WEBP, GIF images allowed'), false);
    }
    cb(null, true);
  }
});

/* ════════════════════════════════════════════════════════════
   DATABASE — connection pool with retry + keep-alive
════════════════════════════════════════════════════════════ */
let pool;

function createPool() {
  pool = mysql.createPool({
    host:             process.env.DB_HOST,
    user:             process.env.DB_USER     || 'foodapp',
    password:         process.env.DB_PASS,
    database:         process.env.DB_NAME     || 'foodapp',
    waitForConnections: true,
    connectionLimit:  15,
    queueLimit:       30,
    connectTimeout:   15000,
    acquireTimeout:   15000,
    // Keep connections alive through NAT gateway
    enableKeepAlive:  true,
    keepAliveInitialDelay: 30000
  });

  // Surface pool errors to logs
  pool.on('connection', (conn) => console.log('[DB] New connection acquired'));
}

// Helper — run a query with structured error logging
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const [rows] = await pool.execute(sql, params);
    console.log(`[DB] ${sql.split(' ').slice(0,3).join(' ')} (${Date.now() - start}ms)`);
    return rows;
  } catch (err) {
    console.error(`[DB ERR] ${err.message} | SQL: ${sql}`);
    throw err;
  }
}

/* ════════════════════════════════════════════════════════════
   STARTUP — init DB with retry
════════════════════════════════════════════════════════════ */
async function init() {
  createPool();
  // Retry connection up to 10 times (RDS takes a while on cold start)
  for (let i = 1; i <= 10; i++) {
    try {
      await pool.execute('SELECT 1');
      console.log(`[DB] Connected to MySQL ✅`);
      break;
    } catch (e) {
      console.log(`[DB] Connection attempt ${i}/10 failed — retrying in ${i * 3}s`);
      if (i === 10) console.error('[DB] Could not connect — starting anyway');
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
}

/* ════════════════════════════════════════════════════════════
   ROUTES
════════════════════════════════════════════════════════════ */

// ── Root — API index ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: '🍔 FoodRush API',
    version: '2.0.0',
    environment: ENV,
    status: 'running',
    docs: 'https://github.com/bhatadarsh/Food-Rush',
    endpoints: {
      health:      'GET  /health',
      restaurants: 'GET  /api/restaurants',
      restaurant:  'GET  /api/restaurants/:id',
      menu:        'GET  /api/restaurants/:id/menu',
      reviews:     'GET  /api/restaurants/:id/reviews',
      addReview:   'POST /api/restaurants/:id/reviews',
      placeOrder:  'POST /api/orders',
      getOrder:    'GET  /api/orders/:id',
      upload:      'POST /api/upload  (multipart/form-data: image)'
    }
  });
});

// ── Health check — used by ALB every 30s ────────────────────
app.get('/health', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'connecting';
  try {
    await pool.execute('SELECT 1');
    dbStatus = 'connected';
  } catch {}
  res.json({
    status: 'ok',
    db: dbStatus,
    uptime: Math.floor(process.uptime()),
    latency_ms: Date.now() - start,
    ts: new Date().toISOString()
  });
});

// ── Restaurants ──────────────────────────────────────────────
app.get('/api/restaurants', async (req, res) => {
  try {
    const rows = await query('SELECT * FROM restaurants ORDER BY rating DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

app.get('/api/restaurants/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await query('SELECT * FROM restaurants WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch restaurant' });
  }
});

// ── Menu ─────────────────────────────────────────────────────
app.get('/api/restaurants/:id/menu', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await query(
      'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY category, price ASC',
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch menu' });
  }
});

// ── Orders ───────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  const { user_id, restaurant_id, items, total } = req.body;
  if (!restaurant_id || total === undefined || total < 0)
    return res.status(400).json({ error: 'restaurant_id and total are required' });
  if (total > 100000)
    return res.status(400).json({ error: 'Invalid order total' });
  try {
    const rows = await query(
      'INSERT INTO orders (user_id, restaurant_id, total, status) VALUES (?, ?, ?, "pending")',
      [user_id || null, restaurant_id, total]
    );
    res.status(201).json({ order_id: rows.insertId, status: 'pending', total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to place order' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await query('SELECT * FROM orders WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// ── Image Upload ─────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return res.status(500).json({ error: 'S3_BUCKET not configured' });

  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `food-photos/${Date.now()}-${safeName}`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket:      bucket,
      Key:         key,
      Body:        req.file.buffer,
      ContentType: req.file.mimetype
    }));
    const url = `https://${bucket}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
    console.log(`[S3] Uploaded: ${key} (${(req.file.size / 1024).toFixed(1)}KB)`);
    res.json({ url, key, size: req.file.size });
  } catch (err) {
    console.error('[S3 ERR]', err.message);
    res.status(500).json({ error: 'Failed to upload to S3' });
  }
});

// ── Reviews ──────────────────────────────────────────────────
app.get('/api/restaurants/:id/reviews', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await query(
      'SELECT * FROM reviews WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 20',
      [id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

app.post('/api/restaurants/:id/reviews', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  const { user_name, rating, comment } = req.body;
  const r = Math.min(5, Math.max(1, parseInt(rating, 10) || 5)); // clamp 1-5
  const name = String(user_name || 'Anonymous').slice(0, 100);
  const text = String(comment || '').slice(0, 1000);
  try {
    const rows = await query(
      'INSERT INTO reviews (restaurant_id, user_name, rating, comment) VALUES (?, ?, ?, ?)',
      [id, name, r, text]
    );
    res.status(201).json({ id: rows.insertId, status: 'created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to submit review' });
  }
});

/* ════════════════════════════════════════════════════════════
   GLOBAL ERROR HANDLERS
════════════════════════════════════════════════════════════ */
// Multer/validation errors
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 10MB)' });
  if (err.message.startsWith('Only '))  return res.status(415).json({ error: err.message });
  if (err.message.startsWith('CORS'))   return res.status(403).json({ error: err.message });
  console.error('[ERR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

/* ════════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN — drains connections cleanly
════════════════════════════════════════════════════════════ */
let server;
function shutdown(signal) {
  console.log(`[Server] ${signal} received — shutting down gracefully`);
  server.close(async () => {
    console.log('[Server] HTTP server closed');
    try { await pool.end(); console.log('[DB] Pool closed'); } catch {}
    process.exit(0);
  });
  // Force exit if shutdown takes too long
  setTimeout(() => { console.error('[Server] Force exit'); process.exit(1); }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});

/* ════════════════════════════════════════════════════════════
   START
════════════════════════════════════════════════════════════ */
init().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🍔 FoodRush API v2.0 — ${ENV}`);
    console.log(`   Listening on: http://0.0.0.0:${PORT}`);
    console.log(`   DB Host:      ${process.env.DB_HOST || 'not set'}`);
    console.log(`   S3 Bucket:    ${process.env.S3_BUCKET || 'not set'}`);
  });
});