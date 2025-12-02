/**
 * Generate parlEmbeddings for Parliament data (bilingual)
 *
 * Supports multiple source types: bills, hansard statements, committees,
 * committee reports/meetings, vote questions, party/member votes, politicians,
 * parties, elections, candidacies, sessions, ridings.
 *
 * Usage examples:
 *   npx tsx scripts/generate-embeddings.ts --types=bills --session 45-1 --skip-existing
 *   npx tsx scripts/generate-embeddings.ts --types=bills,hansard --limit 100
 *
 * --limit behavior:
 *   The --limit flag limits the number of source records fetched, not the number
 *   of embeddings created. With --skip-existing, already-processed records still
 *   count toward the limit. Example: --limit 100 --skip-existing with 80 already
 *   processed will only create ~20 new embeddings. For predictable new embedding
 *   counts, either omit --skip-existing or set a higher limit.
 *   npx tsx scripts/generate-embeddings.ts --drop-tables
 *   npx tsx scripts/generate-embeddings.ts --empty-tables
 *   npx tsx scripts/generate-embeddings.ts --sync-progress  # Rebuild SQLite from Postgres
 *   npx tsx scripts/generate-embeddings.ts --clear-progress # Clear local progress tracking
 *   npx tsx scripts/generate-embeddings.ts --dry-run        # Preview without making changes
 *   npx tsx scripts/generate-embeddings.ts --yes            # Auto-confirm prompts (CI/non-interactive)
 *
 * Session filtering (--session):
 *   The --session flag filters content by parliamentary session (e.g., "45-1").
 *   However, not all source types support session filtering:
 *
 *   - Session-filtered: bills, hansard, committee_reports, committee_meetings,
 *     vote_questions, party_votes, member_votes (these have a sessionId field
 *     or join to a table with sessionId)
 *   - NOT session-filtered: committees, politicians, parties, elections,
 *     candidacies, sessions, ridings (these are global/cross-session entities)
 *
 *   When processing session-filtered types, only content from the specified
 *   session will be embedded. For non-filtered types, all records are processed.
 */

import { config } from "dotenv";

config({ path: ".env.local" });

import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import Database from "better-sqlite3";
import type { SQL } from "drizzle-orm";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { nanoid } from "nanoid";
import postgres from "postgres";

import { generateEmbeddings } from "@/lib/ai/embeddings";
import {
  type BillsBill,
  billsBill,
  billsBilltext,
  billsMembervote,
  billsPartyvote,
  billsVotequestion,
  committeesCommittee,
  committeesCommitteemeeting,
  committeesCommitteereport,
  coreParty,
  corePolitician,
  coreRiding,
  coreSession,
  electionsCandidacy,
  electionsElection,
  hansardsDocument,
  hansardsStatement,
} from "@/lib/db/parliament/schema";
import { parlResources, type ResourceMetadata } from "@/lib/db/rag/schema";
import {
  type BillContext,
  chunkBill,
  chunkHansard,
  type HansardContext,
} from "@/lib/rag/parliament/semantic-chunking";

// ---------- CLI args ----------
const args = process.argv.slice(2);

function readOptValue(name: string): string | undefined {
  // Supports both --name=value and --name value
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) {
    // Extract value after the equals sign
    const eqIndex = withEq.indexOf("=");
    const value = withEq.slice(eqIndex + 1);
    // Return undefined if value is empty (e.g., --limit= with no value)
    return value || undefined;
  }
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = args[idx + 1];
    // Don't treat the next arg as a value if it looks like another flag
    if (!val.startsWith("-")) {
      return val;
    }
  }
  return;
}

const limitStr = readOptValue("limit");
const sessionFilter = readOptValue("session");
const typesStr = readOptValue("types");
const skipExisting = args.includes("--skip-existing");
const dropTables = args.includes("--drop-tables");
const emptyTables = args.includes("--empty-tables");
const syncProgress = args.includes("--sync-progress");
const clearProgress = args.includes("--clear-progress");
const dryRun = args.includes("--dry-run");
const assumeYes = args.includes("--yes") || args.includes("--force");

const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
  console.error("Error: --limit must be a positive integer");
  process.exit(1);
}
const types = (typesStr ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * CLI type names for --types flag.
 *
 * IMPORTANT: These CLI names differ from the ResourceMetadata.sourceType values:
 *   CLI (plural)        -> Metadata (singular)
 *   ----------------    -> -------------------
 *   bills               -> bill
 *   hansard             -> hansard (same)
 *   committees          -> committee
 *   committee_reports   -> committee_report
 *   committee_meetings  -> committee_meeting
 *   vote_questions      -> vote_question
 *   party_votes         -> vote_party
 *   member_votes        -> vote_member
 *   politicians         -> politician
 *   parties             -> party
 *   elections           -> election
 *   candidacies         -> candidacy
 *   sessions            -> session
 *   ridings             -> riding
 *
 * The CLI uses plural/friendly names for user convenience.
 * The metadata uses singular names matching the ResourceMetadata type definition.
 */
const ALL_TYPES = [
  "bills",
  "hansard",
  "committees",
  "committee_reports",
  "committee_meetings",
  "vote_questions",
  "party_votes",
  "member_votes",
  "politicians",
  "parties",
  "elections",
  "candidacies",
  "sessions",
  "ridings",
] as const;
type SourceTypeKey = (typeof ALL_TYPES)[number];

// Validate and filter types, warning on unknown values
const unknownTypes = types.filter(
  (t) => !(ALL_TYPES as readonly string[]).includes(t)
);
if (unknownTypes.length > 0) {
  console.warn(
    `⚠️  Warning: Unknown type(s) ignored: ${unknownTypes.join(", ")}`
  );
  console.warn(`   Valid types: ${ALL_TYPES.join(", ")}\n`);
}

const selectedTypes: SourceTypeKey[] = types.length
  ? (types.filter((t) =>
      (ALL_TYPES as readonly string[]).includes(t)
    ) as SourceTypeKey[])
  : ALL_TYPES.slice();

// Error if user specified types but all were invalid
if (types.length > 0 && selectedTypes.length === 0) {
  console.error("Error: No valid types specified");
  console.error(`Valid types: ${ALL_TYPES.join(", ")}`);
  process.exit(1);
}

// ---------- DB setup ----------
const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!dbUrl) {
  throw new Error(
    "DATABASE_URL or POSTGRES_URL environment variable is required"
  );
}
const connection = postgres(dbUrl);
const db = drizzle(connection);

// ---------- Configuration Constants ----------
const EMBEDDING_RETRY_ATTEMPTS = 3;
const EMBEDDING_BATCH_SIZE = 96; // Cohere embed-multilingual-v3.0 supports up to 96 texts per request
const EMBEDDING_CONCURRENCY = 3; // Number of concurrent embedding API calls
const PROGRESS_LOG_INTERVAL = 10;
const DB_FETCH_BATCH_SIZE = 1000; // Fetch from DB in batches to avoid OOM
/**
 * Path to SQLite database for tracking processed embeddings.
 * Configurable via EMBEDDING_PROGRESS_DB_PATH env var for multi-environment setups.
 * Default: scripts/.embedding-progress.db
 */
const PROGRESS_DB_PATH =
  process.env.EMBEDDING_PROGRESS_DB_PATH || "scripts/.embedding-progress.db";
const PROGRESS_SYNC_BATCH_SIZE = 10_000; // Batch size when syncing from Postgres
// Threshold for triggering local cache re-sync from Postgres (0.95 = 95%)
// Lower values re-sync more often (safer but slower); higher values trust local cache more
const PROGRESS_SYNC_THRESHOLD = 0.95;

// Token/character limits for embedding model validation
// Cohere embed-multilingual-v3.0 allows ~2048 tokens but our chunker targets ~1200;
// warn slightly above the target to catch oversize content before API truncation.
const MAX_EMBEDDING_TOKENS = 1400;
const CHARS_PER_TOKEN = 4;
const MAX_EMBEDDING_CHARS = MAX_EMBEDDING_TOKENS * CHARS_PER_TOKEN; // ~5600

// ---------- SQLite Progress Tracker ----------
// Uses a local SQLite database for fast existence checks instead of slow Postgres JSONB queries
class ProgressTracker {
  private readonly sqlite: Database.Database;
  private readonly checkStmt: Database.Statement;
  private readonly insertStmt: Database.Statement;
  private readonly insertManyStmt: Database.Transaction<
    (keys: string[]) => void
  >;

