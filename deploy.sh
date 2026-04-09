#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# FoodRush — Deploy Script  (battle-tested, all known issues fixed)
#
# What this does:
#   1. Packages backend code into a tarball
#   2. Uploads backend + schema to S3 (foodapp-images bucket)
#   3. Uploads frontend to S3 (www.learnwithadarsh.site bucket)
#   4. Updates Lambda function code
#   5. Triggers rolling ASG instance refresh
#   6. Monitors ALB health until instances are healthy
#
# Usage:
#   ./deploy.sh              # full deploy
#   ./deploy.sh --skip-asg   # skip ASG refresh (code-only deploy)
#   ./deploy.sh --lambda-only
#   ./deploy.sh --frontend-only
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# ── Config ─────────────────────────────────────────────────────────────────────
REGION="ap-south-1"
ACCOUNT_ID="470561032473"
APP_NAME="foodapp"

IMAGES_BUCKET="${APP_NAME}-images-${ACCOUNT_ID}"    # for backend code + user uploads
FRONTEND_BUCKET="www.learnwithadarsh.site"          # MUST match domain exactly (S3 website hosting rule)
                                                     # ⚠️  NOT foodapp-frontend-470561032473

ASG_NAME="${APP_NAME}-asg"
LAMBDA_NAME="${APP_NAME}-image-processor"
TG_ARN="arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/foodapp-tg/174fe7f96161f7c9"
ALB_DNS="foodapp-alb-142610432.ap-south-1.elb.amazonaws.com"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Parse flags
SKIP_ASG=false; LAMBDA_ONLY=false; FRONTEND_ONLY=false
for arg in "$@"; do
  case $arg in
    --skip-asg)      SKIP_ASG=true ;;
    --lambda-only)   LAMBDA_ONLY=true ;;
    --frontend-only) FRONTEND_ONLY=true ;;
  esac
done

# ── Colors ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }

# ── Pre-flight checks ───────────────────────────────────────────────────────────
log "${BOLD}FoodRush Deploy — Pre-flight checks${NC}"

command -v aws >/dev/null || err "AWS CLI not installed"
aws sts get-caller-identity --region "$REGION" --output text --query Account >/dev/null \
  || err "AWS credentials not configured. Run: aws configure"

[[ -d "$SCRIPT_DIR/backend"  ]] || err "backend/ directory not found"
[[ -d "$SCRIPT_DIR/frontend" ]] || err "frontend/ directory not found"
[[ -d "$SCRIPT_DIR/lambda"   ]] || err "lambda/ directory not found"
[[ -f "$SCRIPT_DIR/backend/server.js"     ]] || err "backend/server.js not found"
[[ -f "$SCRIPT_DIR/frontend/index.html"   ]] || err "frontend/index.html not found"
[[ -f "$SCRIPT_DIR/lambda/index.js"       ]] || err "lambda/index.js not found"

# ⚠️  Guard: ensure server.js does NOT have ACL: 'public-read' in s3.putObject
if grep -q "ACL.*public-read" "$SCRIPT_DIR/backend/server.js"; then
  err "server.js contains 'ACL: public-read' which breaks S3 uploads!\n   Remove it — the bucket policy already makes uploads public."
fi

# ⚠️  Guard: ensure lambda uses SDK v3, not require('aws-sdk')
if grep -q "require('aws-sdk')" "$SCRIPT_DIR/lambda/index.js"; then
  err "lambda/index.js uses AWS SDK v2 (require('aws-sdk'))!\n   Node 18 runtime only has SDK v3. Use @aws-sdk/client-s3 etc."
fi

ok "Pre-flight checks passed"
echo ""

if $LAMBDA_ONLY; then
  goto_lambda=true
elif $FRONTEND_ONLY; then
  goto_frontend=true
fi

# ── Step 1: Package backend ─────────────────────────────────────────────────────
if ! $LAMBDA_ONLY && ! $FRONTEND_ONLY; then
  log "📦 Packaging backend..."
  cd "$SCRIPT_DIR/backend"
  tar -czf /tmp/foodrush-backend.tar.gz server.js package.json schema.sql
  SIZE=$(du -sh /tmp/foodrush-backend.tar.gz | cut -f1)
  ok "Backend packaged ($SIZE)"
fi

# ── Step 2: Upload backend to S3 ───────────────────────────────────────────────
if ! $LAMBDA_ONLY && ! $FRONTEND_ONLY; then
  log "☁️  Uploading backend to S3 (${IMAGES_BUCKET})..."
  aws s3 cp /tmp/foodrush-backend.tar.gz \
    "s3://${IMAGES_BUCKET}/backend.tar.gz" \
    --region "$REGION" --no-progress
  aws s3 cp "$SCRIPT_DIR/backend/schema.sql" \
    "s3://${IMAGES_BUCKET}/schema.sql" \
    --region "$REGION" --no-progress
  ok "Backend + schema uploaded to s3://${IMAGES_BUCKET}/"
fi

# ── Step 3: Upload frontend to S3 ──────────────────────────────────────────────
# NOTE: Frontend MUST go to bucket named exactly 'www.learnwithadarsh.site'
# because S3 website hosting maps Host header → bucket name.
# The bucket 'foodapp-frontend-470561032473' will give NoSuchBucket error
# when accessed via www.learnwithadarsh.site domain.
if ! $LAMBDA_ONLY; then
  log "🌐 Uploading frontend to S3 (${FRONTEND_BUCKET})..."
  aws s3 cp "$SCRIPT_DIR/frontend/index.html" \
    "s3://${FRONTEND_BUCKET}/index.html" \
    --content-type "text/html" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --region "$REGION" --no-progress
  ok "Frontend uploaded to s3://${FRONTEND_BUCKET}/"
