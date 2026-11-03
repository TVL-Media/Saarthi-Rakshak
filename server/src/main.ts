import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { configureApp } from './app-setup';
import { AppModule } from './app.module';
import { loadEnvFile } from './config/env';
import { validateEnv, type Env } from './config/env.schema';
import { serveWeb } from './web/serve-web';

async function bootstrap(): Promise<void> {
  // Check settings before starting anything, so a missing setting gives a short, clear message.
  let env: Env;
  try {
    loadEnvFile();
    env = validateEnv(process.env);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const app = await NestFactory.create(AppModule);
  configureApp(app, env);
  if (env.SERVE_WEB === 'on') serveWeb(app);
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  console.log(`Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
}

void bootstrap();
