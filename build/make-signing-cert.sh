#!/bin/bash
# One-time setup: creates the certificate GitHub signs Loupe with, and stores it as a secret in
# the repository. With every version signed by the same certificate, macOS recognises updates as
# the same app, so the Screen Recording and Accessibility permissions survive them.
#
# Run once from the release folder:   bash build/make-signing-cert.sh
#
# The certificate is self-signed: it proves "this is the same Loupe as before", not who made it,
# so macOS still asks for "Open Anyway" when a new version is downloaded. Only a paid Apple
# Developer ID removes that.

set -euo pipefail
cd "$(dirname "$0")/.."

OPENSSL=/usr/bin/openssl            # the one that comes with macOS
NAME="Loupe Signing"
BACKUP="$HOME/Documents/Loupe signing certificate"

if [ -f "$BACKUP/loupe-signing.p12" ]; then
  echo "✗ A certificate already exists in \"$BACKUP\"." >&2
  echo "  To upload it again instead of making a new one, run:  bash build/make-signing-cert.sh --upload" >&2
  [ "${1:-}" = "--upload" ] || exit 1
fi

gh auth status >/dev/null 2>&1 || { echo "✗ Log in to GitHub first: gh auth login" >&2; exit 1; }
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

if [ "${1:-}" != "--upload" ]; then
  mkdir -p "$BACKUP"
  chmod 700 "$BACKUP"
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT

  cat > "$WORK/cert.cnf" <<CNF
[ req ]
distinguished_name = dn
prompt = no
x509_extensions = codesign
[ dn ]
CN = $NAME
[ codesign ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
CNF

  PASSWORD=$("$OPENSSL" rand -base64 24 | tr -d '/+=' | cut -c1-24)
  echo "▸ Creating the certificate \"$NAME\" (valid for 20 years)"
  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 7300 -nodes \
    -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/cert.cnf" 2>/dev/null
  "$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
    -out "$BACKUP/loupe-signing.p12" -passout "pass:$PASSWORD"
  printf '%s' "$PASSWORD" > "$BACKUP/password.txt"
  chmod 600 "$BACKUP/loupe-signing.p12" "$BACKUP/password.txt"
fi

echo "▸ Storing it as secrets in $REPO (only GitHub's build can read them)"
base64 -i "$BACKUP/loupe-signing.p12" | gh secret set LOUPE_SIGNING_P12 --repo "$REPO"
gh secret set LOUPE_SIGNING_PASSWORD --repo "$REPO" < "$BACKUP/password.txt"

echo "✓ Done. Every build from now on is signed with \"$NAME\"."
echo "  A backup is in: $BACKUP"
echo "  Keep it (for example in 1Password). If it's lost, run this script again: everyone then"
echo "  allows Loupe under Screen Recording (and Accessibility) once more, and after that it sticks again."
