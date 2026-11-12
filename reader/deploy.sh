#!/usr/bin/env bash
# Build and deploy the Paradise Reader to Cloud Run.
#
# APPROVAL STEP: creates secrets and a public Cloud Run service. Run only
# after Jacob approves the Noos-isolated rollout and both Ideaflow ID client
# registrations (reader/DEPLOY.md has the full order and rollback).
#
#   reader/deploy.sh                 print the plan (default; changes nothing)
#   reader/deploy.sh secrets         create session + OIDC client secrets (once)
#   reader/deploy.sh deploy          build image, deploy (new service: serves;
#                                    existing service: --no-traffic + tag)
#   reader/deploy.sh public          allow unauthenticated invocations
#                                    (needs an owner account, e.g. jacob@ideaflow.io)
#   reader/deploy.sh verify [URL]    check /api/ok and /api/config
#   reader/deploy.sh promote REV     send 100% traffic to revision REV
set -euo pipefail

PROJECT=boreal-conquest-464203-v2
REGION=us-central1
SERVICE=xfeed-noos-reader
ORIGIN="https://$SERVICE-874749606899.$REGION.run.app"
REPO="$REGION-docker.pkg.dev/$PROJECT/cloud-run-source-deploy"
EXTENSION_ORIGINS="${EXTENSION_ORIGINS:-chrome-extension://dljipjmfogkcfmbainbepkmblodkndph}"
ISSUER="${OIDC_ISSUER:-https://id.ideaflow.app/api/auth}"
WEB_CLIENT_FILE="${WEB_CLIENT_FILE:-}"
EXT_CLIENT_FILE="${EXT_CLIENT_FILE:-}"
ACCOUNT="${CLOUDSDK_CORE_ACCOUNT:-874749606899-compute@developer.gserviceaccount.com}"
G=(gcloud --project="$PROJECT" --account="$ACCOUNT" --quiet)
HERE="$(cd "$(dirname "$0")" && pwd)"
CMD="${1:-plan}"

json_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

case "$CMD" in
  plan)
    cat <<EOF
Paradise Reader deploy plan ($PROJECT / $REGION / $SERVICE)
  public origin      $ORIGIN
  extension origins  $EXTENSION_ORIGINS
  issuer             $ISSUER
  web client file    $WEB_CLIENT_FILE (from register:first-party-client)
  ext client file    $EXT_CLIENT_FILE (from oidc/register-extension-client.mjs)
Requires an approved isolated Noos archive endpoint and its shared secret first.
Steps after approval: secrets -> deploy -> public -> verify. See reader/DEPLOY.md.
EOF
    ;;

  secrets)
    umask 077
    if ! "${G[@]}" secrets describe xfeed-noos-reader-session-secret >/dev/null 2>&1; then
      openssl rand -base64 48 | tr -d '\n' | "${G[@]}" secrets create xfeed-noos-reader-session-secret --replication-policy=automatic --data-file=-
    else
      echo "xfeed-noos-reader-session-secret exists; leaving it"
    fi
    if ! "${G[@]}" secrets describe xfeed-noos-reader-oidc-client-secret >/dev/null 2>&1; then
      [[ -f "$WEB_CLIENT_FILE" ]] || { echo "missing $WEB_CLIENT_FILE (register the web client first)" >&2; exit 1; }
      json_field "$WEB_CLIENT_FILE" client_secret | tr -d '\n' | "${G[@]}" secrets create xfeed-noos-reader-oidc-client-secret --replication-policy=automatic --data-file=-
    else
      echo "xfeed-noos-reader-oidc-client-secret exists; leaving it"
    fi
    ;;

  deploy)
    [[ "${NOOS_PARADISE_URL:-}" == https://* ]] || { echo "set the approved HTTPS NOOS_PARADISE_URL first" >&2; exit 1; }
    [[ -f "$WEB_CLIENT_FILE" && -f "$EXT_CLIENT_FILE" ]] || { echo "register both Ideaflow ID clients first (see DEPLOY.md)" >&2; exit 1; }
    for s in xfeed-noos-archive-secret xfeed-noos-reader-session-secret xfeed-noos-reader-oidc-client-secret; do
      "${G[@]}" secrets describe "$s" >/dev/null || { echo "missing secret $s" >&2; exit 1; }
    done
    WEB_ID=$(json_field "$WEB_CLIENT_FILE" client_id)
    EXT_ID=$(json_field "$EXT_CLIENT_FILE" client_id)
    TAG="r$(git -C "$HERE" rev-parse --short=7 HEAD)"
    if [[ -n "$(git -C "$HERE" status --porcelain -- .)" ]]; then
      echo "reader/ has uncommitted changes; commit before deploying" >&2
      exit 1
    fi
    IMAGE="$REPO/$SERVICE:$TAG"
    "${G[@]}" builds submit "$HERE" --tag "$IMAGE"
    COMMON=(--region="$REGION" --image="$IMAGE" --revision-suffix="$TAG"
      --set-secrets="NOOS_PARADISE_SECRET=xfeed-noos-archive-secret:latest,SESSION_SECRET=xfeed-noos-reader-session-secret:latest,OIDC_WEB_CLIENT_SECRET=xfeed-noos-reader-oidc-client-secret:latest"
      --set-env-vars="^@^PUBLIC_ORIGIN=$ORIGIN@NOOS_PARADISE_URL=$NOOS_PARADISE_URL@EXTENSION_ORIGINS=$EXTENSION_ORIGINS@OIDC_ISSUER=$ISSUER@OIDC_WEB_CLIENT_ID=$WEB_ID@OIDC_EXTENSION_CLIENT_IDS=$EXT_ID"
      --memory=256Mi --cpu=1 --concurrency=80 --min-instances=0 --max-instances=2 --timeout=30)
    if "${G[@]}" run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1; then
      "${G[@]}" run deploy "$SERVICE" "${COMMON[@]}" --no-traffic --tag="$TAG"
      echo "Deployed $SERVICE-$TAG with no traffic. Check https://$TAG---$SERVICE-874749606899.$REGION.run.app/api/ok"
      echo "then: reader/deploy.sh promote $SERVICE-$TAG"
    else
      "${G[@]}" run deploy "$SERVICE" "${COMMON[@]}" --no-allow-unauthenticated
      echo "Created $SERVICE. Next: reader/deploy.sh public (owner account), then verify."
    fi
    ;;

  public)
    # The compute service account lacks run.services.setIamPolicy; use an owner.
    gcloud --project="$PROJECT" --account="${OWNER_ACCOUNT:-jacob@ideaflow.io}" run services add-iam-policy-binding "$SERVICE" \
      --region="$REGION" --member=allUsers --role=roles/run.invoker
    ;;

  verify)
    URL="${2:-$ORIGIN}"
    curl -fsS --max-time 15 "$URL/api/ok"; echo
    curl -fsS --max-time 15 "$URL/api/config"; echo
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$URL/v1/items")
    [[ "$code" == 401 ]] && echo "items require auth: ok" || { echo "expected 401 from /v1/items, got $code" >&2; exit 1; }
    ;;

  promote)
    REV="${2:?revision name, e.g. $SERVICE-r1234567}"
    "${G[@]}" run services update-traffic "$SERVICE" --region="$REGION" --to-revisions="$REV=100"
    ;;

  *)
    echo "unknown command: $CMD" >&2
    exit 2
    ;;
esac
