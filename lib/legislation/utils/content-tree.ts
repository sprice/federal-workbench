/**
 * Content tree extraction for legislation XML.
 *
 * This module parses XML files with `preserveOrder=true` to extract
 * an ordered content tree that preserves document order. This is essential
 * for mixed content like:
 *   <Text>This Act may be cited as the <XRefExternal>Accessible Canada Act</XRefExternal>.</Text>
 *
 * The standard parser uses `preserveOrder=false` which loses the order of
 * text vs child elements. This module provides order-preserving extraction.
 *
 * IMPORTANT: The sectionLabel values produced here MUST match exactly what
 * the main parser (sections.ts, schedules.ts) produces, since that's the join key.
 */

import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type { ContentNode } from "../types";

/**
 * Parser that preserves document order - essential for mixed content.
 * This is different from the main parser which uses preserveOrder=false.
 */
const preserveOrderParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  preserveOrder: true,
  trimValues: false,
  textNodeName: "#text",
});

/**
 * Parsed XML data from preserveOrder parser.
 * This is an opaque type - callers should not inspect the structure directly.
 */
export type PreservedOrderData = unknown[];

/**
 * Parse an XML file with preserveOrder=true.
 * Call this once per file, then pass the result to extraction functions.
 *
 * This avoids re-parsing the same file multiple times when extracting
 * different content types (sections, definitions, preambles, treaties).
 */
export function parseFileWithPreservedOrder(
  filePath: string
): PreservedOrderData {
  const xmlContent = readFileSync(filePath, "utf-8");
  return preserveOrderParser.parse(xmlContent);
}

// =============================================================================
// COMBINED EXTRACTION (Single Tree Walk)
// =============================================================================

/**
 * Result from combined extraction - all content types in one pass.
 * This is much faster than calling individual extraction functions.
 */
export type ExtractedContent = {
  contentTrees: SectionContentTree[];
  sectionContents: SectionContent[];
  definitionTexts: DefinitionText[];
  preamble: PreambleProvisionText[] | undefined;
  treaties: TreatyContentText[] | undefined;
};

/**
 * Context for combined extraction walk - bundles all mutable state.
 */
type ExtractionContext = {
  result: ExtractedContent;
  state: ParserState;
  preambleProvisions: PreambleProvisionText[];
  treatyContents: TreatyContentText[];
};

/**
 * Detect document language from root element (Statute/Regulation) xml:lang attribute.
 * Returns "en" if not found or not recognized.
 */
function detectDocumentLanguage(parsed: PreservedOrderData): "en" | "fr" {
  if (!Array.isArray(parsed)) {
    return "en";
  }

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    // Check for root elements (Statute for acts, Regulation for regulations)
    if (tag === "Statute" || tag === "Regulation") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const lang = attrs?.["@_xml:lang"] as string | undefined;
      if (lang?.toLowerCase().startsWith("fr")) {
        return "fr";
      }
      return "en";
    }

    // Recurse into container elements
    const value = obj[tag];
    if (Array.isArray(value)) {
      const nested = detectDocumentLanguage(value);
      if (nested !== "en") {
        return nested;
      }
    }
  }

  return "en";
}

/**
 * Extract all content types from pre-parsed XML data in a single tree walk.
 * This is ~5x faster than calling individual extraction functions.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractAllContent(
  parsed: PreservedOrderData
): ExtractedContent {
  const language = detectDocumentLanguage(parsed);
  const ctx: ExtractionContext = {
    result: {
      contentTrees: [],
      sectionContents: [],
      definitionTexts: [],
      preamble: undefined,
      treaties: undefined,
    },
    state: { globalSectionOrder: 0, currentHierarchy: [], language },
    preambleProvisions: [],
    treatyContents: [],
  };

  walkForAllContent(parsed, ctx);

  if (ctx.preambleProvisions.length > 0) {
    ctx.result.preamble = ctx.preambleProvisions;
  }
  if (ctx.treatyContents.length > 0) {
    ctx.result.treaties = ctx.treatyContents;
  }

  return ctx.result;
}

/**
 * Combined tree walk that extracts all content types simultaneously.
 */
function walkForAllContent(items: unknown[], ctx: ExtractionContext): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];
    const attrs = obj[":@"] as Record<string, unknown> | undefined;

    // Handle Heading elements - update hierarchy and add as searchable content
    if (tag === "Heading") {
      updateHierarchyFromHeading(children, attrs, ctx.state);
      // Also add to content trees for searchability
      const contentChildren = convertPreservedToContentTree(children);
      const headingNode = convertTagToNode(tag, contentChildren, attrs || {});
      if (headingNode) {
        const headingLabel = ctx.state.currentHierarchy.at(-1) || "Heading";
        ctx.result.contentTrees.push({
          sectionLabel: headingLabel,
          contentTree: [headingNode],
          hierarchyPath: [...ctx.state.currentHierarchy],
          limsId: null,
        });
      }
      continue;
    }

    // Handle Preamble
    if (tag === "Preamble") {
      extractPreambleProvisions(children, ctx.preambleProvisions);
      continue;
    }

    // Handle Treaties (multiple tag names used in legislation XML)
    if (
      tag === "TreatyAgreement" ||
      tag === "Convention" ||
      tag === "Agreement" ||
      tag === "ConventionAgreementTreaty"
    ) {
      const treaty = extractTreatyContent(children);
      if (treaty) {
        ctx.treatyContents.push(treaty);
      }
      continue;
    }

    // Handle Definition elements
    if (tag === "Definition") {
      const limsId = attrs?.["@_lims:id"] as string | undefined;
      if (limsId) {
        const definitionText = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();
        if (definitionText) {
          ctx.result.definitionTexts.push({ limsId, definitionText });
        }
      }
      continue;
    }

    // Handle Enacts element (enacting clause)
    if (tag === "Enacts") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;

      // Content tree
      const contentChildren = filterContentChildren(children);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        ctx.result.contentTrees.push({
          sectionLabel: "Enacting Clause",
          contentTree,
          hierarchyPath: [...ctx.state.currentHierarchy],
          limsId,
        });
      }

      // Section content (plain text)
      if (limsId) {
        const content = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          ctx.result.sectionContents.push({ limsId, content });
        }
      }
      continue;
    }

    // Handle Schedule elements
    if (tag === "Schedule") {
      extractScheduleContentCombined(children, ctx.result, ctx.state);
      // Only look for treaties and definitions within schedules
      // (don't re-process Section/Provision - already handled by walkScheduleItemsCombined)
      walkScheduleForTreatiesAndDefinitions(children, ctx);
      continue;
    }

    // Handle Section elements
    if (tag === "Section") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      const label = extractLabelFromPreserved(children);

      if (label) {
        ctx.state.globalSectionOrder++;

        // Content tree
        const contentChildren = filterContentChildren(children);
        const contentTree = convertPreservedToContentTree(contentChildren);
        if (contentTree.length > 0) {
          ctx.result.contentTrees.push({
            sectionLabel: label,
            contentTree,
            hierarchyPath: [...ctx.state.currentHierarchy],
            limsId,
          });
        }

        // Section content (plain text)
        if (limsId) {
          const content = extractTextFromPreserved(children)
            .replace(/\s+/g, " ")
            .trim();
          if (content) {
            ctx.result.sectionContents.push({ limsId, content });
          }
        }
      }

      // Recurse to find nested definitions
      walkForAllContent(children, ctx);
      continue;
    }

    // Handle Provision elements (in Order blocks - regulations)
    if (tag === "Provision") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      ctx.state.globalSectionOrder++;

      const label = extractLabelFromPreserved(children);
      const provLabel = label || `order-${ctx.state.globalSectionOrder}`;

      // Content tree
      const contentChildren = filterContentChildren(children);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        ctx.result.contentTrees.push({
          sectionLabel: provLabel,
          contentTree,
          hierarchyPath: [...ctx.state.currentHierarchy],
          limsId,
        });
      }

      // Section content (plain text)
      if (limsId) {
        const content = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          ctx.result.sectionContents.push({ limsId, content });
        }
      }

      // Recurse to find nested definitions
      walkForAllContent(children, ctx);
      continue;
    }

    // Recurse into container elements
    if (children.length > 0) {
      walkForAllContent(children, ctx);
    }
  }
}

