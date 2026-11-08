# Use an official node image as the base image
FROM node:latest

# Set the working directory in the container
WORKDIR /nextapp

# COPY public/ /app/public
# COPY src/ /app/src
# COPY package.json /app
# COPY package-lock.json /app
COPY . /nextapp

RUN npm install

# The public address of the site, used for canonical links, the sitemap and social previews.
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

RUN npm run build

# Make port 3040 available to the world outside this container
EXPOSE 3000

# Run app.js when the container launches
CMD ["npm", "start"]