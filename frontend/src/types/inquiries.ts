/** Inquiry (Requirement) types. Mirrors backend/app/inquiries/schemas.py. */

export type InquiryItemStatus = "proposed" | "approved";
export type InquiryConsignmentStatus = "proposed" | "partial_approved" | "fully_approved";

export interface ConsignmentCode {
  id: string;
  code: string;
  label?: string | null;
  buyer_id: string;
  status: string;
  created_at: string;
}

export interface InquiryItem {
  id: string;
  inquiry_id: string;
  product_id: string;
  uom_id: string;
  quantity: number;
  brand_preference?: string | null;
  product_specs_remarks?: string | null;
  status: InquiryItemStatus;
  proposed_at: string;
  proposed_by: string;
  approved_at?: string | null;
  approved_by?: string | null;
  tally_entry_posted: boolean;
  tally_posted_at?: string | null;
  tally_posted_by?: string | null;
  procurement_remarks?: string | null;
  requires_license: boolean;
  created_at: string;
  updated_at: string;
}

export interface Inquiry {
  id: string;
  buyer_id: string;
  consignment_code_id: string;
  consignment_status: InquiryConsignmentStatus;
  total_cbm: number;
  total_weight: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  items: InquiryItem[];
}

export interface InquiryListItem {
  id: string;
  buyer_id: string;
  consignment_code_id: string;
  consignment_status: InquiryConsignmentStatus;
  total_cbm: number;
  total_weight: number;
  created_at: string;
  updated_at: string;
}

export interface CompanySummary {
  buyer_id: string;
  consignment_count: number;
  total_cbm: number;
  total_weight: number;
}
