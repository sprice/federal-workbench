/**
 * Text extraction and HTML helpers for legislation XML content.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";

/**
 * Parser for HTML extraction with preserveOrder=true.
 * This preserves document order for mixed content (text interspersed with elements).
 */
const htmlPreserveOrderParser = new XMLParser({
  ignoreAttributes: false,
  preserveOrder: true,
  trimValues: false,
  // Don't use stopNodes - let everything be parsed normally for HTML
});

/**
 * Builder to serialize parsed objects back to XML.
 * Used to convert objects parsed with preserveOrder=false back to XML
 * so we can re-parse with preserveOrder=true.
 */
const xmlBuilder = new XMLBuilder({
  ignoreAttributes: false,
  preserveOrder: false,
  suppressEmptyNode: false,
  format: false,
});

/**
 * Extract text content from a complex XML element.
 * Collects all text parts and joins them with spaces, then normalizes whitespace.
 *
 * For elements parsed with stopNodes (like DefinedTermEn/Fr), the value will be
 * a raw XML string which is handled by stripping tags.
 */
export function extractTextContent(el: unknown): string {
  if (typeof el === "string") {
    // Check if this is raw XML from stopNodes (contains < and >)
    // This happens for DefinedTermEn/Fr which are parsed with stopNodes
    if (el.includes("<") && el.includes(">")) {
      // Strip XML tags and normalize whitespace - preserves document order!
      return el
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
    return el.trim();
  }
  if (typeof el === "number") {
    return String(el);
  }
  if (!el || typeof el !== "object") {
    return "";
  }

  const obj = el as Record<string, unknown>;
  const parts: string[] = [];

  // Process all entries in their natural order
  for (const [key, value] of Object.entries(obj)) {
    // Skip attributes
    if (key.startsWith("@_")) {
      continue;
    }

    // Handle direct text content
    if (key === "#text") {
      if (typeof value === "string" && value.trim()) {
        parts.push(value);
      }
      continue;
    }

    // Handle child elements
    if (Array.isArray(value)) {
      for (const v of value) {
        const childText = extractTextContent(v);
        if (childText) {
          parts.push(childText);
        }
      }
    } else {
      const childText = extractTextContent(value);
      if (childText) {
        parts.push(childText);
      }
    }
  }

  // Join with spaces and normalize whitespace (collapse multiple spaces)
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Normalize image source paths for proper resolution.
 * Justice Canada XML uses relative filenames like "2007c-25_ef001.jpg"
 * which need to be converted to resolvable paths.
 *
 */
function normalizeImageSource(source: string): string {
  // If already a full URL or absolute path, return as-is
  if (
    source.startsWith("http://") ||
    source.startsWith("https://") ||
    source.startsWith("/")
  ) {
    return source;
  }

  // Convert relative filename to a path that can be resolved
  // The images are typically stored alongside the XML files or in an images directory
  // Using a relative path prefix that can be configured at render time
  return `/legislation/images/${source}`;
}

/**
 * Extract HTML from preserved-order parsed structure.
 * With preserveOrder=true, fast-xml-parser returns an array where each item is
 * an object with a single key (element name) or "#text" for text nodes.
 * Attributes are stored under the ":@" key.
 *
 * Example structure:
 * [
 *   { "DefinedTermEn": [...], ":@": {} },
 *   { "#text": " means the member..." },
 *   { "XRefExternal": [...], ":@": { "@_link": "H-6" } },
 * ]
 */
function extractHtmlFromPreserved(items: unknown): string {
  if (!items) {
    return "";
  }

  // Handle string (shouldn't happen with preserveOrder but just in case)
  if (typeof items === "string") {
    return escapeHtml(items);
  }

  // Handle number
  if (typeof items === "number") {
    return String(items);
  }

  // Not an array - shouldn't happen with preserveOrder structure
  if (!Array.isArray(items)) {
    return "";
  }

  let html = "";

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const itemObj = item as Record<string, unknown>;

    // Get the element name (first key that's not ":@")
    const keys = Object.keys(itemObj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const key = keys[0];
    const value = itemObj[key];
    const attrs = (itemObj[":@"] as Record<string, unknown>) || {};

    // Handle text nodes
    if (key === "#text") {
      if (typeof value === "string") {
        html += escapeHtml(value);
      }
      continue;
    }

    // Get children (value is an array in preserveOrder mode)
    const children = Array.isArray(value) ? value : [];

    // Process element based on type
    html += processPreservedElement(key, children, attrs);
  }

  return html;
}

/**
 * Process a single element from preserved-order structure and convert to HTML.
 */
function processPreservedElement(
  tag: string,
  children: unknown[],
  attrs: Record<string, unknown>
): string {
  const childHtml = extractHtmlFromPreserved(children);

  switch (tag) {
    case "Emphasis": {
      const style = attrs["@_style"] as string | undefined;
      if (style === "italic") {
        return `<em>${childHtml}</em>`;
      }
      if (style === "smallcaps") {
        return `<span class="smallcaps">${childHtml}</span>`;
      }
      return `<strong>${childHtml}</strong>`;
    }
    case "Sup":
      return `<sup>${childHtml}</sup>`;
    case "Sub":
      return `<sub>${childHtml}</sub>`;
    case "Language": {
      const lang = attrs["@_xml:lang"] as string | undefined;
      return `<span lang="${escapeHtml(lang || "")}">${childHtml}</span>`;
    }
    case "BilingualGroup":
      return `<div class="bilingual-group">${childHtml}</div>`;
    case "BilingualItemEn":
      return `<span lang="en" class="bilingual-en">${childHtml}</span>`;
    case "BilingualItemFr":
      return `<span lang="fr" class="bilingual-fr">${childHtml}</span>`;
    case "XRefExternal": {
      const link = attrs["@_link"] as string | undefined;
      const refType = attrs["@_reference-type"] as string | undefined;
      let href = "";
      if (link && refType === "act") {
        href = `/legislation/act/${escapeHtml(link)}`;
      } else if (link && refType === "regulation") {
        href = `/legislation/regulation/${escapeHtml(link)}`;
      } else if (link) {
        href = `#${escapeHtml(link)}`;
      }
      if (href) {
        return `<a class="xref" href="${href}">${childHtml}</a>`;
      }
      return `<span class="xref">${childHtml}</span>`;
    }
    case "XRefInternal": {
      const targetId =
        (attrs["@_id"] as string | undefined) ||
        (attrs["@_idref"] as string | undefined) ||
        (attrs["@_link"] as string | undefined) ||
        (attrs["@_target"] as string | undefined);
      if (targetId) {
        return `<a class="xref xref-internal" href="#${escapeHtml(targetId)}">${childHtml}</a>`;
      }
      return `<span class="xref xref-internal">${childHtml}</span>`;
    }
    case "DefinedTermEn":
    case "DefinedTermFr":
    case "DefinitionRef":
      return `<dfn>${childHtml}</dfn>`;
    case "FootnoteRef":
      return `<sup class="footnote-ref">${childHtml}</sup>`;
    case "Repealed":
      return `<span class="repealed">${childHtml}</span>`;
    case "TableGroup": {
      const tgAttrs: string[] = [];
      if (attrs["@_bilingual"]) {
        tgAttrs.push(
          `data-bilingual="${escapeHtml(String(attrs["@_bilingual"]))}"`
        );
      }
      if (tgAttrs.length > 0) {
        return `<div class="table-group" ${tgAttrs.join(" ")}>${childHtml}</div>`;
      }
      return childHtml;
    }
    case "table": {
      const tableAttrs: string[] = [];
      if (attrs["@_frame"]) {
        tableAttrs.push(`data-frame="${escapeHtml(String(attrs["@_frame"]))}"`);
      }
      if (attrs["@_colsep"]) {
        tableAttrs.push(
          `data-colsep="${escapeHtml(String(attrs["@_colsep"]))}"`
        );
      }
      if (attrs["@_rowsep"]) {
        tableAttrs.push(
          `data-rowsep="${escapeHtml(String(attrs["@_rowsep"]))}"`
        );
      }
      if (attrs["@_bilingual"]) {
        tableAttrs.push(
          `data-bilingual="${escapeHtml(String(attrs["@_bilingual"]))}"`
        );
      }
      const attrStr = tableAttrs.length > 0 ? ` ${tableAttrs.join(" ")}` : "";
      return `<table${attrStr}>${childHtml}</table>`;
    }
    case "tgroup":
    case "colspec":
      return childHtml;
    case "thead": {
      const theadAttrs: string[] = [];
      if (attrs["@_valign"]) {
        theadAttrs.push(
          `data-valign="${escapeHtml(String(attrs["@_valign"]))}"`
        );
      }
      const attrStr = theadAttrs.length > 0 ? ` ${theadAttrs.join(" ")}` : "";
      return `<thead${attrStr}>${extractTableRowsPreserved(children, true)}</thead>`;
    }
    case "tbody": {
      const tbodyAttrs: string[] = [];
      if (attrs["@_valign"]) {
        tbodyAttrs.push(
          `data-valign="${escapeHtml(String(attrs["@_valign"]))}"`
        );
      }
      const attrStr = tbodyAttrs.length > 0 ? ` ${tbodyAttrs.join(" ")}` : "";
      return `<tbody${attrStr}>${extractTableRowsPreserved(children, false)}</tbody>`;
    }
    case "row":
      return extractTableRowPreserved(children, false);
    case "entry":
      return extractTableCellPreserved(children, attrs, false);
    case "List": {
      const style = (attrs["@_style"] as string | undefined) || "unordered";
      let listTag = "ul";
      let listAttr = "";
      switch (style) {
        case "arabic":
        case "decimal":
          listTag = "ol";
          listAttr = ' type="1"';
          break;
        case "lower-roman":
        case "roman":
          listTag = "ol";
          listAttr = ' type="i"';
          break;
        case "upper-roman":
          listTag = "ol";
          listAttr = ' type="I"';
          break;
        case "lower-alpha":
          listTag = "ol";
          listAttr = ' type="a"';
          break;
        case "upper-alpha":
          listTag = "ol";
          listAttr = ' type="A"';
          break;
        default:
          // Default to unordered list (ul) - already set above
          break;
      }
      return `<${listTag}${listAttr}>${extractListItemsPreserved(children)}</${listTag}>`;
    }
    case "Item":
      return `<li>${childHtml}</li>`;
    case "DocumentInternal":
      return `<section class="document-internal">${childHtml}</section>`;
    case "Group":
      return `<div class="group">${childHtml}</div>`;
    case "GroupHeading":
      return `<h4 class="group-heading">${childHtml}</h4>`;
    case "Provision":
      return `<p class="provision">${childHtml}</p>`;
    case "SectionPiece":
      return `<div class="section-piece">${childHtml}</div>`;
    case "ImageGroup": {
      const position = attrs["@_position"] as string | undefined;
      const positionAttr = position
        ? ` data-position="${escapeHtml(position)}"`
        : "";
      return `<figure class="image-group"${positionAttr}>${childHtml}</figure>`;
    }
    case "Image": {
      const source = attrs["@_source"] as string | undefined;
      if (source) {
        const normalizedSource = normalizeImageSource(source);
        return `<img src="${escapeHtml(normalizedSource)}" alt="" class="legislation-image" loading="lazy" />`;
      }
      return "";
    }
    case "Caption":
      return `<figcaption class="image-caption">${childHtml}</figcaption>`;
    case "FormulaGroup":
      return `<div class="formula-group">${childHtml}</div>`;
    case "Formula":
      return `<div class="formula">${childHtml}</div>`;
    case "FormulaText":
      return `<code class="formula-text">${childHtml}</code>`;
    case "FormulaConnector":
      return `<p class="formula-connector">${childHtml}</p>`;
    case "FormulaDefinition":
      return `<div class="formula-definition">${childHtml}</div>`;
    case "FormulaTerm":
      return `<var class="formula-term">${childHtml}</var>`;
    case "FormulaParagraph": {
      const label = extractLabelFromPreserved(children);
      const contentWithoutLabel = extractHtmlFromPreservedExcluding(
        children,
        "Label"
      );
      return `<p class="formula-paragraph">${label}${contentWithoutLabel}</p>`;
    }
    case "math":
    case "MathML":
      return serializeMathMLPreserved(children, attrs);
    case "Subsection":
      return `<div class="subsection">${childHtml}</div>`;
    case "Paragraph":
      return `<div class="paragraph">${childHtml}</div>`;
    case "Subparagraph":
      return `<div class="subparagraph">${childHtml}</div>`;
    case "Clause":
      return `<div class="clause">${childHtml}</div>`;
    case "Subclause":
      return `<div class="subclause">${childHtml}</div>`;
    case "Label":
      return `<span class="label">${childHtml}</span> `;
    case "Text":
      return childHtml;
    case "MarginalNote":
      return ""; // Skip - rendered separately
    case "Definition":
      return `<div class="definition">${childHtml}</div>`;
    case "HistoricalNote":
    case "HistoricalNoteSubItem":
      return ""; // Skip - rendered separately
    case "ContinuedSectionSubsection":
    case "ContinuedParagraph":
    case "ContinuedSubparagraph":
    case "ContinuedClause":
    case "ContinuedSubclause":
    case "ContinuedDefinition":
      return `<div class="continued">${childHtml}</div>`;
    case "LeaderRightJustified":
      return `<span class="leader-right">${childHtml}</span>`;
    case "QuotedText":
      return `<blockquote class="quoted-text">${childHtml}</blockquote>`;
    case "ScheduleFormHeading":
      return `<h5 class="schedule-form-heading">${childHtml}</h5>`;
    case "Oath":
    case "Affirmation":
      return `<div class="oath">${childHtml}</div>`;
    case "CenteredText":
      return `<p class="centered-text">${childHtml}</p>`;
    case "ReadAsText":
      return `<div class="read-as-text">${childHtml}</div>`;
    default:
      return childHtml;
  }
}

/**
 * Extract table rows from preserved-order structure.
 */
function extractTableRowsPreserved(
  children: unknown[],
  isHeader: boolean
): string {
  let html = "";
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    if (childObj.row) {
      const rowChildren = Array.isArray(childObj.row) ? childObj.row : [];
      html += extractTableRowPreserved(rowChildren, isHeader);
    }
  }
  return html;
}

/**
 * Extract a single table row from preserved-order structure.
 */
function extractTableRowPreserved(
  children: unknown[],
  isHeader: boolean
): string {
  let html = "<tr>";
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    if (childObj.entry) {
      const entryChildren = Array.isArray(childObj.entry) ? childObj.entry : [];
      const entryAttrs = (childObj[":@"] as Record<string, unknown>) || {};
      html += extractTableCellPreserved(entryChildren, entryAttrs, isHeader);
    }
  }
  html += "</tr>";
  return html;
}

