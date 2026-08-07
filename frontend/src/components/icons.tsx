/**
 * Icon set, ported one-for-one from the ICONS string map in nav.js.
 * Paths, viewBoxes and stroke settings are unchanged.
 */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/** Shared stroke setup used by every nav icon in the original markup. */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function NavSvg({ children, className = "nav-icon", ...rest }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} className={className} {...rest}>
      {children}
    </svg>
  );
}

export function IconDashboard(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </NavSvg>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </NavSvg>
  );
}

export function IconBuilding(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M6 22V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v18Z" />
      <path d="M6 12H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
      <path d="M18 9h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2" />
      <path d="M10 6h.01M14 6h.01M10 10h.01M14 10h.01M10 14h.01M14 14h.01M10 18h.01M14 18h.01" />
    </NavSvg>
  );
}

export function IconBriefcase(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </NavSvg>
  );
}

export function IconGlobe(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </NavSvg>
  );
}

export function IconMap(props: IconProps) {
  return (
    <NavSvg {...props}>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </NavSvg>
  );
}

export function IconPin(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </NavSvg>
  );
}

export function IconCoins(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
      <path d="M7 6h1v4" />
      <path d="m16.71 13.88.7.71-2.82 2.82" />
    </NavSvg>
  );
}

export function IconRuler(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="m14.5 12.5 2-2a2.12 2.12 0 0 1 3 3l-2 2Z" />
      <path d="m9.5 7.5 2-2a2.12 2.12 0 0 1 3 3l-2 2" />
      <path d="m3.5 21.5 2-2" />
      <path d="m5.5 19.5 2 2" />
      <path d="M14.5 21.5 21.5 14.5" />
      <path d="M2.5 9.5 9.5 2.5" />
    </NavSvg>
  );
}

export function IconTag(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M20.59 13.41 11 22l-9-9V4a2 2 0 0 1 2-2h9Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
    </NavSvg>
  );
}

export function IconAward(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.48 13.06 17 22l-5-3-5 3 1.52-8.94" />
    </NavSvg>
  );
}

/** `layers` and `layersplus` were identical in the original ICONS map. */
export function IconLayers(props: IconProps) {
  return (
    <NavSvg {...props}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </NavSvg>
  );
}

export function IconBox(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </NavSvg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
    </NavSvg>
  );
}

export function IconClock(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </NavSvg>
  );
}

export function IconTruck(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M1 3h15v13H1z" />
      <path d="M16 8h4l3 3v5h-7V8z" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
    </NavSvg>
  );
}

export function IconTask(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </NavSvg>
  );
}

export function IconFileText(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
    </NavSvg>
  );
}

/* --- Topbar icons (sized, no nav-icon class) --- */

export function IconSearch(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} width={16} height={16} {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconBell(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} width={18} height={18} {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function IconLogout(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} width={15} height={15} {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

/* --- Dashboard stat-tile icons (width/height 20, no nav-icon class) --- */

export function IconStatUsers(props: IconProps) {
  return <IconUsers width={20} height={20} className={undefined} {...props} />;
}

export function IconStatTruck(props: IconProps) {
  return <IconTruck width={20} height={20} className={undefined} {...props} />;
}

export function IconStatTask(props: IconProps) {
  return <IconTask width={20} height={20} className={undefined} {...props} />;
}

export function IconStatBriefcase(props: IconProps) {
  return <IconBriefcase width={20} height={20} className={undefined} {...props} />;
}

export function IconStatAward(props: IconProps) {
  return <IconAward width={20} height={20} className={undefined} {...props} />;
}

/** The dashboard's Organization tile used a simplified single-path building. */
export function IconStatBuilding(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...stroke} width={20} height={20} {...props}>
      <path d="M6 22V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v18Z" />
    </svg>
  );
}

/* --- Tasks page icons --- */

export function IconPlus(props: IconProps) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconListView(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

export function IconKanbanView(props: IconProps) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <rect x="3" y="3" width="5" height="18" rx="1" />
      <rect x="12" y="3" width="5" height="12" rx="1" />
      <rect x="21" y="3" width="5" height="8" rx="1" />
    </svg>
  );
}

/** Icon lookup by the string keys the nav config uses. */
export const ICONS = {
  dashboard: IconDashboard,
  users: IconUsers,
  building: IconBuilding,
  briefcase: IconBriefcase,
  globe: IconGlobe,
  map: IconMap,
  pin: IconPin,
  coins: IconCoins,
  ruler: IconRuler,
  tag: IconTag,
  award: IconAward,
  layers: IconLayers,
  layersplus: IconLayers,
  box: IconBox,
  shield: IconShield,
  clock: IconClock,
  truck: IconTruck,
  task: IconTask,
  fileText: IconFileText,
} as const;

export type IconKey = keyof typeof ICONS;
