#!/usr/bin/env bash
# The original Postgres provisioner does not apply to the Noos archive fork.
set -euo pipefail
if [[ "${1:-plan}" != plan ]]; then
  echo 'Noos archive provisioning requires a reviewed isolated database/credential plan. See reader/DEPLOY.md; no Cloud SQL action was taken.' >&2
  exit 1
fi
cat <<'PLAN'
This fork uses Noos app storage, not the older xfeed_reader Cloud SQL database.
No infrastructure is provisioned by this script. Prepare the isolated Noos
archive connection, identity clients and deployment approval in reader/DEPLOY.md.
PLAN
