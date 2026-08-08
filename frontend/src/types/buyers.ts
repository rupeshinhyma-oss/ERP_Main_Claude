/** Buyer (Client) types. Mirrors backend/app/buyers/schemas.py. */

export type BuyerType = "manufacturer" | "trader";
export type BuyerCurrentStatus = "new" | "existing";
export type BuyerPotential = "yes" | "no";
export type BuyerGrade = "A" | "B" | "C";

export interface BuyerContact {
  id: string;
  buyer_id: string;
  salutation?: string | null;
  person_name: string;
  designation?: string | null;
  country_id?: string | null;
  calling_number?: string | null;
  whatsapp_number?: string | null;
  email?: string | null;
  is_primary: boolean;
  created_at: string;
  updated_at: string;
}

export interface Buyer {
  id: string;
  company_name: string;
  buyer_type?: BuyerType | null;
  country_id: string;
  city?: string | null;
  address?: string | null;
  contact_salutation?: string | null;
  contact_full_name?: string | null;
  contact_designation?: string | null;
  contact_calling_number?: string | null;
  contact_whatsapp_number?: string | null;
  tax_id_number?: string | null;
  website?: string | null;
  current_status?: BuyerCurrentStatus | null;
  product_range?: string | null;
  potential?: BuyerPotential | null;
  potential_reason?: string | null;
  buyer_grade?: BuyerGrade | null;
  currently_buying_from?: string | null;
  overall_remarks?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  emails?: string[];
  contacts?: BuyerContact[];
  category_ids?: string[];
  sub_category_ids?: string[];
}
