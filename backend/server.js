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
const { randomUUID } = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
const ENV  = process.env.NODE_ENV || 'production';

/* ══════════════════════════════════════════════════════════
   STRUCTURED JSON LOGGER
══════════════════════════════════════════════════════════ */
const log = (level, msg, meta = {}) => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    pid: process.pid,
    ...meta
  }));
};

/* ══════════════════════════════════════════════════════════
   IN-MEMORY CACHE (TTL-based, no dependencies)
══════════════════════════════════════════════════════════ */
class Cache {
  constructor() { this.store = new Map(); this.hits = 0; this.misses = 0; }
  get(key) {
    const item = this.store.get(key);
    if (!item) { this.misses++; return null; }
    if (Date.now() > item.exp) { this.store.delete(key); this.misses++; return null; }
    this.hits++;
    return item.val;
  }
  set(key, val, ttlMs = 60000) {
    this.store.set(key, { val, exp: Date.now() + ttlMs });
  }
  del(key) { this.store.delete(key); }
  flush()  { this.store.clear(); }
  stats()  { return { size: this.store.size, hits: this.hits, misses: this.misses, ratio: this.hits + this.misses > 0 ? `${Math.round(this.hits / (this.hits + this.misses) * 100)}%` : '0%' }; }
}
const cache = new Cache();

/* ══════════════════════════════════════════════════════════
   SECURITY & PERFORMANCE MIDDLEWARE
══════════════════════════════════════════════════════════ */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(morgan(ENV === 'production'
  ? ':method :url :status :res[content-length] - :response-time ms'
  : 'dev'
));

const ALLOWED_ORIGINS = [
  'http://www.learnwithadarsh.site', 'https://www.learnwithadarsh.site',
  'http://learnwithadarsh.site',     'https://learnwithadarsh.site',
  'http://localhost:3000', 'null'
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  maxAge: 86400
}));

app.set('trust proxy', 1);