/**
 * Walk schedule children looking ONLY for treaties and definitions.
 * This avoids re-processing Section/Provision which are already handled
 * by walkScheduleItemsCombined.
 */
function walkScheduleForTreatiesAndDefinitions(
  items: unknown[],
  ctx: ExtractionContext
): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];
    const attrs = obj[":@"] as Record<string, unknown> | undefined;

    // Handle Treaties within schedules (multiple tag names used in legislation XML)
    if (
      tag === "TreatyAgreement" ||
      tag === "Convention" ||
      tag === "Agreement" ||
      tag === "ConventionAgreementTreaty"
    ) {
      const treaty = extractTreatyContent(children);
      if (treaty) {
        ctx.treatyContents.push(treaty);
      }
      continue;
    }

    // Handle Definition elements within schedules
    if (tag === "Definition") {
      const limsId = attrs?.["@_lims:id"] as string | undefined;
      if (limsId) {
        const definitionText = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();
        if (definitionText) {
          ctx.result.definitionTexts.push({ limsId, definitionText });
        }
      }
      continue;
    }

    // Recurse into container elements (but skip Section/Provision/Item which are already handled)
    if (
      children.length > 0 &&
      tag !== "Section" &&
      tag !== "Provision" &&
      tag !== "Item" &&
      tag !== "FormGroup" &&
      tag !== "TableGroup"
    ) {
      walkScheduleForTreatiesAndDefinitions(children, ctx);
    }
  }
}

/**
 * Extract schedule content for combined walk.
 */
function extractScheduleContentCombined(
  scheduleChildren: unknown[],
  result: ExtractedContent,
  state: ParserState
): void {
  // Get schedule label (may be null for schedules without ScheduleFormHeading)
  // Use language-appropriate fallback: "Schedule" (en) or "Annexe" (fr)
  const fallbackLabel = state.language === "fr" ? "Annexe" : "Schedule";
  const scheduleLabel = extractScheduleLabel(scheduleChildren) ?? fallbackLabel;

  // Process all schedule item types
  walkScheduleItemsCombined(scheduleChildren, scheduleLabel, result, state);
}

/**
 * Walk schedule items and extract both content trees and section content.
 */
function walkScheduleItemsCombined(
  children: unknown[],
  scheduleLabel: string,
  result: ExtractedContent,
  state: ParserState
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];
    const attrs = obj[":@"] as Record<string, unknown> | undefined;

    if (tag === "Item") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      state.globalSectionOrder++;
      const itemLabel = extractLabelFromPreserved(tagChildren);
      const sectionLabel = itemLabel
        ? `${scheduleLabel} Item ${itemLabel}`
        : `${scheduleLabel} Item ${state.globalSectionOrder}`;

      // Content tree
      const contentChildren = filterContentChildren(tagChildren);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        result.contentTrees.push({
          sectionLabel,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      // Section content
      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          result.sectionContents.push({ limsId, content });
        }
      }

      // Recurse for nested items
      walkScheduleItemsCombined(tagChildren, scheduleLabel, result, state);
    } else if (tag === "FormGroup") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      state.globalSectionOrder++;

      const contentTree = convertPreservedToContentTree(tagChildren);
      if (contentTree.length > 0) {
        result.contentTrees.push({
          sectionLabel: `${scheduleLabel} Form`,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          result.sectionContents.push({ limsId, content });
        }
      }
    } else if (tag === "TableGroup") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      state.globalSectionOrder++;

      const contentTree = convertPreservedToContentTree(tagChildren);
      if (contentTree.length > 0) {
        result.contentTrees.push({
          sectionLabel: `${scheduleLabel} Table`,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          result.sectionContents.push({ limsId, content });
        }
      }
    } else if (tag === "Provision") {
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      state.globalSectionOrder++;
      const provLabel = extractLabelFromPreserved(tagChildren);
      const sectionLabel = provLabel
        ? `${scheduleLabel} ${provLabel}`.trim()
        : `${scheduleLabel} Provision ${state.globalSectionOrder}`.trim();

      const contentChildren = filterContentChildren(tagChildren);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        result.contentTrees.push({
          sectionLabel,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          result.sectionContents.push({ limsId, content });
        }
      }
    } else if (tag === "Section") {
      // Sections within schedules (e.g., in BillPiece containers)
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      state.globalSectionOrder++;
      const sectionLabelText = extractLabelFromPreserved(tagChildren);
      const sectionLabelFull = sectionLabelText
        ? `${scheduleLabel} ${sectionLabelText}`.trim()
        : `${scheduleLabel} Section ${state.globalSectionOrder}`.trim();

      const contentChildren = filterContentChildren(tagChildren);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        result.contentTrees.push({
          sectionLabel: sectionLabelFull,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
        if (content) {
          result.sectionContents.push({ limsId, content });
        }
      }
    } else if (
      tag === "List" ||
      tag === "DocumentInternal" ||
      tag === "Group" ||
      tag === "BillPiece" ||
      tag === "RegulationPiece" ||
      tag === "RelatedOrNotInForce"
    ) {
      // Container elements - recurse into them (per LIMS2HTML.xsl patterns)
      walkScheduleItemsCombined(tagChildren, scheduleLabel, result, state);
    }
  }
}

