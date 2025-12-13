"use client";

import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { HydratedLegislationSource } from "@/lib/rag/legislation/hydrate";
import { cn } from "@/lib/utils";

type LegislationContextPanelProps = {
  hydratedSources: HydratedLegislationSource[];
  language: "en" | "fr" | "unknown";
  onOpenSource: (source: HydratedLegislationSource) => void;
};

/**
 * Multi-tier display for legislation context in chat messages.
 *
 * Tier 1: Act - prominent link
 * Tier 2: Regulation - secondary link
 * Tier 3: Related Resources - expandable panel with sections, terms, cross-refs
 */
export function LegislationContextPanel({
  hydratedSources,
  language,
  onOpenSource,
}: LegislationContextPanelProps) {
  const [open, setOpen] = useState(false);
  const isFr = language === "fr";

  if (!hydratedSources || hydratedSources.length === 0) {
    return null;
  }

  // Extract sources by tier
  const actSource = hydratedSources.find((s) => s.sourceType === "act");
  const regSource = hydratedSources.find((s) => s.sourceType === "regulation");
  const panelSources = hydratedSources.filter((s) =>
    ["act_section", "defined_term", "cross_reference"].includes(s.sourceType)
  );

  // Format label for panel items
  const formatPanelLabel = (source: HydratedLegislationSource): string => {
    switch (source.sourceType) {
      case "act_section":
        return isFr
          ? `Article ${source.sectionLabel ?? ""}`
          : `Section ${source.sectionLabel ?? ""}`;
      case "defined_term":
        return source.term
          ? `"${source.term}" — ${isFr ? "définition" : "definition"}`
          : isFr
            ? "Terme défini"
            : "Defined term";
      case "cross_reference":
        return source.targetTitle
          ? `${isFr ? "Renvoi:" : "Cross-ref:"} ${source.targetTitle}`
          : isFr
            ? "Renvoi"
            : "Cross-reference";
      default:
        return source.displayLabel ?? source.id;
    }
  };

  return (
    <div className="mt-3 space-y-2">
      {/* Tier 1: Act (prominent link) */}
      {actSource && (
        <button
          className="group flex items-center gap-1.5 font-medium text-primary hover:underline"
          onClick={() => onOpenSource(actSource)}
          type="button"
        >
          <span>{actSource.displayLabel ?? "View Act"}</span>
          <ExternalLinkIcon className="size-3.5 opacity-50 group-hover:opacity-100" />
        </button>
      )}

      {/* Tier 2: Regulation (secondary) */}
      {regSource && (
        <div className="text-muted-foreground text-sm">
          {isFr ? "Connexe: " : "Related: "}
          <button
            className="text-primary hover:underline"
            onClick={() => onOpenSource(regSource)}
            type="button"
          >
            {regSource.displayLabel ?? "View Regulation"}
          </button>
        </div>
      )}

      {/* Tier 3: Expandable panel */}
      {panelSources.length > 0 && (
        <Collapsible onOpenChange={setOpen} open={open}>
          <CollapsibleTrigger className="flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            <ChevronRightIcon
              className={cn(
                "size-4 transition-transform duration-200",
                open && "rotate-90"
              )}
            />
            <span>
              {isFr ? "Ressources connexes" : "Related Resources"} (
              {panelSources.length})
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-1 ml-5 space-y-1">
            {panelSources.map((source) => (
              <button
                className="block text-primary text-sm hover:underline"
                key={source.id}
                onClick={() => onOpenSource(source)}
                type="button"
              >
                {formatPanelLabel(source)}
              </button>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
