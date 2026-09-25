# Build from the repository root:
#   docker build -f apps/live-relay/Dockerfile -t jev-events-relay .
FROM node:24-slim
WORKDIR /app
COPY . .
RUN npm ci --workspace @jev-events/live-relay --omit=dev --ignore-scripts && npm cache clean --force
ENV NODE_ENV=production PORT=8790
EXPOSE 8790
USER node
CMD ["node", "--conditions=source", "--import", "tsx", "apps/live-relay/src/main.ts"]
