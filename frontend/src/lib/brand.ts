/**
 * Company brand name shown as the sidebar title and in document.title.
 *
 * Cached in sessionStorage so the sidebar doesn't flicker through the default
 * on every navigation. Organization Settings calls invalidateBrandNameCache()
 * after a rename so the new name appears immediately, here and on every other
 * open tab's next navigation.
 */

import { apiGet } from "./api";
import { DEFAULT_BRAND_NAME } from "./nav";
import type { Organization } from "@/types";

const CACHE_KEY = "erp_org_company_name";

type Listener = (name: string) => void;
const listeners = new Set<Listener>();

export function subscribeBrandName(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getCachedBrandName(): string {
  return sessionStorage.getItem(CACHE_KEY) || DEFAULT_BRAND_NAME;
}

export function setBrandName(name: string): void {
  sessionStorage.setItem(CACHE_KEY, name);
  listeners.forEach((listener) => listener(name));
}

export function invalidateBrandNameCache(): void {
  sessionStorage.removeItem(CACHE_KEY);
}

export async function resolveBrandName(): Promise<string> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return cached;
  try {
    const { data } = await apiGet<Organization>("/organizations");
    const name = (data && data.company_name) || DEFAULT_BRAND_NAME;
    setBrandName(name);
    return name;
  } catch {
    return DEFAULT_BRAND_NAME;
  }
}