  constructor() {
    // Ensure scripts directory exists
    const dir = PROGRESS_DB_PATH.split("/").slice(0, -1).join("/");
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.sqlite = new Database(PROGRESS_DB_PATH);
    this.sqlite.pragma("journal_mode = WAL"); // Better concurrent performance
    this.sqlite.pragma("synchronous = NORMAL"); // Good balance of safety/speed

    // Create table with index
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS processed (
        key TEXT PRIMARY KEY,
        created_at INTEGER DEFAULT (unixepoch())
      ) WITHOUT ROWID;
    `);

    // Prepare statements for reuse (much faster)
    this.checkStmt = this.sqlite.prepare(
      "SELECT 1 FROM processed WHERE key = ?"
    );
    this.insertStmt = this.sqlite.prepare(
      "INSERT OR IGNORE INTO processed (key) VALUES (?)"
    );

    // Transaction for bulk inserts (much faster than individual inserts)
    this.insertManyStmt = this.sqlite.transaction((keys: string[]) => {
      for (const key of keys) {
        this.insertStmt.run(key);
      }
    });
  }

  /** Check if a key has been processed */
  has(key: string): boolean {
    return this.checkStmt.get(key) !== undefined;
  }

  /** Mark a key as processed */
  mark(key: string): void {
    this.insertStmt.run(key);
  }

  /** Mark multiple keys as processed (uses transaction for speed) */
  markMany(keys: string[]): void {
    if (keys.length > 0) {
      this.insertManyStmt(keys);
    }
  }

  /** Get count of processed items for a source type prefix */
  countByPrefix(prefix: string): number {
    const stmt = this.sqlite.prepare(
      "SELECT COUNT(*) as count FROM processed WHERE key LIKE ?"
    );
    const result = stmt.get(`${prefix}%`) as { count: number };
    return result.count;
  }

  /** Clear all progress for a specific source type */
  clearByPrefix(prefix: string): number {
    const stmt = this.sqlite.prepare("DELETE FROM processed WHERE key LIKE ?");
    const result = stmt.run(`${prefix}%`);
    return result.changes;
  }

  /** Clear all progress */
  clearAll(): void {
    this.sqlite.exec("DELETE FROM processed");
  }

  /** Get total count */
  totalCount(): number {
    const stmt = this.sqlite.prepare("SELECT COUNT(*) as count FROM processed");
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /** Get sample keys for debugging */
  sampleKeys(prefix: string, maxResults = 5): string[] {
    const stmt = this.sqlite.prepare(
      "SELECT key FROM processed WHERE key LIKE ? LIMIT ?"
    );
    const rows = stmt.all(`${prefix}%`, maxResults) as { key: string }[];
    return rows.map((r) => r.key);
  }

  /**
   * Get the maximum numeric sourceId for a given sourceType.
   * Used for efficient cursor-based pagination when resuming.
   * Key format: sourceType:sourceId:language:chunkIndex
   *
   * Uses SQL aggregation to avoid loading all keys into memory.
   * Note: Only works for sourceTypes with numeric IDs.
   * For string IDs (like session "45-1"), returns null.
   */
  getMaxNumericSourceId(sourceType: string): number | null {
    // Use SQL aggregation to find max sourceId without loading all rows
    // Key format: sourceType:sourceId:language:chunkIndex
    // Extract sourceId by finding text between first and second colons
    const stmt = this.sqlite.prepare(`
      SELECT MAX(CAST(
        SUBSTR(key,
          INSTR(key, ':') + 1,
          INSTR(SUBSTR(key, INSTR(key, ':') + 1), ':') - 1
        ) AS INTEGER
      )) as max_id
      FROM processed
      WHERE key LIKE ?
    `);
    const result = stmt.get(`${sourceType}:%`) as { max_id: number | null };
    return result?.max_id ?? null;
  }

  /**
   * Get all unique sourceIds for a given sourceType (for string ID types).
   * Used for skip-existing logic when cursor-based pagination isn't possible.
   * Key format: sourceType:sourceId:language:chunkIndex
   */
  getProcessedSourceIds(sourceType: string): Set<string> {
    const sourceIds = new Set<string>();
    const stmt = this.sqlite.prepare(`
      SELECT DISTINCT SUBSTR(
        key,
        INSTR(key, ':') + 1,
        INSTR(SUBSTR(key, INSTR(key, ':') + 1), ':') - 1
      ) as source_id
      FROM processed
      WHERE key LIKE ?
    `);

    for (const row of stmt.iterate(`${sourceType}:%`) as IterableIterator<{
      source_id: string | null;
    }>) {
      if (row?.source_id) {
        sourceIds.add(row.source_id);
      }
    }
    return sourceIds;
  }

  close(): void {
    this.sqlite.close();
  }
}

// Initialize progress tracker
const progressTracker = new ProgressTracker();

// ---------- Graceful Shutdown ----------
let isShuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 5000;

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    return; // Prevent double shutdown
  }
  isShuttingDown = true;

  console.log(`\n\n⚠️  Received ${signal}, shutting down gracefully...`);
  console.log(
    `   Progress saved: ${progressTracker.totalCount().toLocaleString()} items tracked`
  );

  // Force exit after timeout to prevent hanging on stuck connections
  const forceExitTimer = setTimeout(() => {
    console.error(
      `   ⚠️  Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) exceeded, forcing exit`
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  try {
    progressTracker.close();
    await connection.end();
    console.log("   ✅ Connections closed cleanly\n");
  } catch (err) {
    console.error("   ❌ Error during shutdown:", err);
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

// Handle termination signals
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

/**
 * Sync progress tracker from Postgres for a specific source type.
 * This is useful for first-time setup or if SQLite was cleared.
 * Uses cursor-based pagination for O(n) performance instead of OFFSET which is O(n²).
 */
async function syncProgressFromPostgres(
  sourceType?: ResourceMetadata["sourceType"]
): Promise<void> {
  // Get total count first for progress display
  const countResult = await db.execute<{ count: string }>(
    sourceType
      ? sql`SELECT COUNT(*) as count FROM ${parlResources} WHERE ${parlResources.metadata}->>'sourceType' = ${sourceType}`
      : sql`SELECT COUNT(*) as count FROM ${parlResources}`
  );
  const totalCount = Number.parseInt(countResult[0]?.count ?? "0", 10);

  if (totalCount === 0) {
    console.log(
      `   No existing records found${sourceType ? ` for ${sourceType}` : ""}`
    );
    return;
  }

  console.log(
    `   📥 Syncing ${totalCount.toLocaleString()} records from Postgres...`
  );

  let synced = 0;
  let lastId: string | null = null;

  // Cursor-based pagination: use WHERE id > lastId instead of OFFSET
  while (true) {
    const rows = await db
      .select({ id: parlResources.id, metadata: parlResources.metadata })
      .from(parlResources)
      .where(
        sourceType
          ? lastId
            ? and(
                sql`${parlResources.metadata}->>'sourceType' = ${sourceType}`,
                gt(parlResources.id, lastId)
              )
            : sql`${parlResources.metadata}->>'sourceType' = ${sourceType}`
          : lastId
            ? gt(parlResources.id, lastId)
            : undefined
      )
      .orderBy(parlResources.id)
      .limit(PROGRESS_SYNC_BATCH_SIZE);

    const lastRow = rows.at(-1);
    if (!lastRow) {
      break; // No more rows
    }

    // Update cursor for next batch
    lastId = lastRow.id;

    const keys = rows.map((r) =>
      buildResourceKey(r.metadata as ResourceMetadata)
    );
    progressTracker.markMany(keys);
    synced += keys.length;

    const pct = Math.round((synced / totalCount) * 100);
    console.log(
      `   📊 Synced ${synced.toLocaleString()}/${totalCount.toLocaleString()} (${pct}%)`
    );
  }

  console.log(`   ✅ Sync complete: ${synced.toLocaleString()} records`);
}

/**
 * Clear progress and optionally sync fresh from Postgres
 */
async function clearProgressWithConfirmation(): Promise<void> {
  const count = progressTracker.totalCount();
  console.log("\n⚠️  WARNING: CLEAR PROGRESS OPERATION\n");
  console.log(
    `This will clear ${count.toLocaleString()} tracked items from the local SQLite database.`
  );
  console.log(`File: ${PROGRESS_DB_PATH}\n`);

  const confirmed = await promptConfirmation(
    "Are you sure you want to clear progress? Type Y to continue"
  );
  if (!confirmed) {
    console.log("\n❌ Operation cancelled by user\n");
    return;
  }

  progressTracker.clearAll();
  console.log("\n✅ Progress cleared\n");
}

// ---------- Lazy-Loaded Lookup Maps ----------
// These maps are lazy-loaded to avoid DB calls on --help/--drop-tables commands.

/**
 * Create a lazy-loaded async getter with retry support.
 * If the first call fails, subsequent calls will retry.
 * This pattern avoids repeated DB queries while allowing recovery from transient failures.
 */
function createLazyLoader<T>(loader: () => Promise<T>): () => Promise<T> {
  let cachedPromise: Promise<T> | null = null;

  return async () => {
    if (cachedPromise) {
      try {
        return await cachedPromise;
      } catch {
        // Previous attempt failed, reset and retry
        cachedPromise = null;
      }
    }
    cachedPromise = loader();
    return cachedPromise;
  };
}

type SessionMapType = Map<
  string,
  {
    name: string | null;
    parliamentnum: number | null;
    sessnum: number | null;
  }
>;

const getSessionMap = createLazyLoader<SessionMapType>(async () => {
  const rows = await db.select().from(coreSession);
  const m: SessionMapType = new Map();
  for (const s of rows) {
    m.set(s.id, {
      name: s.name ?? null,
      parliamentnum: s.parliamentnum ?? null,
      sessnum: s.sessnum ?? null,
    });
  }
  return m;
});

/**
 * Lazy-loaded map of bill ID to bill number for vote question cross-linking.
 *
 * Memory note: Without session filter, loads all bills (~50k+ entries, ~500KB-1MB).
 * With --session filter, only loads bills from that session (~500-2000 entries).
 * This is acceptable because:
 * 1. The map is needed for accurate bill number in vote_question metadata
 * 2. Loading per-batch would cause N+1 queries
 * 3. Memory is bounded and predictable
 */
const getBillNumberMap = createLazyLoader<Map<number, string>>(async () => {
  const rows = sessionFilter
    ? await db
        .select({ id: billsBill.id, number: billsBill.number })
        .from(billsBill)
        .where(eq(billsBill.sessionId, sessionFilter))
    : await db
        .select({ id: billsBill.id, number: billsBill.number })
        .from(billsBill);
  const m = new Map<number, string>();
  for (const r of rows) {
    m.set(r.id, r.number);
  }
  return m;
});

// ---------- Utilities ----------

/**
 * Format a Date to ISO date string (YYYY-MM-DD) or undefined if null/undefined.
 * Centralizes date formatting to ensure consistent output across all processors.
 */
function formatDateISO(date: Date | null | undefined): string | undefined {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

/**
 * Type-safe institution validator.
 * Returns "C" | "S" | undefined for valid values, undefined for invalid.
 */
function validateInstitution(value: string | null): "C" | "S" | undefined {
  if (value === "C" || value === "S") {
    return value;
  }
  return;
}

/**
 * Track missing committee warnings to avoid duplicate log spam.
 * Bounded: cleared when it exceeds MAX_WARNING_CACHE_SIZE to prevent memory growth.
 * In practice, missing committees are rare, so this rarely triggers.
 */
const MAX_WARNING_CACHE_SIZE = 1000;
const missingCommitteeWarnings = new Set<string>();

function warnMissingCommittee(
  committeeId: number | null | undefined,
  context: string
): void {
  if (!committeeId) {
    return;
  }
  const key = `${context}:${committeeId}`;
  if (missingCommitteeWarnings.has(key)) {
    return;
  }

  // Prevent unbounded memory growth by clearing when cache is full
  if (missingCommitteeWarnings.size >= MAX_WARNING_CACHE_SIZE) {
    console.warn(
      `   ⚠️  Warning cache full (${MAX_WARNING_CACHE_SIZE}), clearing to prevent memory growth`
    );
    missingCommitteeWarnings.clear();
  }

  missingCommitteeWarnings.add(key);
  console.warn(
    `   ⚠️  Missing committee ${committeeId} referenced by ${context}; metadata will include committeeId only`
  );
}

function promptConfirmation(message: string): Promise<boolean> {
  if (assumeYes) {
    return Promise.resolve(true);
  }
  if (!process.stdin.isTTY) {
    console.warn(
      "   ⚠️  Non-interactive input detected; rerun with --yes to auto-confirm."
    );
    return Promise.resolve(false);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} (Y/n): `, (answer) => {
      rl.close();
      resolve(answer.trim().toUpperCase() === "Y");
    });
  });
}

async function dropTablesWithConfirmation(): Promise<void> {
  console.log("\n⚠️  WARNING: DROP TABLES OPERATION\n");
  console.log("This will permanently delete the following tables:");
  console.log("  • parlEmbeddings (all vector parlEmbeddings)");
  console.log("  • parlResources (all resource metadata)\n");
  console.log("⚠️  This action CANNOT be undone!\n");
  const confirmed = await promptConfirmation(
    "Are you sure you want to drop these tables? Type Y to continue"
  );
  if (!confirmed) {
    console.log("\n❌ Operation cancelled by user\n");
    process.exit(0);
  }
  console.log("\n🗑️  Dropping tables...");
  await db.execute(sql`DROP TABLE IF EXISTS rag.parl_embeddings CASCADE`);
  console.log("   ✅ Dropped rag.parl_embeddings table");
  await db.execute(sql`DROP TABLE IF EXISTS rag.parl_resources CASCADE`);
  console.log("   ✅ Dropped rag.parl_resources table");
  console.log("\n✨ Tables dropped successfully\n");
}

