#!/usr/bin/env sh
# A generic CI job step using a machine identity.
#
# The CI system provides, from its masked secret store:
#   ENVVAULT_API_URL               https address of the EnvVault API
#   ENVVAULT_SERVICE_CREDENTIAL    the identity's credential (or ENVVAULT_SERVICE_CREDENTIAL_FILE)
# and ENVVAULT_ENVIRONMENT (for example staging). The credential is never put
# on a command line, echoed or written to the workspace.
set -eu

: "${ENVVAULT_API_URL:?Set ENVVAULT_API_URL}"
: "${ENVVAULT_ENVIRONMENT:=staging}"
if [ -z "${ENVVAULT_SERVICE_CREDENTIAL:-}" ] && [ -z "${ENVVAULT_SERVICE_CREDENTIAL_FILE:-}" ]; then
  echo "Set ENVVAULT_SERVICE_CREDENTIAL or ENVVAULT_SERVICE_CREDENTIAL_FILE" >&2
  exit 3
fi

# Fails early (exit 4) when the credential is invalid, expired or revoked.
envvault auth service --from-env

# The build sees the values in its environment only; exit codes pass through.
envvault run --env "$ENVVAULT_ENVIRONMENT" -- "$@"
