import parse from "html-react-parser";
import { ExternalLinkIcon } from "lucide-react";
import Image from "next/image";
import React, { type ReactNode } from "react";
import { buildJusticeCanadaUrl } from "@/lib/legislation/constants";
import type { ContentNode } from "@/lib/legislation/types";

type Props = {
  nodes: ContentNode[];
  language?: "en" | "fr";
  /** Callback when an internal reference is clicked. Receives the target section label. */
  onNavigate?: (target: string) => void;
};

/**
 * Extract plain text from ContentNode children (for XRefInternal targets)
 */
function extractTextFromChildren(children: ContentNode[] | undefined): string {
  if (!children) {
    return "";
  }
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.value;
      }
      if ("children" in child) {
        return extractTextFromChildren(child.children);
      }
      return "";
    })
    .join("");
}

/**
 * MathML renderer - uses html-react-parser to safely convert
 * MathML XML to React elements for browser math rendering.
 */
function MathMLRenderer({
  raw,
  display,
}: {
  raw: string;
  display?: "block" | "inline";
}) {
  return (
    <span className={display === "block" ? "my-2 block" : "inline"}>
      {parse(raw)}
    </span>
  );
}

export function ContentTreeRenderer({
  nodes,
  language = "en",
  onNavigate,
}: Props): ReactNode {
  return (
    <>{nodes.map((node, i) => renderNode(node, i, language, onNavigate))}</>
  );
}

