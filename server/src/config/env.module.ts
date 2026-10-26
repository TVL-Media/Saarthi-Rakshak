import { Global, Module } from '@nestjs/common';
import { loadEnvFile } from './env';
import { validateEnv } from './env.schema';

export const ENV = Symbol('ENV');

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => {
        loadEnvFile();
        return validateEnv(process.env);
      },
    },
  ],
  exports: [ENV],
})
export class EnvModule {}