/**
 * Result from content tree extraction for a single section.
 */
export type SectionContentTree = {
  sectionLabel: string;
  contentTree: ContentNode[];
  hierarchyPath: string[];
  /** Justice Canada's unique element ID (lims:id attribute). Used as primary join key. */
  limsId: string | null;
};

/**
 * State for tracking position during parsing.
 *
 * The globalSectionOrder counter is used for fallback labels when elements don't have
 * explicit Label children (e.g., "Schedule I Item 157"). The primary join key is limsId
 * (Justice Canada's unique element ID), which is deterministic and order-independent.
 * The counter-based sectionLabel is only used as a fallback for rare elements without limsId.
 */
type ParserState = {
  /**
   * Global section order that matches the main parser's sectionOrder.
   * Increments for ALL section types in document order.
   */
  globalSectionOrder: number;
  /**
   * Current hierarchy path (Part, Division, etc).
   * Updated when Heading elements are encountered.
   */
  currentHierarchy: string[];
  /**
   * Document language from xml:lang attribute on root element.
   * Used for language-appropriate fallback labels (e.g., "Schedule" vs "Annexe").
   */
  language: "en" | "fr";
};

/**
 * Extract content trees for all sections from pre-parsed XML data.
 * Returns an array of { sectionLabel, contentTree } for joining with
 * the main parser's canonicalSectionId.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractContentTrees(
  parsed: PreservedOrderData
): SectionContentTree[] {
  const results: SectionContentTree[] = [];
  const language = detectDocumentLanguage(parsed);
  const state: ParserState = {
    globalSectionOrder: 0,
    currentHierarchy: [],
    language,
  };

  // Walk the preserved structure to find sections
  walkPreservedStructure(parsed, results, state);

  return results;
}

/**
 * Walk preserved-order structure to find Section, Schedule, Provision, and Enacts elements.
 * Adds results directly to the results array.
 */
function walkPreservedStructure(
  items: unknown[],
  results: SectionContentTree[],
  state: ParserState
): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];

    // Handle Heading elements - update hierarchy and add as searchable content
    if (tag === "Heading") {
      // Pass attributes from parent object - level is on the Heading element itself
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      updateHierarchyFromHeading(children, attrs, state);
      // Also add to results for searchability
      const contentChildren = convertPreservedToContentTree(children);
      const headingNode = convertTagToNode(tag, contentChildren, attrs || {});
      if (headingNode) {
        const headingLabel = state.currentHierarchy.at(-1) || "Heading";
        results.push({
          sectionLabel: headingLabel,
          contentTree: [headingNode],
          hierarchyPath: [...state.currentHierarchy],
          limsId: null,
        });
      }
      continue;
    }

    // Handle Enacts element (enacting clause)
    if (tag === "Enacts") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      const contentChildren = filterContentChildren(children);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        results.push({
          sectionLabel: "Enacting Clause",
          contentTree,
          hierarchyPath: [...state.currentHierarchy],
          limsId,
        });
      }
      continue;
    }

    // Handle Schedule elements - extract individual items, not whole schedule
    if (tag === "Schedule") {
      extractScheduleContent(children, results, state);
      // Don't recurse - schedule content is handled by extractScheduleContent
      continue;
    }

    // Handle Section elements (main sections with numbered labels)
    if (tag === "Section") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      const label = extractLabelFromPreserved(children);
      if (label) {
        // Increment counter for fallback labels (used when limsId is unavailable)
        state.globalSectionOrder++;

        const contentChildren = filterContentChildren(children);
        const contentTree = convertPreservedToContentTree(contentChildren);
        if (contentTree.length > 0) {
          results.push({
            sectionLabel: label,
            contentTree,
            hierarchyPath: [...state.currentHierarchy],
            limsId,
          });
        }
      }
      // Don't recurse into sections - their content is already captured
      continue;
    }

    // Handle Provision elements (in Order blocks - regulations)
    // Main parser (sections.ts) labels these as "order-{sectionOrder}"
    if (tag === "Provision") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      // Increment counter for fallback labels (used when limsId is unavailable)
      state.globalSectionOrder++;

      const label = extractLabelFromPreserved(children);
      // Match main parser's fallback label format: "order-{sectionOrder}"
      const provLabel = label || `order-${state.globalSectionOrder}`;

      const contentChildren = filterContentChildren(children);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        results.push({
          sectionLabel: provLabel,
          contentTree,
          hierarchyPath: [...state.currentHierarchy],
          limsId,
        });
      }
      continue;
    }

    // Recurse into container elements (Body, Introduction, Preamble, etc.)
    if (children.length > 0) {
      walkPreservedStructure(children, results, state);
    }
  }
}

/**
 * Update hierarchy from a Heading element.
 * Headings have @level attribute that determines their depth in the hierarchy.
 * Level 1 = Part, Level 2 = Division, etc.
 *
 * With preserveOrder=true, the level attribute is on the Heading element itself
 * (passed via headingAttrs), while Label/TitleText are in headingChildren.
 */
