"use client";

import { BookOpenIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { DefinedTermsResponse } from "@/app/(chat)/api/legislation/defined-terms/route";
import type { DefinedTermItem } from "@/lib/db/legislation/queries";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

type DefinedTermsPanelProps = {
  docType: "act" | "regulation";
  docId: string;
  language: "en" | "fr";
  sectionLabel: string;
  partLabel?: string;
};

function truncateDefinition(text: string, maxLength = 80): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trim()}...`;
}

function TermRow({
  term,
  isExpanded,
  onToggle,
  language,
}: {
  term: DefinedTermItem;
  isExpanded: boolean;
  onToggle: () => void;
  language: "en" | "fr";
}) {
  const scopeLabel =
    term.scopeType === "act"
      ? language === "fr"
        ? "Loi entière"
        : "Entire Act"
      : term.scopeType === "regulation"
        ? language === "fr"
          ? "Règlement entier"
          : "Entire Regulation"
        : term.scopeType === "part"
          ? language === "fr"
            ? "Cette partie"
            : "This Part"
          : term.scopeRawText ||
            (language === "fr" ? "Section(s)" : "Section(s)");

  const ariaLabel =
    language === "fr"
      ? `${isExpanded ? "Réduire" : "Développer"} la définition de ${term.term}`
      : `${isExpanded ? "Collapse" : "Expand"} definition for ${term.term}`;

  return (
    <Collapsible onOpenChange={onToggle} open={isExpanded}>
      <CollapsibleTrigger
        aria-label={ariaLabel}
        className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
      >
        {isExpanded ? (
          <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-medium text-sm">{term.term}</span>
          {!isExpanded && (
            <span className="ml-2 text-muted-foreground text-sm">
              {truncateDefinition(term.definition)}
            </span>
          )}
        </div>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-1 mb-3 ml-6 rounded-md border bg-muted/30 p-3">
          <p className="text-sm leading-relaxed">{term.definition}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            {term.sectionLabel && (
              <span>
                {language === "fr"
                  ? "Défini à l'article"
                  : "Defined in Section"}{" "}
                {term.sectionLabel}
              </span>
            )}
            {term.sectionLabel && <span className="text-border">·</span>}
            <span className="italic">{scopeLabel}</span>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function DefinedTermsPanel({
  docType,
  docId,
  language,
  sectionLabel,
  partLabel,
}: DefinedTermsPanelProps) {
  const [terms, setTerms] = useState<DefinedTermItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [expandedTermId, setExpandedTermId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchTerms() {
      setIsLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          docType,
          docId,
          language,
          sectionLabel,
        });
        if (partLabel) {
          params.set("partLabel", partLabel);
        }

        const res = await fetch(`/api/legislation/defined-terms?${params}`);
        if (!res.ok) {
          throw new Error(`Failed to fetch defined terms: ${res.status}`);
        }
        const data: DefinedTermsResponse = await res.json();

        // Only update state if this request wasn't cancelled
        if (!cancelled) {
          setTerms(data.terms);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to load defined terms"
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    fetchTerms();

    return () => {
      cancelled = true;
    };
  }, [docType, docId, language, sectionLabel, partLabel]);

  const handleTermToggle = useCallback((termId: string) => {
    setExpandedTermId((prev) => (prev === termId ? null : termId));
  }, []);

  // Don't render anything while loading or if there are no terms
  if (isLoading) {
    return null;
  }

  if (error) {
    return null; // Silently fail - this is supplementary info
  }

  if (terms.length === 0) {
    return null;
  }

  const labels = {
    definedTerms:
      language === "fr"
        ? `${terms.length} terme${terms.length > 1 ? "s" : ""} défini${terms.length > 1 ? "s" : ""}`
        : `${terms.length} defined term${terms.length > 1 ? "s" : ""}`,
    show: language === "fr" ? "Afficher" : "Show",
    hide: language === "fr" ? "Masquer" : "Hide",
  };

  const panelAriaLabel =
    language === "fr"
      ? `${isExpanded ? "Masquer" : "Afficher"} ${labels.definedTerms}`
      : `${isExpanded ? "Hide" : "Show"} ${labels.definedTerms}`;

  return (
    <div className="mb-3">
      <Collapsible onOpenChange={setIsExpanded} open={isExpanded}>
        <CollapsibleTrigger
          aria-label={panelAriaLabel}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700 text-xs transition-colors hover:bg-emerald-500/20 dark:text-emerald-400"
        >
          <BookOpenIcon className="size-3.5" />
          <span>{labels.definedTerms}</span>
          {isExpanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="mt-2 rounded-lg border bg-card p-3">
            <div className="space-y-0.5">
              {terms.map((term) => (
                <TermRow
                  isExpanded={expandedTermId === term.id}
                  key={term.id}
                  language={language}
                  onToggle={() => handleTermToggle(term.id)}
                  term={term}
                />
              ))}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
