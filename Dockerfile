# Specify the base Docker image with Playwright + Chrome
FROM apify/actor-node-playwright-chrome:22-1.56.1

# Copy just package.json and package-lock.json first for caching
COPY --chown=myuser:myuser package*.json ./

# Install NPM packages (production only)
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && rm -r ~/.npm

# Copy remaining source code
COPY --chown=myuser:myuser . ./

# Start the actor
CMD npm start --silent
