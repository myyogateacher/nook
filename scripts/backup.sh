#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

compose() {
  docker compose --project-directory "${PROJECT_DIR}" -f "${PROJECT_DIR}/compose.yaml" "$@"
}

container_id="$(compose ps -aq app 2>/dev/null || true)"
mounted_data_dir=""
if [[ -n "${container_id}" ]]; then
  mounted_data_dir="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "${container_id}" 2>/dev/null || true)"
fi

configured_data_dir="${MYNOTES_DATA_DIR:-}"
if [[ -z "${configured_data_dir}" && -f "${PROJECT_DIR}/.env" ]]; then
  configured_data_dir="$(sed -n 's/^MYNOTES_DATA_DIR=//p' "${PROJECT_DIR}/.env" | tail -n 1)"
  configured_data_dir="${configured_data_dir%$'\r'}"
  configured_data_dir="${configured_data_dir#\"}"
  configured_data_dir="${configured_data_dir%\"}"
  configured_data_dir="${configured_data_dir#\'}"
  configured_data_dir="${configured_data_dir%\'}"
fi

# S3 storage: with STORAGE_BACKEND=s3 the file bytes live in the bucket, not in DATA_DIR.
storage_backend="${STORAGE_BACKEND:-}"
if [[ -z "${storage_backend}" && -f "${PROJECT_DIR}/.env" ]]; then
  storage_backend="$(sed -n 's/^STORAGE_BACKEND=//p' "${PROJECT_DIR}/.env" | tail -n 1)"
  storage_backend="${storage_backend%$'\r'}"
  storage_backend="${storage_backend#\"}"
  storage_backend="${storage_backend%\"}"
  storage_backend="${storage_backend#\'}"
  storage_backend="${storage_backend%\'}"
fi
storage_backend="$(printf '%s' "${storage_backend}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
s3_warning() {
  if [[ "${storage_backend}" == "s3" ]]; then
    echo "WARNING: STORAGE_BACKEND=s3. File bytes (Files, attachments, note and whiteboard pictures, whiteboard scenes," >&2
    echo "WARNING: profile pictures) live in the S3 bucket and are NOT in this archive; it holds the database and settings only." >&2
    echo "WARNING: Back up the bucket separately: bucket versioning, aws s3 sync, or rclone (docs/OPERATIONS.md, Backups)." >&2
  fi
}

data_dir_candidate="${mounted_data_dir:-${configured_data_dir:-/srv/mynotes}}"
readonly DATA_DIR="$(realpath -e -- "${data_dir_candidate}")"
readonly BACKUP_DIR="${DATA_DIR}/backup"
readonly RETENTION_COUNT=5
readonly MINIMUM_AGE_SECONDS=$((7 * 24 * 60 * 60))

force=false
if [[ "${1:-}" == "--force" ]]; then
  force=true
elif [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--force]" >&2
  exit 2
fi

s3_warning

if [[ "${DATA_DIR}" != /* || "${DATA_DIR}" == "/" ]]; then
  echo "MYNOTES_DATA_DIR must be a safe absolute path, not /." >&2
  exit 1
fi
if [[ ! -d "${DATA_DIR}" ]]; then
  echo "Data directory does not exist: ${DATA_DIR}" >&2
  exit 1
fi

mkdir -p -- "${BACKUP_DIR}"
chmod 700 -- "${BACKUP_DIR}"

latest_backup="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'mynotes-*.tar.gz' -printf '%T@ %p\n' | sort -nr | head -n 1 | cut -d' ' -f2- || true)"
if [[ "${force}" == false && -n "${latest_backup}" ]]; then
  latest_epoch="$(stat -c '%Y' -- "${latest_backup}")"
  current_epoch="$(date +%s)"
  if (( current_epoch - latest_epoch < MINIMUM_AGE_SECONDS )); then
    echo "A weekly backup already exists: ${latest_backup}"
    exit 0
  fi
fi

lock_dir="${BACKUP_DIR}/.backup.lock"
if ! mkdir -- "${lock_dir}" 2>/dev/null; then
  echo "Another Nook backup is already running." >&2
  exit 1
fi

timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
archive="${BACKUP_DIR}/mynotes-${timestamp}.tar.gz"
temporary="${archive}.partial"
app_was_running=false
app_was_stopped=false

cleanup() {
  status=$?
  trap - EXIT INT TERM
  rm -f -- "${temporary}"
  rmdir -- "${lock_dir}" 2>/dev/null || true
  if [[ "${app_was_running}" == true && "${app_was_stopped}" == true ]]; then
    compose up -d app >/dev/null || {
      echo "WARNING: backup finished but the Nook service could not be restarted." >&2
      status=1
    }
  fi
  exit "${status}"
}
trap cleanup EXIT INT TERM

container_id="$(compose ps -q app 2>/dev/null || true)"
if [[ -n "${container_id}" && "$(docker inspect -f '{{.State.Running}}' "${container_id}" 2>/dev/null || true)" == "true" ]]; then
  app_was_running=true
  compose stop app >/dev/null
  app_was_stopped=true
fi

# The backup directory is excluded to prevent archives recursively containing older archives.
# In-flight upload staging files are never needed for a restore.
tar --exclude='./backup' --exclude='./documents/.staging' -C "${DATA_DIR}" -czf "${temporary}" .
gzip -t -- "${temporary}"
mv -- "${temporary}" "${archive}"
chmod 600 -- "${archive}"

mapfile -t expired < <(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'mynotes-*.tar.gz' -printf '%T@ %p\n' | sort -nr | tail -n +$((RETENTION_COUNT + 1)) | cut -d' ' -f2-)
if (( ${#expired[@]} > 0 )); then
  rm -f -- "${expired[@]}"
fi

echo "Backup created: ${archive}"
echo "Restore into an empty directory with: tar -xzf '${archive}' -C /path/to/restored-data"
s3_warning
