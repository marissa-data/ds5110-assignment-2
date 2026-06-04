#!/usr/bin/env bash
# Deploy Lambdas + API Gateway + S3 static website + S3 data bucket.
set -euo pipefail

REGION="us-east-1"
ACCOUNT_ID="175407131980"
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/LabRole"
LAMBDA1_NAME="ds5110-a2-lambda1"
LAMBDA2_NAME="ds5110-a2-lambda2"
COORDINATOR_NAME="ds5110-a2-coordinator"
WORKER_NAME="ds5110-a2-worker"
ML_LAYER_NAME="ds5110-a2-ml-layer"
COORD_LAYER_NAME="ds5110-a2-coordinator-layer"
API_NAME="ds5110-a2-api"
FRONTEND_BUCKET="ds5110-a2-frontend-${ACCOUNT_ID}"
DATA_BUCKET="ds5110-a2-data-${ACCOUNT_ID}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="${SCRIPT_DIR}/frontend"

export PATH="/home/ubuntu/.local/bin:/home/ubuntu/bin:$PATH"

# ── Package all Lambdas ──────────────────────────────────────────────────────
pack() {
  local src=$1 dest=$2
  python3 - <<PYEOF
import zipfile
z = zipfile.ZipFile('${dest}', 'w', zipfile.ZIP_DEFLATED)
z.write('${src}', 'handler.py')
z.close()
PYEOF
}

echo "==> Packaging Lambdas"
pack "${SCRIPT_DIR}/lambdas/lambda1/handler.py"      /tmp/lambda1.zip
pack "${SCRIPT_DIR}/lambdas/lambda2/handler.py"      /tmp/lambda2.zip
pack "${SCRIPT_DIR}/lambdas/coordinator/handler.py"  /tmp/coordinator.zip
pack "${SCRIPT_DIR}/lambdas/worker/handler.py"       /tmp/worker.zip

# ── Generic Lambda deploy helper ─────────────────────────────────────────────
deploy_lambda() {
  local name=$1 zip=$2 timeout=${3:-30} memory=${4:-128}
  if aws lambda get-function --function-name "$name" --region "$REGION" &>/dev/null; then
    echo "==> Updating $name"
    aws lambda update-function-code \
      --function-name "$name" --zip-file "fileb://${zip}" \
      --region "$REGION" --output text --query 'FunctionArn' >/dev/null
    aws lambda wait function-updated --function-name "$name" --region "$REGION"
  else
    echo "==> Creating $name"
    aws lambda create-function \
      --function-name "$name" --runtime python3.12 --role "$ROLE_ARN" \
      --handler handler.lambda_handler --zip-file "fileb://${zip}" \
      --timeout "$timeout" --memory-size "$memory" \
      --region "$REGION" --output text --query 'FunctionArn' >/dev/null
    aws lambda wait function-active --function-name "$name" --region "$REGION"
  fi
}

# ── Deploy placeholder Lambdas ───────────────────────────────────────────────
deploy_lambda "$LAMBDA1_NAME" /tmp/lambda1.zip
deploy_lambda "$LAMBDA2_NAME" /tmp/lambda2.zip

# ── API Gateway HTTP API ─────────────────────────────────────────────────────
API_ID=$(aws apigatewayv2 get-apis --region "$REGION" \
  --output text --query "Items[?Name=='${API_NAME}'].ApiId | [0]")

