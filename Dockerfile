FROM node:20-bullseye

WORKDIR /app

# Install Python 3 for yt-dlp-exec (its postinstall checks for a `python` binary)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
