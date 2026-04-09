#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# FoodRush — Deploy Script
#
# How it works:
#   1. If a CloudFormation stack exists → reads resource names from CF outputs
#   2. Falls back to hardcoded values (for manual/legacy deployments)
#   3. Packages backend code + uploads to S3
#   4. Deploys frontend to S3
#   5. Updates Lambda function code
#   6. Triggers ASG rolling instance refresh
#   7. Monitors ALB health until instances are healthy
#
# Usage:
#   ./deploy.sh                         # full deploy
#   ./deploy.sh --stack-name my-stack   # use specific CF stack
#   ./deploy.sh --skip-asg              # skip instance refresh (code-only)
#   ./deploy.sh --frontend-only         # only update frontend
#   ./deploy.sh --lambda-only           # only update Lambda
#   ./deploy.sh --infra                 # deploy CloudFormation stack first, then code
# ═══════════════════════════════════════════════════════════════════════════════

set -e

# ── Colors ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()  { echo -e "${BLUE}[$(date +%H:%M:%S)]${NC} $1"; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }

# ── Parse flags ────────────────────────────────────────────────────────────────
SKIP_ASG=false; LAMBDA_ONLY=false; FRONTEND_ONLY=false; DEPLOY_INFRA=false
STACK_NAME="foodapp-stack"  # default CF stack name

for arg in "$@"; do
  case $arg in
    --skip-asg)            SKIP_ASG=true ;;
    --lambda-only)         LAMBDA_ONLY=true ;;
    --frontend-only)       FRONTEND_ONLY=true ;;
    --infra)               DEPLOY_INFRA=true ;;
    --stack-name=*)        STACK_NAME="${arg#*=}" ;;
  esac
done

REGION="ap-south-1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log "${BOLD}═══════════════════════════════════════${NC}"
log "${BOLD}  FoodRush Deploy — Stack: $STACK_NAME${NC}"
log "${BOLD}═══════════════════════════════════════${NC}"
echo ""

# ── Pre-flight checks ───────────────────────────────────────────────────────────
log "Pre-flight checks..."

command -v aws >/dev/null || err "AWS CLI not installed"
aws sts get-caller-identity --region "$REGION" --output text --query Account >/dev/null \
  || err "AWS credentials not configured"

[[ -f "$SCRIPT_DIR/backend/server.js"   ]] || err "backend/server.js not found"
[[ -f "$SCRIPT_DIR/frontend/index.html" ]] || err "frontend/index.html not found"
[[ -f "$SCRIPT_DIR/lambda/index.js"    ]] || err "lambda/index.js not found"

# ⚠️ Guard: ACL in server.js breaks S3 uploads on modern buckets
if grep -q "ACL.*public-read" "$SCRIPT_DIR/backend/server.js"; then
  err "server.js has 'ACL: public-read' — remove it! Bucket policy handles public access."
fi

# ⚠️ Guard: Lambda must use SDK v3 (Node 18 runtime dropped sdk v2)
if grep -q "require('aws-sdk')" "$SCRIPT_DIR/lambda/index.js"; then
  err "lambda/index.js uses require('aws-sdk') (v2). Node 18 only has @aws-sdk/client-* (v3)."
fi

ok "Pre-flight checks passed"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# OPTIONAL: Deploy CloudFormation infrastructure first (--infra flag)
# ══════════════════════════════════════════════════════════════════════════════
if $DEPLOY_INFRA; then
  log "Deploying CloudFormation infrastructure..."
  read -p "  Enter DBPassword: " -s DB_PASS_INPUT; echo ""
  read -p "  Enter KeyPairName [foodApp]: " KEY_PAIR_INPUT
  KEY_PAIR_INPUT="${KEY_PAIR_INPUT:-foodApp}"

  aws cloudformation deploy \
    --template-file "$SCRIPT_DIR/infra/foodapp-cloudformation.yaml" \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --capabilities CAPABILITY_NAMED_IAM \
    --parameter-overrides \
      KeyPairName="$KEY_PAIR_INPUT" \
      DBPassword="$DB_PASS_INPUT" \
      DomainName="learnwithadarsh.site" \
      HostedZoneId="Z0367376ZWWODPWBUBY2" 2>&1

  ok "CloudFormation stack deployed: $STACK_NAME"
  echo ""
fi

# ══════════════════════════════════════════════════════════════════════════════
# READ RESOURCE NAMES — from CloudFormation outputs OR hardcoded fallback
# ══════════════════════════════════════════════════════════════════════════════
log "Reading resource configuration..."

# Try to read from CloudFormation stack outputs
CF_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].Outputs' \
  --output json 2>/dev/null)

get_cf_output() {
  echo "$CF_OUTPUTS" | python3 -c "
import sys, json
outputs = json.load(sys.stdin) or []
key = '$1'
for o in outputs:
    if o['OutputKey'] == key:
        print(o['OutputValue'])
        break
" 2>/dev/null
}

