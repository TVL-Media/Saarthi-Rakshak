import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { INestApplication } from '@nestjs/common';

/** Server routes; everything else can be a page. */
const API = /^\/(v1|admin|g|health)(\/|$)/;
/** Guardian pages from SMS links: /i/<code> (invite) and /l/<code> (live). */
const GUARDIAN_PAGE = /^\/(i|l)\/[A-Za-z0-9_-]+\/?$/;
/** The guardian page is built with `--base=/gw/`, so its files never mix with the admin panel's. */
const GUARDIAN_BASE = '/gw/';

export interface WebDirs {
  /** apps/admin/dist */
  admin: string;
  /** apps/guardian-web/dist (built with --base=/gw/) */
  guardian: string;
}

/** Where the built pages are when the server runs from server/dist. */
export const DEFAULT_WEB_DIRS: WebDirs = {
  admin: resolve(__dirname, '../../../apps/admin/dist'),
  guardian: resolve(__dirname, '../../../apps/guardian-web/dist'),
};

interface Req {
  method: string;
  path: string;
}
interface Res {
  setHeader(name: string, value: string): void;
  sendFile(
    path: string,
    options: { root: string; dotfiles: 'deny' },
    done: (err?: unknown) => void,
  ): void;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/**
 * Serves the built admin panel and guardian page from this server (SERVE_WEB=on), so a single
 * address works for everything: the admin login cookie (SameSite=Strict) and the guardian page's
 * live updates need the pages and the API on one site. Server routes always win; unknown page
 * addresses get the admin panel (it shows its own "not found" handling).
 */
export function serveWeb(app: INestApplication, dirs: WebDirs = DEFAULT_WEB_DIRS): void {
  for (const dir of [dirs.admin, dirs.guardian]) {
    if (!isFile(join(dir, 'index.html'))) {
      throw new Error(`SERVE_WEB=on but ${dir}/index.html is missing: build the web pages first.`);
    }
  }
  app.use((req: Req, res: Res, next: (err?: unknown) => void) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || API.test(req.path)) return next();

    let root = dirs.admin;
    let file = 'index.html';
    if (GUARDIAN_PAGE.test(req.path)) {
      root = dirs.guardian;
    } else if (req.path.startsWith(GUARDIAN_BASE)) {
      root = dirs.guardian;
      file = req.path.slice(GUARDIAN_BASE.length);
    } else if (req.path !== '/' && isFile(join(dirs.admin, req.path))) {
      file = req.path.slice(1);
    }
    // Pages must always be fresh; built files have a hash in their name.
    res.setHeader(
      'Cache-Control',
      file === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    // sendFile with `root` refuses paths that leave the folder ("..").
    res.sendFile(file, { root, dotfiles: 'deny' }, (err) => {
      if (err) next();
    });
  });
}
