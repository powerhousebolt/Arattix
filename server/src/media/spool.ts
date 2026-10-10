import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger';
import { AppError } from '../errors';

/**
 * Uploads are written to a spool directory by the API and streamed to Arattai by the worker.
 * In split deployments the spool directory must be shared by API and worker processes
 * (same host with PM2, or a shared volume in containers).
 */
export class MediaSpool {
  readonly dir: string;

  constructor(dir: string, private readonly logger: Logger) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /**
   * Job data comes back from Redis. Refuse paths outside the spool so a tampered job cannot
   * make the worker upload arbitrary local files.
   */
  resolve(filePath: string): string {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== this.dir) {
      throw new AppError({ status: 400, code: 'MEDIA_PATH_REJECTED', message: 'Media path is outside the spool directory' });
    }
    return resolved;
  }

  async remove(filePath: string): Promise<void> {
    await fs.promises.rm(filePath, { force: true }).catch((err) =>
      this.logger.warn('Could not remove spooled file', { component: 'spool', filePath, error: (err as Error).message }),
    );
  }

  /** Delete spool files older than maxAgeMs (orphans from crashes or abandoned jobs). */
  async sweep(maxAgeMs: number): Promise<number> {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of await fs.promises.readdir(this.dir)) {
      const file = path.join(this.dir, name);
      const stat = await fs.promises.stat(file).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await this.remove(file);
        removed += 1;
      }
    }
    if (removed > 0) this.logger.info('Swept stale spool files', { component: 'spool', removed });
    return removed;
  }

  startSweeper(maxAgeMs: number): () => void {
    const timer = setInterval(() => void this.sweep(maxAgeMs).catch(() => undefined), Math.min(maxAgeMs, 60 * 60 * 1000));
    timer.unref();
    return () => clearInterval(timer);
  }
}
