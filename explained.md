# 📖 FoodRush — Complete Project Explanation

> This document explains every part of the FoodRush platform—what each service does,
> why it was chosen, and how all the pieces connect together.

---

## Table of Contents

1. [What We Built](#1-what-we-built)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Every AWS Service Explained](#3-every-aws-service-explained)
4. [Request Lifecycle — Step by Step](#4-request-lifecycle--step-by-step)
5. [Database Deep Dive](#5-database-deep-dive)
6. [Image Upload Pipeline](#6-image-upload-pipeline)
7. [Auto Scaling — How It Saves Cost](#7-auto-scaling--how-it-saves-cost)
8. [Security Model](#8-security-model)
9. [DNS & Domain Routing](#9-dns--domain-routing)
10. [Bugs Encountered & Fixes Applied](#10-bugs-encountered--fixes-applied)
11. [API Reference](#11-api-reference)
12. [Quick Command Reference](#12-quick-command-reference)

---

## 1. What We Built

FoodRush is a **food ordering web application** similar to Swiggy or Zomato, where:

- Users visit `www.learnwithadarsh.site` to browse restaurants and place orders
- The backend API runs at `api.learnwithadarsh.site`
- Food photos are uploaded to AWS S3
- Every upload automatically triggers a Lambda function
- The infrastructure handles traffic spikes by adding EC2 instances automatically
- Everything is defined as code using CloudFormation

---

## 2. Architecture Diagram

```
INTERNET
  │
  ├── www.learnwithadarsh.site ──► Route 53 CNAME
  │                                    ↓
  │                               S3 Website (www.learnwithadarsh.site bucket)
  │                               serves index.html  [No server needed]
  │
  └── api.learnwithadarsh.site ──► Route 53 CNAME
                                       ↓
                                   ALB (foodapp-alb)
                                       ↓
                              [VPC: 10.0.0.0/16]
                              Auto Scaling Group (1→4 EC2)
                                  EC2 t3.micro
                                  Node.js + PM2 :3000
                                       ↓
                                  RDS MySQL 8.0
                                  (private subnet only)

S3 (foodapp-images) ─[S3 event]─► Lambda ─► CloudWatch Metrics
```

---

## 3. Every AWS Service Explained

### 3.1 EC2 (Elastic Compute Cloud)
**What it is:** A virtual server in the cloud.
**What it runs:** Node.js backend (Express.js) via PM2.

```
Instance type:  t3.micro (1 vCPU, 1GB RAM)
OS:             Amazon Linux 2
Port:           3000
Process mgr:    PM2 cluster mode
Node install:   nvm → Node 16 (AL2 kernel 4.14 needs nvm, not NodeSource)
```

### 3.2 IAM (Identity and Access Management)
**What it is:** AWS's permission system.

| Role | Who uses it | Permissions |
|------|-------------|-------------|
| `foodapp-ec2-role` | EC2 instances | S3 read/write, CloudWatch logs |
| `foodapp-lambda-role` | Lambda | S3 read, CloudWatch metrics + logs |

EC2 gets credentials automatically from the Instance Metadata Service (IMDS). No credentials stored on disk.

### 3.3 VPC (Virtual Private Cloud)
**What it is:** Your own isolated network inside AWS.

```
VPC:  10.0.0.0/16

Public subnets  (EC2 + ALB — internet accessible):
  10.0.1.0/24  ap-south-1a
  10.0.2.0/24  ap-south-1b

Private subnets (RDS — NOT internet accessible):
  10.0.3.0/24  ap-south-1a
  10.0.4.0/24  ap-south-1b

NAT Gateway:       EC2 → internet (for npm, S3, etc.)
Internet Gateway:  internet → public subnets
```

### 3.4 Security Groups (Firewall Rules)

| SG | Inbound | Why |
|----|---------|-----|
| `foodapp-alb-sg` | 80/443 from 0.0.0.0/0 | Internet → ALB |
| `foodapp-ec2-sg` | 3000 from ALB SG only | ALB → EC2 (no direct internet) |
| `foodapp-rds-sg` | 3306 from EC2 SG only | EC2 → DB (nothing else can reach RDS) |

### 3.5 S3 — Two Buckets

**`www.learnwithadarsh.site`** — Frontend
- Static website hosting (serves index.html)
- Bucket name must match domain exactly (S3 uses Host header to find bucket)
- Public read via bucket policy

**`foodapp-images-470561032473`** — Images + Deployment
- `food-photos/*` — user uploaded food photos
- `backend.tar.gz` — Node.js app deployment artifact
- `schema.sql` — database schema
- S3 event → Lambda on every new upload to `food-photos/`

### 3.6 Route 53 (DNS)
Hosted Zone: `learnwithadarsh.site` (Hostinger nameservers point to AWS)

| Record | Type | Destination |
|--------|------|-------------|
| `www.learnwithadarsh.site` | CNAME | S3 website endpoint |
| `api.learnwithadarsh.site` | CNAME | ALB DNS name |
| `_27eda0092...` | CNAME | ACM SSL validation |

### 3.7 Application Load Balancer (ALB)
- Receives all API traffic
- Health checks: `GET /health` every 30s → needs HTTP 200
- Healthy threshold: 2 passes / Unhealthy: 3 failures
- Routes to healthy EC2 instances via Target Group on port 3000

### 3.8 Auto Scaling Group (ASG)
```
Min: 1  |  Max: 4  |  Default: 1

Scale-OUT: CPU > 70% (avg, 2 eval periods)
Scale-IN:  CPU drops below 70%
ALB requests: > 1000 req/target also triggers scale-out
Warmup: 300s (new instance gets time to bootstrap before health checks)
```

### 3.9 Lambda
```
Name:     foodapp-image-processor
Runtime:  nodejs18.x  ← SDK v3 ONLY (no aws-sdk v2)
Trigger:  S3 ObjectCreated on food-photos/*
Actions:  1. Read file metadata from S3
          2. Push metrics to CloudWatch (FoodApp/Uploads namespace)
          3. Log everything to CloudWatch Logs
Cost:     $0 when idle
```

### 3.10 RDS
```
Engine:   MySQL 8.0
Class:    db.t3.micro
Endpoint: foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com
DB:       foodapp  |  User: foodapp
Subnet:   Private (cannot be reached from internet)
```

### 3.11 CloudFormation
Template: `infra/foodapp-cloudformation.yaml`
Defines all 30+ resources — rebuild entire infrastructure with one command.

### 3.12 AWS CLI
Used in `deploy.sh` for: packaging, uploading, triggering refreshes, monitoring health.

---

## 4. Request Lifecycle — Step by Step

### User Opens www.learnwithadarsh.site

```
1. Browser DNS lookup → Route 53
2. Returns CNAME → S3 website endpoint
3. S3 reads Host header → finds bucket named 'www.learnwithadarsh.site'
4. S3 returns index.html
5. Browser renders UI (skeleton cards shown)
6. JavaScript runs: fetch('https://api.learnwithadarsh.site/api/restaurants')
```

### API Call Travels Through the Stack

```
Browser → api.learnwithadarsh.site
        → Route 53 → ALB
        → Healthy EC2 instance (round-robin)
        → Node.js Express: GET /api/restaurants
        → MySQL: SELECT * FROM restaurants ORDER BY rating DESC
        → Returns JSON array
        → Browser renders restaurant cards
```

### User Places an Order

```
Browser: POST /api/orders  {restaurant_id:1, total:540}
EC2:     INSERT INTO orders (restaurant_id, total, status) VALUES (1, 540, 'pending')
         Returns: {order_id: 42, status: 'pending'}
Browser: Shows "Order Placed!" modal
```

---

## 5. Database Deep Dive

### Schema

```sql
restaurants  (id, name, cuisine, rating, delivery_time, min_order, image_url, address, is_open)
menu_items   (id, restaurant_id, name, price, description, category, is_veg, is_available)
orders       (id, user_id, restaurant_id, total, status, created_at)
             status: pending → confirmed → preparing → out_for_delivery → delivered
reviews      (id, restaurant_id, user_name, rating 1-5, comment, created_at)
```

### Connecting

```bash
# From EC2 (inside VPC)
mysql -h foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com \
      -u foodapp -pYourStrongPassword123! foodapp

# From laptop (SSH tunnel)
ssh -i foodApp.pem \
    -L 3307:foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com:3306 \
    ec2-user@<EC2_IP> -N &
mysql -h 127.0.0.1 -P 3307 -u foodapp -pYourStrongPassword123! foodapp
```

---

## 6. Image Upload Pipeline

```
User selects image → POST /api/upload (multipart)
        ↓
EC2 (multer): holds file in memory, no disk write
        ↓
EC2 calls S3 via IAM role (NO hardcoded keys, NO ACL param):
  s3.putObject({ Bucket, Key: 'food-photos/timestamp-name.jpg', Body, ContentType })
        ↓
S3 stores file. Public via bucket policy.
Returns URL to browser.
        ↓
S3 fires ObjectCreated event → Lambda wakes up
        ↓
Lambda: reads metadata → pushes CloudWatch metrics → logs
```

### See Uploaded Images

```bash
# List
aws s3 ls s3://foodapp-images-470561032473/food-photos/ --region ap-south-1

# Public URL format
https://foodapp-images-470561032473.s3.ap-south-1.amazonaws.com/food-photos/FILENAME

# CloudWatch upload count
aws cloudwatch get-metric-statistics \
  --namespace FoodApp/Uploads --metric-name ImageUploaded \
  --dimensions Name=BucketName,Value=foodapp-images-470561032473 \
  --start-time $(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 86400 --statistics Sum --region ap-south-1
```

---

## 7. Auto Scaling — How It Saves Cost

```
Normal traffic:  1 EC2 running  (~$0.01/hr)
High traffic:    ASG launches EC2 #2, #3, #4 automatically
After peak:      Extra instances terminated, back to 1

New instance bootstrap time: ~5 minutes
  - nvm + Node 16 install
  - Download backend.tar.gz from S3
  - npm install
  - Load schema into MySQL
  - PM2 start
  - ALB health check passes → receives traffic
```

---

## 8. Security Model

```
Layered network: Internet → ALB SG → EC2 SG → RDS SG
IAM least privilege: EC2 can only touch its own S3 buckets
No keys on server: credentials come from IMDS (Instance Metadata Service)
DB not exposed: RDS in private subnet, only EC2 SG can reach port 3306
```

---

## 9. DNS & Domain Routing

- `learnwithadarsh.site` was bought from **Hostinger**
- Route 53 hosted zone created — gave 4 NS records
- Those 4 NS records configured in Hostinger's control panel
- Route 53 now controls all DNS

**Critical rule:** `www.learnwithadarsh.site` CNAME must point to the S3 website endpoint (not the REST API endpoint), AND the bucket name must be `www.learnwithadarsh.site` exactly.

---

## 10. Bugs Encountered & Fixes Applied

### Bug 1 — S3 Upload: "The bucket does not allow ACLs"
**Cause:** AWS disabled ACLs on new S3 buckets by default (April 2023).
`ACL: 'public-read'` in `s3.putObject()` throws an error.

**Fix:** Removed `ACL: 'public-read'` from `server.js`. Bucket policy (`s3:GetObject` for `*`) makes files public instead.

**Rule:** Never use ACLs on new buckets. Use bucket policies.

---

### Bug 2 — Lambda: "Cannot find module 'aws-sdk'"
**Cause:** Lambda Node 18 runtime removed AWS SDK v2. Only SDK v3 is bundled.

**Fix:** Rewrote `lambda/index.js` with SDK v3:
```javascript
// WRONG (v2)
const AWS = require('aws-sdk');

// CORRECT (v3 — built into Node 18 Lambda)
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
```

---

### Bug 3 — Frontend: "NoSuchBucket: www.learnwithadarsh.site"
**Cause:** S3 website hosting reads the HTTP Host header to find the bucket.
The old bucket `foodapp-frontend-470561032473` didn't match the domain.

**Fix:** Created bucket named exactly `www.learnwithadarsh.site`. Updated Route 53 CNAME to its website endpoint.

**Rule:** S3 website hosting + custom domain = bucket name must equal domain name.

---

### Bug 4 — EC2: Node.js 18 fails to install on Amazon Linux 2
**Cause:** AL2 ships with glibc 2.26. Node 18 via NodeSource requires glibc 2.28+.

**Fix:** Use `nvm` instead:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 16
```

**Rule:** Amazon Linux 2 → use nvm. Amazon Linux 2023 → can use NodeSource or dnf directly.

---

### Bug 5 — Lambda: CloudWatch permission denied
**Cause:** `foodapp-lambda-role` only had `AWSLambdaBasicExecutionRole` (only Logs, not Metrics).
Inline policy wasn't taking effect due to IAM caching.

**Fix:** Attached `CloudWatchFullAccess` managed policy to the role.
`deploy.sh` now auto-checks and attaches this if missing.

**Rule:** `AWSLambdaBasicExecutionRole` = only CloudWatch Logs. For CloudWatch Metrics you need additional policy.

---

## 11. API Reference

Base URL: `https://api.learnwithadarsh.site`

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| GET | `/health` | — | `{status, db, ts}` |
| GET | `/api/restaurants` | — | Array sorted by rating |
| GET | `/api/restaurants/:id` | — | Single restaurant |
| GET | `/api/restaurants/:id/menu` | — | Menu items by category |
| POST | `/api/orders` | `{restaurant_id, total, items}` | `{order_id, status}` |
| GET | `/api/orders/:id` | — | Order details |
| POST | `/api/upload` | `multipart: image` | `{url, key}` |
| GET | `/api/restaurants/:id/reviews` | — | Reviews array |
| POST | `/api/restaurants/:id/reviews` | `{user_name, rating, comment}` | `{id, status}` |

---

## 12. Quick Command Reference

```bash
# Health check
curl https://api.learnwithadarsh.site/health

# ALB target health
aws elbv2 describe-target-health --region ap-south-1 \
  --target-group-arn arn:aws:elasticloadbalancing:ap-south-1:470561032473:targetgroup/foodapp-tg/174fe7f96161f7c9

# Lambda logs live
aws logs tail /aws/lambda/foodapp-image-processor --region ap-south-1 --follow

# S3 uploads
aws s3 ls s3://foodapp-images-470561032473/food-photos/ --region ap-south-1

# SSH into EC2
ssh -i foodApp.pem ec2-user@<EC2_IP>
pm2 status && pm2 logs foodapp

# Trigger ASG refresh
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name foodapp-asg --region ap-south-1 \
  --strategy Rolling --preferences '{"MinHealthyPercentage":0,"InstanceWarmup":300}'

# DB tunnel + connect
ssh -i foodApp.pem -L 3307:foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com:3306 \
    ec2-user@<EC2_IP> -N &
mysql -h 127.0.0.1 -P 3307 -u foodapp -pYourStrongPassword123! foodapp

# Deploy everything
./deploy.sh

# Deploy only frontend
./deploy.sh --frontend-only

# Deploy only Lambda
./deploy.sh --lambda-only

# Deploy code without restarting instances
./deploy.sh --skip-asg
```
