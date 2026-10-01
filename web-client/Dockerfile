FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL=http://127.0.0.1:8000
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY package.json ./
RUN npm install --no-audit --no-fund --package-lock=false
COPY . .
RUN npm run build

FROM nginx:1.29-alpine
COPY --from=build /app/dist /usr/share/nginx/html
