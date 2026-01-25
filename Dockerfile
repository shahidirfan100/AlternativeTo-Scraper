# Specify the base Docker image with Playwright + Firefox
FROM apify/actor-node-playwright-firefox:22-1.56.1

# Check preinstalled packages
RUN npm ls crawlee apify puppeteer playwright

# Copy just package.json and package-lock.json first for caching
COPY --chown=myuser:myuser package*.json Dockerfile ./

# Check Playwright version matches base image
RUN node check-playwright-version.mjs

# Install NPM packages (production only)
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version \
    && rm -r ~/.npm

# Copy remaining source code
COPY --chown=myuser:myuser . ./

# Start the actor
CMD npm start --silent