async function emptyTablesWithConfirmation(): Promise<void> {
  console.log("\n⚠️  WARNING: EMPTY TABLES OPERATION\n");
  console.log("This will delete all data from the following tables:");
  console.log("  • parlEmbeddings (all vector parlEmbeddings)");
  console.log("  • parlResources (all resource metadata)\n");
  console.log("The table structure will remain intact.");
  console.log("\n⚠️  This action CANNOT be undone!\n");
  const confirmed = await promptConfirmation(
    "Are you sure you want to empty these tables? Type Y to continue"
  );
  if (!confirmed) {
    console.log("\n❌ Operation cancelled by user\n");
    process.exit(0);
  }
  console.log("\n🧹 Emptying tables...");
  await db.execute(sql`TRUNCATE TABLE rag.parl_embeddings CASCADE`);
  console.log("   ✅ Emptied rag.parl_embeddings table");
  await db.execute(sql`TRUNCATE TABLE rag.parl_resources CASCADE`);
  console.log("   ✅ Emptied rag.parl_resources table");
  console.log("\n✨ Tables emptied successfully\n");
}

type ChunkInput = { content: string; metadata: ResourceMetadata };

/**
 * Build a unique key for a resource based on its metadata
 */
function buildResourceKey(meta: ResourceMetadata): string {
  return `${meta.sourceType}:${meta.sourceId}:${meta.language}:${meta.chunkIndex ?? 0}`;
}

/**
 * Efficiently join SQL fragments with a separator.
 * Avoids O(n²) string concatenation from using reduce.
 * Uses sql.join() which is Drizzle's idiomatic approach.
 */
function sqlJoinValues<T>(
  items: T[],
  mapper: (item: T) => ReturnType<typeof sql>
): ReturnType<typeof sql> {
  if (items.length === 0) {
    return sql``;
  }
  const fragments = items.map(mapper);
  // Use sql template with array spread for efficient joining
  return sql.join(fragments, sql`, `);
}

/**
 * Check if progress tracker has any data for a source type.
 * If local cache is missing records that exist in Postgres, sync them.
 */
async function ensureProgressSynced(
  sourceType: ResourceMetadata["sourceType"]
): Promise<void> {
  const localCount = progressTracker.countByPrefix(`${sourceType}:`);

  // Always check Postgres count to ensure we're not missing records
  const pgCountResult = await db.execute<{ count: string }>(
    sql`SELECT COUNT(*) as count FROM ${parlResources} WHERE ${parlResources.metadata}->>'sourceType' = ${sourceType}`
  );
  const pgCount = Number.parseInt(pgCountResult[0]?.count ?? "0", 10);

  if (pgCount === 0) {
    console.log(
      `   📋 No existing records in database (local cache: ${localCount.toLocaleString()})`
    );
    return;
  }

  // If local cache has significantly fewer records than Postgres, re-sync.
  // We use PROGRESS_SYNC_THRESHOLD (default 95%) rather than exact equality because:
  // 1. Race conditions: items may be inserted between count and sync queries
  // 2. Partial failures: some items might fail to be tracked in SQLite
  // 3. Performance: avoids unnecessary sync for small discrepancies
  // A difference exceeding the threshold indicates SQLite was cleared or is out of sync.
  const syncThreshold = Math.floor(pgCount * PROGRESS_SYNC_THRESHOLD);
  if (localCount >= syncThreshold) {
    console.log(
      `   📋 Local cache: ${localCount.toLocaleString()} / Postgres: ${pgCount.toLocaleString()} - in sync`
    );
    return;
  }

  console.log(
    `   ⚠️  Local cache: ${localCount.toLocaleString()} / Postgres: ${pgCount.toLocaleString()} - syncing missing records...`
  );
  await syncProgressFromPostgres(sourceType);

  const newLocalCount = progressTracker.countByPrefix(`${sourceType}:`);
  console.log(
    `   ✅ Sync complete: ${newLocalCount.toLocaleString()} items now cached`
  );
}

/**
 * Generate parlEmbeddings with retry logic and error handling
 */
async function generateEmbeddingsWithRetry(
  contents: string[],
  maxRetries = EMBEDDING_RETRY_ATTEMPTS
): Promise<number[][]> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Note: generateEmbeddings has its own internal retry via AI SDK's maxRetries
      // We handle outer retry here for network-level failures with exponential backoff
      return await generateEmbeddings(contents);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `   ⚠️  Embedding attempt ${attempt}/${maxRetries} failed: ${lastError.message}`
      );
      // Log full stack trace on final attempt for debugging production issues
      if (attempt === maxRetries && lastError.stack) {
        console.warn(`   Stack trace:\n${lastError.stack}`);
      }
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s...
        const delay = 1000 * 2 ** (attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new Error(
    `Embedding generation failed after ${maxRetries} attempts: ${lastError?.message}`
  );
}

/**
 * Simple concurrency limiter for parallel processing.
 * Ensures proper cleanup: queued callbacks are always resolved even on errors.
 */
function createLimiter(concurrency: number) {
  let running = 0;
  const queue: (() => void)[] = [];

  const releaseNext = () => {
    running--;
    const next = queue.shift();
    if (next) {
      next();
    }
  };

  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (running >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running++;
    try {
      return await fn();
    } finally {
      releaseNext();
    }
  };
}

/**
 * Filter and validate content lengths before embedding.
 * Removes chunks that exceed the model's token limit to prevent API truncation.
 *
 * Note: The embedding API uses truncate: "END" which would silently degrade
 * embedding quality. We filter oversized chunks and log them instead.
 *
 * Returns filtered chunks and statistics about what was filtered.
 */
function filterOversizedChunks(chunks: ChunkInput[]): {
  validChunks: ChunkInput[];
  oversizedCount: number;
  maxLength: number;
} {
  const validChunks: ChunkInput[] = [];
  let oversizedCount = 0;
  let maxLength = 0;

  for (const chunk of chunks) {
    const len = chunk.content.length;
    if (len > maxLength) {
      maxLength = len;
    }
    if (len > MAX_EMBEDDING_CHARS) {
      oversizedCount++;
      // Log first few oversized chunks for debugging
      if (oversizedCount <= 3) {
        const estimatedTokens = Math.ceil(len / CHARS_PER_TOKEN);
        console.warn(
          `   ⚠️  Skipping oversized chunk: ${chunk.metadata.sourceType}:${chunk.metadata.sourceId} ` +
            `(${len} chars, ~${estimatedTokens} tokens)`
        );
      }
    } else {
      validChunks.push(chunk);
    }
  }

  return { validChunks, oversizedCount, maxLength };
}

/**
 * Insert chunks in batches with progress logging
 * Uses bulk inserts and parallel embedding generation for performance
 *
 * In dry-run mode, logs what would be processed without making changes.
 */
async function insertChunksBatched(
  chunks: ChunkInput[],
  label: string
): Promise<number> {
  if (chunks.length === 0) {
    console.log(`   📦 No new chunks to embed for ${label}`);
    return 0;
  }

  // Filter out oversized chunks that would be truncated by the API
  const { validChunks, oversizedCount, maxLength } =
    filterOversizedChunks(chunks);

  if (oversizedCount > 0) {
    const estimatedTokens = Math.ceil(maxLength / CHARS_PER_TOKEN);
    console.warn(
      `   ⚠️  Filtered ${oversizedCount}/${chunks.length} oversized chunks (>${MAX_EMBEDDING_CHARS} chars)`
    );
    console.warn(
      `   ⚠️  Largest filtered chunk: ${maxLength} chars (~${estimatedTokens} tokens)`
    );
    if (oversizedCount > 3) {
      console.warn(
        `   ⚠️  (${oversizedCount - 3} more oversized chunks not shown)`
      );
    }
  }

  // Use filtered chunks for embedding
  const chunksToEmbed = validChunks;
  if (chunksToEmbed.length === 0) {
    console.log(
      `   📦 No valid chunks to embed for ${label} (all ${chunks.length} were oversized)`
    );
    return 0;
  }

  const contents = chunksToEmbed.map((c) => c.content);

  // In dry-run mode, just log what would be processed
  if (dryRun) {
    const totalChars = contents.reduce((sum, c) => sum + c.length, 0);
    const avgChars = Math.round(totalChars / contents.length);
    const sourceTypes = new Set(
      chunksToEmbed.map((c) => c.metadata.sourceType)
    );
    console.log(`   🔍 [DRY-RUN] Would embed ${chunksToEmbed.length} chunks:`);
    console.log(`      Source types: ${[...sourceTypes].join(", ")}`);
    console.log(
      `      Total chars: ${totalChars.toLocaleString()} (avg ${avgChars}/chunk)`
    );
    console.log(
      `      Batches needed: ${Math.ceil(chunksToEmbed.length / EMBEDDING_BATCH_SIZE)}`
    );
    return chunksToEmbed.length; // Return what would have been inserted
  }

  let inserted = 0;

  // Split chunks into batches
  const batches: ChunkInput[][] = [];
  for (let i = 0; i < chunksToEmbed.length; i += EMBEDDING_BATCH_SIZE) {
    batches.push(chunksToEmbed.slice(i, i + EMBEDDING_BATCH_SIZE));
  }
  const totalBatches = batches.length;

  // Process embedding batches in parallel with concurrency limit
  const concurrencyLimiter = createLimiter(EMBEDDING_CONCURRENCY);

  // Counter for progress tracking (JS single-threaded, so increment is safe)
  // Note: Batches may complete out of order due to parallel execution,
  // but we track completion count rather than batch indices for simplicity.
  let completedBatches = 0;
  const incrementAndGetCompleted = () => ++completedBatches;

  // Generate all embeddings in parallel (with concurrency limit)
  console.log(
    `   📦 Generating embeddings for ${chunksToEmbed.length} chunks in ${totalBatches} batches (${EMBEDDING_CONCURRENCY}x parallel)...`
  );

  const embeddingResults = await Promise.all(
    batches.map((batch, batchIdx) =>
      concurrencyLimiter(async () => {
        const vectors = await generateEmbeddingsWithRetry(
          batch.map((c) => c.content)
        );
        const completed = incrementAndGetCompleted();
        // Log progress at first, every 5th, and final batch
        // (batches complete out-of-order, so we show completion count not batch index)
        if (
          completed === 1 ||
          completed === totalBatches ||
          completed % 5 === 0
        ) {
          console.log(
            `   📊 Embedding progress: ${completed}/${totalBatches} batches completed`
          );
        }
        return { batch, vectors, batchIdx };
      })
    )
  );

  // Insert all batches to database (sequentially to avoid connection issues)
  console.log(`   💾 Inserting ${chunksToEmbed.length} chunks to database...`);

  for (const { batch, vectors } of embeddingResults) {
    const now = new Date();

    // Prepare bulk insert data with generated IDs
    const resourceIds = batch.map(() => nanoid());
    const resourceValues = batch.map((ch, idx) => ({
      id: resourceIds[idx],
      content: ch.content,
      metadata: ch.metadata,
      createdAt: now,
      updatedAt: now,
    }));

    // Insert in a single transaction with bulk inserts
    // Uses ON CONFLICT DO UPDATE to handle idempotent re-runs after crashes.
    // The DO UPDATE ensures we get the resource ID back via RETURNING,
    // whether the row was inserted or already existed.
    await db.transaction(async (tx) => {
      if (resourceValues.length === 0) {
        return;
      }

      // Bulk insert resources with ON CONFLICT DO UPDATE for idempotency
      // DO UPDATE sets updated_at so we can use RETURNING to get actual IDs
      const resourceValuesSql = sqlJoinValues(
        resourceValues,
        (r) =>
          sql`(${r.id}, ${r.content}, ${r.metadata}::jsonb, ${r.createdAt}, ${r.updatedAt})`
      );

      const insertedResources = await tx.execute<{ id: string }>(sql`
        INSERT INTO rag.parl_resources (id, content, metadata, created_at, updated_at)
        VALUES ${resourceValuesSql}
        ON CONFLICT ((metadata->>'sourceType'), (metadata->>'sourceId'), (metadata->>'language'), COALESCE((metadata->>'chunkIndex')::int, 0))
        DO UPDATE SET updated_at = EXCLUDED.updated_at
        RETURNING id
      `);

      // Map batch indices to actual resource IDs (handles both new and existing)
      // The RETURNING clause returns IDs in the same order as VALUES
      const actualResourceIds = insertedResources.map((r) => r.id);

      if (actualResourceIds.length !== batch.length) {
        console.warn(
          `   ⚠️  Resource insert returned ${actualResourceIds.length} IDs for ${batch.length} items`
        );
      }

      // Validate embedding dimensions before insert
      for (let i = 0; i < vectors.length; i++) {
        if (vectors[i].length !== 1024) {
          throw new Error(
            `Embedding dimension mismatch: expected 1024, got ${vectors[i].length} at index ${i}`
          );
        }
      }

      // Prepare embedding values using actual resource IDs
      const embeddingValues = batch.map((ch, idx) => ({
        id: nanoid(),
        resourceId: actualResourceIds[idx],
        content: ch.content,
        embedding: vectors[idx],
      }));

      // Delete any existing embeddings for these resources (handles re-runs where
      // resource existed but embedding may be stale or partially created)
      // This ensures 1:1 relationship between resources and embeddings
      const resourceIdList = sql.join(
        actualResourceIds.map((id) => sql`${id}`),
        sql`, `
      );
      await tx.execute(sql`
        DELETE FROM rag.parl_embeddings WHERE resource_id IN (${resourceIdList})
      `);

      // Bulk insert embeddings with tsvector computed inline
      const embeddingValuesSql = sqlJoinValues(
        embeddingValues,
        (e) =>
          sql`(${e.id}, ${e.resourceId}, ${e.content}, ${e.embedding}::vector, to_tsvector('simple', ${e.content}))`
      );

      await tx.execute(sql`
        INSERT INTO rag.parl_embeddings (id, resource_id, content, embedding, tsv)
        VALUES ${embeddingValuesSql}
      `);
    });

    // Mark as processed in SQLite (after successful Postgres commit)
    // This is intentionally outside the transaction - if we crash here,
    // the next run will update via ON CONFLICT DO UPDATE clauses
    const processedKeys = batch.map((ch) => buildResourceKey(ch.metadata));
    progressTracker.markMany(processedKeys);

    inserted += batch.length;
  }

  return inserted;
}

