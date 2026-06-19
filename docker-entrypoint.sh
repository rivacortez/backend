#!/bin/sh
# Arranque del contenedor de la API: aplica migraciones pendientes y luego inicia
# el server. `prisma migrate deploy` es idempotente (solo aplica lo que falta) y es
# el comando correcto para entornos no-interactivos (no genera ni resetea).
set -e

echo "[entrypoint] Aplicando migraciones (prisma migrate deploy)…"
bunx prisma migrate deploy

echo "[entrypoint] Iniciando API…"
exec "$@"
