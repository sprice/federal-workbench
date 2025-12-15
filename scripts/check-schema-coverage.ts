/**
 * Schema Coverage Report Script
 *
 * Compares our content-tree.ts handlers against the official
 * XSLT (LIMS2HTML.xsl) and DTD (regulation_web.dtd) schemas.
 *
 * Usage: npx tsx scripts/check-schema-coverage.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data/legislation");
const LIB_DIR = join(process.cwd(), "lib/legislation/utils");

// Regex patterns at module level
const XSLT_TEMPLATE_REGEX = /<xsl:template\s+match="([^"]+)"/g;
const ELEMENT_NAME_REGEX = /^([A-Za-z][A-Za-z0-9_-]*)/;
const DTD_ELEMENT_REGEX = /<!ELEMENT\s+([A-Za-z][A-Za-z0-9_-]*)/g;

// Patterns to find tag handling in code
const TAG_EQUALS_REGEX = /tag === "([A-Za-z][A-Za-z0-9_-]*)"/g;
const CASE_REGEX = /case "([A-Za-z][A-Za-z0-9_-]*)"/g;
const OBJ_PROPERTY_REGEX = /\bo\.([A-Z][A-Za-z]+)\b/g;
const OBJ_BRACKET_REGEX = /obj\["([A-Z][A-Za-z]+)"\]/g;
const KEY_EQUALS_REGEX = /key === "([A-Z][A-Za-z]+)"/g;

/**
 * Elements handled via specialized extraction functions rather than
 * generic tag processing. These are intentional architectural decisions.
 */
const SPECIALIZED_HANDLERS: Record<string, string> = {
  TitleText:
    "Extracted via extractTitleText(), extractTitleTextFromPreserved(), and heading.ts utilities",
  Footnote: "Extracted via extractFootnotes() as FootnoteInfo[] metadata",
  HistoricalNote:
    "Extracted via extractHistoricalNotes() as HistoricalNoteInfo[]",
  Ins: "Change tracking - content passed through, marker not preserved",
  Del: "Change tracking - content passed through, marker not preserved",
};

/**
 * Extract all xsl:template match="..." patterns from XSLT
 */
function extractXsltTemplates(xsltPath: string): Set<string> {
  const content = readFileSync(xsltPath, "utf-8");
  const templates = new Set<string>();

  const templateRegex = new RegExp(XSLT_TEMPLATE_REGEX.source, "g");
  let match = templateRegex.exec(content);

  while (match !== null) {
    const matchAttr = match[1];
    const elements = matchAttr.split("|").map((e) => e.trim());

    for (const element of elements) {
      const elementMatch = element.match(ELEMENT_NAME_REGEX);
      if (elementMatch) {
        templates.add(elementMatch[1]);
      }
    }
    match = templateRegex.exec(content);
  }

  return templates;
}

/**
 * Extract all <!ELEMENT ...> definitions from DTD
 */
function extractDtdElements(dtdPath: string): Set<string> {
  const content = readFileSync(dtdPath, "utf-8");
  const elements = new Set<string>();

  const elementRegex = new RegExp(DTD_ELEMENT_REGEX.source, "g");
  let match = elementRegex.exec(content);

  while (match !== null) {
    elements.add(match[1]);
    match = elementRegex.exec(content);
  }

  return elements;
}

/**
 * Extract all handled tags from a TypeScript file using multiple patterns
 */
function extractHandledTags(filePath: string): Set<string> {
  const content = readFileSync(filePath, "utf-8");
  const handlers = new Set<string>();

  // Pattern 1: tag === "ElementName"
  const tagEqualsRegex = new RegExp(TAG_EQUALS_REGEX.source, "g");
  let match = tagEqualsRegex.exec(content);
  while (match !== null) {
    handlers.add(match[1]);
    match = tagEqualsRegex.exec(content);
  }

  // Pattern 2: case "ElementName":
  const caseRegex = new RegExp(CASE_REGEX.source, "g");
  match = caseRegex.exec(content);
  while (match !== null) {
    handlers.add(match[1]);
    match = caseRegex.exec(content);
  }

  // Pattern 3: o.ElementName (property access on parsed XML)
  const objPropRegex = new RegExp(OBJ_PROPERTY_REGEX.source, "g");
  match = objPropRegex.exec(content);
  while (match !== null) {
    // Filter out common non-element properties
    const prop = match[1];
    if (
      ![
        "Array",
        "Object",
        "String",
        "Number",
        "Boolean",
        "Set",
        "Map",
      ].includes(prop)
    ) {
      handlers.add(prop);
    }
    match = objPropRegex.exec(content);
  }

  // Pattern 4: obj["ElementName"] (bracket access)
  const objBracketRegex = new RegExp(OBJ_BRACKET_REGEX.source, "g");
  match = objBracketRegex.exec(content);
  while (match !== null) {
    handlers.add(match[1]);
    match = objBracketRegex.exec(content);
  }

  // Pattern 5: key === "ElementName"
  const keyEqualsRegex = new RegExp(KEY_EQUALS_REGEX.source, "g");
  match = keyEqualsRegex.exec(content);
  while (match !== null) {
    handlers.add(match[1]);
    match = keyEqualsRegex.exec(content);
  }

  return handlers;
}

/**
 * Categorize elements by type
 */
