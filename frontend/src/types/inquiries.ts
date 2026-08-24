/** Inquiry (Requirement) types. Mirrors backend/app/inquiries/schemas.py. */

export type InquiryItemStatus = "proposed" | "approved";
export type InquiryConsignmentStatus = "proposed" | "partial_approved" | "fully_approved";

export interface ConsignmentCode {
  id: string;
  code: string;
  label?: string | null;
  buyer_id: string;
  branch_id?: string | null;
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
  product_name?: string | null;
  product_name_tally?: string | null;
  product_code?: string | null;
  uom_name?: string | null;
  uom_code?: string | null;
  license_details?: string | null;
  packaging_quantity?: number | null;
  packaging_gross_weight?: number | null;
  packaging_unit_cbm?: number | null;
  quotation_count?: number;
  created_at: string;
  updated_at: string;
}

export interface Quotation {
  id: string;
  quote_number: string;
  inquiry_item_id: string;
  supplier_id: string;
  supplier_name?: string | null;
  supplier_code?: string | null;
  quantity: number;
  unit_price: number;
  total_cost: number;
  currency: string;
  expected_receiving_date?: string | null;
  terms_and_conditions?: string | null;
  remarks?: string | null;
  status: "pending" | "approved" | "rejected" | "po_created";
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RFQ {
  id: string;
  inquiry_item_id: string;
  expected_receiving_date?: string | null;
  supplier_type: string;
  supplier_ids?: string[] | null;
  notes?: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

export interface Inquiry {
  id: string;
  buyer_id: string;
  buyer_name?: string | null;
  branch_id?: string | null;
  consignment_code_id: string;
  consignment_code?: string | null;
  consignment_status: InquiryConsignmentStatus;
  total_cbm: number;
  total_weight: number;
  total_amount?: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  items: InquiryItem[];
}

export interface InquiryListItem {
  id: string;
  buyer_id: string;
  buyer_name?: string | null;
  branch_id?: string | null;
  consignment_code_id: string;
  consignment_code?: string | null;
  consignment_status: InquiryConsignmentStatus;
  total_cbm: number;
  total_weight: number;
  total_amount?: number;
  created_at: string;
  updated_at: string;
}

export interface CompanySummary {
  buyer_id: string;
  company_name?: string | null;
  consignment_count: number;
  proposed_count?: number;
  approved_count?: number;
  total_cbm: number;
  total_weight: number;
  total_amount?: number;
  consignment_status: InquiryConsignmentStatus;
  consignment_codes: string[];
  updated_at?: string | null;
}

