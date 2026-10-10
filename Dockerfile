# syntax=docker/dockerfile:1.7
#
# Arattix bot image: the library plus the example bots.
#   docker build -t arattix-bot .
#   docker run -it --rm -v arattix-bot-data:/data arattix-bot
#
# Session files (cookies.json, headers.json) and downloads are written to the working
# directory, /data, which is a volume: mount a named volume there to keep the login across
# container re-creations. (Bind-mounting single files is fragile: a missing host file is
# created as a directory, and the library also needs headers.json.)
#
# Run your own bot:
#   docker run -it --rm -v arattix-bot-data:/data -v "$PWD/my-bot.js:/app/bots/my-bot.js:ro" \
#     arattix-bot node /app/bots/my-bot.js
# `require('arattix')` works from any path inside the container.
#
# For the REST API server use server/Dockerfile instead.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine

ENV NODE_ENV=production \
    # Lets scripts mounted anywhere resolve require('arattix') and its dependencies.
    NODE_PATH=/app/node_modules

WORKDIR /app
# The repository ships without a lockfile, so `npm ci` is not possible here.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts \
 && npm cache clean --force
COPY index.js ./
COPY src ./src
COPY Example ./Example
# Make the library resolvable by name, like an installed package.
RUN ln -s /app /app/node_modules/arattix \
 && mkdir -p /app/bots /data/downloads \
 && chown -R node:node /data

WORKDIR /data
VOLUME ["/data"]
USER node

# Node runs as PID 1; the example bots handle SIGTERM/SIGINT. Add `--init` (or compose
# `init: true`) if your own bot spawns child processes.
CMD ["node", "/app/Example/docker-bot.js"]
