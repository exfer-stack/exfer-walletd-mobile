// Icon set ported from the design prototype's core.jsx. Stroke icons drawn
// with currentColor so they inherit text color. Names are a closed string
// union loosely typed as `string` per the brief.

import type { JSX } from "react";

export interface IconProps {
  name: string;
  size?: number;
  stroke?: number;
}

export function Icon({ name, size = 24, stroke = 2 }: IconProps): JSX.Element | null {
  const c = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: stroke,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "wallet":
      return (
        <svg {...c}>
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1" />
          <path d="M3 7.5V18a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" />
          <path d="M16 12.5h5v4h-5a2 2 0 0 1 0-4Z" />
        </svg>
      );
    case "activity":
      return (
        <svg {...c}>
          <path d="M3 12h4l2.5 7 5-14L17 12h4" />
        </svg>
      );
    case "settings":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="3" />
          <path
            d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.82 1.17V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 14a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 7a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 2.6a1.65 1.65 0 0 0 1-1.51V1a2 2 0 0 1 4 0v.09A1.65 1.65 0 0 0 15 2.6a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 7v0c.27.63.9 1.04 1.6 1.04H21a2 2 0 0 1 0 4h-.09c-.7 0-1.33.41-1.51 1.04Z"
            transform="translate(0 1)"
          />
        </svg>
      );
    case "send":
      return (
        <svg {...c}>
          <path d="M12 19V6" />
          <path d="m6 12 6-7 6 7" />
        </svg>
      );
    case "receive":
      return (
        <svg {...c}>
          <path d="M12 5v13" />
          <path d="m6 12 6 7 6-7" />
        </svg>
      );
    case "copy":
      return (
        <svg {...c}>
          <rect x="9" y="9" width="11" height="11" rx="2.5" />
          <path d="M5 15V6a2 2 0 0 1 2-2h8" />
        </svg>
      );
    case "check":
      return (
        <svg {...c}>
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      );
    case "plus":
      return (
        <svg {...c}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...c}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...c}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "back":
      return (
        <svg {...c}>
          <path d="m15 18-6-6 6-6" />
        </svg>
      );
    case "close":
      return (
        <svg {...c}>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "eye":
      return (
        <svg {...c}>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "eye-off":
      return (
        <svg {...c}>
          <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3 3.8M6.6 6.6A18 18 0 0 0 2 12s3.6 7 10 7a10.9 10.9 0 0 0 4-.75M3 3l18 18" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </svg>
      );
    case "more":
      return (
        <svg {...c}>
          <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "tag":
      return (
        <svg {...c}>
          <path d="M3 7.5V4a1 1 0 0 1 1-1h3.5a2 2 0 0 1 1.4.6l10 10a2 2 0 0 1 0 2.8l-3.5 3.5a2 2 0 0 1-2.8 0l-10-10A2 2 0 0 1 3 7.5Z" />
          <circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "eye-slash-row":
      return (
        <svg {...c}>
          <path d="M9.9 4.2A9.6 9.6 0 0 1 12 4c6 0 9 7 9 7a16 16 0 0 1-2 3M5 6a15 15 0 0 0-2 5s3 7 9 7a9 9 0 0 0 3-.5M2 2l20 20" />
        </svg>
      );
    case "trash":
      return (
        <svg {...c}>
          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-13" />
        </svg>
      );
    case "export":
      return (
        <svg {...c}>
          <path d="M12 15V3m0 0L8 7m4-4 4 4" />
          <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
        </svg>
      );
    case "download":
      return (
        <svg {...c}>
          <path d="M12 3v12m0 0 4-4m-4 4-4-4" />
          <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
        </svg>
      );
    case "key":
      return (
        <svg {...c}>
          <circle cx="8" cy="8" r="4.5" />
          <path d="m11 11 8 8m-3-3 2-2m-4 0 2-2" />
        </svg>
      );
    case "node":
      return (
        <svg {...c}>
          <circle cx="12" cy="12" r="2.5" />
          <circle cx="5" cy="5" r="2" />
          <circle cx="19" cy="5" r="2" />
          <circle cx="5" cy="19" r="2" />
          <circle cx="19" cy="19" r="2" />
          <path d="m6.5 6.5 3.7 3.7m3.6 0 3.7-3.7m0 11-3.7-3.7m-3.6 0-3.7 3.7" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...c}>
          <path d="M21 12a9 9 0 1 1-2.6-6.3M21 4v4h-4" />
        </svg>
      );
    case "shield":
      return (
        <svg {...c}>
          <path d="M12 3 5 6v5c0 4.5 3 8 7 9 4-1 7-4.5 7-9V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "qr":
      return (
        <svg {...c}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <path d="M14 14h3v3h-3zM20 14v3M14 20h3M20 20h1" />
        </svg>
      );
    case "spark":
      return (
        <svg {...c}>
          <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
        </svg>
      );
    case "share":
      return (
        <svg {...c}>
          <path d="M12 16V4m0 0L8 8m4-4 4 4" />
          <path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
        </svg>
      );
    default:
      return null;
  }
}
