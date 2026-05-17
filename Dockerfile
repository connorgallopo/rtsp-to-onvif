FROM node:22-alpine

RUN apk add --no-cache dhclient dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY ["package.json", "package-lock.json*", "./"]
RUN npm ci --omit=dev --silent

COPY . .

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "main.js", "/onvif.yaml"]
