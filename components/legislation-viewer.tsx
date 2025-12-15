"use client";

import {
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleIcon,
  ExternalLinkIcon,
  FileTextIcon,
  HistoryIcon,
  InfoIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActMetadata,
  RegulationMetadata,
  SectionContent,
  SectionTocItem,
} from "@/app/(chat)/api/legislation/sections/route";
import type {
  FootnoteInfo,
  HistoricalNoteItem,
} from "@/lib/db/legislation/queries";
import {
  buildAnnualStatuteUrl,
  buildJusticeCanadaUrl,
  buildPointInTimeIndexUrl,
  parseAmendmentCitation,
} from "@/lib/legislation/constants";
import type { ContentNode } from "@/lib/legislation/types";
import { cn } from "@/lib/utils";
import { ContentTreeRenderer } from "./content-tree-renderer";

import { DefinedTermsPanel } from "./defined-terms-panel";

type DocType = "act" | "regulation";
type DocumentMetadata = ActMetadata | RegulationMetadata;

type LegislationViewerProps = {
  docType: DocType;
  docId: string;
  language: "en" | "fr";
  isLoading?: boolean;
};

// Number of sections to load around the target section
const SECTION_BUFFER = 5;
// Initial sections to load on mount
const INITIAL_SECTIONS_TO_LOAD = 20;
// Debounce delay for intersection observer (ms)
const INTERSECTION_DEBOUNCE_MS = 100;

type LoadedSection = SectionContent & { loaded: true };
type PlaceholderSection = SectionTocItem & { loaded: false };
type DisplaySection = LoadedSection | PlaceholderSection;

// Pattern for repealed sections: "36[Repealed, 2012, c. 9, s. 2]"
const REPEALED_PATTERN = /^\d+(?:\.\d+)?\s*\[(?:Repealed|Abrogé)/i;
// Pattern to extract just the citation part
const REPEALED_CITATION_PATTERN = /\[(Repealed|Abrogé)[^\]]+\]/i;
// Pattern to extract section number from internal reference targets
const SECTION_TARGET_PATTERN = /(?:section_?)?(\d+(?:\.\d+)?)/i;

function SectionContentDisplay({
  content,
  contentTree,
  language,
  onNavigate,
}: {
  content: string;
  contentTree: ContentNode[] | null;
  language: "en" | "fr";
  onNavigate?: (target: string) => void;
}) {
  // Handle repealed sections with a clean citation
  if (REPEALED_PATTERN.test(content)) {
    const citationMatch = content.match(REPEALED_CITATION_PATTERN);
    const citation = citationMatch ? citationMatch[0] : content;
    return <p className="text-muted-foreground italic">{citation}</p>;
  }

  // Prefer contentTree when available (structured React rendering)
  if (contentTree && contentTree.length > 0) {
    return (
      <div className="legislation-content prose prose-sm dark:prose-invert max-w-none">
        <ContentTreeRenderer
          language={language}
          nodes={contentTree}
          onNavigate={onNavigate}
        />
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
      {content}
    </div>
  );
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-CA");
  } catch {
    return dateStr;
  }
}

/**
 * Hierarchy breadcrumb - shows the Part/Division path above section
 * Provides "where am I in this document?" context
 */
function HierarchyBreadcrumb({
  path,
  language,
}: {
  path: string[] | null;
  language: "en" | "fr";
}) {
  if (!path || path.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={language === "fr" ? "Fil d'Ariane" : "Breadcrumb"}
      className="mb-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-muted-foreground text-xs"
    >
      {path.map((item, index) => (
        <span className="inline-flex items-center gap-1" key={item}>
          {index > 0 && (
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/50" />
          )}
          <span>{item}</span>
        </span>
      ))}
    </nav>
  );
}

/**
 * Status and type badges for sections
 * Shows status (repealed, not-in-force) and special section types (amending, transitional)
 */
