# GastronomIA backend (NestJS + Fastify) sobre Bun. Build con tsc + cliente Prisma;
# las migraciones (prisma migrate deploy) se aplican al arrancar (docker-entrypoint.sh).
FROM oven/bun:1

WORKDIR /app

# Capa de dependencias (cacheable): respeta bun.lock (fuente de verdad, CLAUDE.md).
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Código + cliente Prisma + build.
COPY . .
RUN bunx prisma generate && bun run build

# Entrypoint ejecutable (migra y arranca).
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["bun", "dist/src/main.js"]
