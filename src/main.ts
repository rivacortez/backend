import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Register @fastify/multipart globally so all routes can accept file uploads.
  // Used by POST /api/import/document/preview (E11 Smart Onboarding).
  // Limit: 10 MB per file; 1 file per request.
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
      files: 1,
    },
  });

  // All routes under /api (contract backend.md §7).
  app.setGlobalPrefix('api');
  // Bind to 0.0.0.0 so the app is reachable inside containers (Hetzner + Coolify).
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}
void bootstrap();