// Rate limiting
app.use('/api', rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use('/api/upload', rateLimit({ windowMs: 60000, max: 10, message: { error: 'Upload rate limit exceeded.' } }));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

/* ══════════════════════════════════════════════════════════
   CORRELATION ID MIDDLEWARE
══════════════════════════════════════════════════════════ */
app.use((req, res, next) => {
  const id = req.headers['x-request-id'] || randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-ID', id);
  res.setHeader('X-Powered-By', 'FoodRush/2.0');
  next();
});

/* ══════════════════════════════════════════════════════════
   AWS S3 (IAM Role — no keys needed on EC2)
══════════════════════════════════════════════════════════ */
const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-south-1' });

/* ══════════════════════════════════════════════════════════
   MULTER — memory storage, images only, 10MB
══════════════════════════════════════════════════════════ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.mimetype))
      return cb(new Error('Only JPEG, PNG, WEBP, GIF images allowed'), false);
    cb(null, true);
  }
});

/* ══════════════════════════════════════════════════════════
   DATABASE — pool with retry & keep-alive
══════════════════════════════════════════════════════════ */
let pool;

function createPool() {
  pool = mysql.createPool({
    host:               process.env.DB_HOST,
    user:               process.env.DB_USER     || 'foodapp',
    password:           process.env.DB_PASS,
    database:           process.env.DB_NAME     || 'foodapp',
    waitForConnections: true,
    connectionLimit:    15,
    queueLimit:         30,
    connectTimeout:     15000,
    enableKeepAlive:    true,
    keepAliveInitialDelay: 30000
  });
}

async function dbQuery(sql, params = [], reqId = '-') {
  const t = Date.now();
  try {
    const [rows] = await pool.execute(sql, params);
    log('info', 'db_query', { sql: sql.split(' ').slice(0,4).join(' '), ms: Date.now()-t, rows: rows.length, reqId });
    return rows;
  } catch (err) {
    log('error', 'db_error', { sql, err: err.message, reqId });
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════
   STARTUP — DB retry
══════════════════════════════════════════════════════════ */
async function init() {
  createPool();
  for (let i = 1; i <= 10; i++) {
    try {
      await pool.execute('SELECT 1');
      log('info', 'db_connected', { host: process.env.DB_HOST });
      break;
    } catch (e) {
      log('warn', 'db_retry', { attempt: i, delay: `${i*3}s`, err: e.message });
      if (i === 10) log('error', 'db_failed_all_retries', {});
      await new Promise(r => setTimeout(r, i * 3000));
    }
  }
}

/* ══════════════════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════════════════ */

// Root — API index
app.get('/', (req, res) => res.json({
  name: '🍔 FoodRush API',
  version: '2.1.0',
  status: 'running',
  endpoints: {
    health:      'GET  /health',
    restaurants: 'GET  /api/restaurants?q=&cuisine=&sort=rating&page=1&limit=20',
    restaurant:  'GET  /api/restaurants/:id',
    menu:        'GET  /api/restaurants/:id/menu',
    reviews:     'GET  /api/restaurants/:id/reviews',
    addReview:   'POST /api/restaurants/:id/reviews',
    placeOrder:  'POST /api/orders',
    getOrder:    'GET  /api/orders/:id',
    upload:      'POST /api/upload'
  }
}));

// Health — with memory + cache stats
app.get('/health', async (req, res) => {
  const start = Date.now();
  let dbStatus = 'connecting';
  try { await pool.execute('SELECT 1'); dbStatus = 'connected'; } catch {}
  const mem = process.memoryUsage();
  res.json({
    status:  'ok',
    db:      dbStatus,
    uptime:  `${Math.floor(process.uptime())}s`,
    latency: `${Date.now() - start}ms`,
    memory: {
      rss:  `${Math.round(mem.rss / 1024 / 1024)}MB`,
      heap: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`
    },
    cache:   cache.stats(),
    ts:      new Date().toISOString()
  });
});

// Restaurants — search, filter, sort, paginate, cached
app.get('/api/restaurants', async (req, res) => {
  const { q = '', cuisine = '', sort = 'rating', page = 1, limit = 20, open_only } = req.query;
  const cacheKey = `restaurants:${q}:${cuisine}:${sort}:${page}:${limit}:${open_only}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }

  try {
    let sql = 'SELECT * FROM restaurants WHERE 1=1';
    const params = [];
    if (q) { sql += ' AND (name LIKE ? OR cuisine LIKE ? OR address LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    if (cuisine) { sql += ' AND cuisine = ?'; params.push(cuisine); }
    if (open_only === 'true') { sql += ' AND is_open = 1'; }

    const sortMap = { rating: 'rating DESC', time: 'delivery_time ASC', price: 'min_order ASC', newest: 'id DESC' };
    sql += ` ORDER BY ${sortMap[sort] || 'rating DESC'}`;

    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(50, parseInt(limit));
    sql += ' LIMIT ? OFFSET ?';
    params.push(Math.min(50, parseInt(limit)), offset);

    const rows = await dbQuery(sql, params, req.requestId);
    cache.set(cacheKey, rows, 60000); // 60s TTL
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Total-Count', rows.length);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch restaurants' });
  }
});

// Single restaurant
app.get('/api/restaurants/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  const key = `restaurant:${id}`;
  const cached = cache.get(key);
  if (cached) return res.setHeader('X-Cache','HIT').json(cached);
  try {
    const rows = await dbQuery('SELECT * FROM restaurants WHERE id = ?', [id], req.requestId);
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    cache.set(key, rows[0], 120000); // 2min TTL
    res.setHeader('X-Cache', 'MISS').json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to fetch restaurant' }); }
});

// Menu
app.get('/api/restaurants/:id/menu', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  const key = `menu:${id}`;
  const cached = cache.get(key);
  if (cached) return res.setHeader('X-Cache','HIT').json(cached);
  try {
    const rows = await dbQuery(
      'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY category, price ASC', [id], req.requestId
    );
    cache.set(key, rows, 120000);
    res.setHeader('X-Cache','MISS').json(rows);
  } catch { res.status(500).json({ error: 'Failed to fetch menu' }); }
});

// Orders — create
app.post('/api/orders', async (req, res) => {
  const { user_id, restaurant_id, items, total, promo_code, delivery_address } = req.body;
  if (!restaurant_id || total === undefined || total < 0)
    return res.status(400).json({ error: 'restaurant_id and total are required' });
  if (total > 100000) return res.status(400).json({ error: 'Invalid order total' });
  try {
    const rows = await dbQuery(
      'INSERT INTO orders (user_id, restaurant_id, total, status) VALUES (?, ?, ?, "pending")',
      [user_id || null, restaurant_id, total], req.requestId
    );
    log('info', 'order_placed', { orderId: rows.insertId, total, restaurant_id, promo: promo_code || null });
    res.status(201).json({ order_id: rows.insertId, status: 'pending', total, eta_minutes: Math.floor(Math.random() * 10) + 25 });
  } catch { res.status(500).json({ error: 'Failed to place order' }); }
});

// Orders — get
app.get('/api/orders/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await dbQuery('SELECT * FROM orders WHERE id = ?', [id], req.requestId);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch { res.status(500).json({ error: 'Failed to fetch order' }); }
});

// Image upload
app.post('/api/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });
  const bucket = process.env.S3_BUCKET;
  if (!bucket) return res.status(500).json({ error: 'S3_BUCKET not configured' });
  const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `food-photos/${Date.now()}-${safeName}`;
  try {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }));
    const url = `https://${bucket}.s3.${process.env.AWS_REGION || 'ap-south-1'}.amazonaws.com/${key}`;
    log('info', 's3_upload', { key, size: req.file.size, reqId: req.requestId });
    res.json({ url, key, size: req.file.size });
  } catch (err) {
    log('error', 's3_error', { err: err.message, reqId: req.requestId });
    res.status(500).json({ error: 'Failed to upload to S3' });
  }
});

