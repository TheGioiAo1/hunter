FROM node:20-alpine

# Native module build tools (bcrypt, etc.)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy full monorepo (node_modules excluded via .dockerignore)
COPY . .

# Install all workspace dependencies
RUN npm ci --production=false

ENV NODE_ENV=production
