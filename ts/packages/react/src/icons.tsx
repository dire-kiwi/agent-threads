// Small line icons, drawn here so the package has no icon dependency. They take the text colour.

import type { ReactNode } from "react";

function icon(name: string, body: ReactNode) {
  const Icon = ({ size = 13, className }: { size?: number; className?: string }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className ? `at-icon ${className}` : "at-icon"}
    >
      {body}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

export const TerminalIcon = icon("TerminalIcon", <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>);
export const FileIcon = icon("FileIcon", <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h5" /></>);
export const PencilIcon = icon("PencilIcon", <><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>);
export const SearchIcon = icon("SearchIcon", <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const GlobeIcon = icon("GlobeIcon", <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>);
export const PlugIcon = icon("PlugIcon", <><path d="M9 2v6M15 2v6" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></>);
export const AppIcon = icon("AppIcon", <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>);
export const BotIcon = icon("BotIcon", <><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 2h8" /><path d="M9 13v2M15 13v2" /></>);
export const ListIcon = icon("ListIcon", <><path d="m3 6 2 2 3-3" /><path d="m3 15 2 2 3-3" /><path d="M12 7h9M12 16h9" /></>);
export const WrenchIcon = icon("WrenchIcon", <><path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.3-1.3a4 4 0 0 1-5-5L13 2z" transform="translate(-1 0)" /></>);
export const ChevronIcon = icon("ChevronIcon", <path d="m9 6 6 6-6 6" />);
export const CheckIcon = icon("CheckIcon", <path d="M20 6 9 17l-5-5" />);
export const XIcon = icon("XIcon", <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const SpinnerIcon = icon("SpinnerIcon", <path d="M21 12a9 9 0 1 1-6.2-8.6" />);
export const ShieldIcon = icon("ShieldIcon", <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 17h.01" /></>);
export const QuestionIcon = icon("QuestionIcon", <><path d="M21 12a9 9 0 0 1-13.5 7.8L3 21l1.2-4.5A9 9 0 1 1 21 12z" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5M12 16.5h.01" /></>);
export const StopIcon = icon("StopIcon", <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />);
export const ArrowUpIcon = icon("ArrowUpIcon", <><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>);
export const LayersIcon = icon("LayersIcon", <><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>);
export const BrainIcon = icon("BrainIcon", <><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" /></>);
export const AlertIcon = icon("AlertIcon", <><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></>);
export const ClockIcon = icon("ClockIcon", <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const MapIcon = icon("MapIcon", <><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z" /><path d="M9 4v14M15 6v14" /></>);
export const SendIcon = icon("SendIcon", <><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4z" /></>);
