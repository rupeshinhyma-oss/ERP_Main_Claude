/**
 * Breadcrumb trail: a Dashboard link followed by `/`-separated segments.
 *
 * Ported from the `.breadcrumb` markup repeated at the top of every page. The
 * original marked every segment after the link with `class="current"`
 * (including intermediate ones like "Master Data"), so that is preserved.
 */

import { Link } from "react-router-dom";

export function Breadcrumb({ trail }: { trail: string[] }) {
  return (
    <div className="breadcrumb">
      <Link to="/">Dashboard</Link>
      {trail.map((segment, index) => (
        <span key={`${segment}-${index}`}>
          <span className="sep">/</span>
          <span className="current">{segment}</span>
        </span>
      ))}
    </div>
  );
}