function renderNode(
  node: ContentNode,
  key: number,
  language: string,
  onNavigate?: (target: string) => void
): ReactNode {
  // Handle text nodes
  if (node.type === "text") {
    return node.value;
  }

  // Render children recursively
  const children =
    "children" in node && node.children
      ? node.children.map((child, i) =>
          renderNode(child, i, language, onNavigate)
        )
      : null;

  switch (node.type) {
    // Structure elements
    case "Label":
      return (
        <span className="label font-semibold" key={key}>
          {children}{" "}
        </span>
      );
    case "Text":
      return <span key={key}>{children}</span>;
    case "Subsection":
      return (
        <div className="subsection mt-2 ml-4" key={key}>
          {children}
        </div>
      );
    case "Paragraph":
      return (
        <div className="paragraph mt-1 ml-6" key={key}>
          {children}
        </div>
      );
    case "Subparagraph":
      return (
        <div className="subparagraph mt-1 ml-8" key={key}>
          {children}
        </div>
      );
    case "Clause":
      return (
        <div className="clause mt-1 ml-10" key={key}>
          {children}
        </div>
      );
    case "Subclause":
      return (
        <div className="subclause mt-1 ml-12" key={key}>
          {children}
        </div>
      );
    case "Definition":
      return (
        <div className="definition mt-2" key={key}>
          {children}
        </div>
      );
    case "Continued":
      return (
        <div className="continued" key={key}>
          {children}
        </div>
      );

    // Terms and references
    case "DefinedTermEn":
    case "DefinedTermFr":
      return (
        <dfn className="font-semibold" key={key}>
          {children}
        </dfn>
      );
    case "DefinitionRef":
      return (
        <span className="text-primary" key={key}>
          {children}
        </span>
      );
    case "XRefExternal": {
      // Only create links for acts/regulations that have a valid link attribute
      // External references like "Designated Airspace Handbook" (reference-type="other")
      // don't have links and should render as styled text, not broken anchors
      if (node.link) {
        const href = buildJusticeCanadaUrl(
          node.link,
          node.refType === "regulation" ? "regulation" : "act",
          language as "en" | "fr"
        );
        return (
          <a
            className="inline-flex items-center gap-1 text-primary underline hover:text-primary/80"
            href={href}
            key={key}
            rel="noopener noreferrer"
            target="_blank"
          >
            {children}
            <ExternalLinkIcon className="size-3 shrink-0" />
          </a>
        );
      }
      // No link available - render as emphasized text (external publications, standards)
      return (
        <em className="text-foreground" key={key}>
          {children}
        </em>
      );
    }
    case "XRefInternal": {
      // Target can be explicit attribute or extracted from children text
      const target = node.target || extractTextFromChildren(node.children);
      // If we have a navigation handler and target, make it clickable
      if (onNavigate && target) {
        return (
          <button
            className="text-primary underline hover:text-primary/80"
            key={key}
            onClick={() => onNavigate(target)}
            type="button"
          >
            {children}
          </button>
        );
      }
      // Fallback to plain text if no handler
      return (
        <span className="text-primary" key={key}>
          {children}
        </span>
      );
    }

    // Text formatting
    case "Emphasis":
      if (node.style === "italic") {
        return (
          <em className="italic" key={key}>
            {children}
          </em>
        );
      }
      if (node.style === "smallcaps") {
        return (
          <span className="text-[0.85em] uppercase tracking-wide" key={key}>
            {children}
          </span>
        );
      }
      return (
        <strong className="font-bold" key={key}>
          {children}
        </strong>
      );
    case "Sup":
      return <sup key={key}>{children}</sup>;
    case "Sub":
      return <sub key={key}>{children}</sub>;
    case "Repealed":
      return (
        <span className="text-muted-foreground italic" key={key}>
          {children}
        </span>
      );
    case "FootnoteRef":
      return (
        <sup className="text-primary text-xs" key={key}>
          [{node.id || children}]
        </sup>
      );
    case "LineBreak":
      return <br key={key} />;
    case "PageBreak":
      return <hr className="my-4 border-dashed" key={key} />;
    case "FormBlank":
      return (
        <span
          className="inline-block border-current border-b"
          key={key}
          style={{ width: node.width || "4em" }}
        >
          &nbsp;
        </span>
      );
    case "Fraction":
      return (
        <span className="inline-fraction" key={key}>
          {children}
        </span>
      );
    case "Leader":
      return (
        <span
          className="leader inline-block flex-1"
          key={key}
          style={{
            borderBottom:
              node.style === "solid"
                ? "1px solid currentColor"
                : node.style === "dash"
                  ? "1px dashed currentColor"
                  : "1px dotted currentColor",
          }}
        >
          &nbsp;
        </span>
      );
    case "Separator":
      return <hr className="my-2" key={key} />;
    case "Language":
      return (
        <span key={key} lang={node.lang}>
          {children}
        </span>
      );

    // Lists
    case "List": {
      const isOrdered =
        node.style?.includes("alpha") ||
        node.style?.includes("arabic") ||
        node.style?.includes("roman");
      const ListTag = isOrdered ? "ol" : "ul";
      return (
        <ListTag className="my-2 ml-4 list-inside" key={key}>
          {children}
        </ListTag>
      );
    }
    case "Item":
      return (
        <li className="mt-1" key={key}>
          {children}
        </li>
      );

    // Tables (CALS)
    case "TableGroup":
      return (
        <div className="table-group my-4 overflow-x-auto" key={key}>
          {children}
        </div>
      );
    case "Table":
      return (
        <table
          className="min-w-full border-collapse border border-border text-sm"
          key={key}
        >
          {children}
        </table>
      );
    case "TGroup":
      return <React.Fragment key={key}>{children}</React.Fragment>;
    case "THead":
      return (
        <thead className="bg-muted" key={key}>
          {children}
        </thead>
      );
    case "TBody":
      return <tbody key={key}>{children}</tbody>;
    case "TFoot":
      return (
        <tfoot className="bg-muted/50" key={key}>
          {children}
        </tfoot>
      );
    case "Row":
      return (
        <tr className="border-border border-b" key={key}>
          {children}
        </tr>
      );
    case "Entry": {
      const attrs = node.attrs || {};
      const rowSpan = attrs.morerows
        ? Number.parseInt(attrs.morerows, 10) + 1
        : undefined;
      return (
        <td className="border border-border p-2" key={key} rowSpan={rowSpan}>
          {children}
        </td>
      );
    }
    case "ColSpec":
      return null; // Handled by table rendering logic

    // Formulas and math
    case "FormulaGroup":
      return (
        <div className="formula-group my-4" key={key}>
          {children}
        </div>
      );
    case "Formula":
      return (
        <div className="formula my-2 overflow-x-auto" key={key}>
          {children}
        </div>
      );
    case "FormulaText":
      return (
        <code
          className="formula-text rounded bg-muted px-2 py-1 font-mono"
          key={key}
        >
          {children}
        </code>
      );
    case "FormulaConnector":
      return (
        <p className="formula-connector my-1 text-center" key={key}>
          {children}
        </p>
      );
    case "FormulaDefinition":
      return (
        <div className="formula-definition mt-2 ml-4" key={key}>
          {children}
        </div>
      );
    case "FormulaTerm":
      return (
        <var className="formula-term font-semibold italic" key={key}>
          {children}
        </var>
      );
    case "FormulaParagraph":
      return (
        <p className="formula-paragraph my-1" key={key}>
          {children}
        </p>
      );

    // MathML - inject raw XML for browser math rendering
    case "MathML":
      return <MathMLRenderer display={node.display} key={key} raw={node.raw} />;

    // Images
    case "ImageGroup":
      return (
        <figure className="image-group my-4" key={key}>
          {children}
        </figure>
      );
    case "Image":
      // Use Next.js Image with unoptimized for legislation images
      // Width/height are placeholder values; CSS will control actual display
      return node.source ? (
        <Image
          alt=""
          className="legislation-image max-w-full"
          height={400}
          key={key}
          src={`/legislation/images/${node.source}`}
          unoptimized
          width={600}
        />
      ) : null;
    case "Caption":
      return (
        <figcaption className="mt-2 text-center text-sm italic" key={key}>
          {children}
        </figcaption>
      );

    // Bilingual content
    case "BilingualGroup":
      return (
        <div className="bilingual-group my-2 flex gap-4" key={key}>
          {children}
        </div>
      );
    case "BilingualItemEn":
      return (
        <span className="bilingual-en flex-1" key={key} lang="en">
          {children}
        </span>
      );
    case "BilingualItemFr":
      return (
        <span className="bilingual-fr flex-1" key={key} lang="fr">
          {children}
        </span>
      );

    // Special content
    case "QuotedText":
      return (
        <blockquote
          className="quoted-text my-2 border-muted border-l-4 pl-4 italic"
          key={key}
        >
          {children}
        </blockquote>
      );
    case "CenteredText":
      return (
        <p className="centered-text my-2 text-center" key={key}>
          {children}
        </p>
      );
    case "FormGroup":
      return (
        <div className="form-group my-4 rounded border p-4" key={key}>
          {children}
        </div>
      );
    case "Oath":
      return (
        <div className="oath my-4 border-primary border-l-4 pl-4" key={key}>
          {children}
        </div>
      );
    case "ReadAsText":
      return (
        <div className="read-as-text my-2 bg-muted/50 p-2" key={key}>
          {children}
        </div>
      );
    case "ScheduleFormHeading":
      return (
        <div className="schedule-form-heading my-4 font-semibold" key={key}>
          {children}
        </div>
      );
    case "LeaderRightJustified":
      return (
        <span className="leader-right flex justify-between" key={key}>
          {children}
        </span>
      );

    // Fallback for unhandled elements (including "Unknown" type)
    default:
      return <span key={key}>{children}</span>;
  }
}