/**
 * Extract a single table cell from preserved-order structure.
 */
function extractTableCellPreserved(
  children: unknown[],
  attrs: Record<string, unknown>,
  isHeader: boolean
): string {
  const tag = isHeader ? "th" : "td";
  const cellAttrs: string[] = [];

  if (attrs["@_namest"] && attrs["@_nameend"]) {
    cellAttrs.push(`data-namest="${escapeHtml(String(attrs["@_namest"]))}"`);
    cellAttrs.push(`data-nameend="${escapeHtml(String(attrs["@_nameend"]))}"`);
  }
  if (attrs["@_morerows"]) {
    const morerows = Number.parseInt(String(attrs["@_morerows"]), 10);
    if (!Number.isNaN(morerows) && morerows > 0) {
      cellAttrs.push(`rowspan="${morerows + 1}"`);
    }
  }

  const styles: string[] = [];
  if (attrs["@_align"]) {
    styles.push(`text-align: ${escapeHtml(String(attrs["@_align"]))}`);
  }
  if (attrs["@_valign"]) {
    styles.push(`vertical-align: ${escapeHtml(String(attrs["@_valign"]))}`);
  }
  if (styles.length > 0) {
    cellAttrs.push(`style="${styles.join("; ")}"`);
  }

  if (attrs["@_colsep"]) {
    cellAttrs.push(`data-colsep="${escapeHtml(String(attrs["@_colsep"]))}"`);
  }
  if (attrs["@_rowsep"]) {
    cellAttrs.push(`data-rowsep="${escapeHtml(String(attrs["@_rowsep"]))}"`);
  }

  const attrStr = cellAttrs.length > 0 ? ` ${cellAttrs.join(" ")}` : "";
  return `<${tag}${attrStr}>${extractHtmlFromPreserved(children)}</${tag}>`;
}

