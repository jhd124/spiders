import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** True when the module with this import.meta.url is the script being run (not imported). */
export const isMain = (metaUrl: string) => !!process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === metaUrl;