if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  echo "==> Creating API Gateway HTTP API"
  API_ID=$(aws apigatewayv2 create-api \
    --name "$API_NAME" --protocol-type HTTP \
    --cors-configuration 'AllowOrigins=["*"],AllowMethods=["GET","POST"],AllowHeaders=["Content-Type"]' \
    --region "$REGION" --output text --query 'ApiId')

  INT1=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA1_NAME}/invocations" \
    --region "$REGION" --output text --query 'IntegrationId')
  INT2=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${LAMBDA2_NAME}/invocations" \
    --region "$REGION" --output text --query 'IntegrationId')

  aws apigatewayv2 create-route --api-id "$API_ID" \
    --route-key "POST /lambda1" --target "integrations/$INT1" \
    --region "$REGION" --output text --query 'RouteId' >/dev/null
  aws apigatewayv2 create-route --api-id "$API_ID" \
    --route-key "POST /lambda2" --target "integrations/$INT2" \
    --region "$REGION" --output text --query 'RouteId' >/dev/null

  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' \
    --auto-deploy --region "$REGION" --output text --query 'StageName' >/dev/null

  aws lambda add-permission --function-name "$LAMBDA1_NAME" \
    --statement-id AllowAPIGW --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/lambda1" \
    --region "$REGION" --output text --query 'Statement' >/dev/null
  aws lambda add-permission --function-name "$LAMBDA2_NAME" \
    --statement-id AllowAPIGW --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*/lambda2" \
    --region "$REGION" --output text --query 'Statement' >/dev/null

  echo "==> API Gateway created: $API_ID"
else
  echo "==> API Gateway already exists: $API_ID"
fi

BASE_URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com"
API_CALLBACK_URL="${BASE_URL}/job/worker-done"

# ── Look up published layer ARNs ─────────────────────────────────────────────
get_layer_arn() {
  local name=$1
  aws lambda list-layer-versions --layer-name "$name" \
    --region "$REGION" --output text \
    --query 'LayerVersions[0].LayerVersionArn' 2>/dev/null || echo "None"
}

ML_LAYER_ARN=$(get_layer_arn "$ML_LAYER_NAME")
COORD_LAYER_ARN=$(get_layer_arn "$COORD_LAYER_NAME")

for arn_check in "$ML_LAYER_ARN" "$COORD_LAYER_ARN"; do
  if [ "$arn_check" = "None" ] || [ -z "$arn_check" ]; then
    echo "ERROR: A required Lambda layer is missing. Run the one-time layer setup first." >&2
    exit 1
  fi
done
echo "==> ML layer:          $ML_LAYER_ARN"
echo "==> Coordinator layer: $COORD_LAYER_ARN"

# ── Worker Lambda ────────────────────────────────────────────────────────────
deploy_lambda "$WORKER_NAME" /tmp/worker.zip 300 3008

echo "==> Attaching ML layer + env to worker"
aws lambda update-function-configuration \
  --function-name "$WORKER_NAME" \
  --timeout 600 --memory-size 2048 \
  --layers "$ML_LAYER_ARN" \
  --environment '{"Variables":{"HF_HOME":"/tmp","TRANSFORMERS_CACHE":"/tmp/model","HF_HUB_DISABLE_XET":"1"}}' \
  --region "$REGION" --output text --query 'FunctionArn' >/dev/null
aws lambda wait function-updated --function-name "$WORKER_NAME" --region "$REGION"

# ── Coordinator Lambda ───────────────────────────────────────────────────────
deploy_lambda "$COORDINATOR_NAME" /tmp/coordinator.zip 300 512

echo "==> Attaching coordinator layer + env"
aws lambda update-function-configuration \
  --function-name "$COORDINATOR_NAME" \
  --timeout 300 --memory-size 512 \
  --layers "$COORD_LAYER_ARN" \
  --environment "{\"Variables\":{\"DATA_BUCKET\":\"${DATA_BUCKET}\",\"WORKER_FUNCTION\":\"${WORKER_NAME}\",\"API_CALLBACK_URL\":\"${API_CALLBACK_URL}\",\"SHARD_SIZE\":\"200\"}}" \
  --region "$REGION" --output text --query 'FunctionArn' >/dev/null
aws lambda wait function-updated --function-name "$COORDINATOR_NAME" --region "$REGION"

# Wire coordinator routes into API Gateway (idempotent: skip if permission exists)
COORD_POLICY=$(aws lambda get-policy --function-name "$COORDINATOR_NAME" \
  --region "$REGION" 2>/dev/null || echo '{}')
if echo "$COORD_POLICY" | grep -q 'AllowAPIGW'; then
  echo "==> Coordinator API Gateway routes already configured"
