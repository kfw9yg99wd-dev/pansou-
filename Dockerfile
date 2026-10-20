# Build the backend and independently authored web/ assets into one binary.
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETARCH
ARG TARGETVARIANT
RUN CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} GOARM=${TARGETVARIANT#v} \
    go build -trimpath -ldflags="-s -w" -o /out/pansou .

FROM alpine:3.23
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 pansou \
    && adduser -S -D -H -u 10001 -G pansou pansou \
    && mkdir -p /app/cache \
    && chown 10001:10001 /app/cache
WORKDIR /app
COPY --from=builder /out/pansou /app/pansou
COPY --from=builder /src/LICENSE /app/LICENSE

# Deliberately no preset AUTH_USERS or AUTH_JWT_SECRET: startup fails closed
# until the operator supplies both. PORT may be set by the hosting platform.
ENV PORT=8888 \
    PANSOU_LISTEN_HOST=0.0.0.0 \
    AUTH_ENABLED=true \
    AUTH_TOKEN_EXPIRY=24 \
    CACHE_ENABLED=true \
    CACHE_PATH=/app/cache \
    TZ=Asia/Shanghai
USER 10001:10001
EXPOSE 8888

ARG VERSION=dev
ARG BUILD_DATE=unknown
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="PanSou personal web deployment" \
      org.opencontainers.image.description="Personal web adaptation of the fish2018/pansou backend with an independently authored frontend" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.documentation="https://github.com/fish2018/pansou"
CMD ["/app/pansou"]
