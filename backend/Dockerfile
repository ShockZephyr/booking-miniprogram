FROM node:22-bookworm-slim

ARG PG_MAJOR=18

RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|http://mirrors.cloud.tencent.com/debian|g' \
      -e 's|http://security.debian.org/debian-security|http://mirrors.cloud.tencent.com/debian-security|g' \
      /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
  && install -d -m 0755 /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://mirrors.cloud.tencent.com/postgresql/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY backend/migrations ./migrations
COPY backend/public ./public
COPY backend/src ./src
COPY miniprogram /workspace/miniprogram
COPY project.config.json /workspace/project.config.json

ENV NODE_ENV=production
EXPOSE 3000

USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "start"]