/**
 * Filter chunks that haven't been processed yet (using SQLite progress tracker)
 */
function filterNewChunks(chunks: ChunkInput[]): ChunkInput[] {
  if (!skipExisting) {
    return chunks; // Process everything if not skipping
  }

  const newChunks: ChunkInput[] = [];
  let skipped = 0;

  for (const ch of chunks) {
    const key = buildResourceKey(ch.metadata);
    if (progressTracker.has(key)) {
      skipped++;
    } else {
      newChunks.push(ch);
    }
  }

  // Debug: show filtering stats
  if (chunks.length > 0) {
    console.log(
      `   🔍 Filter: ${skipped} skipped, ${newChunks.length} new (of ${chunks.length} total)`
    );
    // Show sample keys for debugging
    if (skipped === 0 && chunks.length > 0) {
      const sourceType = chunks[0].metadata.sourceType;
      const sampleKey = buildResourceKey(chunks[0].metadata);
      const cachedCount = progressTracker.countByPrefix(`${sourceType}:`);
      const cachedSamples = progressTracker.sampleKeys(`${sourceType}:`, 3);
      console.log(`   ⚠️  No items skipped! Chunk key: "${sampleKey}"`);
      console.log(
        `   ⚠️  Cached ${sourceType}: ${cachedCount} items. Samples: ${cachedSamples.join(", ") || "(none)"}`
      );
    }
    // Show sample of "new" items when some were skipped but not all
    if (newChunks.length > 0 && skipped > 0) {
      const sampleNew = newChunks
        .slice(0, 3)
        .map((ch) => buildResourceKey(ch.metadata));
      console.log(`   📝 Sample NEW keys: ${sampleNew.join(", ")}`);
    }
  }

  return newChunks;
}

/**
 * Log progress for long-running operations
 * Always logs first item, last item, and every PROGRESS_LOG_INTERVAL items
 */
function logProgress(current: number, total: number, label: string): void {
  if (
    current === 1 ||
    current === total ||
    current % PROGRESS_LOG_INTERVAL === 0
  ) {
    const pct = Math.round((current / total) * 100);
    console.log(`   📊 ${label}: ${current}/${total} (${pct}%)`);
  }
}

// ---------- Generic Batched Processor ----------
/**
 * Configuration for batched processing
 */
type BatchedProcessorConfig<TRow, TId extends number | string = number> = {
  /** Display name for logging */
  label: string;
  /** Source type for progress tracking */
  sourceType: ResourceMetadata["sourceType"];
  /** Function to get total count of items to process */
  getCount: (startAfterId: TId | null) => Promise<number>;
  /** Function to fetch a batch of rows using cursor-based pagination */
  fetchBatch: (startAfterId: TId | null, batchLimit: number) => Promise<TRow[]>;
  /** Function to extract the ID from a row (for cursor pagination) */
  getRowId: (row: TRow) => TId;
  /** Function to convert a row to chunks */
  rowToChunks: (row: TRow) => ChunkInput[];
  /** Whether this source type uses numeric IDs for cursor pagination */
  hasNumericIds?: boolean;
};

/**
 * Generic batched processor that handles cursor-based pagination,
 * progress tracking, and memory-efficient batch processing.
 *
 * This is the standard pattern all processors should follow.
 */
async function processBatched<TRow, TId extends number | string = number>(
  options: BatchedProcessorConfig<TRow, TId>
): Promise<void> {
  const {
    label,
    sourceType,
    getCount,
    fetchBatch,
    getRowId,
    rowToChunks,
    hasNumericIds = true,
  } = options;

  console.log(`• ${label}`);
  if (skipExisting) {
    await ensureProgressSynced(sourceType);
  }

  // For efficient resume, use cursor-based pagination if we have progress
  // IMPORTANT: Disable cursor-based resume when session filter is active.
  // The cursor is based on global max ID across all sessions, but records from
  // different sessions may have overlapping ID ranges. If you previously embedded
  // session 45-1 (IDs 1000-2000) and then run --session 44-2 --skip-existing,
  // the cursor would start at ID 2000, skipping all of 44-2's records.
  let startAfterId: TId | null = null;
  if (skipExisting && hasNumericIds && !sessionFilter) {
    const maxProcessedId = progressTracker.getMaxNumericSourceId(sourceType);
    if (maxProcessedId !== null) {
      startAfterId = maxProcessedId as TId;
      console.log(
        `   🚀 Resuming from ID > ${startAfterId} (cursor-based pagination)`
      );
    }
  } else if (skipExisting && sessionFilter) {
    console.log(
      "   📋 Session filter active: using per-chunk skip logic (cursor disabled)"
    );
  }

  // Get count of remaining rows (for progress display)
  const remainingCount = await getCount(startAfterId);
  const effectiveTotal = limit
    ? Math.min(limit, remainingCount)
    : remainingCount;
  console.log(
    `   Found ${effectiveTotal} ${label.toLowerCase()} to process (fetching in batches)`
  );

  if (effectiveTotal === 0) {
    console.log(`   ↳ No new ${label.toLowerCase()} to process`);
    return;
  }

  let totalInserted = 0;
  let totalSkipped = 0;
  let processed = 0;
  let lastProcessedId = startAfterId;
  let batchNum = 0;
  const totalBatches = Math.ceil(effectiveTotal / DB_FETCH_BATCH_SIZE);

  // Process in batches using cursor-based pagination
  while (processed < effectiveTotal) {
    // Check for graceful shutdown
    if (isShuttingDown) {
      console.log(
        `   ⏸️  Shutdown requested, stopping ${label} at ${processed}/${effectiveTotal}`
      );
      break;
    }

    batchNum++;
    const batchLimit = Math.min(
      DB_FETCH_BATCH_SIZE,
      effectiveTotal - processed
    );
    console.log(
      `   📥 Fetching DB batch ${batchNum}/${totalBatches} (after ID ${lastProcessedId ?? "start"})...`
    );

    const rows = await fetchBatch(lastProcessedId, batchLimit);

    if (rows.length === 0) {
      break; // No more rows
    }

    // Update cursor for next batch
    const lastRow = rows.at(-1);
    if (!lastRow) {
      break;
    }
    lastProcessedId = getRowId(lastRow);

    // Convert rows to chunks and insert incrementally to avoid memory explosion
    // Insert when accumulated chunks reach the embedding batch threshold
    let pendingChunks: ChunkInput[] = [];
    const CHUNK_INSERT_THRESHOLD = EMBEDDING_BATCH_SIZE * 2; // Insert at 2x batch size

    for (const row of rows) {
      processed++;
      logProgress(processed, effectiveTotal, label);
      const chunks = rowToChunks(row);
      pendingChunks.push(...chunks);

      // Insert incrementally when we have enough chunks
      if (pendingChunks.length >= CHUNK_INSERT_THRESHOLD) {
        const newChunks = filterNewChunks(pendingChunks);
        const inserted = await insertChunksBatched(
          newChunks,
          label.toLowerCase()
        );
        totalInserted += inserted;
        totalSkipped += pendingChunks.length - newChunks.length;
        pendingChunks = []; // Clear to free memory
      }
    }

    // Insert any remaining chunks
    if (pendingChunks.length > 0) {
      const newChunks = filterNewChunks(pendingChunks);
      const inserted = await insertChunksBatched(
        newChunks,
        label.toLowerCase()
      );
      totalInserted += inserted;
      totalSkipped += pendingChunks.length - newChunks.length;
    }
  }

  console.log(
    `   ↳ inserted ${totalInserted} chunks for ${label.toLowerCase()} (${totalSkipped} skipped)`
  );
}

