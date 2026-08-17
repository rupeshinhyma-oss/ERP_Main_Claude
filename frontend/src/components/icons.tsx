/**
 * Icon set, designed with unique, crisp SVG definitions for every navigation item.
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

/* -------------------------------------------------------------------------- */
/* Distinct Nav Icons for each ERP Section / Item                             */
/* -------------------------------------------------------------------------- */

/** 1. Dashboard (4-quadrant layout) */
export function IconDashboard(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </NavSvg>
  );
}

/** 2. Suppliers (Factory / Manufacturing Facility) */
export function IconFactory(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M17 18h1M12 18h1M7 18h1" />
    </NavSvg>
  );
}

/** 3. Buyers (Shopping Bag / Retail Buyer) */
export function IconShoppingBag(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M16 10a4 4 0 0 1-8 0" />
    </NavSvg>
  );
}

/** 4. Product Master (3D Box / Isometric Package) */
export function IconBox(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <line x1="12" y1="22" x2="12" y2="12" />
    </NavSvg>
  );
}

/** 5. Product Gallery (Image / Photo Gallery Frame) */
export function IconImage(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </NavSvg>
  );
}

/** 6. Categories (3D Stacked Layers) */
export function IconLayers(props: IconProps) {
  return (
    <NavSvg {...props}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </NavSvg>
  );
}

/** 7. Sub Categories (Branching Tree / Hierarchy) */
export function IconFolderTree(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M4 3v14a2 2 0 0 0 2 2h14" />
      <path d="M8 7h6a2 2 0 0 1 2 2v1" />
      <circle cx="16" cy="12" r="2" />
      <path d="M8 15h10" />
      <circle cx="18" cy="15" r="2" />
      <circle cx="8" cy="7" r="2" />
    </NavSvg>
  );
}

/** 8. Brands (Award Badge / Quality Medal) */
export function IconAward(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="8" r="6" />
      <path d="M15.48 13.06 17 22l-5-3-5 3 1.52-8.94" />
    </NavSvg>
  );
}

/** 9. Supplier Types (Network Nodes / Classification) */
export function IconNetwork(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3" />
      <path d="M12 12V8" />
    </NavSvg>
  );
}

/** 10. Buyer Types (Customer Segment Badge Card) */
export function IconIdCard(props: IconProps) {
  return (
    <NavSvg {...props}>
      <rect width="18" height="14" x="3" y="5" rx="2" />
      <path d="M7 15h4M15 15h2M7 11h2" />
      <circle cx="8" cy="9" r="1.25" />
      <path d="M3 10h18" />
    </NavSvg>
  );
}

/** 11. Inquiries (Proforma / Sales Document) */
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

/** 12. Shipment Planning (Cargo Transport Delivery Truck) */
export function IconTruck(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" />
      <path d="M15 18H9" />
      <path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14v10Z" />
      <circle cx="17" cy="18.5" r="2.5" />
      <circle cx="7" cy="18.5" r="2.5" />
    </NavSvg>
  );
}

/** 13. Users (Single User Profile) */
export function IconUser(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="7" r="4" />
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    </NavSvg>
  );
}

/** Users Group (Multi-user Icon) */
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

/** 14. Roles & Permissions (Security Shield with Checkmark) */
export function IconShield(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </NavSvg>
  );
}

/** 15. HSN Codes (Barcode / Tariff Code) */
export function IconBarcode(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14M5 5v14M14 5v14M19 5v14" />
    </NavSvg>
  );
}

/** 16. Countries (Globe) */
export function IconGlobe(props: IconProps) {
  return (
    <NavSvg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
    </NavSvg>
  );
}

/** 17. Provinces / States (Unfolded 3-panel Map) */
export function IconMap(props: IconProps) {
  return (
    <NavSvg {...props}>
      <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
      <line x1="8" y1="2" x2="8" y2="18" />
      <line x1="16" y1="6" x2="16" y2="22" />
    </NavSvg>
  );
}

/** 18. City (Location Pin) */
export function IconPin(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </NavSvg>
  );
}

/** 19. Currencies (Stacked Currency Coins) */
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

/** 20. Units of Measurement (Ruler / Measure) */
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

/** 21. Organization Settings (Settings Gear) */
export function IconSettings(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </NavSvg>
  );
}

/** 22. Organization List (Corporate Building) */
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

/** 23. Audit Log (History Clock) */
export function IconClock(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </NavSvg>
  );
}

/** 24. Trash (Trash Bin) */
export function IconTrash(props: IconProps) {
  return (
    <NavSvg {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </NavSvg>
  );
}

/* -------------------------------------------------------------------------- */
/* Auxiliary / Legacy / Toolbar Icons                                         */
/* -------------------------------------------------------------------------- */

export function IconTag(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M20.59 13.41 11 22l-9-9V4a2 2 0 0 1 2-2h9Z" />
      <circle cx="7.5" cy="7.5" r="1.5" />
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

export function IconTask(props: IconProps) {
  return (
    <NavSvg {...props}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
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
  factory: IconFactory,
  shoppingBag: IconShoppingBag,
  box: IconBox,
  image: IconImage,
  layers: IconLayers,
  folderTree: IconFolderTree,
  award: IconAward,
  network: IconNetwork,
  idCard: IconIdCard,
  fileText: IconFileText,
  truck: IconTruck,
  user: IconUser,
  users: IconUsers,
  shield: IconShield,
  barcode: IconBarcode,
  globe: IconGlobe,
  map: IconMap,
  pin: IconPin,
  coins: IconCoins,
  ruler: IconRuler,
  settings: IconSettings,
  building: IconBuilding,
  clock: IconClock,
  trash: IconTrash,
  // legacy aliases for backward compatibility
  tag: IconTag,
  briefcase: IconBriefcase,
  task: IconTask,
  grid: IconImage,
  folder: IconLayers,
  sliders: IconSettings,
  refresh: IconClock,
} as const;

export type IconKey = keyof typeof ICONS;