function updateHierarchyFromHeading(
  headingChildren: unknown[],
  headingAttrs: Record<string, unknown> | undefined,
  state: ParserState
): void {
  // Extract level from the Heading element's attributes (not from children)
  let level = 1;
  if (headingAttrs?.["@_level"]) {
    level = Number.parseInt(String(headingAttrs["@_level"]), 10) || 1;
  }

  // Extract Label and TitleText from children
  let labelText = "";
  let titleText = "";

  for (const child of headingChildren) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];

    if (tag === "Label") {
      labelText = extractTextFromPreserved(value);
    } else if (tag === "TitleText") {
      titleText = extractTextFromPreserved(value);
    }
  }

  // Build heading text
  const headingText = [labelText, titleText].filter(Boolean).join(" ");

  // Adjust hierarchy based on level
  // Pop entries until we're at the right level (level 1 clears all, level 2 keeps level 1, etc.)
  while (state.currentHierarchy.length >= level) {
    state.currentHierarchy.pop();
  }

  // Push this heading
  if (headingText) {
    state.currentHierarchy.push(headingText);
  }
}

/**
 * Extract text content from a preserveOrder structure.
 * Used for extracting Label/TitleText from Heading elements.
 * Recursively descends into child elements.
 */
function extractTextFromPreserved(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return "";
  }

  let text = "";
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    // Handle both string and numeric text values (fast-xml-parser parses "1" as number 1)
    if (obj["#text"] !== undefined) {
      text += String(obj["#text"]);
    }
    // Recurse into child elements
    for (const key of Object.keys(obj)) {
      if (key !== ":@" && key !== "#text") {
        const children = obj[key];
        if (Array.isArray(children)) {
          text += extractTextFromPreserved(children);
        }
      }
    }
  }
  return text.trim();
}

/**
 * Extract content from a Schedule element into individual sections.
 * Matches the labeling logic from schedules.ts:
 * - List/Item → "${scheduleLabel} Item ${itemLabel}"
 * - FormGroup → "${scheduleLabel} Form"
 * - TableGroup → "${scheduleLabel} Table"
 * - DocumentInternal/Provision → "${scheduleLabel} ${groupPath} ${provLabel}"
 */
function extractScheduleContent(
  scheduleChildren: unknown[],
  results: SectionContentTree[],
  state: ParserState
): void {
  // Get schedule label (may be null for schedules without ScheduleFormHeading)
  // Use language-appropriate fallback: "Schedule" (en) or "Annexe" (fr)
  const fallbackLabel = state.language === "fr" ? "Annexe" : "Schedule";
  const scheduleLabel = extractScheduleLabel(scheduleChildren) ?? fallbackLabel;

  // Process List elements (schedule items)
  extractScheduleListItems(scheduleChildren, scheduleLabel, results, state);

  // Process FormGroup elements
  extractScheduleFormGroups(scheduleChildren, scheduleLabel, results, state);

  // Process TableGroup elements
  extractScheduleTableGroups(scheduleChildren, scheduleLabel, results, state);

  // Process DocumentInternal elements (treaties, agreements with nested provisions)
  extractScheduleDocumentInternal(
    scheduleChildren,
    scheduleLabel,
    results,
    state
  );
}

/**
 * Extract List/Item elements from schedule.
 * Creates sections with labels like "Schedule I Item 1" or "Schedule I Item (a)".
 */
function extractScheduleListItems(
  children: unknown[],
  scheduleLabel: string,
  results: SectionContentTree[],
  state: ParserState
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "List") {
      // Process items in this list
      processListItems(tagChildren, scheduleLabel, results, state);
    }
  }
}

/**
 * Process Item elements within a List.
 */
function processListItems(
  listChildren: unknown[],
  scheduleLabel: string,
  results: SectionContentTree[],
  state: ParserState
): void {
  for (const child of listChildren) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Item") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      // Increment counter for fallback labels (used when limsId is unavailable)
      state.globalSectionOrder++;
      const itemLabel = extractLabelFromPreserved(tagChildren);

      // Match schedules.ts labeling: "${scheduleLabel} Item ${itemLabel}" or "${scheduleLabel} Item ${sectionOrder}"
      const sectionLabel = itemLabel
        ? `${scheduleLabel} Item ${itemLabel}`
        : `${scheduleLabel} Item ${state.globalSectionOrder}`;

      const contentChildren = filterContentChildren(tagChildren);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        results.push({
          sectionLabel,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }

      // Process nested lists within this item
      for (const itemChild of tagChildren) {
        if (!itemChild || typeof itemChild !== "object") {
          continue;
        }
        const itemChildObj = itemChild as Record<string, unknown>;
        const itemChildKeys = Object.keys(itemChildObj).filter(
          (k) => k !== ":@"
        );
        if (itemChildKeys.length > 0 && itemChildKeys[0] === "List") {
          const nestedListChildren = Array.isArray(itemChildObj.List)
            ? itemChildObj.List
            : [];
          processListItems(nestedListChildren, scheduleLabel, results, state);
        }
      }
    }
  }
}

/**
 * Extract FormGroup elements from schedule.
 * Creates sections with label "${scheduleLabel} Form".
 */
function extractScheduleFormGroups(
  children: unknown[],
  scheduleLabel: string,
  results: SectionContentTree[],
  state: ParserState
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "FormGroup") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      // Increment counter for fallback labels (used when limsId is unavailable)
      state.globalSectionOrder++;
      const contentTree = convertPreservedToContentTree(tagChildren);
      if (contentTree.length > 0) {
        results.push({
          sectionLabel: `${scheduleLabel} Form`,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }
    }
  }
}

/**
 * Extract TableGroup elements from schedule.
 * Creates sections with label "${scheduleLabel} Table".
 */
function extractScheduleTableGroups(
  children: unknown[],
  scheduleLabel: string,
  results: SectionContentTree[],
  state: ParserState
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "TableGroup") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      // Increment counter for fallback labels (used when limsId is unavailable)
      state.globalSectionOrder++;
      const contentTree = convertPreservedToContentTree(tagChildren);
      if (contentTree.length > 0) {
        results.push({
          sectionLabel: `${scheduleLabel} Table`,
          contentTree,
          hierarchyPath: [scheduleLabel],
          limsId,
        });
      }
    }
  }
}

/**
 * Extract DocumentInternal/Provision elements from schedule.
 * Creates sections with labels like "${scheduleLabel} Article 1" or "${scheduleLabel} PART I Section 2".
 */
