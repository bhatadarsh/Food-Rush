# 🍔 FoodRush — How the Whole Thing Works

## 1. The Big Picture (30-second overview)

```
User's Browser
     │
     ├─ Opens www.learnwithadarsh.site  ──▶  S3 Bucket (HTML/JS/CSS)
     │                                       (No server needed — just static files)
     │
     └─ Clicks "Order" / "Upload"  ──▶  api.learnwithadarsh.site
                                          │
                                     Route 53 (DNS)
                                          │
                                      ALB (Load Balancer)
                                          │
                                   EC2 Instance (Node.js)
                                          │
                                    ┌─────┴──────┐
                                  RDS MySQL    S3 Images
                                  (data)      (photos)
```

---

## 2. Step-by-Step: What Happens When a User Opens the App

### Step 1 — Browser hits `www.learnwithadarsh.site`

```
Route 53 DNS lookup:
  www.learnwithadarsh.site
       ↓  CNAME
  www.learnwithadarsh.site.s3-website.ap-south-1.amazonaws.com
       ↓
  S3 Bucket serves index.html
```

- S3 just sends back the raw `index.html` file (42KB)
- **No server involved** — it's just like opening a file from a file server
- The entire UI (Swiggy-style cards, cart, categories) is inside that one HTML file

---

### Step 2 — Browser runs the JavaScript in `index.html`

The JS immediately calls:
```javascript
const API = 'https://api.learnwithadarsh.site';
fetch(`${API}/api/restaurants`)  // ← This hits your EC2 backend
```

---

### Step 3 — API request travels through the stack

```
Browser
  → api.learnwithadarsh.site  (Route 53 CNAME)
    → foodapp-alb-142610432.ap-south-1.elb.amazonaws.com  (ALB)
      → EC2 Instance i-099f10d0c2836731b : port 3000  (Node.js)
        → MySQL query to RDS  (foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com)
          → Returns JSON  ←─────────────────────────────────────────────┘
```

---

## 3. How the Database Works

### Where it lives
```
RDS MySQL 8.0
Host:  foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com
Port:  3306
DB:    foodapp
User:  foodapp
Pass:  YourStrongPassword123!
```

> **Important:** RDS is in a **private subnet** — it cannot be accessed from the internet directly.
> Only EC2 instances inside the VPC can reach it (via Security Group rule: port 3306 from EC2 SG only).

### The 4 Tables

```sql
restaurants          ← list of restaurants (name, cuisine, rating, etc.)
     │
     ├── menu_items  ← food items per restaurant (price, category, is_veg)
     │
     ├── orders      ← placed orders (total, status: pending/confirmed/delivered)
     │
     └── reviews     ← user reviews per restaurant (rating, comment)
```

### How to connect to & query the DB manually

**From your laptop** (via SSH tunnel through EC2):
```bash
# 1. SSH tunnel — forward local port 3307 → RDS via EC2
ssh -i foodApp.pem \
    -L 3307:foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com:3306 \
    ec2-user@52.66.163.0 -N &

# 2. Connect with mysql client (in another terminal)
mysql -h 127.0.0.1 -P 3307 -u foodapp -pYourStrongPassword123! foodapp

# 3. Run queries
SELECT * FROM restaurants;
SELECT * FROM menu_items WHERE restaurant_id = 1;
SELECT * FROM orders ORDER BY created_at DESC LIMIT 10;
```

**From inside EC2 directly:**
```bash
ssh -i foodApp.pem ec2-user@52.66.163.0
mysql -h foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com \
      -u foodapp -pYourStrongPassword123! foodapp
```

### What data is pre-loaded (seed data)

| Restaurant | Cuisine | Rating |
|-----------|---------|--------|
| Sushi Sensei | Japanese | 4.7 |
| Biryani Blues | Indian | 4.6 |
| Spice Garden | Indian | 4.5 |
| Pizza House | Italian | 4.2 |
| The Wok | Chinese | 4.1 |
| Burger Barn | American | 4.0 |

Each restaurant has menu items in `menu_items` table.

---

## 4. How Image Upload Works (S3 + Lambda)

### The Upload Flow

```
User selects image in browser
        ↓
POST /api/upload  (multipart form-data)
        ↓
EC2 Node.js (multer middleware stores file in memory)
        ↓
aws-sdk: s3.putObject(...)
        ↓
S3 Bucket: foodapp-images-470561032473
  └── food-photos/1712345678-pizza.jpg   ← stored here
        ↓
EC2 returns JSON: { "url": "https://foodapp-images-470561032473.s3.ap-south-1.amazonaws.com/food-photos/..." }
        ↓
S3 Event triggers Lambda (foodapp-image-processor)
        ↓
Lambda logs metadata + emits CloudWatch metrics
  (MetricName: ImageUploaded, UploadSizeBytes)
```

