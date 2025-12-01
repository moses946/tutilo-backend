# Use Node 18
FROM node:18

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy all source code
COPY . .

# Expose the port Cloud Run will use
ENV PORT 8080
EXPOSE 8080

# Start the server
CMD ["node", "index.js"]