/**
 * Extract list items from preserved-order structure.
 */
function extractListItemsPreserved(children: unknown[]): string {
  let html = "";
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    if (childObj.Item) {
      const itemChildren = Array.isArray(childObj.Item) ? childObj.Item : [];
      html += `<li>${extractHtmlFromPreserved(itemChildren)}</li>`;
    }
  }
  return html;
}

/**
 * Extract Label element content from preserved-order children.
 */
function extractLabelFromPreserved(children: unknown[]): string {
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    if (childObj.Label) {
      const labelChildren = Array.isArray(childObj.Label) ? childObj.Label : [];
      return `<span class="label">${extractHtmlFromPreserved(labelChildren)}</span>`;
    }
  }
  return "";
}

/**
 * Extract HTML from preserved-order children, excluding a specific element.
 */
function extractHtmlFromPreservedExcluding(
  children: unknown[],
  excludeTag: string
): string {
  let html = "";
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    const keys = Object.keys(childObj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }
    const key = keys[0];
    if (key === excludeTag) {
      continue;
    }

    const value = childObj[key];
    const attrs = (childObj[":@"] as Record<string, unknown>) || {};

    if (key === "#text") {
      if (typeof value === "string") {
        html += escapeHtml(value);
      }
      continue;
    }

    const childChildren = Array.isArray(value) ? value : [];
    html += processPreservedElement(key, childChildren, attrs);
  }
  return html;
}

