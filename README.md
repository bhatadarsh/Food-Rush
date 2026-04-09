# 🍔 FoodRush — AWS Food Ordering Platform

> **Mentor Task** — Full-stack food ordering app (Swiggy/Zomato style) deployed entirely on AWS  
> **Domain:** [www.learnwithadarsh.site](http://www.learnwithadarsh.site) | **API:** [api.learnwithadarsh.site](https://api.learnwithadarsh.site)  
> **Region:** `ap-south-1` (Mumbai) | **Account:** `470561032473`

---

## 🌐 Live URLs

| URL | Service | Status |
|-----|---------|--------|
| `http://www.learnwithadarsh.site` | S3 Static Frontend | ✅ Live |
| `https://api.learnwithadarsh.site/health` | Backend Health | ✅ `{"status":"ok","db":"connected"}` |
| `https://api.learnwithadarsh.site/api/restaurants` | Restaurants API | ✅ Returns 6 restaurants |
| `https://api.learnwithadarsh.site/api/upload` | Image Upload → S3 | ✅ With Lambda trigger |

---

## 🏗️ Architecture

```
Internet
  │
  ├── www.learnwithadarsh.site ─────► S3 Bucket (www.learnwithadarsh.site)
  │                                   Static website hosting
  │
  └── api.learnwithadarsh.site ─────► Route 53 CNAME
                                           │
                                       ALB (foodapp-alb)
                                           │
                                  ┌────────┴────────┐
                              EC2 (t3.micro)    EC2 (t3.micro)
                              ap-south-1a      ap-south-1a
                              Node.js + PM2    [ASG: 1→4]
                                  │
                              RDS MySQL 8.0
                              (private subnet)

S3 (foodapp-images) ──[event]──► Lambda ──► CloudWatch Metrics
```

---

## 📁 Project Structure

```
foodappnew/
├── foodApp.pem                       # EC2 SSH key (chmod 400)
├── foodapp-admin_accessKeys.csv      # AWS IAM credentials
├── deploy.sh                         # 🚀 One-command deploy script
├── README.md                         # This file
├── explained.md                      # Full project explanation
│
├── backend/
│   ├── server.js       # Express.js API — NO ACL in s3.putObject (important!)
│   ├── schema.sql      # MySQL schema + seed data (6 restaurants, 25+ items)
│   ├── package.json    # Dependencies: express, mysql2, multer, aws-sdk, cors, dotenv
│   └── .env            # Environment variables (NOT committed to git)
│
├── frontend/
│   └── index.html      # Full Swiggy-style SPA (dark UI, cart, filters, upload)
│
├── lambda/
│   └── index.js        # AWS SDK v3 (NOT v2) — uses @aws-sdk/client-s3 & @aws-sdk/client-cloudwatch
│
└── infra/
    └── foodapp-cloudformation.yaml   # Full IaC template
```

---

## ⚠️ Known Issues & Fixes Applied

> **Read this before making changes — these cost hours to debug.**

### 1. S3 Upload: "The bucket does not allow ACLs"
**Cause:** AWS changed S3 defaults in 2023. New buckets block ACLs by default.  
**Fix applied:** `server.js` does NOT use `ACL: 'public-read'` in `s3.putObject()`.  
The bucket policy (`s3:GetObject` for `*`) already makes uploads public.  
**Never add `ACL: 'public-read'` back.**

### 2. Lambda: "Cannot find module 'aws-sdk'"
**Cause:** Node.js 18 runtime dropped AWS SDK v2. Only SDK v3 is available built-in.  
**Fix applied:** `lambda/index.js` uses `@aws-sdk/client-s3` and `@aws-sdk/client-cloudwatch`.  
**Never use `require('aws-sdk')` in Lambda — use `require('@aws-sdk/client-s3')` instead.**

### 3. S3 Frontend: "NoSuchBucket: www.learnwithadarsh.site"
**Cause:** S3 website hosting with custom domain requires the bucket name to EXACTLY match the domain.  
**Fix applied:** Frontend bucket is named `www.learnwithadarsh.site` (not `foodapp-frontend-*`).  
**Never rename this bucket.**

### 4. EC2 Node.js install on Amazon Linux 2
**Cause:** The AMI is Amazon Linux 2 (kernel 4.14). NodeSource Node 18 requires glibc 2.28+ which AL2 doesn't have.  
**Fix applied:** Use `nvm` to install Node 16 on the instance.  
**The launch template UserData uses nvm — do not change to NodeSource.**

### 5. Lambda CloudWatch permission denied
**Cause:** The `foodapp-lambda-role` inline policy wasn't overriding the execution context.  
**Fix applied:** `CloudWatchFullAccess` managed policy is attached to `foodapp-lambda-role`.

---

## 🚀 Deploy

```bash
# Full deploy (packages backend, uploads to S3, refreshes ASG, updates Lambda)
./deploy.sh

# Manual step-by-step:

# 1. Package & upload backend
cd backend && tar -czf /tmp/backend.tar.gz server.js package.json schema.sql
aws s3 cp /tmp/backend.tar.gz s3://foodapp-images-470561032473/backend.tar.gz --region ap-south-1

# 2. Upload frontend (must go to www.learnwithadarsh.site bucket)
aws s3 cp frontend/index.html s3://www.learnwithadarsh.site/index.html \
  --content-type text/html --region ap-south-1

# 3. Update Lambda
cd lambda && zip /tmp/lambda.zip index.js
aws lambda update-function-code \
  --function-name foodapp-image-processor --zip-file fileb:///tmp/lambda.zip \
  --region ap-south-1

# 4. Refresh EC2 instances
aws autoscaling start-instance-refresh \
  --auto-scaling-group-name foodapp-asg --region ap-south-1 \
  --strategy Rolling --preferences '{"MinHealthyPercentage":0,"InstanceWarmup":300}'
```

---

## 🔧 CloudFormation (Full Infrastructure Rebuild)

```bash
# Deploy from scratch on any AWS account
aws cloudformation deploy \
  --template-file infra/foodapp-cloudformation.yaml \
  --stack-name foodapp-stack \
  --region ap-south-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    KeyPairName=foodApp \
    DBPassword=YourStrongPassword123! \
    HostedZoneId=Z0367376ZWWODPWBUBY2 \
    DomainName=learnwithadarsh.site \
    AccountId=470561032473
```

---

## 🔍 Monitoring & Debugging

```bash
# Check backend health
curl https://api.learnwithadarsh.site/health

# SSH into EC2
ssh -i foodApp.pem ec2-user@<INSTANCE_IP>
pm2 status
pm2 logs foodapp
pm2 logs foodapp --err

# ALB target health
aws elbv2 describe-target-health --region ap-south-1 \
  --target-group-arn arn:aws:elasticloadbalancing:ap-south-1:470561032473:targetgroup/foodapp-tg/174fe7f96161f7c9

# Lambda logs (live tail)
aws logs tail /aws/lambda/foodapp-image-processor --region ap-south-1 --follow

# All uploads in S3
aws s3 ls s3://foodapp-images-470561032473/food-photos/ --region ap-south-1

# CloudWatch upload metrics
aws cloudwatch list-metrics --namespace FoodApp/Uploads --region ap-south-1
```

---

## 🗄️ Database

```bash
# Connect via SSH tunnel (from your laptop)
ssh -i foodApp.pem \
  -L 3307:foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com:3306 \
  ec2-user@<EC2_PUBLIC_IP> -N &

mysql -h 127.0.0.1 -P 3307 -u foodapp -pYourStrongPassword123! foodapp

# Or directly on EC2
mysql -h foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com \
      -u foodapp -pYourStrongPassword123! foodapp
```

---

## 📋 All AWS Resources

| Resource | Name / ID |
|----------|-----------|
| EC2 Instance | `i-099f10d0c2836731b` |
| Key Pair | `foodApp` |
| VPC | `vpc-0237c70ba86a22c69` (10.0.0.0/16) |
| Public Subnet 1a | `subnet-08ec11ef91a731474` (10.0.1.0/24) |
| Public Subnet 1b | `subnet-050c6f75d336920be` (10.0.2.0/24) |
| Private Subnet 1a | `subnet-019b2bae594bf5e4a` (10.0.3.0/24) |
| Private Subnet 1b | `subnet-0737a98cfe556348c` (10.0.4.0/24) |
| ALB | `foodapp-alb-142610432.ap-south-1.elb.amazonaws.com` |
| Target Group | `foodapp-tg` (port 3000, `/health`) |
| ASG | `foodapp-asg` (min:1, max:4, CPU target: 70%) |
| Launch Template | `foodapp-lt` (lt-0e95ecd5e8daec201) |
| RDS | `foodapp-db.cvu6kmcoq6zz.ap-south-1.rds.amazonaws.com` |
| S3 Frontend | `www.learnwithadarsh.site` |
| S3 Images | `foodapp-images-470561032473` |
| Lambda | `foodapp-image-processor` |
| IAM EC2 Role | `foodapp-ec2-role` |
| IAM Lambda Role | `foodapp-lambda-role` |
| Hosted Zone | `Z0367376ZWWODPWBUBY2` (learnwithadarsh.site) |
| CloudWatch NS | `FoodApp/Uploads` |