function extractScheduleDocumentInternal(
  children: unknown[],
  scheduleLabel: string,
  results: SectionContentTree[],
  state: ParserState
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "DocumentInternal") {
      // Process provisions within DocumentInternal, building group path
      processDocumentInternalContent({
        children: tagChildren,
        scheduleLabel,
        groupPath: [],
        results,
        state,
      });
    }
  }
}

type DocumentInternalContext = {
  children: unknown[];
  scheduleLabel: string;
  groupPath: string[];
  results: SectionContentTree[];
  state: ParserState;
};

/**
 * Process content within DocumentInternal, tracking group hierarchy for labels.
 */
function processDocumentInternalContent(ctx: DocumentInternalContext): void {
  const { children, scheduleLabel, groupPath, results, state } = ctx;
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Provision") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = (attrs?.["@_lims:id"] as string) || null;
      // Increment counter for fallback labels (used when limsId is unavailable)
      state.globalSectionOrder++;
      const provLabel = extractLabelFromPreserved(tagChildren);

      // Match schedules.ts labeling: "${scheduleLabel} ${groupPath} ${provLabel}"
      const pathStr = groupPath.join(" ");
      const sectionLabel = provLabel
        ? `${scheduleLabel} ${pathStr} ${provLabel}`.trim()
        : `${scheduleLabel} ${pathStr} Provision ${state.globalSectionOrder}`.trim();

      const contentChildren = filterContentChildren(tagChildren);
      const contentTree = convertPreservedToContentTree(contentChildren);
      if (contentTree.length > 0) {
        // Build hierarchy: schedule label + group path
        const hierarchyPath = [scheduleLabel, ...groupPath].filter(Boolean);
        results.push({ sectionLabel, contentTree, hierarchyPath, limsId });
      }
    } else if (tag === "Group") {
      // Extract group heading for hierarchy path
      const groupHeading = extractGroupHeading(tagChildren);
      const newPath = groupHeading ? [...groupPath, groupHeading] : groupPath;
      processDocumentInternalContent({
        children: tagChildren,
        scheduleLabel,
        groupPath: newPath,
        results,
        state,
      });
    } else if (tagChildren.length > 0) {
      // Recurse into other container elements
      processDocumentInternalContent({
        children: tagChildren,
        scheduleLabel,
        groupPath,
        results,
        state,
      });
    }
  }
}

/**
 * Extract group heading text from Group element's GroupHeading child.
 * Returns combined Label and TitleText.
 */
function extractGroupHeading(groupChildren: unknown[]): string | null {
  for (const child of groupChildren) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "GroupHeading") {
      const label = extractLabelFromPreserved(tagChildren);
      const title = extractTitleTextFromPreserved(tagChildren);
      const heading = [label, title].filter(Boolean).join(" ");
      return heading || null;
    }
  }
  return null;
}

/**
 * Extract TitleText content from preserved-order children.
 */
function extractTitleTextFromPreserved(children: unknown[]): string | null {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];

    if (tag === "TitleText") {
      const tagChildren = Array.isArray(value) ? value : [];
      return extractTextFromPreserved(tagChildren);
    }
  }
  return null;
}

/**
 * Extract the label from a Schedule element.
 * Looks for <ScheduleFormHeading><Label>Schedule I</Label></ScheduleFormHeading>
 * or falls back to @id attribute.
 *
 * With preserveOrder=true, structure is:
 * [{ "ScheduleFormHeading": [...], ":@": {} }, { "Label": [...], ":@": {} }, ...]
 */
function extractScheduleLabel(children: unknown[]): string | null {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    // Check for ScheduleFormHeading - look for Label inside it
    if (tag === "ScheduleFormHeading") {
      const label = extractLabelFromPreserved(tagChildren);
      if (label) {
        return label;
      }
    }

    // Check for direct Label
    if (tag === "Label") {
      return extractTextFromPreserved(tagChildren);
    }
  }
  return null;
}

/**
 * Extract Label text from preserved-order children.
 *
 * With preserveOrder=true, structure is:
 * [{ "Label": [...], ":@": {} }, { "#text": "..." }, ...]
 */
function extractLabelFromPreserved(children: unknown[]): string | null {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];

    if (tag === "Label") {
      const tagChildren = Array.isArray(value) ? value : [];
      return extractTextFromPreserved(tagChildren);
    }
  }
  return null;
}

/**
 * Filter out metadata elements from section children.
 * Keep only content elements (Text, Subsection, Paragraph, Definition, etc.)
 */
function filterContentChildren(children: unknown[]): unknown[] {
  const skipTags = new Set([
    "Label",
    "MarginalNote",
    "HistoricalNote",
    "HistoricalNoteSubItem",
  ]);

  return children.filter((child) => {
    if (!child || typeof child !== "object") {
      return false;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      return false;
    }
    const tag = keys[0];
    return !skipTags.has(tag);
  });
}

/**
 * Serialize preserved-order XML structure back to XML string.
 * Used for MathML which needs to be preserved as raw XML for browser rendering.
 */
function serializePreservedToXml(items: unknown[]): string {
  let xml = "";

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const attrs = (obj[":@"] as Record<string, unknown>) || {};

    // Handle text nodes
    if (tag === "#text") {
      const textValue = typeof value === "string" ? value : String(value);
      // Escape XML special characters
      xml += textValue
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      continue;
    }

    // Build attributes string
    const attrStr = Object.entries(attrs)
      .filter(([k]) => k.startsWith("@_"))
      .map(([k, v]) => `${k.slice(2)}="${String(v)}"`)
      .join(" ");

    const children = Array.isArray(value) ? value : [];
    if (children.length === 0) {
      // Self-closing tag
      xml += attrStr ? `<${tag} ${attrStr}/>` : `<${tag}/>`;
    } else {
      // Tag with children
      xml += attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;
      xml += serializePreservedToXml(children);
      xml += `</${tag}>`;
    }
  }

  return xml;
}

/**
 * Convert fast-xml-parser's preserveOrder structure to ContentNode[].
 */