function SectionBadges({
  status,
  sectionType,
  language,
}: {
  status: string | null;
  sectionType: string | null;
  language: "en" | "fr";
}) {
  const badges: Array<{ label: string; className: string }> = [];

  // Status badges (only for non-default states)
  if (status === "repealed") {
    badges.push({
      label: language === "fr" ? "Abrogé" : "Repealed",
      className: "bg-destructive/10 text-destructive",
    });
  } else if (status === "not-in-force") {
    badges.push({
      label: language === "fr" ? "Non en vigueur" : "Not in Force",
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    });
  }

  // Section type badges (only for special types)
  if (sectionType === "amending") {
    badges.push({
      label: language === "fr" ? "Modificatif" : "Amending",
      className: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    });
  } else if (sectionType === "transitional") {
    badges.push({
      label: language === "fr" ? "Transitoire" : "Transitional",
      className: "bg-purple-500/10 text-purple-700 dark:text-purple-400",
    });
  }

  if (badges.length === 0) {
    return null;
  }

  return (
    <span className="ml-2 inline-flex gap-1.5">
      {badges.map((badge) => (
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 font-medium text-xs",
            badge.className
          )}
          key={badge.label}
        >
          {badge.label}
        </span>
      ))}
    </span>
  );
}

/**
 * Footnotes display - shows editorial notes and footnotes at end of section
 */
