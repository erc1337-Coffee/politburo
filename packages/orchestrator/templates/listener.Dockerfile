# Listener image of a channel. A channel that turns on local deployment gets a copy of this
# template in its settings; the orchestrator edits that copy for the channel's code.
# The build context is the repository at the listener's subpath; PORT is the container port.
FROM node:24-alpine
RUN apk add --no-cache busybox-extras
WORKDIR /app
COPY . .
RUN if [ -f package-lock.json ]; then npm ci; \
    elif [ -f package.json ]; then npm install; fi \
 && if [ -f package.json ]; then npm run build --if-present; fi
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
# A package with a start script runs it; anything else is served as static files.
CMD ["sh", "-c", "if [ -f package.json ] && grep -q '\"start\"' package.json; then exec npm start; else exec busybox-extras httpd -f -v -p \"$PORT\" -h /app; fi"]
