import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { ENV } from '../config/env.module';
import { activeConnections, type Env } from '../config/env.schema';

export const DATABASE_URL = Symbol('DATABASE_URL');

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(DATABASE_URL) url: string) {
    this.pool = new Pool({ connectionString: url, connectionTimeoutMillis: 2000 });
    // Without this, a dropped idle connection would crash the server.
    this.pool.on('error', (err) => this.logger.error(`PostgreSQL error: ${err.message}`));
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_URL,
      inject: [ENV],
      useFactory: (env: Env) => activeConnections(env).databaseUrl,
    },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