// Reviews
app.get('/api/restaurants/:id/reviews', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  try {
    const rows = await dbQuery(
      'SELECT * FROM reviews WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 20', [id], req.requestId
    );
    res.json(rows);
  } catch { res.status(500).json({ error: 'Failed to fetch reviews' }); }
});

app.post('/api/restaurants/:id/reviews', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid ID' });
  const r    = Math.min(5, Math.max(1, parseInt(req.body.rating, 10) || 5));
  const name = String(req.body.user_name || 'Anonymous').slice(0, 100);
  const text = String(req.body.comment  || '').slice(0, 1000);
  try {
    const rows = await dbQuery(
      'INSERT INTO reviews (restaurant_id, user_name, rating, comment) VALUES (?, ?, ?, ?)',
      [id, name, r, text], req.requestId
    );
    // Invalidate restaurant cache so updated rating reflects
    cache.del(`restaurant:${id}`);
    cache.flush(); // clear restaurants list cache too
    res.status(201).json({ id: rows.insertId, status: 'created' });
  } catch { res.status(500).json({ error: 'Failed to submit review' }); }
});

// Cache admin (flush)
app.post('/api/admin/cache/flush', (req, res) => {
  cache.flush();
  log('info', 'cache_flushed', { by: req.ip });
  res.json({ message: 'Cache flushed', stats: cache.stats() });
});

/* ══════════════════════════════════════════════════════════
   ERROR HANDLERS
══════════════════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 10MB)' });
  if (err.message?.startsWith('Only '))  return res.status(415).json({ error: err.message });
  if (err.message?.startsWith('CORS'))   return res.status(403).json({ error: err.message });
  log('error', 'unhandled_error', { err: err.message, path: req.path, reqId: req.requestId });
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

/* ══════════════════════════════════════════════════════════
   GRACEFUL SHUTDOWN
══════════════════════════════════════════════════════════ */
let server;
function shutdown(signal) {
  log('info', 'shutdown', { signal });
  server.close(async () => {
    try { await pool.end(); log('info', 'pool_closed', {}); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException', err => { log('error', 'uncaught', { err: err.message }); process.exit(1); });

/* ══════════════════════════════════════════════════════════
   START
══════════════════════════════════════════════════════════ */
init().then(() => {
  server = app.listen(PORT, '0.0.0.0', () => {
    log('info', 'server_started', { port: PORT, env: ENV, pid: process.pid });
  });
});