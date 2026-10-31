import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, type MigrationResult, type SqliteDatabase } from '@tjalve/memex-sqlite';

/** The folder of the core migrations (scope 'core'), for migrate and assertSchemaMatches. */
export const CORE_MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

/**
 * Apply the core migrations bundled with @tjalve/memex-schema: the entity
 * spine, provenance v2, derived facts, and corrections. Call it outside a
 * transaction, before the app's own migrations.
 */
export function migrateCore(db: SqliteDatabase): MigrationResult {
  return migrate(db, 'core', CORE_MIGRATIONS_DIR);
}