fi

# ── Step 4: Update Lambda ───────────────────────────────────────────────────────
# NOTE: Lambda runtime is nodejs18.x which does NOT include aws-sdk v2.
# lambda/index.js MUST use @aws-sdk/client-s3 and @aws-sdk/client-cloudwatch (v3).
log "⚡ Updating Lambda function (${LAMBDA_NAME})..."
cd "$SCRIPT_DIR/lambda"
zip -q /tmp/foodrush-lambda.zip index.js
LAMBDA_MODIFIED=$(aws lambda update-function-code \
  --function-name "$LAMBDA_NAME" \
  --zip-file fileb:///tmp/foodrush-lambda.zip \
  --region "$REGION" \
  --output text --query 'LastModified' 2>&1)
ok "Lambda updated: ${LAMBDA_MODIFIED}"

# Ensure Lambda IAM role has CloudWatch permission
# (CloudWatchFullAccess managed policy must be attached to foodapp-lambda-role)
CW_ATTACHED=$(aws iam list-attached-role-policies \
  --role-name foodapp-lambda-role \
  --query "AttachedPolicies[?PolicyName=='CloudWatchFullAccess'].PolicyName" \
  --output text 2>/dev/null)
if [[ -z "$CW_ATTACHED" ]]; then
  warn "CloudWatchFullAccess not attached to foodapp-lambda-role. Attaching now..."
  aws iam attach-role-policy \
    --role-name foodapp-lambda-role \
    --policy-arn arn:aws:iam::aws:policy/CloudWatchFullAccess 2>&1
  ok "CloudWatchFullAccess attached"
else
  ok "Lambda CloudWatch permission: present"
fi

if $LAMBDA_ONLY || $FRONTEND_ONLY; then
  echo ""
  ok "Done (partial deploy)"
  exit 0
fi

# ── Step 5: Trigger ASG instance refresh ───────────────────────────────────────
if ! $SKIP_ASG; then
  log "🔄 Triggering ASG instance refresh (${ASG_NAME})..."
  REFRESH_OUTPUT=$(aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$ASG_NAME" \
    --region "$REGION" \
    --strategy Rolling \
    --preferences '{"MinHealthyPercentage":0,"InstanceWarmup":300}' \
    --output text --query 'InstanceRefreshId' 2>&1)

  if echo "$REFRESH_OUTPUT" | grep -q "InstanceRefreshInProgress"; then
    warn "Instance refresh already in progress — skipping"
  else
    ok "Instance refresh started: ${REFRESH_OUTPUT}"
    log "Waiting 30s for new instance to start bootstrapping..."
    sleep 30
  fi
else
  warn "Skipping ASG refresh (--skip-asg flag set)"
  log "Restarting PM2 on existing instances via SSM (if available)..."
  aws ssm send-command \
    --document-name "AWS-RunShellScript" \
    --targets "Key=tag:aws:autoscaling:groupName,Values=${ASG_NAME}" \
    --parameters 'commands=["cd /home/ec2-user && aws s3 cp s3://foodapp-images-470561032473/backend.tar.gz . --region ap-south-1 && tar -xzf backend.tar.gz && pm2 restart foodapp --update-env"]' \
    --region "$REGION" \
    --output text --query 'Command.CommandId' 2>/dev/null \
    && ok "SSM restart command sent" || warn "SSM not available — instances will pick up code on next refresh"
fi

# ── Step 6: Health monitoring ───────────────────────────────────────────────────
log "🏥 Monitoring ALB target health (timeout: 5 min)..."
HEALTHY=false
for i in $(seq 1 20); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
    "http://${ALB_DNS}/health" 2>/dev/null || echo "000")

  TG_HEALTH=$(aws elbv2 describe-target-health \
    --target-group-arn "$TG_ARN" \
    --region "$REGION" \
    --query 'TargetHealthDescriptions[*].TargetHealth.State' \
    --output text 2>/dev/null | tr ' ' '\n' | sort | uniq -c | tr '\n' ' ')

  echo "  Attempt ${i}/20 — HTTP ${STATUS} | Targets: ${TG_HEALTH}(waiting...)"

  if [[ "$STATUS" == "200" ]]; then
    HEALTHY=true
    ok "Backend is HEALTHY! (HTTP 200 on /health)"
    break
  fi
  sleep 15
done

# ── Summary ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "${BOLD}  🚀 FoodRush Deploy Summary${NC}"
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}Frontend:${NC}    http://www.learnwithadarsh.site"
echo -e "  ${GREEN}API health:${NC}  https://api.learnwithadarsh.site/health"
echo -e "  ${GREEN}Restaurants:${NC} https://api.learnwithadarsh.site/api/restaurants"
echo -e "  ${GREEN}Lambda logs:${NC} aws logs tail /aws/lambda/foodapp-image-processor --region ${REGION} --follow"
echo -e "  ${GREEN}S3 uploads:${NC}  aws s3 ls s3://${IMAGES_BUCKET}/food-photos/ --region ${REGION}"
echo ""

if $HEALTHY; then
  echo -e "${GREEN}${BOLD}✅ FoodRush is fully LIVE!${NC}"
else
  echo -e "${YELLOW}${BOLD}⏳ Deployment complete — backend still warming up.${NC}"
  echo ""
  echo "  Debug commands:"
  echo "  → aws elbv2 describe-target-health --target-group-arn $TG_ARN --region $REGION"
  echo "  → ssh -i foodApp.pem ec2-user@\$(aws ec2 describe-instances --region $REGION ..."
  echo "       ...then: pm2 logs foodapp"
fi
echo ""
