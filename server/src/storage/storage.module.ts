import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ENV } from '../config/env.module';
import { activeStorage, type Env, type StorageSettings } from '../config/env.schema';

export const STORAGE_SETTINGS = Symbol('STORAGE_SETTINGS');

/** How long an upload link works. */
export const UPLOAD_LINK_SECONDS = 300;

export interface StoredFile {
  sizeBytes: number;
  contentType: string | undefined;
}

function client(settings: StorageSettings, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: settings.region,
    // SeaweedFS needs bucket-in-path addresses; DigitalOcean Spaces accepts them too.
    forcePathStyle: true,
    // Only add checksums when S3 requires them. Otherwise the SDK signs a checksum of an empty body
    // into upload links, and uploads fail; DigitalOcean Spaces also rejects the newer checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
}

/**
 * Photos and audio files, through the S3 API: SeaweedFS locally, DigitalOcean Spaces on servers.
 * Phones upload directly with short-lived upload links; the server never streams files.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly s3: S3Client;
  /** Signs upload links with the address phones can reach. */
  private readonly publicS3: S3Client;
  readonly bucket: string;

  constructor(
    @Inject(STORAGE_SETTINGS) settings: StorageSettings,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.bucket = settings.bucket;
    this.s3 = client(settings, settings.endpoint);
    this.publicS3 = client(settings, settings.publicEndpoint);
  }

  /** Locally the bucket is created on start. On servers it is created once, by hand. */
  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === 'production') return;
    try {
      await this.ensureBucket();
    } catch (err) {
      // Not fatal: the rest of the server works without storage (e.g. admin panel work).
      this.logger.warn(
        `File storage not reachable (${(err as Error).message}). Start it with: docker compose up -d`,
      );
    }
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      if (!(err instanceof NotFound) && (err as { name?: string }).name !== 'NotFound') throw err;
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  /**
   * A link the phone uses to upload one file with HTTP PUT. Type and exact size are part of the
   * signature, so the phone must send exactly these `Content-Type` and `Content-Length` headers.
   */
  async uploadUrl(key: string, contentType: string, sizeBytes: number): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    return getSignedUrl(this.publicS3, command, {
      expiresIn: UPLOAD_LINK_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    });
  }

  /** Size and type of an uploaded file, or null if there is none. */
  async info(key: string): Promise<StoredFile | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch (err) {
      if (err instanceof NotFound || (err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  /** Deletes a file. Deleting a file that does not exist is not an error. */
  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onApplicationShutdown(): void {
    this.s3.destroy();
    this.publicS3.destroy();
  }
}

@Global()
@Module({
  providers: [
    { provide: STORAGE_SETTINGS, inject: [ENV], useFactory: (env: Env) => activeStorage(env) },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
