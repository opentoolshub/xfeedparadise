#!/usr/bin/env bash
# Provision the Paradise Reader database on the shared Cloud SQL instance.
#
# APPROVAL STEP: this changes shared infrastructure. Run only after Jacob
# approves. See reader/DEPLOY.md for the whole sequence and rollback.
#
# Creates, on collablists-pg (project boreal-conquest-464203-v2):
#   - database xfeed_reader, owned by a new login role xfeed_reader
#   - CONNECT revoked from PUBLIC, so other apps' roles cannot open it
#   - Secret Manager secret xfeed-reader-database-url (Cloud SQL socket DSN)
# The app creates its one table on first start. No password is printed.
#
# Usage: reader/provision.sh            (dry run: prints the plan)
#        reader/provision.sh --apply    (does it)
# Rollback: reader/provision.sh --rollback   (drops DB, role and secret)
set -euo pipefail

PROJECT=boreal-conquest-464203-v2
REGION=us-central1
INSTANCE=collablists-pg
CONN="$PROJECT:$REGION:$INSTANCE"
DB=xfeed_reader
ROLE=xfeed_reader
SECRET=xfeed-reader-database-url
ACCOUNT="${CLOUDSDK_CORE_ACCOUNT:-874749606899-compute@developer.gserviceaccount.com}"
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/bin/psql)}"
PROXY="${CLOUD_SQL_PROXY:-$(command -v cloud-sql-proxy || echo /opt/homebrew/bin/cloud-sql-proxy)}"
G=(gcloud --project="$PROJECT" --account="$ACCOUNT" --quiet)
MODE="${1:-}"

plan() {
  cat <<EOF
Plan (instance $CONN, account $ACCOUNT):
  1. gcloud sql users create $ROLE --instance=$INSTANCE --password=<random 40 chars>
  2. gcloud sql databases create $DB --instance=$INSTANCE
  3. via cloud-sql-proxy as $ROLE: ALTER DATABASE $DB OWNER TO $ROLE; REVOKE ALL ON DATABASE $DB FROM PUBLIC
  4. gcloud secrets create $SECRET (value: postgresql://$ROLE:***@/$DB?host=/cloudsql/$CONN)
Run with --apply to execute, --rollback to undo.
EOF
}

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

if [[ "$MODE" == "--rollback" ]]; then
  echo "Rolling back $DB on $CONN (data in $DB will be destroyed)."
  "${G[@]}" sql databases delete "$DB" --instance="$INSTANCE" || echo "database $DB not deleted (missing?)"
  "${G[@]}" sql users delete "$ROLE" --instance="$INSTANCE" || echo "role $ROLE not deleted (missing?)"
  "${G[@]}" secrets delete "$SECRET" || echo "secret $SECRET not deleted (missing?)"
  exit 0
fi

if [[ "$MODE" != "--apply" ]]; then
  plan
  exit 0
fi

# Refuse to touch an existing database or role.
if "${G[@]}" sql databases describe "$DB" --instance="$INSTANCE" >/dev/null 2>&1; then
  echo "Database $DB already exists on $INSTANCE; refusing." >&2
  exit 1
fi
if "${G[@]}" sql users list --instance="$INSTANCE" --format='value(name)' | grep -qx "$ROLE"; then
  echo "Role $ROLE already exists on $INSTANCE; refusing." >&2
  exit 1
fi
if "${G[@]}" secrets describe "$SECRET" >/dev/null 2>&1; then
  echo "Secret $SECRET already exists; refusing." >&2
  exit 1
fi

WORK=$(mktemp -d)
chmod 700 "$WORK"
PROXY_PID=""
cleanup() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

umask 077
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-40 > "$WORK/pw"
[[ $(wc -c < "$WORK/pw") -ge 40 ]] || { echo "password generation failed" >&2; exit 1; }

echo "1/4 creating role $ROLE"
"${G[@]}" sql users create "$ROLE" --instance="$INSTANCE" --password="$(cat "$WORK/pw")"

echo "2/4 creating database $DB"
"${G[@]}" sql databases create "$DB" --instance="$INSTANCE"

echo "3/4 handing ownership to $ROLE and closing PUBLIC access"
PORT=$(free_port)
"$PROXY" --port "$PORT" --address 127.0.0.1 --gcloud-auth "$CONN" > "$WORK/proxy.log" 2>&1 &
PROXY_PID=$!
for _ in $(seq 1 30); do
  grep -q "ready for new connections" "$WORK/proxy.log" 2>/dev/null && break
  sleep 1
done
PGPASSWORD="$(cat "$WORK/pw")" "$PSQL" "host=127.0.0.1 port=$PORT dbname=$DB user=$ROLE sslmode=disable" -v ON_ERROR_STOP=1 -q <<SQL
ALTER DATABASE $DB OWNER TO $ROLE;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE $DB TO $ROLE;
SELECT current_user, current_database(), pg_catalog.pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = '$DB';
SQL

echo "4/4 storing $SECRET"
printf 'postgresql://%s:%s@/%s?host=/cloudsql/%s' "$ROLE" "$(cat "$WORK/pw")" "$DB" "$CONN" \
  | "${G[@]}" secrets create "$SECRET" --replication-policy=automatic --data-file=-

echo "Done. Database $DB is ready; the reader creates its table on first start."