if [[ -n "$CF_OUTPUTS" && "$CF_OUTPUTS" != "null" ]]; then
  log "Using CloudFormation stack outputs from: $STACK_NAME"

  IMAGES_BUCKET=$(get_cf_output "ImagesBucketName")
  FRONTEND_BUCKET=$(get_cf_output "FrontendBucketName")
  ASG_NAME=$(get_cf_output "ASGName")
  LAMBDA_NAME=$(get_cf_output "LambdaFunctionName")
  ALB_DNS=$(get_cf_output "ALBDNSName")
  TG_ARN=$(get_cf_output "TargetGroupARN")

  ok "Resources loaded from CloudFormation"
else
  warn "CloudFormation stack '$STACK_NAME' not found — using hardcoded fallback values"
  warn "To use CF outputs, deploy with: ./deploy.sh --infra"
  echo ""

  # ── HARDCODED FALLBACK (legacy / manual deployment) ──────────────────────
  # Update these if you recreated resources with different names
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  IMAGES_BUCKET="foodapp-images-${ACCOUNT_ID}"
  FRONTEND_BUCKET="www.learnwithadarsh.site"    # MUST match domain exactly (S3 website hosting)
  ASG_NAME="foodapp-asg"
  LAMBDA_NAME="foodapp-image-processor"
  ALB_DNS=$(aws elbv2 describe-load-balancers --names "foodapp-alb" --region "$REGION" \
    --query 'LoadBalancers[0].DNSName' --output text 2>/dev/null || echo "")
  TG_ARN="arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT_ID}:targetgroup/foodapp-tg/174fe7f96161f7c9"
fi

# Validate we got all required values
[[ -z "$IMAGES_BUCKET"  ]] && err "Could not determine IMAGES_BUCKET"
[[ -z "$FRONTEND_BUCKET" ]] && err "Could not determine FRONTEND_BUCKET"
[[ -z "$ASG_NAME"       ]] && err "Could not determine ASG_NAME"
[[ -z "$LAMBDA_NAME"    ]] && err "Could not determine LAMBDA_NAME"

echo ""
log "Deploying to:"
echo "  Images bucket:   $IMAGES_BUCKET"
echo "  Frontend bucket: $FRONTEND_BUCKET"
echo "  ASG:             $ASG_NAME"
echo "  Lambda:          $LAMBDA_NAME"
echo "  ALB:             ${ALB_DNS:-N/A}"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1: Package + upload backend
# ══════════════════════════════════════════════════════════════════════════════
if ! $LAMBDA_ONLY && ! $FRONTEND_ONLY; then
  log "📦 Packaging backend..."
  cd "$SCRIPT_DIR/backend"
  tar -czf /tmp/foodrush-backend.tar.gz server.js package.json schema.sql
  ok "Backend packaged ($(du -sh /tmp/foodrush-backend.tar.gz | cut -f1))"

  log "☁️  Uploading backend to s3://$IMAGES_BUCKET/"
  aws s3 cp /tmp/foodrush-backend.tar.gz "s3://${IMAGES_BUCKET}/backend.tar.gz" \
    --region "$REGION" --no-progress
  aws s3 cp schema.sql "s3://${IMAGES_BUCKET}/schema.sql" \
    --region "$REGION" --no-progress
  ok "Backend + schema uploaded"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: Upload frontend
# NOTE: Bucket name MUST match domain (www.learnwithadarsh.site) — S3 website
# hosting reads Host header to find the bucket. Any other name = NoSuchBucket.
# ══════════════════════════════════════════════════════════════════════════════
if ! $LAMBDA_ONLY; then
  log "🌐 Uploading frontend to s3://$FRONTEND_BUCKET/"
  aws s3 cp "$SCRIPT_DIR/frontend/index.html" \
    "s3://${FRONTEND_BUCKET}/index.html" \
    --content-type "text/html" \
    --cache-control "no-cache, no-store, must-revalidate" \
    --region "$REGION" --no-progress
  ok "Frontend uploaded → http://$FRONTEND_BUCKET"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: Update Lambda
# NOTE: Lambda runtime is nodejs18.x — uses AWS SDK v3 built-in.
# Do NOT add a package.json with aws-sdk v2, it won't be installed for inline code.
# ══════════════════════════════════════════════════════════════════════════════
log "⚡ Updating Lambda: $LAMBDA_NAME..."
cd "$SCRIPT_DIR/lambda"
zip -q /tmp/foodrush-lambda.zip index.js
aws lambda update-function-code \
  --function-name "$LAMBDA_NAME" \
  --zip-file fileb:///tmp/foodrush-lambda.zip \
  --region "$REGION" \
  --output text --query 'LastModified' > /dev/null
ok "Lambda updated"

