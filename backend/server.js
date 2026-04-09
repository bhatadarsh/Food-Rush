require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const AWS = require('aws-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());

// AWS S3 — uses EC2 IAM role automatically
const s3 = new AWS.S3({ region: 'ap-south-1' });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// DB connection pool with retry
let pool;
function createPool() {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com',
    user: process.env.DB_USER || 'foodapp',
    password: process.env.DB_PASS || 'YourStrongPassword123!',
    database: process.env.DB_NAME || 'foodapp',
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10000,
    acquireTimeout: 10000
  });
}
createPool();

// ── Root route — API index ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name: '🍔 FoodRush API',
    version: '1.0.0',
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
      upload:      'POST /api/upload  (multipart: image)'
    }
  });
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', ts: new Date().toISOString() });
  } catch (err) {
    // Still return 200 so ALB doesn't kill the instance before DB is ready
    res.json({ status: 'ok', db: 'connecting', ts: new Date().toISOString() });
  }
});

// ── Restaurants ───────────────────────────────────────────────────────────────
app.get('/api/restaurants', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM restaurants ORDER BY rating DESC');
    res.json(rows);
  } catch (err) {
    console.error('GET /api/restaurants', err.message);
    res.status(500).json({ error: 'DB error', detail: err.message });
  }
});

app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM restaurants WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Menu ──────────────────────────────────────────────────────────────────────
app.get('/api/restaurants/:id/menu', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY category, price',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/menu', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Orders ────────────────────────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { user_id, restaurant_id, items, total } = req.body;
    if (!restaurant_id || !total) return res.status(400).json({ error: 'Missing required fields' });
    const [result] = await pool.query(
      'INSERT INTO orders (user_id, restaurant_id, total, status) VALUES (?, ?, ?, "pending")',
      [user_id || null, restaurant_id, total]
    );
    res.json({ order_id: result.insertId, status: 'pending', total });
  } catch (err) {
    console.error('POST /api/orders', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Image Upload ──────────────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const bucket = process.env.S3_BUCKET || 'foodapp-images-470561032473';
    const key = `food-photos/${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;
    await s3.putObject({
      Bucket: bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype
    }).promise();
    const url = `https://${bucket}.s3.ap-south-1.amazonaws.com/${key}`;
    res.json({ url, key });
  } catch (err) {
    console.error('POST /api/upload', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Reviews ───────────────────────────────────────────────────────────────────
app.get('/api/restaurants/:id/reviews', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM reviews WHERE restaurant_id = ? ORDER BY created_at DESC LIMIT 20',
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/restaurants/:id/reviews', async (req, res) => {
  try {
    const { user_name, rating, comment } = req.body;
    const [result] = await pool.query(
      'INSERT INTO reviews (restaurant_id, user_name, rating, comment) VALUES (?, ?, ?, ?)',
      [req.params.id, user_name || 'Anonymous', rating || 5, comment || '']
    );
    res.json({ id: result.insertId, status: 'created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[FoodApp] Server running on port ${PORT}`);
  console.log(`[FoodApp] DB: ${process.env.DB_HOST || 'foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com'}`);
});