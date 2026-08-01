# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"


# Throw-away build stage to reduce size of final image
FROM base AS build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package.json ./
RUN npm install

# Copy application code
COPY . .


# Final stage for app image
FROM base

# Chromium + системные библиотеки для puppeteer (headless-smoke)
RUN apt-get update -qq && apt-get install --no-install-recommends -y \
    chromium libnss3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 \
    libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libxkbcommon0 \
    libpango-1.0-0 fonts-liberation && \
    rm -rf /var/lib/apt/lists/*
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE 3000
CMD [ "npm", "run", "start" ]