// ---------- Content builders ----------
// Note: French translations are hardcoded inline for simplicity since this is a script.
// The translations are specific to Canadian parliamentary terminology and are unlikely
// to change. If translation needs grow, consider extracting to a separate i18n module.
// Current French terms include:
// - "Chambre des communes" / "Sénat" (institutions)
// - "Projet de loi d'initiative parlementaire" / "Projet de loi du gouvernement" (bill types)
// - "Comité" / "Rapport de comité" / "Réunion du comité" (committees)
// - "Question de vote" / "Vote du parti" / "Vote du député" (votes)
// - "Politicien/ne" / "Parti" / "Élection" / "Candidature" (elections)
// - "Session" / "Circonscription" (geography/parliament)

function billMetadataText(bill: BillsBill, lang: "en" | "fr"): string {
  const parts: string[] = [];
  // Use local alias for the shared formatDateISO utility for conciseness
  const date = formatDateISO;
  const inst =
    bill.institution === "C"
      ? lang === "fr"
        ? "Chambre des communes"
        : "House of Commons"
      : lang === "fr"
        ? "Sénat"
        : "Senate";
  if (lang === "fr") {
    parts.push(`Projet de loi ${bill.number}`);
    parts.push(`Session: ${bill.sessionId}`);
    if (bill.nameFr) {
      parts.push(`Titre: ${bill.nameFr}`);
    }
    if (bill.shortTitleFr) {
      parts.push(`Titre abrégé: ${bill.shortTitleFr}`);
    }
    if (bill.statusCode) {
      parts.push(`Statut: ${bill.statusCode}`);
    }
    if (bill.introduced) {
      parts.push(`Présenté: ${date(bill.introduced)}`);
    }
    if (bill.statusDate) {
      parts.push(`Date du statut: ${date(bill.statusDate)}`);
    }
    parts.push(`Institution: ${inst}`);
    if (bill.privatemember !== null) {
      parts.push(
        `Type: ${bill.privatemember ? "Projet de loi d’initiative parlementaire" : "Projet de loi du gouvernement"}`
      );
    }
    if (bill.law !== null) {
      parts.push(`Devenu loi: ${bill.law ? "Oui" : "Non"}`);
    }
  } else {
    parts.push(`Bill ${bill.number}`);
    parts.push(`Session: ${bill.sessionId}`);
    if (bill.nameEn) {
      parts.push(`Title: ${bill.nameEn}`);
    }
    if (bill.shortTitleEn) {
      parts.push(`Short Title: ${bill.shortTitleEn}`);
    }
    if (bill.statusCode) {
      parts.push(`Status: ${bill.statusCode}`);
    }
    if (bill.introduced) {
      parts.push(`Introduced: ${date(bill.introduced)}`);
    }
    if (bill.statusDate) {
      parts.push(`Status Date: ${date(bill.statusDate)}`);
    }
    parts.push(`Institution: ${inst}`);
    if (bill.privatemember !== null) {
      parts.push(
        `Type: ${bill.privatemember ? "Private Member's Bill" : "Government Bill"}`
      );
    }
    if (bill.law !== null) {
      parts.push(`Law: ${bill.law ? "Yes" : "No"}`);
    }
  }
  return parts.join("\n");
}

// ---------- Processors ----------

// Type for bill row with joined text
type BillRow = {
  bill: typeof billsBill.$inferSelect;
  billtext: typeof billsBilltext.$inferSelect | null;
};

/**
 * Convert a bill row to chunks (EN + FR metadata + text chunks)
 *
 * Memory note: Large bills can produce 50+ chunks. With DB_FETCH_BATCH_SIZE=1000,
 * this could create 50,000+ chunk objects before insertion. The calling code
 * mitigates this via CHUNK_INSERT_THRESHOLD which triggers incremental inserts
 * at 2x EMBEDDING_BATCH_SIZE (~192 chunks). This keeps peak memory bounded to
 * roughly 200 chunks + one DB batch worth of data at a time.
 */
function billRowToChunks(
  row: BillRow,
  sessionMap: Map<
    string,
    {
      name: string | null;
      parliamentnum: number | null;
      sessnum: number | null;
    }
  >
): ChunkInput[] {
  const bill = row.bill;
  const bt = row.billtext;
  const chunks: ChunkInput[] = [];

  const sessInfo = sessionMap.get(bill.sessionId);
  const baseMetadata = {
    sourceType: "bill" as const,
    sourceId: bill.id,
    sessionId: bill.sessionId,
    billNumber: bill.number,
    billStatusCode: bill.statusCode || undefined,
    billIntroduced: formatDateISO(bill.introduced),
    billStatusDate: formatDateISO(bill.statusDate),
    institution: validateInstitution(bill.institution),
    privateMember: bill.privatemember ?? undefined,
    law: bill.law ?? undefined,
    sessionName: sessInfo?.name ?? undefined,
    parliamentnum: sessInfo?.parliamentnum ?? undefined,
    sessnum: sessInfo?.sessnum ?? undefined,
  };

  // Metadata chunks (EN + FR)
  chunks.push({
    content: billMetadataText(bill, "en"),
    metadata: {
      ...baseMetadata,
      language: "en",
      billTitle: bill.nameEn || undefined,
      nameEn: bill.nameEn || undefined,
      chunkIndex: 0,
    },
  });
  chunks.push({
    content: billMetadataText(bill, "fr"),
    metadata: {
      ...baseMetadata,
      language: "fr",
      billTitle: bill.nameFr || undefined,
      nameFr: bill.nameFr || undefined,
      chunkIndex: 0,
    },
  });

  // Text chunks by language using semantic chunking
  const billContext: BillContext = {
    number: bill.number,
    nameEn: bill.nameEn || undefined,
    nameFr: bill.nameFr || undefined,
    sessionId: bill.sessionId,
  };

  // Text chunks start at index 1 to avoid collision with metadata chunk at index 0
  if (bt?.textEn?.trim()) {
    const textChunks = chunkBill(bt.textEn, billContext, "en");
    for (const ch of textChunks) {
      chunks.push({
        content: ch.content,
        metadata: {
          ...baseMetadata,
          language: "en",
          billTitle: bill.nameEn || undefined,
          nameEn: bill.nameEn || undefined,
          chunkIndex: ch.index + 1,
          ...(ch.section ? { billSection: ch.section } : {}),
        },
      });
    }
  }
  if (bt?.textFr?.trim()) {
    const textChunks = chunkBill(bt.textFr, billContext, "fr");
    for (const ch of textChunks) {
      chunks.push({
        content: ch.content,
        metadata: {
          ...baseMetadata,
          language: "fr",
          billTitle: bill.nameFr || undefined,
          nameFr: bill.nameFr || undefined,
          chunkIndex: ch.index + 1,
          ...(ch.section ? { billSection: ch.section } : {}),
        },
      });
    }
  }

  return chunks;
}

async function processBills(): Promise<void> {
  // Resolve sessionMap once before processing (lazy-loaded)
  const sessionMap = await getSessionMap();

  await processBatched<BillRow>({
    label: "Bills",
    sourceType: "bill",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsBill.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsBill.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billsBill)
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsBill.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsBill.id, startAfterId));
      }

      return db
        .select({ bill: billsBill, billtext: billsBilltext })
        .from(billsBill)
        .leftJoin(billsBilltext, eq(billsBill.id, billsBilltext.billId))
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(billsBill.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.bill.id,
    rowToChunks: (row) => billRowToChunks(row, sessionMap),
  });
}

// Type for hansard row with joined document
type HansardRow = {
  st: typeof hansardsStatement.$inferSelect;
  doc: typeof hansardsDocument.$inferSelect;
};

/**
 * Convert a hansard row to chunks (EN + FR content chunks)
 */
function hansardRowToChunks(row: HansardRow): ChunkInput[] {
  const st = row.st;
  const doc = row.doc;
  const chunks: ChunkInput[] = [];

  const headerEn = [st.h1En, st.h2En, st.h3En].filter(Boolean).join(" – ");
  const headerFr = [st.h1Fr, st.h2Fr, st.h3Fr].filter(Boolean).join(" – ");
  // Use formatDateISO for consistency with other processors
  const dateIso = formatDateISO(st.time);

  const baseMeta = {
    sourceType: "hansard" as const,
    sourceId: st.id,
    documentId: st.documentId,
    sessionId: doc.sessionId,
    date: dateIso,
    statementId: st.id,
    politicianId: st.politicianId ?? undefined,
    billDebatedId: st.billDebatedId ?? undefined,
    billDebateStage: st.billDebateStage || undefined,
    writtenQuestion: st.writtenQuestion || undefined,
    speakerNameEn: st.whoEn || undefined,
    speakerNameFr: st.whoFr || undefined,
    nameEn: headerEn || undefined,
    nameFr: headerFr || undefined,
    docNumber: doc.number || undefined,
  };

  // EN content using semantic chunking
  if (st.contentEn?.trim()) {
    const hansardContext: HansardContext = {
      speakerName: st.whoEn || undefined,
      date: dateIso,
      documentNumber: doc.number?.toString(),
    };
    const textChunks = chunkHansard(st.contentEn, hansardContext, "en");
    for (const ch of textChunks) {
      chunks.push({
        content: ch.content,
        metadata: { ...baseMeta, language: "en", chunkIndex: ch.index },
      });
    }
  }

  // FR content using semantic chunking
  if (st.contentFr?.trim()) {
    const hansardContext: HansardContext = {
      speakerName: st.whoFr || undefined,
      date: dateIso,
      documentNumber: doc.number?.toString(),
    };
    const textChunks = chunkHansard(st.contentFr, hansardContext, "fr");
    for (const ch of textChunks) {
      chunks.push({
        content: ch.content,
        metadata: { ...baseMeta, language: "fr", chunkIndex: ch.index },
      });
    }
  }

  return chunks;
}

async function processHansard(): Promise<void> {
  await processBatched<HansardRow>({
    label: "Hansard statements",
    sourceType: "hansard",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(hansardsDocument.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(hansardsStatement.id, startAfterId));
      }

      const [{ count }] = sessionFilter
        ? await db
            .select({ count: sql<number>`count(*)::int` })
            .from(hansardsStatement)
            .innerJoin(
              hansardsDocument,
              eq(hansardsStatement.documentId, hansardsDocument.id)
            )
            .where(
              whereConditions.length > 0 ? and(...whereConditions) : undefined
            )
        : await db
            .select({ count: sql<number>`count(*)::int` })
            .from(hansardsStatement)
            .where(
              startAfterId !== null
                ? gt(hansardsStatement.id, startAfterId)
                : undefined
            );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(hansardsDocument.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(hansardsStatement.id, startAfterId));
      }

      return db
        .select({ st: hansardsStatement, doc: hansardsDocument })
        .from(hansardsStatement)
        .innerJoin(
          hansardsDocument,
          eq(hansardsStatement.documentId, hansardsDocument.id)
        )
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(hansardsStatement.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.st.id,
    rowToChunks: hansardRowToChunks,
  });
}

// Type aliases for processor row types
type CommitteeRow = typeof committeesCommittee.$inferSelect;
type CommitteeReportRow = typeof committeesCommitteereport.$inferSelect;
type CommitteeMeetingRow = typeof committeesCommitteemeeting.$inferSelect;
type VoteQuestionRow = typeof billsVotequestion.$inferSelect;
type PartyVoteRow = typeof billsPartyvote.$inferSelect;
type MemberVoteRow = typeof billsMembervote.$inferSelect;
type PoliticianRow = typeof corePolitician.$inferSelect;
type PartyRow = typeof coreParty.$inferSelect;
type ElectionRow = typeof electionsElection.$inferSelect;
type CandidacyRow = typeof electionsCandidacy.$inferSelect;
type SessionRow = typeof coreSession.$inferSelect;
type RidingRow = typeof coreRiding.$inferSelect;