function convertPreservedToContentTree(items: unknown[]): ContentNode[] {
  const result: ContentNode[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const attrs = (obj[":@"] as Record<string, unknown>) || {};

    // Handle text nodes
    if (tag === "#text") {
      const textValue = typeof value === "string" ? value : String(value);
      if (textValue) {
        result.push({ type: "text", value: textValue });
      }
      continue;
    }

    // Handle MathML specially - serialize to raw XML for browser rendering
    if (tag === "math" || tag === "MathML") {
      const children = Array.isArray(value) ? value : [];
      const innerXml = serializePreservedToXml(children);
      const display = attrs["@_display"] as "block" | "inline" | undefined;
      // Always use <math> tag with MathML namespace for browser compatibility
      const displayAttr = display ? ` display="${display}"` : "";
      const raw = `<math xmlns="http://www.w3.org/1998/Math/MathML"${displayAttr}>${innerXml}</math>`;
      result.push({ type: "MathML", raw, display });
      continue;
    }

    // Get children recursively
    const children = Array.isArray(value)
      ? convertPreservedToContentTree(value)
      : [];

    // Convert to ContentNode based on tag
    const node = convertTagToNode(tag, children, attrs);
    if (node) {
      result.push(node);
    }
  }

  return result;
}

/**
 * Convert an XML tag to a ContentNode.
 */
function convertTagToNode(
  tag: string,
  children: ContentNode[],
  attrs: Record<string, unknown>
): ContentNode | null {
  switch (tag) {
    // Defined terms and references
    case "DefinedTermEn":
      return { type: "DefinedTermEn", children };
    case "DefinedTermFr":
      return { type: "DefinedTermFr", children };
    case "DefinitionRef":
      return { type: "DefinitionRef", children };

    // Cross-references
    case "XRefExternal":
      return {
        type: "XRefExternal",
        link: attrs["@_link"] as string | undefined,
        refType: attrs["@_reference-type"] as string | undefined,
        children,
      };
    case "XRefInternal":
      return {
        type: "XRefInternal",
        target: (attrs["@_target"] || attrs["@_idref"] || attrs["@_link"]) as
          | string
          | undefined,
        children,
      };

    // Text formatting
    case "Emphasis":
      return {
        type: "Emphasis",
        style: attrs["@_style"] as "italic" | "bold" | "smallcaps" | undefined,
        children,
      };
    case "Language":
      return {
        type: "Language",
        lang: attrs["@_xml:lang"] as string | undefined,
        children,
      };
    case "Repealed":
      return { type: "Repealed", children };
    case "FootnoteRef":
      return {
        type: "FootnoteRef",
        id: attrs["@_idref"] as string | undefined,
        children,
      };
    case "Sup":
      return { type: "Sup", children };
    case "Sub":
      return { type: "Sub", children };

    // Inline formatting elements (self-closing)
    case "LineBreak":
      return { type: "LineBreak" };
    case "PageBreak":
      return { type: "PageBreak" };
    case "FormBlank":
      return {
        type: "FormBlank",
        width: attrs["@_width"] as string | undefined,
      };
    case "Fraction":
      return { type: "Fraction", children };
    case "Leader":
      return {
        type: "Leader",
        style: attrs["@_leader-pattern"] as
          | "solid"
          | "dot"
          | "dash"
          | undefined,
      };
    case "Separator":
      return { type: "Separator" };

    // Structure elements
    case "Label":
      return { type: "Label", children };
    case "Text":
      return { type: "Text", children };
    case "Subsection":
      return { type: "Subsection", children };
    case "Paragraph":
      return { type: "Paragraph", children };
    case "Subparagraph":
      return { type: "Subparagraph", children };
    case "Clause":
      return { type: "Clause", children };
    case "Subclause":
      return { type: "Subclause", children };
    case "Definition":
      return { type: "Definition", children };
    case "Continued":
      return { type: "Continued", children };

    // Lists
    case "List":
      return {
        type: "List",
        style: attrs["@_style"] as string | undefined,
        children,
      };
    case "Item":
      return { type: "Item", children };

    // Tables (CALS)
    case "TableGroup":
      return { type: "TableGroup", children };
    case "table":
    case "Table":
      return {
        type: "Table",
        attrs: extractTableAttrs(attrs),
        children,
      };
    case "tgroup":
    case "TGroup":
      return {
        type: "TGroup",
        cols: attrs["@_cols"]
          ? Number.parseInt(attrs["@_cols"] as string, 10)
          : undefined,
        children,
      };
    case "colspec":
    case "ColSpec":
      return {
        type: "ColSpec",
        colName: attrs["@_colname"] as string | undefined,
        colWidth: attrs["@_colwidth"] as string | undefined,
      };
    case "thead":
    case "THead":
      return { type: "THead", children };
    case "tbody":
    case "TBody":
      return { type: "TBody", children };
    case "tfoot":
    case "TFoot":
      return { type: "TFoot", children };
    case "row":
    case "Row":
      return { type: "Row", children };
    case "entry":
    case "Entry":
      return {
        type: "Entry",
        attrs: extractEntryAttrs(attrs),
        children,
      };

    // Formulas
    case "FormulaGroup":
      return { type: "FormulaGroup", children };
    case "Formula":
      return { type: "Formula", children };
    case "FormulaText":
      return { type: "FormulaText", children };
    case "FormulaConnector":
      return { type: "FormulaConnector", children };
    case "FormulaDefinition":
      return { type: "FormulaDefinition", children };
    case "FormulaTerm":
      return { type: "FormulaTerm", children };
    case "FormulaParagraph":
      return { type: "FormulaParagraph", children };

    // Images
    case "ImageGroup":
      return { type: "ImageGroup", children };
    case "Image":
      return {
        type: "Image",
        source: attrs["@_source"] as string | undefined,
      };
    case "Caption":
      return { type: "Caption", children };

    // Bilingual content
    case "BilingualGroup":
      return { type: "BilingualGroup", children };
    case "BilingualItemEn":
      return { type: "BilingualItemEn", children };
    case "BilingualItemFr":
      return { type: "BilingualItemFr", children };

    // Special content
    case "QuotedText":
      return { type: "QuotedText", children };
    case "CenteredText":
      return { type: "CenteredText", children };
    case "FormGroup":
      return { type: "FormGroup", children };
    case "Oath":
      return { type: "Oath", children };
    case "ReadAsText":
      return { type: "ReadAsText", children };
    case "ScheduleFormHeading":
      return { type: "ScheduleFormHeading", children };
    case "Heading":
      return {
        type: "Heading",
        level: attrs["@_level"]
          ? Number.parseInt(attrs["@_level"] as string, 10)
          : undefined,
        children,
      };
    case "LeaderRightJustified":
      return { type: "LeaderRightJustified", children };

    // Skip metadata elements that are handled separately
    case "MarginalNote":
    case "HistoricalNote":
    case "HistoricalNoteSubItem":
      return null;

    default:
      // For unhandled elements, preserve with Unknown type (even if no children)
      return { type: "Unknown", tag, children };
  }
}