### How to see uploaded images

**Via AWS CLI:**
```bash
# List all uploaded food photos
aws s3 ls s3://foodapp-images-470561032473/food-photos/ --region ap-south-1

# Download a specific image
aws s3 cp s3://foodapp-images-470561032473/food-photos/FILENAME.jpg ./

# Get a public URL (images are public-read)
# https://foodapp-images-470561032473.s3.ap-south-1.amazonaws.com/food-photos/FILENAME.jpg
```

**Via S3 Console:**
- Go to → S3 → `foodapp-images-470561032473` → `food-photos/` folder

**Via the App:**
- Open `www.learnwithadarsh.site`
- Scroll down to "📸 Upload Food Photo"
- Drag & drop or click to select image → click "Upload to S3"
- You'll get back the public URL instantly

### How EC2 gets permission to write to S3
The EC2 instance has an **IAM Role** (`foodapp-ec2-role`) attached.
This role has a policy allowing `s3:PutObject` on the images bucket.
**No AWS keys are stored on the server** — IAM handles it automatically via instance metadata.

---

## 5. How the Load Balancer & Auto Scaling Works

```
Normal traffic (1 EC2):
  ALB → EC2 #1 (handles all requests)

High traffic (CPU > 70%):
  Auto Scaling → launches EC2 #2, #3, #4
  ALB → round-robins between all instances

Low traffic again:
  Auto Scaling → terminates extra instances
  (saves cost — free tier friendly)
```

### Health Check
Every 30 seconds, ALB calls `GET /health` on each EC2.
- If it gets `{"status":"ok"}` → instance stays in service ✅
- If it fails 3 times → instance is marked unhealthy, ASG launches a replacement

---

## 6. All API Endpoints

| Method | Endpoint | What it does |
|--------|----------|-------------|
| `GET` | `/health` | ALB health check |
| `GET` | `/api/restaurants` | List all restaurants (sorted by rating) |
| `GET` | `/api/restaurants/:id` | Single restaurant details |
| `GET` | `/api/restaurants/:id/menu` | Menu items for a restaurant |
| `POST` | `/api/orders` | Place an order `{restaurant_id, total, items}` |
| `GET` | `/api/orders/:id` | Get order status |
| `POST` | `/api/upload` | Upload food image (multipart form) |
| `GET` | `/api/restaurants/:id/reviews` | Get reviews |
| `POST` | `/api/restaurants/:id/reviews` | Post a review |

**Test them directly:**
```bash
# Health
curl https://api.learnwithadarsh.site/health

# All restaurants
curl https://api.learnwithadarsh.site/api/restaurants

# Menu for restaurant #1
curl https://api.learnwithadarsh.site/api/restaurants/1/menu

# Place an order
curl -X POST https://api.learnwithadarsh.site/api/orders \
  -H "Content-Type: application/json" \
  -d '{"restaurant_id": 1, "total": 540, "items": [{"id":1,"qty":2}]}'

# Upload an image
curl -X POST https://api.learnwithadarsh.site/api/upload \
  -F "image=@/path/to/photo.jpg"
```

---

## 7. How to Monitor What's Happening

### Check if the backend is running (on EC2)
```bash
ssh -i foodApp.pem ec2-user@52.66.163.0

pm2 status           # Is the app running?
pm2 logs foodapp     # Live logs (requests coming in)
pm2 monit            # CPU/Memory dashboard
```

### Check Lambda logs (image upload events)
```bash
aws logs tail /aws/lambda/foodapp-image-processor \
  --region ap-south-1 --follow
```

### Check ALB target health
```bash
aws elbv2 describe-target-health \
  --region ap-south-1 \
  --target-group-arn arn:aws:elasticloadbalancing:ap-south-1:470561032473:targetgroup/foodapp-tg/174fe7f96161f7c9
```

### Check Auto Scaling activity
```bash
aws autoscaling describe-scaling-activities \
  --auto-scaling-group-name foodapp-asg \
  --region ap-south-1 \
  --max-items 5
```

---

## 8. Quick Reference — All Resource Names

| Resource | Name/ID |
|----------|---------|
| EC2 Instance | `i-099f10d0c2836731b` (52.66.163.0) |
| PEM Key | `foodApp.pem` |
| RDS | `foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com` |
| ALB | `foodapp-alb-142610432.ap-south-1.elb.amazonaws.com` |
| ASG | `foodapp-asg` (min:1, max:4) |
| S3 Frontend | `www.learnwithadarsh.site` |
| S3 Images | `foodapp-images-470561032473` |
| Lambda | `foodapp-image-processor` |
| VPC | `vpc-0237c70ba86a22c69` (10.0.0.0/16) |
| Hosted Zone | `Z0367376ZWWODPWBUBY2` (learnwithadarsh.site) |
