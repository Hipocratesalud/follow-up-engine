#!/bin/sh
# Redeploys the hosted demo (docs/deploy.md#hosted-demo) from the local
# checkout: `pnpm deploy:demo`. Uploads the working tree (git-ignored files
# stay out, .env included) to the Railway project `follow-up-engine-demo`,
# which builds apps/api/Dockerfile.demo (railway.json).
#
# It only ever targets that project: the project id is looked up by name
# (exactly one must exist) and passed explicitly with the service and the
# environment, and it refuses to run in a directory the Railway CLI links to
# any other project (the CLI resolves a parent directory's link).
set -eu

PROJECT_NAME="follow-up-engine-demo"
SERVICE_NAME="follow-up-engine-demo"
ENVIRONMENT_NAME="production"

root=$(git rev-parse --show-toplevel)
cd "$root"

command -v railway >/dev/null || {
  echo "deploy:demo: the Railway CLI is not installed" >&2
  exit 1
}

linked=$(railway status --json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try { process.stdout.write(JSON.parse(raw).name ?? ""); } catch { process.stdout.write(""); }
  });
') || linked=""
if [ -n "$linked" ] && [ "$linked" != "$PROJECT_NAME" ]; then
  echo "deploy:demo: $root is linked to the Railway project \"$linked\", not $PROJECT_NAME. Refusing." >&2
  exit 1
fi

project_id=$(railway list --json | node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    const matches = JSON.parse(raw).filter((project) => project.name === process.argv[1]);
    if (matches.length !== 1) {
      console.error(`deploy:demo: expected exactly one Railway project named ${process.argv[1]}, found ${matches.length}`);
      process.exit(1);
    }
    process.stdout.write(matches[0].id);
  });
' "$PROJECT_NAME")

echo "deploy:demo: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) -> $PROJECT_NAME ($project_id) / $SERVICE_NAME / $ENVIRONMENT_NAME"
if [ -n "$(git status --porcelain)" ]; then
  echo "deploy:demo: note: uncommitted changes are uploaded too"
fi

railway up --ci \
  --project "$project_id" \
  --environment "$ENVIRONMENT_NAME" \
  --service "$SERVICE_NAME" \
  --message "deploy:demo $(git rev-parse --short HEAD)"

echo "deploy:demo: built; Railway switches traffic once /healthz answers (the first boot seeds for about a minute)."
