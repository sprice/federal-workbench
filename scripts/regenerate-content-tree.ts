/**
 * Regenerate content_tree for all legislation sections
 *
 * This script re-parses the original XML files with preserveOrder=true
 * and regenerates the contentTree JSONB field, then updates the
 * database without changing any IDs (preserving RAG embedding references).
 *
 * Usage:
 *   pnpm db:leg:regen-tree [options]
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
import type { ContentNode, LegislationType } from "@/lib/legislation/types";
import { extractContentTreesFromFile } from "@/lib/legislation/utils/content-tree";

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
  sectionsNotFound: number;
  sectionsExpected: number;
  sectionsNoMatch: number;
};

const stats: Stats = {
  filesProcessed: 0,
  filesFailed: 0,
  sectionsUpdated: 0,
  sectionsNotFound: 0,
  sectionsExpected: 0,
  sectionsNoMatch: 0,
};

function log(message: string) {
  console.log(`[regen-tree] ${message}`);
}

function logVerbose(message: string) {
  if (verbose) {
    console.log(`  ${message}`);
  }
}

/**
 * Update contentTree for sections from a file.
 * Uses batched updates within a transaction for atomicity and performance.
 */
async function updateContentTreeFromFile(
  filePath: string,
  language: "en" | "fr"
): Promise<void> {
  // Step 1: Parse with main parser to get canonicalSectionIds
  const doc = parseLegislationXml(filePath, language);
  const parsedSections = doc.sections;

  if (parsedSections.length === 0) {
    logVerbose("  No sections found in file");
    return;
  }

  // Step 2: Extract content trees with preserveOrder parser
  const contentTrees = extractContentTreesFromFile(filePath);

  if (contentTrees.length === 0) {
    logVerbose("  No content trees extracted from file");
  }

  // Step 3: Build maps for joining - limsId (primary) and sectionLabel (fallback)
  type ContentData = { contentTree: ContentNode[]; hierarchyPath: string[] };
  const idToData = new Map<string, ContentData>();
  const labelToData = new Map<string, ContentData>();

  for (const {
    sectionLabel,
    contentTree,
    hierarchyPath,
    limsId,
  } of contentTrees) {
    const data = { contentTree, hierarchyPath };
    // Primary join key: limsId (deterministic, order-independent)
    if (limsId && !idToData.has(limsId)) {
      idToData.set(limsId, data);
    }
    // Fallback join key: sectionLabel
    if (labelToData.has(sectionLabel)) {
      logVerbose(`  Duplicate label dropped: ${sectionLabel}`);
    } else {
      labelToData.set(sectionLabel, data);
    }
  }

  // Step 4: Join by limsId (preferred) or sectionLabel (fallback)
  const updates: {
    canonicalSectionId: string;
    contentTree: ContentNode[];
    hierarchyPath: string[];
  }[] = [];

  for (const section of parsedSections) {
    // Try limsId first (from main parser's limsMetadata.id)
    const limsId = section.limsMetadata?.id;
    let data = limsId ? idToData.get(limsId) : undefined;

    // Fall back to sectionLabel
    if (!data) {
      data = labelToData.get(section.sectionLabel);
    }

    if (!data || data.contentTree.length === 0) {
      stats.sectionsNoMatch++;
      logVerbose(
        `  No content tree match for section: ${section.sectionLabel} (limsId: ${limsId || "none"})`
      );
      continue;
    }

    updates.push({
      canonicalSectionId: section.canonicalSectionId,
      contentTree: data.contentTree,
      hierarchyPath: data.hierarchyPath,
    });
  }

  if (updates.length === 0) {
    logVerbose(
      `  No updates generated (${parsedSections.length} sections, ${labelToData.size} trees)`
    );
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
      const trees = batch.map((u) => JSON.stringify(u.contentTree));
      const paths = batch.map((u) => JSON.stringify(u.hierarchyPath));

      const result = await tx`
        UPDATE legislation.sections AS s
        SET
          content_tree = data.content_tree::jsonb,
          hierarchy_path = data.hierarchy_path::jsonb
        FROM unnest(${ids}::text[], ${trees}::text[], ${paths}::text[]) AS data(canonical_section_id, content_tree, hierarchy_path)
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
  log("Regenerating content_tree for legislation sections");
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

      await updateContentTreeFromFile(file.path, file.language);

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
  log(`Sections no label match: ${stats.sectionsNoMatch}`);
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

  if (stats.sectionsNoMatch > 0) {
    log("");
    log(
      `NOTE: ${stats.sectionsNoMatch} sections had no content tree match by label.`
    );
    log(
      "This can happen for headings, stubs, or sections without content elements."
    );
  }

  await client.end();
  process.exit(stats.filesFailed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