/**
 * Extract relevant table attributes.
 */
function extractTableAttrs(
  attrs: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (attrs["@_frame"]) {
    result.frame = String(attrs["@_frame"]);
  }
  if (attrs["@_pgwide"]) {
    result.pgwide = String(attrs["@_pgwide"]);
  }
  if (attrs["@_tabstyle"]) {
    result.tabstyle = String(attrs["@_tabstyle"]);
  }
  return result;
}

/**
 * Extract relevant entry (table cell) attributes.
 */
function extractEntryAttrs(
  attrs: Record<string, unknown>
): Record<string, string> {
  const result: Record<string, string> = {};
  if (attrs["@_colname"]) {
    result.colname = String(attrs["@_colname"]);
  }
  if (attrs["@_namest"]) {
    result.namest = String(attrs["@_namest"]);
  }
  if (attrs["@_nameend"]) {
    result.nameend = String(attrs["@_nameend"]);
  }
  if (attrs["@_morerows"]) {
    result.morerows = String(attrs["@_morerows"]);
  }
  if (attrs["@_align"]) {
    result.align = String(attrs["@_align"]);
  }
  if (attrs["@_valign"]) {
    result.valign = String(attrs["@_valign"]);
  }
  return result;
}

// =============================================================================
// DEFINITION TEXT EXTRACTION
// =============================================================================

/**
 * Result from definition text extraction.
 */
export type DefinitionText = {
  /** Justice Canada's unique element ID (lims:id attribute) */
  limsId: string;
  /** Full definition text with proper document order */
  definitionText: string;
};

/**
 * Extract definition text for all Definition elements from pre-parsed XML data.
 * Uses preserveOrder=true to maintain correct text order in mixed content.
 *
 * Returns definitions with their limsId for joining with database records.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractDefinitionTexts(
  parsed: PreservedOrderData
): DefinitionText[] {
  const results: DefinitionText[] = [];
  walkForDefinitions(parsed, results);

  return results;
}

/**
 * Walk preserved-order structure to find Definition elements and extract text.
 */
function walkForDefinitions(items: unknown[], results: DefinitionText[]): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];

    if (tag === "Definition") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        // Extract text from all children, preserving order
        const definitionText = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();

        if (definitionText) {
          results.push({ limsId, definitionText });
        }
      }
      // Don't recurse into Definition - its content is already captured
      continue;
    }

    // Recurse into container elements
    if (children.length > 0) {
      walkForDefinitions(children, results);
    }
  }
}

// =============================================================================
// SECTION CONTENT EXTRACTION
// =============================================================================

/**
 * Result from section content extraction.
 */
export type SectionContent = {
  /** Justice Canada's unique element ID (lims:id attribute) */
  limsId: string;
  /** Full section content as plain text with proper document order */
  content: string;
};

/**
 * Extract plain text content for all Section elements from pre-parsed XML data.
 * Uses preserveOrder=true to maintain correct text order in mixed content.
 *
 * Returns sections with their limsId for joining with database records.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractSectionContents(
  parsed: PreservedOrderData
): SectionContent[] {
  const results: SectionContent[] = [];
  walkForSectionContent(parsed, results);

  return results;
}

/**
 * Walk preserved-order structure to find Section/Provision elements and extract text.
 */
function walkForSectionContent(
  items: unknown[],
  results: SectionContent[]
): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];

    // Handle Section elements (acts)
    if (tag === "Section") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        // Extract text from all children, preserving order
        const content = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
      // Don't recurse into Section - its content is already captured
      continue;
    }

    // Handle Provision elements (regulations)
    if (tag === "Provision") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        const content = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
      continue;
    }

    // Handle Enacts element (enacting clause)
    if (tag === "Enacts") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        const content = extractTextFromPreserved(children)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
      continue;
    }

    // Handle Schedule elements - extract Item content
    if (tag === "Schedule") {
      walkScheduleForContent(children, results);
      continue;
    }

    // Recurse into container elements
    if (children.length > 0) {
      walkForSectionContent(children, results);
    }
  }
}

/**
 * Walk Schedule children to extract content from Items, FormGroups, TableGroups, etc.
 */
function walkScheduleForContent(
  children: unknown[],
  results: SectionContent[]
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Item") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
      // Process nested items
      walkScheduleForContent(tagChildren, results);
    } else if (tag === "FormGroup" || tag === "TableGroup") {
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
    } else if (tag === "Provision") {
      // DocumentInternal provisions
      const attrs = obj[":@"] as Record<string, unknown> | undefined;
      const limsId = attrs?.["@_lims:id"] as string | undefined;

      if (limsId) {
        const content = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();

        if (content) {
          results.push({ limsId, content });
        }
      }
    } else if (tagChildren.length > 0) {
      // Recurse into containers (List, DocumentInternal, Group, etc.)
      walkScheduleForContent(tagChildren, results);
    }
  }
}

// =============================================================================
// PREAMBLE TEXT EXTRACTION
// =============================================================================

/**
 * Preamble provision with corrected text order.
 */
export type PreambleProvisionText = {
  /** Full provision text with proper document order */
  text: string;
  /** Marginal note (plain text, not affected by order issues) */
  marginalNote?: string;
};

/**
 * Extract preamble provisions with correct text order from pre-parsed XML data.
 * Uses preserveOrder=true to maintain correct text order in mixed content.
 *
 * Returns preamble provisions for the document, or undefined if no preamble.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractPreamble(
  parsed: PreservedOrderData
): PreambleProvisionText[] | undefined {
  const results: PreambleProvisionText[] = [];
  walkForPreamble(parsed, results);

  return results.length > 0 ? results : undefined;
}

/**
 * Walk preserved-order structure to find Preamble and extract provision text.
 */
