/**
 * Regenerate content_html for all legislation sections
 *
 * This script re-parses the original XML files and regenerates the contentHtml
 * field using the updated extractHtmlContent() function, then updates the
 * database without changing any IDs (preserving RAG embedding references).
 *
 * Usage:
 *   pnpm db:leg:regen-html [options]
 *
 * Options:
 *   --dry-run       Parse files but don't update database
 *   --limit=N       Process only N files (for testing)
 *   --type=act|regulation  Process only acts or regulations
 *   --ids=ID1,ID2   Process specific document IDs
 *   --verbose       Show detailed output
 */

import { config } from "dotenv";

config({ path: ".env.local" });

import postgres from "postgres";
import {
  getLegislationFiles,
  normalizeRegulationId,
  parseLegislationXml,
} from "@/lib/legislation/parser";
import type { LegislationType, ParsedSection } from "@/lib/legislation/types";

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error("POSTGRES_URL environment variable is required");
}

const client = postgres(connectionString, { max: 10, debug: false });

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const verbose = args.includes("--verbose");
const limit = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const typeArg = args.find((a) => a.startsWith("--type="))?.split("=")[1] as
  | LegislationType
  | undefined;
const idsArg = args.find((a) => a.startsWith("--ids="))?.split("=")[1];
const specificIds = idsArg ? idsArg.split(",").map((id) => id.trim()) : null;

const BASE_PATH = "./data/legislation";
const UPDATE_BATCH_SIZE = 500;

type Stats = {
  filesProcessed: number;
  filesFailed: number;
  sectionsUpdated: number;
  sectionsSkipped: number;
  sectionsNotFound: number;
  sectionsExpected: number;
};

const stats: Stats = {
  filesProcessed: 0,
  filesFailed: 0,
  sectionsUpdated: 0,
  sectionsSkipped: 0,
  sectionsNotFound: 0,
  sectionsExpected: 0,
};

function log(message: string) {
  console.log(`[regen] ${message}`);
}

function logVerbose(message: string) {
  if (verbose) {
    console.log(`  ${message}`);
  }
}

/**
 * Update contentHtml for sections from a parsed document.
 * Uses batched updates within a transaction for atomicity and performance.
 */
async function updateSectionsFromDocument(
  parsedSections: ParsedSection[]
): Promise<void> {
  if (parsedSections.length === 0) {
    return;
  }

  // Collect all updates
  const updates: { canonicalSectionId: string; contentHtml: string }[] = [];

  for (const section of parsedSections) {
    if (!section.contentHtml) {
      stats.sectionsSkipped++;
      continue;
    }

    updates.push({
      canonicalSectionId: section.canonicalSectionId,
      contentHtml: section.contentHtml,
    });
  }

  if (updates.length === 0) {
    return;
  }

  stats.sectionsExpected += updates.length;

  if (dryRun) {
    logVerbose(`[DRY RUN] Would update ${updates.length} sections`);
    stats.sectionsUpdated += updates.length;
    return;
  }

  // Process in batches within a transaction
  await client.begin(async (tx) => {
    for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
      const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);

      const ids = batch.map((u) => u.canonicalSectionId);
      const htmls = batch.map((u) => u.contentHtml);

      const result = await tx`
        UPDATE legislation.sections AS s
        SET content_html = data.content_html
        FROM unnest(${ids}::text[], ${htmls}::text[]) AS data(canonical_section_id, content_html)
        WHERE s.canonical_section_id = data.canonical_section_id
      `;

      stats.sectionsUpdated += result.count;

      // Track sections not found (canonicalSectionId mismatch)
      if (result.count < batch.length) {
        const missing = batch.length - result.count;
        stats.sectionsNotFound += missing;
        logVerbose(
          `  Warning: ${missing} sections not found in database (canonicalSectionId mismatch)`
        );
      }

      if (verbose && batch.length > 50) {
        logVerbose(
          `  Batch ${Math.floor(i / UPDATE_BATCH_SIZE) + 1}: updated ${result.count} sections`
        );
      }
    }
  });
}

/**
 * Filter files by specific IDs
 */
function filterByIds(
  files: {
    path: string;
    type: LegislationType;
    language: "en" | "fr";
    id: string;
  }[],
  ids: string[]
): {
  path: string;
  type: LegislationType;
  language: "en" | "fr";
  id: string;
}[] {
  return files.filter((file) => {
    const normalizedFileId =
      file.type === "regulation" ? normalizeRegulationId(file.id) : file.id;

    return ids.some((id) => {
      const normalizedId =
        file.type === "regulation" ? normalizeRegulationId(id) : id;
      return normalizedFileId === normalizedId || file.id === id;
    });
  });
}

async function main() {
  log("Regenerating content_html for legislation sections");
  log(
    `Options: dry-run=${dryRun}, limit=${limit || "none"}, type=${typeArg || "all"}, ids=${specificIds ? specificIds.length : "none"}`
  );

  let files: {
    path: string;
    type: LegislationType;
    language: "en" | "fr";
    id: string;
  }[];

  if (specificIds) {
    const allFiles = getLegislationFiles(BASE_PATH, typeArg, undefined);
    files = filterByIds(allFiles, specificIds);
    log(`Filtering by ${specificIds.length} specific IDs`);
  } else {
    files = getLegislationFiles(
      BASE_PATH,
      typeArg,
      limit ? Number.parseInt(limit, 10) : undefined
    );
  }

  log(`Found ${files.length} files to process`);

  const startTime = Date.now();

  for (const file of files) {
    try {
      logVerbose(`Processing: ${file.path}`);

      const doc = parseLegislationXml(file.path, file.language);
      await updateSectionsFromDocument(doc.sections);

      stats.filesProcessed++;

      if (stats.filesProcessed % 50 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        log(
          `Processed ${stats.filesProcessed}/${files.length} files (${stats.sectionsUpdated} sections updated) [${elapsed}s]`
        );
      }
    } catch (error) {
      stats.filesFailed++;
      log(
        `ERROR processing ${file.path}: ${error instanceof Error ? error.message : String(error)}`
      );
      if (verbose && error instanceof Error) {
        console.error(error.stack);
      }
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  log("");
  log("=== Regeneration Complete ===");
  log(`Files processed: ${stats.filesProcessed}`);
  log(`Files failed: ${stats.filesFailed}`);
  log(`Sections expected: ${stats.sectionsExpected}`);
  log(`Sections updated: ${stats.sectionsUpdated}`);
  log(`Sections skipped (no HTML): ${stats.sectionsSkipped}`);
  log(`Sections not found in DB: ${stats.sectionsNotFound}`);
  log(`Total time: ${totalTime}s`);

  // Warn prominently if there's a mismatch
  if (stats.sectionsNotFound > 0) {
    log("");
    log(
      `WARNING: ${stats.sectionsNotFound} sections from XML were not found in database.`
    );
    log(
      "This may indicate a schema drift or that the database needs to be re-imported."
    );
    log("Run with --verbose to see which batches had mismatches.");
  }

  await client.end();
  process.exit(stats.filesFailed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
