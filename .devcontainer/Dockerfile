# Dev container image for Velora Modern Codespaces test environment.
#
# Provides Node 22 plus the client tools the workspace needs at development
# time (postgres-client for `psql`/diagnostics, git, curl). The application
# runtime itself (`npm ci`, `npx tsx`, `next dev`) runs from the mounted
# workspace; no real secrets are baked into this image.
#
# Build: docker build -f .devcontainer/Dockerfile -t velora-dev .devcontainer
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    git \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspaces/velora-modern

ENV NODE_ENV=development

# Keep the container alive so Codespaces users can open a terminal and run
# `npm run dev` (web), `npm run start:worker` (worker), `npm test`, etc.
CMD ["sleep", "infinity"]
