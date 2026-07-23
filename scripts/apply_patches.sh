#!/usr/bin/env bash

set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "Usage: $0 <source-directory> <patch-directory>" >&2
    exit 2
fi

SOURCE_DIR=$1
PATCH_DIR=$2

while IFS= read -r -d '' PATCH_FILE; do
    if patch --dry-run --silent --forward -p1 -d "${SOURCE_DIR}" < "${PATCH_FILE}" >/dev/null 2>&1; then
        echo "Applying ${PATCH_FILE}"
        patch --silent --forward -p1 -d "${SOURCE_DIR}" < "${PATCH_FILE}"
    elif patch --dry-run --silent --reverse -p1 -d "${SOURCE_DIR}" < "${PATCH_FILE}" >/dev/null 2>&1; then
        echo "Already applied: ${PATCH_FILE}"
    else
        echo "Patch does not apply cleanly: ${PATCH_FILE}" >&2
        exit 1
    fi
done < <(find "${PATCH_DIR}" -type f -name '*.patch' -print0 | sort -z)
