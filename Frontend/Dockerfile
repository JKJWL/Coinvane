# SPDX-License-Identifier: AGPL-3.0-or-later
FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_API_URL=/api
ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Shared header snippet — included from every `location` block in
# nginx.conf to work around nginx's add_header inheritance footgun.
# Lives OUTSIDE /etc/nginx/conf.d/ so nginx doesn't auto-include it
# at http level (which would break startup since it contains only
# location-context directives).
RUN mkdir -p /etc/nginx/snippets
COPY nginx-headers.conf /etc/nginx/snippets/nginx-headers.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]