/**
 * Serialize MathML from preserved-order structure.
 */
function serializeMathMLPreserved(
  children: unknown[],
  attrs: Record<string, unknown>
): string {
  let html = '<math xmlns="http://www.w3.org/1998/Math/MathML"';
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith("@_") && typeof value === "string") {
      const attrName = key.slice(2);
      html += ` ${attrName}="${escapeHtml(value)}"`;
    }
  }
  html += ">";
  html += serializeMathMLContentPreserved(children);
  html += "</math>";
  return html;
}

/**
 * Recursively serialize MathML content from preserved-order structure.
 */
function serializeMathMLContentPreserved(children: unknown[]): string {
  let html = "";
  for (const child of children) {
    if (!child || typeof child !== "object") {
      continue;
    }
    const childObj = child as Record<string, unknown>;
    const keys = Object.keys(childObj).filter((k) => k !== ":@");
    if (keys.length === 0) {
      continue;
    }

    const key = keys[0];
    const value = childObj[key];
    const attrs = (childObj[":@"] as Record<string, unknown>) || {};

    if (key === "#text") {
      if (typeof value === "string") {
        html += escapeHtml(value);
      }
      continue;
    }

    const childChildren = Array.isArray(value) ? value : [];

    let tag = `<${key}`;
    for (const [attrKey, attrValue] of Object.entries(attrs)) {
      if (attrKey.startsWith("@_") && typeof attrValue === "string") {
        const attrName = attrKey.slice(2);
        tag += ` ${attrName}="${escapeHtml(attrValue)}"`;
      }
    }
    tag += ">";
    tag += serializeMathMLContentPreserved(childChildren);
    tag += `</${key}>`;
    html += tag;
  }
  return html;
}

/**
 * Convert XML element to simple HTML (preserving structure and document order).
 *
 * This function re-parses the element with preserveOrder=true to correctly
 * handle mixed content (text interspersed with child elements).
 */
export function extractHtmlContent(el: unknown): string {
  if (typeof el === "string") {
    return escapeHtml(el);
  }
  if (typeof el === "number") {
    return String(el);
  }
  if (!el || typeof el !== "object") {
    return "";
  }

  // Serialize the parsed object back to XML
  const xml = xmlBuilder.build({ root: el });

  // Re-parse with preserveOrder=true to get correct document order
  const preserved = htmlPreserveOrderParser.parse(xml);

  // Extract HTML from the preserved-order structure
  // The structure is [{ root: [...children...] }]
  if (Array.isArray(preserved) && preserved.length > 0) {
    const rootObj = preserved[0] as Record<string, unknown>;
    if (rootObj.root && Array.isArray(rootObj.root)) {
      return extractHtmlFromPreserved(rootObj.root);
    }
  }

  return "";
}