type CommitteeReportWithCommittee = {
  report: CommitteeReportRow;
  committee: CommitteeRow | null;
};

type CommitteeMeetingWithCommittee = {
  meeting: CommitteeMeetingRow;
  committee: CommitteeRow | null;
};

// Joined row types (used to avoid loading entire lookup tables into memory)
type PartyVoteWithRelations = {
  vote: PartyVoteRow;
  question: VoteQuestionRow;
  party: PartyRow;
};

type MemberVoteWithRelations = {
  vote: MemberVoteRow;
  question: VoteQuestionRow;
  politician: PoliticianRow;
};

type CandidacyWithRelations = {
  candidacy: CandidacyRow;
  politician: PoliticianRow | null;
  party: PartyRow | null;
  riding: RidingRow | null;
  election: ElectionRow | null;
};

// Row to chunks converters
function committeeRowToChunks(c: CommitteeRow): ChunkInput[] {
  const baseMeta = {
    sourceType: "committee" as const,
    sourceId: c.id,
    committeeId: c.id,
    committeeSlug: c.slug,
    chunkIndex: 0,
    committeeNameEn: c.nameEn,
    committeeNameFr: c.nameFr,
    nameEn: c.nameEn,
    nameFr: c.nameFr,
  };

  return [
    {
      content: [
        `Committee: ${c.nameEn}`,
        c.shortNameEn && `Short: ${c.shortNameEn}`,
        `Slug: ${c.slug}`,
        `Joint: ${c.joint ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en", title: c.nameEn },
    },
    {
      content: [
        `Comité: ${c.nameFr}`,
        c.shortNameFr && `Abrégé: ${c.shortNameFr}`,
        `Identifiant: ${c.slug}`,
        `Mixte: ${c.joint ? "Oui" : "Non"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr", title: c.nameFr },
    },
  ];
}

function committeeReportRowToChunks(
  row: CommitteeReportWithCommittee
): ChunkInput[] {
  const r = row.report;
  const committee = row.committee;
  if (!committee) {
    warnMissingCommittee(r.committeeId, `committee_report ${r.id}`);
  }

  const adoptedDate = formatDateISO(r.adoptedDate);
  const presentedDate = formatDateISO(r.presentedDate);
  const baseMeta = {
    sourceType: "committee_report" as const,
    sourceId: r.id,
    committeeId: r.committeeId ?? undefined,
    sessionId: r.sessionId ?? undefined,
    chunkIndex: 0,
    ...(committee && {
      committeeSlug: committee.slug,
      committeeNameEn: committee.nameEn,
      committeeNameFr: committee.nameFr,
    }),
  };

  return [
    {
      content: [
        `Committee Report: ${r.nameEn}`,
        committee ? `Committee: ${committee.nameEn}` : undefined,
        r.number != null ? `Number: ${r.number}` : undefined,
        r.sessionId ? `Session: ${r.sessionId}` : undefined,
        adoptedDate ? `Adopted: ${adoptedDate}` : undefined,
        presentedDate ? `Presented: ${presentedDate}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en", title: r.nameEn },
    },
    {
      content: [
        `Rapport de comité: ${r.nameFr}`,
        committee ? `Comité: ${committee.nameFr}` : undefined,
        r.number != null ? `Numéro: ${r.number}` : undefined,
        r.sessionId ? `Session: ${r.sessionId}` : undefined,
        adoptedDate ? `Adopté: ${adoptedDate}` : undefined,
        presentedDate ? `Présenté: ${presentedDate}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr", title: r.nameFr },
    },
  ];
}

function committeeMeetingRowToChunks(
  row: CommitteeMeetingWithCommittee
): ChunkInput[] {
  const m = row.meeting;
  const committee = row.committee;
  if (!committee) {
    warnMissingCommittee(m.committeeId, `committee_meeting ${m.id}`);
  }

  const d = formatDateISO(m.date);
  const baseMeta = {
    sourceType: "committee_meeting" as const,
    sourceId: m.id,
    sessionId: m.sessionId,
    committeeId: m.committeeId,
    chunkIndex: 0,
    date: d,
    meetingNumber: m.number,
    ...(committee && {
      committeeSlug: committee.slug,
      committeeNameEn: committee.nameEn,
      committeeNameFr: committee.nameFr,
    }),
  };

  const titleEn = committee
    ? `${committee.nameEn} – Meeting #${m.number}`
    : `Committee Meeting #${m.number}`;
  const titleFr = committee
    ? `${committee.nameFr} – Réunion n° ${m.number}`
    : `Réunion du comité n° ${m.number}`;

  return [
    {
      content: [
        titleEn,
        committee ? `Committee: ${committee.nameEn}` : undefined,
        d ? `Date: ${d}` : undefined,
        m.sessionId ? `Session: ${m.sessionId}` : undefined,
        `Webcast: ${m.webcast ? "Yes" : "No"}`,
        `Televised: ${m.televised ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en", title: titleEn },
    },
    {
      content: [
        titleFr,
        committee ? `Comité: ${committee.nameFr}` : undefined,
        d ? `Date: ${d}` : undefined,
        m.sessionId ? `Session: ${m.sessionId}` : undefined,
        `Diffusé sur le Web: ${m.webcast ? "Oui" : "Non"}`,
        `Télévisé: ${m.televised ? "Oui" : "Non"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr", title: titleFr },
    },
  ];
}

function voteQuestionRowToChunks(
  vq: VoteQuestionRow,
  billNumMap: Map<number, string>
): ChunkInput[] {
  const dateIso = formatDateISO(vq.date);
  const billNum = vq.billId ? billNumMap.get(vq.billId) : undefined;
  const baseMeta = {
    sourceType: "vote_question" as const,
    sourceId: vq.id,
    sessionId: vq.sessionId,
    voteQuestionId: vq.id,
    voteNumber: vq.number,
    billId: vq.billId ?? undefined,
    billNumber: billNum ?? undefined,
    chunkIndex: 0,
    date: dateIso,
    result: vq.result,
  };

  return [
    {
      content: [
        `Vote Question #${vq.number}`,
        vq.descriptionEn && `Description: ${vq.descriptionEn}`,
        dateIso && `Date: ${dateIso}`,
        vq.result && `Result: ${vq.result}`,
        `Yea: ${vq.yeaTotal}  Nay: ${vq.nayTotal}  Paired: ${vq.pairedTotal}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        ...baseMeta,
        language: "en",
        title: vq.descriptionEn || undefined,
      },
    },
    {
      content: [
        `Question de vote n° ${vq.number}`,
        vq.descriptionFr && `Description: ${vq.descriptionFr}`,
        dateIso && `Date: ${dateIso}`,
        vq.result && `Résultat: ${vq.result}`,
        `Pour: ${vq.yeaTotal}  Contre: ${vq.nayTotal}  Jumelés: ${vq.pairedTotal}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        ...baseMeta,
        language: "fr",
        title: vq.descriptionFr || undefined,
      },
    },
  ];
}

function partyVoteRowToChunks(row: PartyVoteWithRelations): ChunkInput[] {
  const { vote: v, question: q, party: p } = row;

  const dateIso = formatDateISO(q.date);
  const baseMeta = {
    sourceType: "vote_party" as const,
    sourceId: v.id,
    sessionId: q.sessionId,
    voteQuestionId: q.id,
    voteNumber: q.number,
    partyId: p.id,
    partyNameEn: p.nameEn,
    partyNameFr: p.nameFr,
    partyShortEn: p.shortNameEn || undefined,
    partyShortFr: p.shortNameFr || undefined,
    chunkIndex: 0,
    date: dateIso,
    result: v.vote,
  };

  return [
    {
      content: [
        `Party vote: ${p.nameEn} (${p.shortNameEn})`,
        `Vote: ${v.vote}`,
        `Question #${q.number}`,
        q.descriptionEn && `Description: ${q.descriptionEn}`,
        dateIso && `Date: ${dateIso}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en" },
    },
    {
      content: [
        `Vote du parti: ${p.nameFr} (${p.shortNameFr})`,
        `Vote: ${v.vote}`,
        `Question n° ${q.number}`,
        q.descriptionFr && `Description: ${q.descriptionFr}`,
        dateIso && `Date: ${dateIso}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr" },
    },
  ];
}

function memberVoteRowToChunks(row: MemberVoteWithRelations): ChunkInput[] {
  const { vote: v, question: q, politician: p } = row;

  const dateIso = formatDateISO(q.date);
  const baseMeta = {
    sourceType: "vote_member" as const,
    sourceId: v.id,
    sessionId: q.sessionId,
    voteQuestionId: q.id,
    voteNumber: q.number,
    politicianId: p.id,
    memberId: v.memberId,
    politicianName: p.name,
    chunkIndex: 0,
    date: dateIso,
    result: v.vote,
  };

  return [
    {
      content: [
        `Member vote: ${p.name}`,
        `Vote: ${v.vote}`,
        `Question #${q.number}`,
        q.descriptionEn && `Description: ${q.descriptionEn}`,
        dateIso && `Date: ${dateIso}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en" },
    },
    {
      content: [
        `Vote du député/de la députée: ${p.name}`,
        `Vote: ${v.vote}`,
        `Question n° ${q.number}`,
        q.descriptionFr && `Description: ${q.descriptionFr}`,
        dateIso && `Date: ${dateIso}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr" },
    },
  ];
}

/**
 * Convert politician row to chunks.
 *
 * Note: Politician chunks are intentionally sparse (~50-100 chars) as they
 * serve primarily as lookup/filter targets rather than semantic search content.
 * For rich politician context, consumers should query related hansard statements,
 * votes, and candidacies via politicianId in those source types' metadata.
 *
 * Enrichment (party history, riding history, notable bills) would require
 * additional joins that would significantly impact processing time and memory.
 */
function politicianRowToChunks(p: PoliticianRow): ChunkInput[] {
  const givenName = p.nameGiven || undefined;
  const familyName = p.nameFamily || undefined;
  const gender = p.gender || undefined;
  const baseMeta = {
    sourceType: "politician" as const,
    sourceId: p.id,
    chunkIndex: 0,
    title: p.name,
    politicianName: p.name,
    nameGiven: givenName,
    nameFamily: familyName,
    gender,
  };

  return [
    {
      content: [
        `Politician: ${p.name}`,
        givenName && `Given name: ${givenName}`,
        familyName && `Family name: ${familyName}`,
        gender && `Gender: ${gender}`,
        p.slug ? `Slug: ${p.slug}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en", nameEn: p.name },
    },
    {
      content: [
        `Politicien/ne: ${p.name}`,
        givenName && `Prénom: ${givenName}`,
        familyName && `Nom de famille: ${familyName}`,
        gender && `Genre: ${gender}`,
        p.slug ? `Identifiant: ${p.slug}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr", nameFr: p.name },
    },
  ];
}

/**
 * Convert party row to chunks.
 *
 * Note: Party chunks are intentionally sparse (~30-50 chars) as they serve
 * primarily as lookup/filter targets. For rich party context (election results,
 * member counts, policy positions), consumers should query related vote_party,
 * candidacy, and elected_member records via partyId in those source types' metadata.
 */
function partyRowToChunks(p: PartyRow): ChunkInput[] {
  const baseMeta = {
    sourceType: "party" as const,
    sourceId: p.id,
    chunkIndex: 0,
    partyNameEn: p.nameEn,
    partyNameFr: p.nameFr,
    partyShortEn: p.shortNameEn || undefined,
    partyShortFr: p.shortNameFr || undefined,
  };

  return [
    {
      content: [
        `Party: ${p.nameEn}`,
        p.shortNameEn && `Short: ${p.shortNameEn}`,
        p.slug && `Slug: ${p.slug}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        ...baseMeta,
        language: "en",
        title: p.nameEn,
        nameEn: p.nameEn,
      },
    },
    {
      content: [
        `Parti: ${p.nameFr}`,
        p.shortNameFr && `Abrégé: ${p.shortNameFr}`,
        p.slug && `Identifiant: ${p.slug}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        ...baseMeta,
        language: "fr",
        title: p.nameFr,
        nameFr: p.nameFr,
      },
    },
  ];
}

/**
 * Convert election row to chunks.
 *
 * Note: Election chunks are intentionally sparse (~30-50 chars) as they serve
 * primarily as lookup/filter targets. For rich election context (results by
 * riding, party seat counts, turnout), consumers should query related candidacy
 * records via electionId in those source types' metadata.
 */
function electionRowToChunks(e: ElectionRow): ChunkInput[] {
  const d = formatDateISO(e.date);
  const baseMeta = {
    sourceType: "election" as const,
    sourceId: e.id,
    chunkIndex: 0,
    date: d,
  };

  return [
    {
      content: [
        "Election",
        d && `Date: ${d}`,
        `By-election: ${e.byelection ? "Yes" : "No"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en" },
    },
    {
      content: [
        "Élection",
        d && `Date: ${d}`,
        `Élection partielle: ${e.byelection ? "Oui" : "Non"}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr" },
    },
  ];
}

function candidacyRowToChunks(row: CandidacyWithRelations): ChunkInput[] {
  const { candidacy: c, politician: pol, party, riding, election } = row;
  const dateIso = formatDateISO(election?.date);

  const baseMeta = {
    sourceType: "candidacy" as const,
    sourceId: c.id,
    electionId: c.electionId,
    ridingId: c.ridingId,
    partyId: c.partyId,
    politicianId: c.candidateId,
    chunkIndex: 0,
    date: dateIso,
    politicianName: pol?.name,
    partyNameEn: party?.nameEn,
    partyNameFr: party?.nameFr,
    ridingNameEn: riding?.nameEn,
    ridingNameFr: riding?.nameFr,
    province: riding?.province,
  };

  return [
    {
      content: [
        `Candidacy: ${pol?.name ?? c.candidateId}`,
        party ? `Party: ${party.nameEn}` : undefined,
        riding ? `Riding: ${riding.nameEn}, ${riding.province}` : undefined,
        dateIso ? `Election Date: ${dateIso}` : undefined,
        c.votepercent != null ? `Vote %: ${c.votepercent}` : undefined,
        c.votetotal != null ? `Votes: ${c.votetotal}` : undefined,
        c.elected != null ? `Elected: ${c.elected ? "Yes" : "No"}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en" },
    },
    {
      content: [
        `Candidature: ${pol?.name ?? c.candidateId}`,
        party ? `Parti: ${party.nameFr}` : undefined,
        riding
          ? `Circonscription: ${riding.nameFr}, ${riding.province}`
          : undefined,
        dateIso ? `Date de l'élection: ${dateIso}` : undefined,
        c.votepercent != null
          ? `Pourcentage de votes: ${c.votepercent}`
          : undefined,
        c.votetotal != null ? `Votes: ${c.votetotal}` : undefined,
        c.elected != null ? `Élu(e): ${c.elected ? "Oui" : "Non"}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr" },
    },
  ];
}

function sessionRowToChunks(s: SessionRow): ChunkInput[] {
  const dStart = formatDateISO(s.start);
  const dEnd = formatDateISO(s.end);
  const baseMeta = {
    sourceType: "session" as const,
    sourceId: s.id,
    chunkIndex: 0,
    sessionName: s.name,
    parliamentnum: s.parliamentnum ?? undefined,
    sessnum: s.sessnum ?? undefined,
  };

  return [
    {
      content: [
        `Session ${s.id} – ${s.name}`,
        dStart && `Start: ${dStart}`,
        dEnd && `End: ${dEnd}`,
        s.parliamentnum && `Parliament: ${s.parliamentnum}`,
        s.sessnum && `Session #: ${s.sessnum}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "en" },
    },
    {
      content: [
        `Session ${s.id} – ${s.name}`,
        dStart && `Début: ${dStart}`,
        dEnd && `Fin: ${dEnd}`,
        s.parliamentnum && `Législature: ${s.parliamentnum}`,
        s.sessnum && `Session n°: ${s.sessnum}`,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { ...baseMeta, language: "fr" },
    },
  ];
}

function ridingRowToChunks(r: RidingRow): ChunkInput[] {
  const baseMeta = {
    sourceType: "riding" as const,
    sourceId: r.id,
    chunkIndex: 0,
    ridingNameEn: r.nameEn,
    ridingNameFr: r.nameFr,
    province: r.province,
    edid: r.edid ?? undefined,
  };

  return [
    {
      content: [
        `Riding: ${r.nameEn}`,
        `Province: ${r.province}`,
        r.edid != null ? `EDID: ${r.edid}` : undefined,
        `Current: ${r.current ? "Yes" : "No"}`,
      ].join("\n"),
      metadata: { ...baseMeta, language: "en", title: r.nameEn },
    },
    {
      content: [
        `Circonscription: ${r.nameFr}`,
        `Province: ${r.province}`,
        r.edid != null ? `Code EDID: ${r.edid}` : undefined,
        `Actuelle: ${r.current ? "Oui" : "Non"}`,
      ].join("\n"),
      metadata: { ...baseMeta, language: "fr", title: r.nameFr },
    },
  ];
}

// Processor functions using generic batched processor
async function processCommittees(): Promise<void> {
  await processBatched<CommitteeRow>({
    label: "Committees",
    sourceType: "committee",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(committeesCommittee)
        .where(
          startAfterId !== null
            ? gt(committeesCommittee.id, startAfterId)
            : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(committeesCommittee)
        .where(
          startAfterId !== null
            ? gt(committeesCommittee.id, startAfterId)
            : undefined
        )
        .orderBy(committeesCommittee.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: committeeRowToChunks,
  });
}

async function processCommitteeReports(): Promise<void> {
  await processBatched<CommitteeReportWithCommittee>({
    label: "Committee reports",
    sourceType: "committee_report",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(
          eq(committeesCommitteereport.sessionId, sessionFilter)
        );
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(committeesCommitteereport.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(committeesCommitteereport)
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(
          eq(committeesCommitteereport.sessionId, sessionFilter)
        );
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(committeesCommitteereport.id, startAfterId));
      }

      return db
        .select({
          report: committeesCommitteereport,
          committee: committeesCommittee,
        })
        .from(committeesCommitteereport)
        .leftJoin(
          committeesCommittee,
          eq(committeesCommitteereport.committeeId, committeesCommittee.id)
        )
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(committeesCommitteereport.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.report.id,
    rowToChunks: committeeReportRowToChunks,
  });
}

async function processCommitteeMeetings(): Promise<void> {
  await processBatched<CommitteeMeetingWithCommittee>({
    label: "Committee meetings",
    sourceType: "committee_meeting",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(
          eq(committeesCommitteemeeting.sessionId, sessionFilter)
        );
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(committeesCommitteemeeting.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(committeesCommitteemeeting)
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(
          eq(committeesCommitteemeeting.sessionId, sessionFilter)
        );
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(committeesCommitteemeeting.id, startAfterId));
      }

      return db
        .select({
          meeting: committeesCommitteemeeting,
          committee: committeesCommittee,
        })
        .from(committeesCommitteemeeting)
        .leftJoin(
          committeesCommittee,
          eq(committeesCommitteemeeting.committeeId, committeesCommittee.id)
        )
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(committeesCommitteemeeting.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.meeting.id,
    rowToChunks: committeeMeetingRowToChunks,
  });
}

async function processVoteQuestions(): Promise<void> {
  const billNumMap = await getBillNumberMap();

  await processBatched<VoteQuestionRow>({
    label: "Vote questions",
    sourceType: "vote_question",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsVotequestion.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billsVotequestion)
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsVotequestion.id, startAfterId));
      }

      return db
        .select()
        .from(billsVotequestion)
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(billsVotequestion.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.id,
    rowToChunks: (row) => voteQuestionRowToChunks(row, billNumMap),
  });
}

async function processPartyVotes(): Promise<void> {
  // Use JOINs instead of loading entire lookup tables into memory
  // Session filter works through the vote_question's sessionId
  await processBatched<PartyVoteWithRelations>({
    label: "Party votes",
    sourceType: "vote_party",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsPartyvote.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billsPartyvote)
        .innerJoin(
          billsVotequestion,
          eq(billsPartyvote.votequestionId, billsVotequestion.id)
        )
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsPartyvote.id, startAfterId));
      }

      return db
        .select({
          vote: billsPartyvote,
          question: billsVotequestion,
          party: coreParty,
        })
        .from(billsPartyvote)
        .innerJoin(
          billsVotequestion,
          eq(billsPartyvote.votequestionId, billsVotequestion.id)
        )
        .innerJoin(coreParty, eq(billsPartyvote.partyId, coreParty.id))
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(billsPartyvote.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.vote.id,
    rowToChunks: partyVoteRowToChunks,
  });
}

async function processMemberVotes(): Promise<void> {
  // Use JOINs instead of loading entire lookup tables into memory
  // Session filter works through the vote_question's sessionId
  await processBatched<MemberVoteWithRelations>({
    label: "Member votes",
    sourceType: "vote_member",
    getCount: async (startAfterId) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsMembervote.id, startAfterId));
      }

      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(billsMembervote)
        .innerJoin(
          billsVotequestion,
          eq(billsMembervote.votequestionId, billsVotequestion.id)
        )
        .where(
          whereConditions.length > 0 ? and(...whereConditions) : undefined
        );
      return count;
    },
    fetchBatch: (startAfterId, batchLimit) => {
      const whereConditions: SQL[] = [];
      if (sessionFilter) {
        whereConditions.push(eq(billsVotequestion.sessionId, sessionFilter));
      }
      if (startAfterId !== null) {
        whereConditions.push(gt(billsMembervote.id, startAfterId));
      }

      return db
        .select({
          vote: billsMembervote,
          question: billsVotequestion,
          politician: corePolitician,
        })
        .from(billsMembervote)
        .innerJoin(
          billsVotequestion,
          eq(billsMembervote.votequestionId, billsVotequestion.id)
        )
        .innerJoin(
          corePolitician,
          eq(billsMembervote.politicianId, corePolitician.id)
        )
        .where(whereConditions.length > 0 ? and(...whereConditions) : undefined)
        .orderBy(billsMembervote.id)
        .limit(batchLimit);
    },
    getRowId: (row) => row.vote.id,
    rowToChunks: memberVoteRowToChunks,
  });
}

async function processPoliticians(): Promise<void> {
  await processBatched<PoliticianRow>({
    label: "Politicians",
    sourceType: "politician",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(corePolitician)
        .where(
          startAfterId !== null
            ? gt(corePolitician.id, startAfterId)
            : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(corePolitician)
        .where(
          startAfterId !== null
            ? gt(corePolitician.id, startAfterId)
            : undefined
        )
        .orderBy(corePolitician.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: politicianRowToChunks,
  });
}

async function processParties(): Promise<void> {
  await processBatched<PartyRow>({
    label: "Parties",
    sourceType: "party",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(coreParty)
        .where(
          startAfterId !== null ? gt(coreParty.id, startAfterId) : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(coreParty)
        .where(
          startAfterId !== null ? gt(coreParty.id, startAfterId) : undefined
        )
        .orderBy(coreParty.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: partyRowToChunks,
  });
}

async function processElections(): Promise<void> {
  await processBatched<ElectionRow>({
    label: "Elections",
    sourceType: "election",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(electionsElection)
        .where(
          startAfterId !== null
            ? gt(electionsElection.id, startAfterId)
            : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(electionsElection)
        .where(
          startAfterId !== null
            ? gt(electionsElection.id, startAfterId)
            : undefined
        )
        .orderBy(electionsElection.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: electionRowToChunks,
  });
}

async function processCandidacies(): Promise<void> {
  // Use JOINs instead of loading entire lookup tables into memory
  await processBatched<CandidacyWithRelations>({
    label: "Candidacies",
    sourceType: "candidacy",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(electionsCandidacy)
        .where(
          startAfterId !== null
            ? gt(electionsCandidacy.id, startAfterId)
            : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select({
          candidacy: electionsCandidacy,
          politician: corePolitician,
          party: coreParty,
          riding: coreRiding,
          election: electionsElection,
        })
        .from(electionsCandidacy)
        .leftJoin(
          corePolitician,
          eq(electionsCandidacy.candidateId, corePolitician.id)
        )
        .leftJoin(coreParty, eq(electionsCandidacy.partyId, coreParty.id))
        .leftJoin(coreRiding, eq(electionsCandidacy.ridingId, coreRiding.id))
        .leftJoin(
          electionsElection,
          eq(electionsCandidacy.electionId, electionsElection.id)
        )
        .where(
          startAfterId !== null
            ? gt(electionsCandidacy.id, startAfterId)
            : undefined
        )
        .orderBy(electionsCandidacy.id)
        .limit(batchLimit),
    getRowId: (row) => row.candidacy.id,
    rowToChunks: candidacyRowToChunks,
  });
}

async function processSessions(): Promise<void> {
  // Sessions have string IDs (like "45-1"), but string comparison still works
  // for cursor-based pagination since IDs are lexicographically ordered
  await processBatched<SessionRow, string>({
    label: "Sessions",
    sourceType: "session",
    hasNumericIds: false, // Sessions have string IDs
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(coreSession)
        .where(
          startAfterId !== null ? gt(coreSession.id, startAfterId) : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(coreSession)
        .where(
          startAfterId !== null ? gt(coreSession.id, startAfterId) : undefined
        )
        .orderBy(coreSession.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: sessionRowToChunks,
  });
}

async function processRidings(): Promise<void> {
  await processBatched<RidingRow>({
    label: "Ridings",
    sourceType: "riding",
    getCount: async (startAfterId) => {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(coreRiding)
        .where(
          startAfterId !== null ? gt(coreRiding.id, startAfterId) : undefined
        );
      return count;
    },
    fetchBatch: async (startAfterId, batchLimit) =>
      db
        .select()
        .from(coreRiding)
        .where(
          startAfterId !== null ? gt(coreRiding.id, startAfterId) : undefined
        )
        .orderBy(coreRiding.id)
        .limit(batchLimit),
    getRowId: (row) => row.id,
    rowToChunks: ridingRowToChunks,
  });
}

const PROCESSOR_DEPENDENCIES: Record<SourceTypeKey, SourceTypeKey[]> = {
  bills: [],
  hansard: [],
  committees: [],
  committee_reports: [],
  committee_meetings: [],
  vote_questions: [],
  party_votes: ["vote_questions"],
  member_votes: ["vote_questions"],
  politicians: [],
  parties: [],
  elections: [],
  candidacies: ["politicians", "parties", "ridings", "elections"],
  sessions: [],
  ridings: [],
};

/**
 * Check if selected types have missing dependencies and warn the user.
 * This doesn't prevent execution but warns about potential inconsistent coverage.
 */
function warnMissingDependencies(selected: SourceTypeKey[]): void {
  const selectedSet = new Set(selected);
  const warnings: string[] = [];

  for (const type of selected) {
    const deps = PROCESSOR_DEPENDENCIES[type] ?? [];
    const missingDeps = deps.filter((d) => !selectedSet.has(d));
    if (missingDeps.length > 0) {
      warnings.push(
        `   ⚠️  ${type} depends on [${missingDeps.join(", ")}] which are not selected`
      );
    }
  }

  if (warnings.length > 0) {
    console.warn("\n⚠️  Missing dependencies detected:");
    for (const w of warnings) {
      console.warn(w);
    }
    console.warn(
      "   RAG coverage may be inconsistent. Consider including dependencies.\n"
    );
  }
}

function buildDependencyPhases(selected: SourceTypeKey[]): SourceTypeKey[][] {
  // Warn about missing dependencies before building phases
  warnMissingDependencies(selected);

  const remaining = new Set<SourceTypeKey>(selected);
  const phases: SourceTypeKey[][] = [];

  while (remaining.size > 0) {
    const phase: SourceTypeKey[] = [];
    for (const type of ALL_TYPES) {
      if (!remaining.has(type)) {
        continue;
      }
      const deps = PROCESSOR_DEPENDENCIES[type] ?? [];
      const hasUnresolvedDeps = deps.some((d) => remaining.has(d));
      if (!hasUnresolvedDeps) {
        phase.push(type);
      }
    }

    if (phase.length === 0) {
      throw new Error(
        `Dependency cycle detected among selected types: ${[...remaining].join(
          ", "
        )}`
      );
    }

    for (const type of phase) {
      remaining.delete(type);
    }
    phases.push(phase);
  }

  return phases;
}

// ---------- Main ----------
async function main() {
  try {
    console.log("\n🏛️  Embedding Generator (bilingual)\n");
    if (dryRun) {
      console.log("🔍 DRY-RUN MODE - No changes will be made\n");
    }
    console.log(`Types: ${selectedTypes.join(", ")}`);
    console.log(`Session filter: ${sessionFilter ?? "none"}`);
    console.log(`Limit: ${limit ?? "none"}`);
    console.log(`Skip existing: ${skipExisting ? "yes" : "no"}`);
    console.log(`Dry run: ${dryRun ? "yes" : "no"}`);
    console.log(`Drop tables: ${dropTables ? "yes" : "no"}`);
    console.log(`Empty tables: ${emptyTables ? "yes" : "no"}`);
    console.log(`Sync progress: ${syncProgress ? "yes" : "no"}`);
    console.log(`Clear progress: ${clearProgress ? "yes" : "no"}`);
    console.log(
      `Progress cache: ${progressTracker.totalCount().toLocaleString()} items in ${PROGRESS_DB_PATH}\n`
    );
    // Validate COHERE_API_KEY format
    const cohereKey = process.env.COHERE_API_KEY;
    if (!cohereKey && !dryRun) {
      console.warn(
        "⚠️  COHERE_API_KEY not set: embedding calls will fail or hang."
      );
    } else if (cohereKey && !dryRun) {
      // Basic format validation to catch common issues
      // Cohere API keys are typically 40+ characters without spaces
      if (cohereKey.length < 30) {
        console.warn(
          `⚠️  COHERE_API_KEY appears truncated (${cohereKey.length} chars). Expected 40+ characters.`
        );
      } else if (cohereKey.includes(" ") || cohereKey.includes("\n")) {
        console.warn(
          "⚠️  COHERE_API_KEY contains whitespace. Check for copy-paste errors."
        );
      } else if (
        cohereKey.startsWith("sk-") ||
        cohereKey.startsWith("key-") ||
        cohereKey === "your-api-key-here"
      ) {
        console.warn(
          "⚠️  COHERE_API_KEY looks like a placeholder. Set a real API key."
        );
      }
    }

    if (dropTables) {
      await dropTablesWithConfirmation();
      await connection.end();
      return;
    }
    if (emptyTables) {
      await emptyTablesWithConfirmation();
      await connection.end();
      return;
    }
    if (clearProgress) {
      await clearProgressWithConfirmation();
      await connection.end();
      return;
    }
    if (syncProgress) {
      console.log("\n📥 Syncing progress from Postgres...\n");
      await syncProgressFromPostgres();
      console.log(
        `\n✅ Progress synced: ${progressTracker.totalCount().toLocaleString()} items now cached\n`
      );
      await connection.end();
      return;
    }

    // Map of type to processor function
    const processors: Record<SourceTypeKey, () => Promise<void>> = {
      bills: processBills,
      hansard: processHansard,
      committees: processCommittees,
      committee_reports: processCommitteeReports,
      committee_meetings: processCommitteeMeetings,
      vote_questions: processVoteQuestions,
      party_votes: processPartyVotes,
      member_votes: processMemberVotes,
      politicians: processPoliticians,
      parties: processParties,
      elections: processElections,
      candidacies: processCandidacies,
      sessions: processSessions,
      ridings: processRidings,
    };

    const dependencyOrder = buildDependencyPhases(selectedTypes);

    // Process each phase; keep types within a phase sequential for deterministic logging.
    for (const phase of dependencyOrder) {
      const typesInPhase = phase.filter((t) =>
        selectedTypes.includes(t)
      ) as SourceTypeKey[];
      if (typesInPhase.length === 0) {
        continue;
      }

      // Run processors sequentially for predictable progress reporting;
      // per-type embedding calls already use parallelism internally.
      for (const t of typesInPhase) {
        if (isShuttingDown) {
          console.log("   ⏸️  Shutdown requested, stopping...");
          break;
        }
        await processors[t]();
      }
    }

    if (dryRun) {
      console.log(
        "\n🔍 DRY-RUN COMPLETE - No changes were made to the database\n"
      );
      console.log("Run without --dry-run to actually generate embeddings.");
    } else {
      console.log("\n✨ Generation complete!\n");
      console.log(
        `Progress cache: ${progressTracker.totalCount().toLocaleString()} items tracked`
      );
    }
  } catch (err) {
    console.error("\n❌ Fatal error:", err);
    process.exit(1);
  } finally {
    progressTracker.close();
    await connection.end();
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