const ELEMENT_CATEGORIES: Record<string, string[]> = {
  "Schedule Containers": [
    "BillPiece",
    "RegulationPiece",
    "DocumentInternal",
    "Group",
    "SectionPiece",
    "RelatedOrNotInForce",
    "Order",
    "Recommendation",
    "Notice",
    "ConventionAgreementTreaty",
  ],
  "Structure Elements": [
    "Section",
    "Subsection",
    "Paragraph",
    "Subparagraph",
    "Clause",
    "Subclause",
    "Provision",
    "Definition",
    "Item",
    "List",
  ],
  "Content Elements": [
    "Text",
    "Label",
    "MarginalNote",
    "Heading",
    "TitleText",
    "Emphasis",
    "XRefExternal",
    "XRefInternal",
    "DefinedTermEn",
    "DefinedTermFr",
    "FootnoteRef",
    "Footnote",
  ],
  "Table Elements": [
    "TableGroup",
    "Table",
    "table",
    "tgroup",
    "thead",
    "tbody",
    "row",
    "entry",
    "colspec",
  ],
  "Formula Elements": [
    "Formula",
    "FormulaGroup",
    "FormulaText",
    "FormulaTerm",
    "FormulaDefinition",
    "FormulaParagraph",
  ],
  "Image Elements": ["ImageGroup", "Image", "Caption"],
  "Bilingual Elements": [
    "BilingualGroup",
    "BilingualItemEn",
    "BilingualItemFr",
  ],
  "Special Content": [
    "SignatureBlock",
    "Reserved",
    "ExplanatoryNote",
    "AmendedText",
    "ReadAsText",
    "QuotedText",
    "HistoricalNote",
  ],
  "Change Tracking": ["Ins", "Del", "Off", "Alt"],
};

function main() {
  console.log("=== XSLT/DTD Schema Coverage Report ===\n");

  // Load schemas
  const xsltPath = join(DATA_DIR, "xslt/LIMS2HTML.xsl");
  const dtdPath = join(DATA_DIR, "regulation_web.dtd");

  console.log("Loading schemas...");
  const xsltTemplates = extractXsltTemplates(xsltPath);
  const dtdElements = extractDtdElements(dtdPath);

  console.log(`  XSLT templates: ${xsltTemplates.size}`);
  console.log(`  DTD elements: ${dtdElements.size}`);

  // Scan all utility files for handlers
  const utilFiles = [
    "content-tree.ts",
    "sections.ts",
    "schedules.ts",
    "document-metadata.ts",
    "treaties.ts",
    "heading.ts",
    "text.ts",
  ];

  const allHandlers = new Set<string>();
  for (const file of utilFiles) {
    const filePath = join(LIB_DIR, file);
    try {
      const handlers = extractHandledTags(filePath);
      for (const h of handlers) {
        allHandlers.add(h);
      }
    } catch {
      // File may not exist
    }
  }

  // Add specialized handlers
  for (const element of Object.keys(SPECIALIZED_HANDLERS)) {
    allHandlers.add(element);
  }

  console.log(`  Handlers found across utils: ${allHandlers.size}`);
  console.log();

  // Combined schema elements
  const allSchemaElements = new Set([...xsltTemplates, ...dtdElements]);

  // Report by category
  let totalInSchema = 0;
  let totalHandled = 0;
  const gaps: string[] = [];

  for (const [category, elements] of Object.entries(ELEMENT_CATEGORIES)) {
    console.log(`--- ${category} ---`);

    for (const element of elements) {
      const inXslt = xsltTemplates.has(element);
      const inDtd = dtdElements.has(element);
      const inSchema = inXslt || inDtd;
      const handled = allHandlers.has(element);
      const specializedNote = SPECIALIZED_HANDLERS[element];

      if (inSchema) {
        totalInSchema++;
        if (handled) {
          totalHandled++;
          if (specializedNote) {
            console.log(`  ✓ ${element} (specialized: ${specializedNote})`);
          } else {
            console.log(`  ✓ ${element}`);
          }
        } else {
          gaps.push(element);
          const sources: string[] = [];
          if (inXslt) {
            sources.push("XSLT");
          }
          if (inDtd) {
            sources.push("DTD");
          }
          console.log(`  ✗ ${element} (MISSING - in ${sources.join(", ")})`);
        }
      } else if (handled) {
        // Not in schema, but we handle it anyway
        console.log(`  ○ ${element} (handled, not in schemas)`);
      }
    }
    console.log();
  }

  // Elements in schema but not categorized
  const categorizedElements = new Set(Object.values(ELEMENT_CATEGORIES).flat());
  const uncategorized = [...allSchemaElements].filter(
    (e) => !categorizedElements.has(e)
  );

  if (uncategorized.length > 0) {
    console.log("--- Uncategorized Schema Elements ---");
    for (const element of uncategorized.slice(0, 30)) {
      const handled = allHandlers.has(element);
      console.log(`  ${handled ? "✓" : "○"} ${element}`);
    }
    if (uncategorized.length > 30) {
      console.log(`  ... and ${uncategorized.length - 30} more`);
    }
    console.log();
  }

  // Summary
  console.log("=== Summary ===");
  console.log(`Categorized elements in schema: ${totalInSchema}`);
  console.log(`Categorized elements handled: ${totalHandled}`);
  console.log(
    `Coverage: ${((totalHandled / totalInSchema) * 100).toFixed(1)}%`
  );
  console.log();

  if (gaps.length > 0) {
    console.log("=== Gaps to Fix ===");
    for (const gap of gaps) {
      console.log(`  - ${gap}`);
    }
  } else {
    console.log("No gaps found in categorized elements!");
  }

  // Exit code based on critical gaps
  const criticalGaps = gaps.filter((g) =>
    ELEMENT_CATEGORIES["Schedule Containers"].includes(g)
  );
  if (criticalGaps.length > 0) {
    console.log(`\n⚠️  ${criticalGaps.length} critical gap(s) found`);
    process.exit(1);
  }
}

main();