# Auto-fix: ensure Lambda role has CloudWatch metrics permission
# (CloudWatchFullAccess needed for PutMetricData — BasicExecutionRole only covers Logs)
LAMBDA_ROLE=$(aws lambda get-function-configuration \
  --function-name "$LAMBDA_NAME" --region "$REGION" \
  --query 'Role' --output text 2>/dev/null | sed 's|.*/||')

if [[ -n "$LAMBDA_ROLE" ]]; then
  CW_CHECK=$(aws iam list-attached-role-policies --role-name "$LAMBDA_ROLE" \
    --query "AttachedPolicies[?PolicyName=='CloudWatchFullAccess'].PolicyName" \
    --output text 2>/dev/null)
  if [[ -z "$CW_CHECK" ]]; then
    warn "CloudWatchFullAccess not on $LAMBDA_ROLE — attaching..."
    aws iam attach-role-policy --role-name "$LAMBDA_ROLE" \
      --policy-arn arn:aws:iam::aws:policy/CloudWatchFullAccess 2>&1
    ok "CloudWatchFullAccess attached to $LAMBDA_ROLE"
  fi
fi

if $LAMBDA_ONLY || $FRONTEND_ONLY; then
  echo ""
  ok "Partial deploy complete"
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Trigger ASG instance refresh
# ══════════════════════════════════════════════════════════════════════════════
if ! $SKIP_ASG; then
  log "🔄 Triggering ASG instance refresh: $ASG_NAME..."
  REFRESH_OUTPUT=$(aws autoscaling start-instance-refresh \
    --auto-scaling-group-name "$ASG_NAME" \
    --region "$REGION" \
    --strategy Rolling \
    --preferences '{"MinHealthyPercentage":0,"InstanceWarmup":300}' \
    --output text --query 'InstanceRefreshId' 2>&1)

  if echo "$REFRESH_OUTPUT" | grep -q "InstanceRefreshInProgress"; then
    warn "Instance refresh already in progress"
  else
    ok "Instance refresh started: $REFRESH_OUTPUT"
  fi
else
  warn "Skipping ASG refresh (--skip-asg)"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Monitor ALB health
# ══════════════════════════════════════════════════════════════════════════════
if [[ -n "$ALB_DNS" ]]; then
  log "🏥 Monitoring ALB health: http://$ALB_DNS/health (timeout: 5 min)..."
  HEALTHY=false

  for i in $(seq 1 20); do
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 \
      "http://${ALB_DNS}/health" 2>/dev/null || echo "000")

    if [[ -n "$TG_ARN" ]]; then
      TG_HEALTH=$(aws elbv2 describe-target-health \
        --target-group-arn "$TG_ARN" --region "$REGION" \
        --query 'TargetHealthDescriptions[*].TargetHealth.State' \
        --output text 2>/dev/null | sort | uniq -c | tr '\n' ' ')
    fi

    echo "  Attempt $i/20 — HTTP $STATUS | Targets: ${TG_HEALTH:-checking...}"

    if [[ "$STATUS" == "200" ]]; then
      HEALTHY=true
      ok "Backend is HEALTHY (HTTP 200 on /health)"
      break
    fi
    sleep 15
  done
else
  warn "No ALB DNS found — skipping health check"
  HEALTHY=true
fi

# ══════════════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo -e "${BOLD}  🚀 FoodRush Deploy Summary${NC}"
echo -e "${BOLD}═══════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}Frontend:${NC}    http://www.learnwithadarsh.site"
echo -e "  ${GREEN}Root:${NC}        http://learnwithadarsh.site  (redirects to www)"
echo -e "  ${GREEN}API:${NC}         http://api.learnwithadarsh.site"
echo -e "  ${GREEN}Health:${NC}      http://api.learnwithadarsh.site/health"
echo -e "  ${GREEN}ALB direct:${NC}  http://${ALB_DNS:-N/A}"
echo ""
echo -e "  ${GREEN}S3 Images:${NC}   s3://$IMAGES_BUCKET/food-photos/"
echo -e "  ${GREEN}Lambda logs:${NC} aws logs tail /aws/lambda/$LAMBDA_NAME --region $REGION --follow"
echo -e "  ${GREEN}CF Stack:${NC}    $STACK_NAME (${REGION})"
echo ""

if $HEALTHY; then
  echo -e "${GREEN}${BOLD}✅ FoodRush is LIVE!${NC}"
else
  echo -e "${YELLOW}${BOLD}⏳ Backend still warming up (~5 min for new instances).${NC}"
  echo ""
  echo "  Debug commands:"
  echo "  → ssh -i foodApp.pem ec2-user@<EC2-IP>   then:  pm2 logs foodapp"
  echo "  → cat /var/log/user-data.log"
  [[ -n "$TG_ARN" ]] && echo "  → aws elbv2 describe-target-health --target-group-arn $TG_ARN --region $REGION"
fi
echo ""
