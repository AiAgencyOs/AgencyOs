#!/usr/bin/env bash
# Deploy the AgencyOS external-cron stack, then install the canonical handler.
#
# Two steps on purpose: CloudFormation stands up every resource (with a placeholder
# Lambda body), then update-function-code installs infra/aws/cron/handler.mjs — so the
# deployed logic is exactly the file under review, never a copy pasted into the template.
#
# The stack ships INERT: the schedule is DISABLED and the secret holds placeholders.
# Deploying it changes nothing about production until the owner does the two steps this
# script prints at the end.
#
# Usage:
#   AWS_REGION=ap-south-1 infra/aws/cron/deploy.sh            # deploy / update
#   AWS_REGION=ap-south-1 STACK=agencyos-cron infra/aws/cron/deploy.sh
#
# Requires: awscli v2, and AWS credentials with rights to create the stack's resources.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="${STACK:-agencyos-cron}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-south-1}}"
PREFIX="${PREFIX:-agencyos-cron}"

echo "== AgencyOS external cron — deploy =="
echo "   stack:  $STACK"
echo "   region: $REGION"
aws sts get-caller-identity --query Account --output text >/dev/null

echo "== 1/3  validate template =="
aws cloudformation validate-template --region "$REGION" \
  --template-body "file://$HERE/template.yaml" >/dev/null
echo "   ok"

echo "== 2/3  deploy stack (schedule DISABLED, secret placeholders) =="
aws cloudformation deploy --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$HERE/template.yaml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "Prefix=$PREFIX" \
  --no-fail-on-empty-changeset

FN="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)"

echo "== 3/3  install handler.mjs into $FN =="
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cp "$HERE/handler.mjs" "$TMP/index.mjs"
( cd "$TMP" && zip -q handler.zip index.mjs )
aws lambda update-function-code --region "$REGION" \
  --function-name "$FN" \
  --zip-file "fileb://$TMP/handler.zip" >/dev/null
echo "   installed"

cat <<EOF

Deployed — and INERT. Nothing fires yet. To go live, the OWNER does two steps:

  1) Put the real values into the secret (never echo them into a shell that logs):
       aws secretsmanager put-secret-value --region $REGION \\
         --secret-id ${PREFIX}-config \\
         --secret-string '{"PROD_URL":"https://<prod-domain>","CRON_SECRET":"<value>","VERCEL_AUTOMATION_BYPASS_SECRET":"<token>"}'

  2) Enable the once-a-minute schedule:
       aws scheduler update-schedule --region $REGION --name ${PREFIX}-tick \\
         --state ENABLED --schedule-expression 'rate(1 minute)' \\
         --flexible-time-window '{"Mode":"OFF"}' \\
         --target "\$(aws scheduler get-schedule --region $REGION --name ${PREFIX}-tick --query Target --output json)"

  Verify (see infra/aws/cron/README.md): the tick should reach the runner (200), a wrong
  CRON_SECRET should 401, and a core.jobs row should move. To pause: set --state DISABLED.
  To remove everything: aws cloudformation delete-stack --region $REGION --stack-name $STACK
EOF
