#!/usr/bin/env bash
# Deploy the XFeed Paradise built-in scoring service to Cloud Run.
# Idempotent: creates the Secret Manager secrets on first run, adds a new
# secret version on later runs, then deploys from source and prints the URL.
#
# Key files (read with --data-file; values are never printed):
#   OPENAI_KEY_FILE    default ~/.config/openai/api-key      (required)
#   TYPESAFE_KEY_FILE  default ~/.config/typesafe/api-key    (optional; Jev backend)
set -euo pipefail

GCLOUD="${GCLOUD:-$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)}"
ACCOUNT="${ACCOUNT:-874749606899-compute@developer.gserviceaccount.com}"
PROJECT="${PROJECT:-boreal-conquest-464203-v2}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-xfeed-score}"
OPENAI_KEY_FILE="${OPENAI_KEY_FILE:-$HOME/.config/openai/api-key}"
TYPESAFE_KEY_FILE="${TYPESAFE_KEY_FILE:-$HOME/.config/typesafe/api-key}"

g() { "$GCLOUD" --account="$ACCOUNT" --project="$PROJECT" --quiet "$@"; }

# Create the secret if missing; add a version only when the value changed.
put_secret() {
  local name="$1" file="$2"
  if ! g secrets describe "$name" >/dev/null 2>&1; then
    g secrets create "$name" --replication-policy=automatic --data-file="$file" >/dev/null
    echo "Created secret $name"
    return
  fi
  local current new
  current="$(g secrets versions access latest --secret="$name" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)"
  new="$(shasum -a 256 < "$file" | cut -d' ' -f1)"
  if [[ "$current" == "$new" ]]; then
    echo "Secret $name unchanged"
  else
    g secrets versions add "$name" --data-file="$file" >/dev/null
    echo "Added a new version of secret $name"
  fi
}

cd "$(dirname "$0")"

[[ -s "$OPENAI_KEY_FILE" ]] || { echo "Missing OpenAI key file: $OPENAI_KEY_FILE" >&2; exit 1; }
put_secret xfeed-openai-api-key "$OPENAI_KEY_FILE"
SECRETS="OPENAI_API_KEY=xfeed-openai-api-key:latest"
if [[ -s "$TYPESAFE_KEY_FILE" ]]; then
  put_secret xfeed-typesafe-api-key "$TYPESAFE_KEY_FILE"
  SECRETS="$SECRETS,TYPESAFE_API_KEY=xfeed-typesafe-api-key:latest"
else
  echo "No TypeSafe key file; deploying without the Jev backend"
fi

# The runtime service account must be able to read the secrets.
for secret in xfeed-openai-api-key xfeed-typesafe-api-key; do
  if [[ "$SECRETS" == *"$secret"* ]]; then
    # Skip the binding when the runtime account can already read the secret
    # (e.g. a project-level secretAccessor grant); it may lack setIamPolicy.
    if g secrets versions access latest --secret="$secret" >/dev/null 2>&1; then
      echo "Runtime account can already read $secret"
    else
      g secrets add-iam-policy-binding "$secret" \
        --member="serviceAccount:$ACCOUNT" --role=roles/secretmanager.secretAccessor >/dev/null
    fi
  fi
done

g run deploy "$SERVICE" \
  --source=. \
  --region="$REGION" \
  --service-account="$ACCOUNT" \
  --allow-unauthenticated \
  --max-instances=1 \
  --min-instances=1 \
  --concurrency=80 \
  --cpu=1 \
  --memory=256Mi \
  --timeout=60 \
  --set-secrets="$SECRETS" \
  --set-env-vars="^@^XFEED_BACKENDS=${XFEED_BACKENDS:-jev,decisions,nano}"

URL="$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')"
echo "Deployed: $URL"
echo "Stable URL: https://$SERVICE-874749606899.$REGION.run.app"
echo "Health: $(curl -s --max-time 15 "https://$SERVICE-874749606899.$REGION.run.app/api/ok" || echo unreachable)"