else
  echo "==> Adding coordinator routes to API Gateway"
  COORD_ARN="arn:aws:lambda:${REGION}:${ACCOUNT_ID}:function:${COORDINATOR_NAME}"
  COORD_INT=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${COORD_ARN}/invocations" \
    --region "$REGION" --output text --query 'IntegrationId')

  for ROUTE_KEY in "POST /upload" "POST /upload-url" "POST /job/start" "GET /job/status" \
                   "GET /job/results" "POST /job/worker-done"; do
    aws apigatewayv2 create-route --api-id "$API_ID" \
      --route-key "$ROUTE_KEY" --target "integrations/$COORD_INT" \
      --region "$REGION" --output text --query 'RouteId' >/dev/null
    echo "    Route: $ROUTE_KEY"
  done

  # Single broad permission covering all coordinator routes
  aws lambda add-permission --function-name "$COORDINATOR_NAME" \
    --statement-id AllowAPIGW --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT_ID}:${API_ID}/*/*" \
    --region "$REGION" --output text --query 'Statement' >/dev/null
fi

# ── Write config.json ────────────────────────────────────────────────────────
echo "==> Writing frontend/config.json"
cat > "${FRONTEND_DIR}/config.json" <<JSONEOF
{
  "lambda1Url": "${BASE_URL}/lambda1",
  "lambda2Url": "${BASE_URL}/lambda2",
  "coordinatorUrl": "${BASE_URL}"
}
JSONEOF

# ── S3 static website bucket ─────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$FRONTEND_BUCKET" --region "$REGION" &>/dev/null; then
  echo "==> Frontend bucket already exists: $FRONTEND_BUCKET"
else
  echo "==> Creating frontend bucket: $FRONTEND_BUCKET"
  aws s3api create-bucket --bucket "$FRONTEND_BUCKET" --region "$REGION" \
    --output text --query 'Location' >/dev/null
  aws s3api put-public-access-block --bucket "$FRONTEND_BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false \
    --region "$REGION"
  aws s3api put-bucket-website --bucket "$FRONTEND_BUCKET" \
    --website-configuration '{"IndexDocument":{"Suffix":"index.html"},"ErrorDocument":{"Key":"index.html"}}' \
    --region "$REGION"
  aws s3api put-bucket-policy --bucket "$FRONTEND_BUCKET" --region "$REGION" \
    --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicReadGetObject\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${FRONTEND_BUCKET}/*\"}]}"
fi

# ── Data bucket (private) ─────────────────────────────────────────────────────
if aws s3api head-bucket --bucket "$DATA_BUCKET" --region "$REGION" &>/dev/null; then
  echo "==> Data bucket already exists: $DATA_BUCKET"
else
  echo "==> Creating data bucket: $DATA_BUCKET"
  aws s3api create-bucket --bucket "$DATA_BUCKET" --region "$REGION" \
    --output text --query 'Location' >/dev/null
  aws s3api put-public-access-block --bucket "$DATA_BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    --region "$REGION"
fi

# ── Upload frontend files ─────────────────────────────────────────────────────
echo "==> Uploading frontend to s3://${FRONTEND_BUCKET}/"
aws s3 cp "${FRONTEND_DIR}/index.html"  "s3://${FRONTEND_BUCKET}/index.html"  --content-type "text/html"              --region "$REGION"
aws s3 cp "${FRONTEND_DIR}/styles.css"  "s3://${FRONTEND_BUCKET}/styles.css"  --content-type "text/css"               --region "$REGION"
aws s3 cp "${FRONTEND_DIR}/app.js"      "s3://${FRONTEND_BUCKET}/app.js"      --content-type "application/javascript" --region "$REGION"
aws s3 cp "${FRONTEND_DIR}/config.json" "s3://${FRONTEND_BUCKET}/config.json" --content-type "application/json"       --region "$REGION"

WEBSITE_URL="http://${FRONTEND_BUCKET}.s3-website-${REGION}.amazonaws.com"

echo "==> Done."
echo "    Website:         ${WEBSITE_URL}"
echo "    Coordinator:     ${BASE_URL}/job/..."
echo "    Data bucket:     s3://${DATA_BUCKET}"