function FootnotesDisplay({
  footnotes,
  language,
}: {
  footnotes: FootnoteInfo[] | null;
  language: "en" | "fr";
}) {
  if (!footnotes || footnotes.length === 0) {
    return null;
  }

  return (
    <aside className="mt-4 border-muted border-t pt-3">
      <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <InfoIcon className="size-3.5" />
        <span className="font-medium">
          {language === "fr" ? "Notes" : "Notes"}
        </span>
      </div>
      <ul className="mt-2 space-y-1.5 text-muted-foreground text-xs">
        {footnotes.map((note) => (
          <li className="flex gap-2" key={note.id}>
            {note.label && (
              <span className="shrink-0 font-semibold">{note.label}</span>
            )}
            <span>{note.text}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

/**
 * Amendment timeline entry - interactive link to Justice Canada
 * Current version (isLatest) has no link; historical versions link to amending act
 */
function AmendmentTimelineEntry({
  note,
  isLatest,
  language,
}: {
  note: HistoricalNoteItem;
  isLatest: boolean;
  language: "en" | "fr";
}) {
  const parsed = parseAmendmentCitation(note.text);

  // For historical versions, link to the amending act (annual statute) on Justice Canada
  // Current version has no link (user is already viewing it)
  const amendingActUrl =
    !isLatest && parsed
      ? buildAnnualStatuteUrl(parsed.year, parsed.chapter, language)
      : null;

  const isOriginal = note.type === "original";
  const typeLabel = isOriginal
    ? language === "fr"
      ? "Version initiale"
      : "Original"
    : language === "fr"
      ? "Modification"
      : "Amendment";

  return (
    <div className="group relative flex items-start gap-3">
      {/* Timeline dot */}
      <div className="relative flex flex-col items-center">
        {isLatest ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-primary" />
        ) : (
          <CircleIcon className="size-4 shrink-0 text-muted-foreground/50" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          {/* Current version: plain text; Historical: link to amending act */}
          {amendingActUrl ? (
            <a
              className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary hover:underline"
              href={amendingActUrl}
              rel="noopener noreferrer"
              target="_blank"
              title={
                language === "fr"
                  ? `Voir la loi modificative de ${parsed?.year}`
                  : `View ${parsed?.year} amending act`
              }
            >
              {note.text}
              <ExternalLinkIcon className="size-3 opacity-50 group-hover:opacity-100" />
            </a>
          ) : (
            <span className="font-medium text-foreground">{note.text}</span>
          )}

          {/* Type badge */}
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 font-medium text-[10px]",
              isLatest
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            )}
          >
            {isLatest
              ? language === "fr"
                ? "Actuelle"
                : "Current"
              : typeLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function SectionMetadataStrip({
  docType,
  docId,
  enactedDate,
  inForceStartDate,
  lastAmendedDate,
  historicalNotes,
  language,
}: {
  docType: DocType;
  docId: string;
  enactedDate: string | null;
  inForceStartDate: string | null;
  lastAmendedDate: string | null;
  historicalNotes: HistoricalNoteItem[] | null;
  language: "en" | "fr";
}) {
  const [expanded, setExpanded] = useState(false);

  const hasMetadata = enactedDate || inForceStartDate || lastAmendedDate;
  const hasHistory = historicalNotes && historicalNotes.length > 0;

  if (!hasMetadata && !hasHistory) {
    return null;
  }

  // Determine which dates to show (avoid redundancy)
  const showEnacted = enactedDate && enactedDate !== inForceStartDate;
  const showInForce = inForceStartDate;
  const showAmended = lastAmendedDate && lastAmendedDate !== inForceStartDate;

  const labels = {
    enacted: language === "fr" ? "Adopté" : "Enacted",
    inForce: language === "fr" ? "En vigueur" : "In force",
    amended: language === "fr" ? "Modifié" : "Amended",
    history: language === "fr" ? "Historique" : "History",
    versions:
      language === "fr"
        ? `${historicalNotes?.length} version${historicalNotes && historicalNotes.length > 1 ? "s" : ""}`
        : `${historicalNotes?.length} version${historicalNotes && historicalNotes.length > 1 ? "s" : ""}`,
  };

  // Sort notes by citation year (most recent first) for timeline display
  // The inForceStartDate can be the same for all entries (when they were
  // added to the current consolidation), so we parse the year from the
  // citation text to get the actual chronological order
  const sortedNotes = hasHistory
    ? [...historicalNotes].sort((a, b) => {
        const yearA = parseAmendmentCitation(a.text)?.year || 0;
        const yearB = parseAmendmentCitation(b.text)?.year || 0;
        return yearB - yearA; // Most recent first
      })
    : [];

  // Point-in-time URL only available for acts
  const pitUrl =
    docType === "act" ? buildPointInTimeIndexUrl(docId, language) : null;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        {showEnacted && (
          <span>
            {labels.enacted}: {formatDate(enactedDate)}
          </span>
        )}
        {showEnacted && showInForce && <span className="text-border">·</span>}
        {showInForce && (
          <span>
            {labels.inForce}: {formatDate(inForceStartDate)}
          </span>
        )}
        {(showEnacted || showInForce) && showAmended && (
          <span className="text-border">·</span>
        )}
        {showAmended && (
          <span>
            {labels.amended}: {formatDate(lastAmendedDate)}
          </span>
        )}
        {hasHistory && (
          <button
            aria-expanded={expanded}
            className="ml-auto inline-flex items-center gap-1 text-primary hover:underline"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            <HistoryIcon className="size-3" />
            <span>{expanded ? labels.history : labels.versions}</span>
          </button>
        )}
      </div>

      {expanded && hasHistory && (
        <div className="mt-3 rounded-lg border bg-card p-4">
          {/* Header with version indicator and external link */}
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileTextIcon className="size-4 text-muted-foreground" />
              <span className="font-medium text-sm">
                {language === "fr"
                  ? "Historique des modifications"
                  : "Amendment History"}
              </span>
            </div>
            {pitUrl && (
              <a
                className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-muted-foreground text-xs hover:bg-muted/80 hover:text-foreground"
                href={pitUrl}
                rel="noopener noreferrer"
                target="_blank"
                title={
                  language === "fr"
                    ? "Voir toutes les versions sur Justice Canada"
                    : "View all versions on Justice Canada"
                }
              >
                {language === "fr" ? "Toutes les versions" : "All versions"}
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>

          {/* Timeline */}
          <div className="relative">
            {/* Vertical line */}
            <div className="absolute top-2 bottom-2 left-[7px] w-px bg-border" />

            {/* Entries */}
            <div className="space-y-0">
              {sortedNotes.map((note, index) => (
                <AmendmentTimelineEntry
                  isLatest={index === 0}
                  key={`${note.text}-${note.enactedDate}-${index}`}
                  language={language}
                  note={note}
                />
              ))}
            </div>
          </div>

          {/* Footer note */}
          <p className="mt-3 border-muted border-t pt-3 text-muted-foreground text-xs">
            <InfoIcon className="mr-1 inline size-3" />
            {language === "fr"
              ? "Vous consultez la version consolidée actuelle. Cliquez sur une modification pour voir la loi modificative."
              : "You are viewing the current consolidated version. Click an amendment to view the amending act."}
          </p>
        </div>
      )}
    </div>
  );
}

type FetchSectionContentParams = {
  docType: DocType;
  docId: string;
  lang: string;
  startOrder: number;
  endOrder: number;
};

/**
 * Fetch section content for a range of sections.
 */
async function fetchSectionContent({
  docType,
  docId,
  lang,
  startOrder,
  endOrder,
}: FetchSectionContentParams): Promise<SectionContent[]> {
  const res = await fetch(
    `/api/legislation/section-content?docType=${docType}&docId=${encodeURIComponent(docId)}&language=${lang}&startOrder=${startOrder}&endOrder=${endOrder}`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch section content: ${res.status}`);
  }
  const data = await res.json();
  return data.sections;
}

export function LegislationViewer({
  docType,
  docId,
  language,
  isLoading: externalLoading,
}: LegislationViewerProps) {
  const [metadata, setMetadata] = useState<DocumentMetadata | null>(null);
  const [toc, setToc] = useState<SectionTocItem[]>([]);
  const [loadedSections, setLoadedSections] = useState<
    Map<number, SectionContent>
  >(new Map());
  const [isLoadingToc, setIsLoadingToc] = useState(true);
  const [isLoadingContent, setIsLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSectionOrder, setSelectedSectionOrder] = useState<
    number | null
  >(null);

  const contentRef = useRef<HTMLDivElement>(null);
  // Use a callback ref pattern to avoid O(n²) ref management
  const sectionRefCallback =
    useRef<(order: number, el: HTMLElement | null) => void>();
  const sectionElements = useRef<Map<number, HTMLElement>>(new Map());

  // Track in-flight requests to prevent duplicates
  const pendingRequests = useRef<Set<string>>(new Set());
  // Debounce timer for intersection observer
  const intersectionDebounceTimer = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const pendingIntersections = useRef<Set<number>>(new Set());

  // Stable array of loaded section orders for useMemo dependency
  const loadedSectionOrders = useMemo(() => {
    return Array.from(loadedSections.keys()).sort((a, b) => a - b);
  }, [loadedSections]);

  // Fetch TOC on mount
  useEffect(() => {
    async function fetchToc() {
      setIsLoadingToc(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/legislation/sections?docType=${docType}&docId=${encodeURIComponent(docId)}&language=${language}`
        );
        if (!res.ok) {
          throw new Error(`Failed to fetch sections: ${res.status}`);
        }
        const data = await res.json();
        // Set metadata (either act or regulation)
        setMetadata(data.act || data.regulation);
        setToc(data.toc);

        // Load initial sections inline
        if (data.toc.length > 0) {
          const lastSection = data.toc.at(-1);
          const endOrder = Math.min(
            data.toc[INITIAL_SECTIONS_TO_LOAD - 1]?.sectionOrder ??
              lastSection?.sectionOrder ??
              0,
            lastSection?.sectionOrder ?? 0
          );

          const docLang = (data.act || data.regulation)?.language || language;
          setIsLoadingContent(true);
          try {
            const sections = await fetchSectionContent({
              docType,
              docId,
              lang: docLang,
              startOrder: data.toc[0].sectionOrder,
              endOrder,
            });
            setLoadedSections((prev) => {
              const next = new Map(prev);
              for (const section of sections) {
                next.set(section.sectionOrder, section);
              }
              return next;
            });
          } finally {
            setIsLoadingContent(false);
          }
        }
      } catch (err) {
        const label = docType === "regulation" ? "regulation" : "act";
        setError(
          err instanceof Error ? err.message : `Failed to load ${label}`
        );
      } finally {
        setIsLoadingToc(false);
      }
    }
    fetchToc();
  }, [docType, docId, language]);

  const loadSectionRange = useCallback(
    async (startOrder: number, endOrder: number, lang: string) => {
      const cacheKey = `${startOrder}-${endOrder}`;
      if (pendingRequests.current.has(cacheKey)) {
        return;
      }

      pendingRequests.current.add(cacheKey);
      setIsLoadingContent(true);

      try {
        const sections = await fetchSectionContent({
          docType,
          docId,
          lang,
          startOrder,
          endOrder,
        });
        setLoadedSections((prev) => {
          const next = new Map(prev);
          for (const section of sections) {
            next.set(section.sectionOrder, section);
          }
          return next;
        });
      } catch (err) {
        console.error("Failed to load sections:", err);
      } finally {
        pendingRequests.current.delete(cacheKey);
        setIsLoadingContent(false);
      }
    },
    [docType, docId]
  );

  const handleSectionClick = useCallback(
    async (sectionOrder: number) => {
      setSelectedSectionOrder(sectionOrder);

      const tocIndex = toc.findIndex((s) => s.sectionOrder === sectionOrder);
      if (tocIndex === -1) {
        return;
      }

      // Find the first unloaded section between start and target + buffer
      // We need ALL sections above the target loaded to ensure accurate scroll position
      const endIndex = Math.min(toc.length - 1, tocIndex + SECTION_BUFFER);

      // Find first unloaded section
      let firstUnloadedIndex = -1;
      for (let i = 0; i <= endIndex; i++) {
        if (!loadedSections.has(toc[i].sectionOrder)) {
          firstUnloadedIndex = i;
          break;
        }
      }

      // Load all sections from first unloaded to target + buffer
      // Chunk into batches of 100 (API limit)
      if (firstUnloadedIndex !== -1) {
        const lang = metadata?.language || language;
        const CHUNK_SIZE = 100;

        for (
          let chunkStart = firstUnloadedIndex;
          chunkStart <= endIndex;
          chunkStart += CHUNK_SIZE
        ) {
          const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, endIndex);
          await loadSectionRange(
            toc[chunkStart].sectionOrder,
            toc[chunkEnd].sectionOrder,
            lang
          );
        }
      }

      // Scroll to section after content loads
      requestAnimationFrame(() => {
        const element = sectionElements.current.get(sectionOrder);
        if (element) {
          element.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    },
    [toc, loadedSections, loadSectionRange, metadata?.language, language]
  );

  // Handle internal cross-reference navigation (from XRefInternal in content)
  const handleInternalNavigation = useCallback(
    (target: string) => {
      // Target could be like "section_4", "4", or a full lims ID
      // Try to extract just the section number
      const sectionMatch = target.match(SECTION_TARGET_PATTERN);
      const sectionLabel = sectionMatch ? sectionMatch[1] : target;

      // Find the section in TOC by label
      const tocItem = toc.find(
        (item) =>
          item.sectionLabel === sectionLabel ||
          item.sectionLabel === target ||
          item.id === target
      );

      if (tocItem) {
        handleSectionClick(tocItem.sectionOrder);
      }
    },
    [toc, handleSectionClick]
  );

  // Build display sections - combine TOC with loaded content
  // Use loadedSectionOrders for stable dependency tracking
  const displaySections: DisplaySection[] = useMemo(() => {
    const loadedSet = new Set(loadedSectionOrders);
    return toc.map((tocItem) => {
      if (loadedSet.has(tocItem.sectionOrder)) {
        const loaded = loadedSections.get(tocItem.sectionOrder);
        if (loaded) {
          return { ...loaded, loaded: true as const };
        }
      }
      return { ...tocItem, loaded: false as const };
    });
  }, [toc, loadedSectionOrders, loadedSections]);

  // Process pending intersections with debouncing
  const processPendingIntersections = useCallback(() => {
    if (pendingIntersections.current.size === 0) {
      return;
    }

    const orders = Array.from(pendingIntersections.current);
    pendingIntersections.current.clear();

    // Find contiguous ranges to minimize requests
    const unloadedOrders = orders.filter((order) => !loadedSections.has(order));
    if (unloadedOrders.length === 0) {
      return;
    }

    // For each unloaded section, load it with buffer
    for (const order of unloadedOrders) {
      const tocIndex = toc.findIndex((s) => s.sectionOrder === order);
      if (tocIndex !== -1) {
        const startIndex = Math.max(0, tocIndex - SECTION_BUFFER);
        const endIndex = Math.min(toc.length - 1, tocIndex + SECTION_BUFFER);
        loadSectionRange(
          toc[startIndex].sectionOrder,
          toc[endIndex].sectionOrder,
          metadata?.language || language
        );
      }
    }
  }, [toc, loadedSections, loadSectionRange, metadata?.language, language]);

  // Intersection observer for lazy loading as user scrolls
  useEffect(() => {
    if (toc.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const order = Number.parseInt(
              entry.target.getAttribute("data-section-order") || "0",
              10
            );
            if (order && !loadedSections.has(order)) {
              pendingIntersections.current.add(order);
            }
          }
        }

        // Debounce processing of intersections
        if (intersectionDebounceTimer.current) {
          clearTimeout(intersectionDebounceTimer.current);
        }
        intersectionDebounceTimer.current = setTimeout(() => {
          processPendingIntersections();
        }, INTERSECTION_DEBOUNCE_MS);
      },
      {
        root: contentRef.current,
        rootMargin: "200px",
        threshold: 0,
      }
    );

    // Observe all section placeholders
    for (const [order, element] of sectionElements.current) {
      if (!loadedSections.has(order)) {
        observer.observe(element);
      }
    }

    return () => {
      observer.disconnect();
      if (intersectionDebounceTimer.current) {
        clearTimeout(intersectionDebounceTimer.current);
      }
    };
  }, [toc, loadedSections, processPendingIntersections]);

  // Setup callback ref for efficient ref management
  useEffect(() => {
    sectionRefCallback.current = (order: number, el: HTMLElement | null) => {
      if (el) {
        sectionElements.current.set(order, el);
      } else {
        sectionElements.current.delete(order);
      }
    };
  }, []);

  const formatSectionHeader = (
    section: DisplaySection,
    lang: "en" | "fr"
  ): string => {
    const label = section.sectionLabel;
    const note = section.marginalNote;

    if (section.sectionType === "heading") {
      return note ? `${label} - ${note}` : label;
    }
    if (section.sectionType === "schedule") {
      return label;
    }
    const prefix = lang === "fr" ? "Article" : "Section";
    return note ? `${prefix} ${label} - ${note}` : `${prefix} ${label}`;
  };

  const getSectionHeaderLevel = (sectionType: string | null): "h2" | "h3" => {
    if (sectionType === "heading" || sectionType === "schedule") {
      return "h2";
    }
    return "h3";
  };

  if (externalLoading || isLoadingToc) {
    const label = docType === "regulation" ? "regulation" : "act";
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading {label}...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-destructive">{error}</div>
      </div>
    );
  }

  if (!metadata) {
    return null;
  }

  const usedLang = (metadata.language as "en" | "fr") || language;
  const isRegulation = docType === "regulation";
  const reg = isRegulation ? (metadata as RegulationMetadata) : null;
  const act = isRegulation ? null : (metadata as ActMetadata);

  return (
    <div className="flex h-full flex-row">
      {/* Section Navigation Sidebar */}
      <div className="w-64 shrink-0 overflow-y-auto border-r bg-muted/30 p-2">
        <div className="mb-2 px-2 font-semibold text-muted-foreground text-xs uppercase tracking-wide">
          {usedLang === "fr" ? "Sections" : "Sections"} ({toc.length})
        </div>
        <nav className="space-y-0.5">
          {toc.map((item) => (
            <button
              className={cn(
                "w-full rounded px-2 py-1 text-left text-sm transition-colors hover:bg-accent",
                item.sectionType === "heading" && "font-semibold",
                item.isRepealed && "text-muted-foreground",
                selectedSectionOrder === item.sectionOrder &&
                  "bg-accent text-accent-foreground"
              )}
              key={item.id}
              onClick={() => handleSectionClick(item.sectionOrder)}
              type="button"
            >
              <span className="block truncate">
                {item.sectionType === "heading" ? (
                  <span className="font-medium">{item.sectionLabel}</span>
                ) : item.isRepealed ? (
                  <span className="italic">
                    {item.sectionLabel}
                    <span className="ml-1">
                      - {usedLang === "fr" ? "Abrogé" : "Repealed"}
                    </span>
                  </span>
                ) : (
                  <span>
                    {item.sectionLabel}
                    {item.marginalNote && (
                      <span className="ml-1 text-muted-foreground">
                        - {item.marginalNote}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-6" ref={contentRef}>
        {/* Document Header */}
        <header className="mb-8">
          <h1 className="font-bold text-2xl">{metadata.title}</h1>
          {metadata.longTitle && metadata.longTitle !== metadata.title && (
            <p className="mt-1 text-lg text-muted-foreground italic">
              {metadata.longTitle}
            </p>
          )}

          {/* Regulation-specific header info */}
          {isRegulation && reg && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full bg-blue-500/10 px-2 py-0.5 font-medium text-blue-700 text-xs dark:text-blue-400">
                {reg.instrumentNumber}
              </span>
              {reg.regulationType && (
                <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground text-xs">
                  {reg.regulationType}
                </span>
              )}
              {reg.gazettePart && (
                <span className="text-muted-foreground text-sm">
                  {usedLang === "fr" ? "Gazette" : "Gazette"}: {reg.gazettePart}
                </span>
              )}
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground text-sm">
            {metadata.status && (
              <span>
                <strong>{usedLang === "fr" ? "Statut:" : "Status:"}</strong>{" "}
                {metadata.status}
              </span>
            )}

            {/* Act-specific dates */}
            {act?.consolidationDate && (
              <span>
                <strong>
                  {usedLang === "fr"
                    ? "Date de consolidation:"
                    : "Consolidation Date:"}
                </strong>{" "}
                {act.consolidationDate}
              </span>
            )}

            {/* Regulation-specific dates */}
            {reg?.registrationDate && (
              <span>
                <strong>
                  {usedLang === "fr" ? "Enregistré:" : "Registered:"}
                </strong>{" "}
                {formatDate(reg.registrationDate)}
              </span>
            )}
            {reg?.consolidationDate && (
              <span>
                <strong>
                  {usedLang === "fr" ? "Consolidation:" : "Consolidation:"}
                </strong>{" "}
                {reg.consolidationDate}
              </span>
            )}
            {reg?.lastAmendedDate && (
              <span>
                <strong>
                  {usedLang === "fr"
                    ? "Dernière modification:"
                    : "Last Amended:"}
                </strong>{" "}
                {formatDate(reg.lastAmendedDate)}
              </span>
            )}
          </div>

          {/* Enabling Act (for regulations) */}
          {reg?.enablingActId && (
            <div className="mt-3 text-sm">
              <strong className="text-muted-foreground">
                {usedLang === "fr" ? "Loi habilitante:" : "Enabling Act:"}
              </strong>{" "}
              <a
                className="text-primary hover:underline"
                href={buildJusticeCanadaUrl(reg.enablingActId, "act", usedLang)}
                rel="noopener noreferrer"
                target="_blank"
              >
                {reg.enablingActTitle || reg.enablingActId}
                <ExternalLinkIcon className="ml-1 inline size-3" />
              </a>
            </div>
          )}
        </header>

        {/* Loading indicator */}
        {isLoadingContent && (
          <div className="fixed top-20 right-4 rounded bg-accent px-3 py-1 text-accent-foreground text-sm shadow">
            {usedLang === "fr" ? "Chargement..." : "Loading..."}
          </div>
        )}

        {/* Sections */}
        <div className="space-y-6">
          {displaySections.map((section) => {
            const HeaderTag = getSectionHeaderLevel(section.sectionType);
            const isLoaded = section.loaded;

            return (
              <article
                className={cn(
                  "scroll-mt-4",
                  selectedSectionOrder === section.sectionOrder &&
                    "-mx-4 rounded-lg bg-accent/20 p-4"
                )}
                data-section-order={section.sectionOrder}
                key={section.id}
                ref={(el) =>
                  sectionRefCallback.current?.(section.sectionOrder, el)
                }
              >
                {/* Hierarchy breadcrumb - shows Part/Division context */}
                {isLoaded && (
                  <HierarchyBreadcrumb
                    language={usedLang}
                    path={section.hierarchyPath}
                  />
                )}

                {/* Section header with badges */}
                <HeaderTag
                  className={cn(
                    "flex items-center font-semibold",
                    HeaderTag === "h2" ? "mb-2 text-xl" : "mb-1 text-lg"
                  )}
                >
                  <span>{formatSectionHeader(section, usedLang)}</span>
                  {isLoaded && (
                    <SectionBadges
                      language={usedLang}
                      sectionType={section.sectionType}
                      status={section.status}
                    />
                  )}
                </HeaderTag>

                {section.status === "repealed" ? (
                  <p className="text-muted-foreground italic">
                    {usedLang === "fr" ? "Abrogé" : "Repealed"}
                  </p>
                ) : isLoaded ? (
                  <div className="pt-2">
                    <SectionMetadataStrip
                      docId={docId}
                      docType={docType}
                      enactedDate={section.enactedDate}
                      historicalNotes={section.historicalNotes}
                      inForceStartDate={section.inForceStartDate}
                      language={usedLang}
                      lastAmendedDate={section.lastAmendedDate}
                    />
                    <DefinedTermsPanel
                      docId={docId}
                      docType={docType}
                      language={usedLang}
                      partLabel={section.hierarchyPath?.[0]}
                      sectionLabel={section.sectionLabel}
                    />
                    <SectionContentDisplay
                      content={section.content}
                      contentTree={section.contentTree}
                      language={usedLang}
                      onNavigate={handleInternalNavigation}
                    />
                    <FootnotesDisplay
                      footnotes={section.footnotes}
                      language={usedLang}
                    />
                  </div>
                ) : (
                  <div className="h-20 animate-pulse rounded bg-muted" />
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