function walkForPreamble(
  items: unknown[],
  results: PreambleProvisionText[]
): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];

    if (tag === "Preamble") {
      // Found the Preamble element - extract its Provision children
      extractPreambleProvisions(children, results);
      return; // Only one preamble per document
    }

    // Recurse into container elements (Statute, Introduction, etc.)
    if (children.length > 0) {
      walkForPreamble(children, results);
    }
  }
}

/**
 * Extract text from Provision elements within a Preamble.
 */
function extractPreambleProvisions(
  children: unknown[],
  results: PreambleProvisionText[]
): void {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Provision") {
      // Extract text from this provision, excluding MarginalNote
      let marginalNote: string | undefined;
      const textParts: string[] = [];

      for (const provChild of tagChildren) {
        if (!provChild || typeof provChild !== "object") {
          continue;
        }
        const provObj = provChild as Record<string, unknown>;
        const provKeys = Object.keys(provObj).filter((k) => k !== ":@");
        if (provKeys.length === 0) {
          continue;
        }

        const provTag = provKeys[0];
        const provValue = provObj[provTag];
        const provChildren = Array.isArray(provValue) ? provValue : [];

        if (provTag === "MarginalNote") {
          // Extract marginal note text (plain text, order doesn't matter)
          marginalNote = extractTextFromPreserved(provChildren)
            .replace(/\s+/g, " ")
            .trim();
        } else if (provTag === "Text") {
          // Extract text content with preserved order
          const text = extractTextFromPreserved(provChildren)
            .replace(/\s+/g, " ")
            .trim();
          if (text) {
            textParts.push(text);
          }
        }
      }

      const fullText = textParts.join(" ").trim();
      if (fullText) {
        results.push({
          text: fullText,
          marginalNote: marginalNote || undefined,
        });
      }
    }
  }
}

// =============================================================================
// TREATY TEXT EXTRACTION
// =============================================================================

/**
 * Treaty definition with corrected text order.
 */
export type TreatyDefinitionText = {
  term: string;
  definition: string;
};

/**
 * Treaty content with corrected text order.
 * Matches the TreatyContent type from schema but with corrected text.
 */
export type TreatyContentText = {
  title?: string;
  text: string;
  definitions?: TreatyDefinitionText[];
};

/**
 * Extract treaty content with correct text order from pre-parsed XML data.
 * Uses preserveOrder=true to maintain correct text order in mixed content.
 *
 * Returns treaty content array for the document, or undefined if no treaties.
 *
 * @param parsed - Pre-parsed XML data from parseFileWithPreservedOrder()
 */
export function extractTreaties(
  parsed: PreservedOrderData
): TreatyContentText[] | undefined {
  const results: TreatyContentText[] = [];
  walkForTreaties(parsed, results);

  return results.length > 0 ? results : undefined;
}

/**
 * Walk preserved-order structure to find Treaty/Convention elements.
 */
function walkForTreaties(items: unknown[], results: TreatyContentText[]): void {
  if (!Array.isArray(items)) {
    return;
  }

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const children = Array.isArray(value) ? value : [];

    // Treaties can be nested in Schedule elements
    if (tag === "Schedule") {
      walkForTreaties(children, results);
      continue;
    }

    // Look for treaty-like content (multiple tag names used in legislation XML)
    if (
      tag === "TreatyAgreement" ||
      tag === "Convention" ||
      tag === "Agreement" ||
      tag === "ConventionAgreementTreaty"
    ) {
      const treaty = extractTreatyContent(children);
      if (treaty) {
        results.push(treaty);
      }
      continue;
    }

    // Recurse into container elements
    if (children.length > 0) {
      walkForTreaties(children, results);
    }
  }
}

/**
 * Extract content from a treaty/convention element.
 */
function extractTreatyContent(children: unknown[]): TreatyContentText | null {
  let title: string | undefined;
  const textParts: string[] = [];
  const definitions: TreatyDefinitionText[] = [];

  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Heading") {
      // Extract title from first heading
      if (!title) {
        title = extractTextFromPreserved(tagChildren)
          .replace(/\s+/g, " ")
          .trim();
      }
    } else if (tag === "Definition") {
      // Extract definition with preserved order
      const def = extractTreatyDefinition(tagChildren);
      if (def) {
        definitions.push(def);
      }
    } else if (tag === "Text" || tag === "Provision" || tag === "Article") {
      // Extract text content
      const text = extractTextFromPreserved(tagChildren)
        .replace(/\s+/g, " ")
        .trim();
      if (text) {
        textParts.push(text);
      }
    } else if (tagChildren.length > 0) {
      // Recurse to find nested content
      const nested = extractTreatyContent(tagChildren);
      if (nested) {
        if (!title && nested.title) {
          title = nested.title;
        }
        if (nested.text) {
          textParts.push(nested.text);
        }
        if (nested.definitions) {
          definitions.push(...nested.definitions);
        }
      }
    }
  }

  const fullText = textParts.join(" ").trim();
  if (!fullText && definitions.length === 0) {
    return null;
  }

  return {
    title,
    text: fullText,
    definitions: definitions.length > 0 ? definitions : undefined,
  };
}

/**
 * Extract a single treaty definition.
 */
function extractTreatyDefinition(
  children: unknown[]
): TreatyDefinitionText | null {
  let term = "";
  let definition = "";

  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const obj = child as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const tag = keys[0];
    const value = obj[tag];
    const tagChildren = Array.isArray(value) ? value : [];

    if (tag === "Text") {
      // Look for DefinedTermEn/Fr within Text
      for (const textChild of tagChildren) {
        if (!textChild || typeof textChild !== "object") {
          continue;
        }
        const textObj = textChild as Record<string, unknown>;
        const textKeys = Object.keys(textObj).filter((k) => k !== ":@");
        if (textKeys.length === 0) {
          continue;
        }

        const textTag = textKeys[0];
        const textValue = textObj[textTag];
        const textTagChildren = Array.isArray(textValue) ? textValue : [];

        if (textTag === "DefinedTermEn" || textTag === "DefinedTermFr") {
          term = extractTextFromPreserved(textTagChildren)
            .replace(/\s+/g, " ")
            .trim();
        }
      }

      // Full definition text
      definition = extractTextFromPreserved(tagChildren)
        .replace(/\s+/g, " ")
        .trim();
    }
  }

  if (!term || !definition) {
    return null;
  }

  return { term, definition };
}
