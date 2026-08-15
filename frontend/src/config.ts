// GigTax static configuration. Milestone 1 = Australia live; others scaffolded.

export interface CountryCfg {
  code: string;
  name: string;
  currency: string;
  symbol: string;
  distanceUnit: "km" | "mi";
  active: boolean;
}

export const COUNTRIES: CountryCfg[] = [
  { code: "AU", name: "Australia", currency: "AUD", symbol: "$", distanceUnit: "km", active: true },
  { code: "US", name: "United States", currency: "USD", symbol: "$", distanceUnit: "mi", active: false },
  { code: "UK", name: "United Kingdom", currency: "GBP", symbol: "£", distanceUnit: "mi", active: false },
  { code: "CA", name: "Canada", currency: "CAD", symbol: "$", distanceUnit: "km", active: false },
];

export const AU_STATES = ["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"];

export const WORK_TYPES = [
  {
    key: "passengers",
    label: "Carry passengers",
    hint: "Rideshare (Uber, DiDi, Ola). Requires GST registration from your first dollar.",
    icon: "car-outline",
  },
  {
    key: "delivery",
    label: "Deliver goods & food",
    hint: "Delivery (DoorDash, Uber Eats, Menulog, Amazon Flex). GST only above $75k.",
    icon: "fast-food-outline",
  },
  {
    key: "both",
    label: "Both",
    hint: "Any passenger work pulls all your gig income onto one GST registration.",
    icon: "swap-horizontal-outline",
  },
] as const;

export const PLATFORMS = [
  "Uber", "Uber Eats", "DoorDash", "Menulog", "Amazon Flex",
  "DiDi", "Ola", "Lyft", "HungryPanda", "Other",
];

export const OWNERSHIP = [
  {
    key: "own",
    label: "Own outright",
    note: "Depreciation / decline in value may be claimable — the app flags it so you work it out separately.",
  },
  {
    key: "loan",
    label: "Loan finance",
    note: "Same as owned, plus loan interest is deductible — never the principal repayments.",
  },
  {
    key: "lease",
    label: "Lease",
    note: "No depreciation (you're not the owner). The lease payment itself is the deductible cost.",
  },
  {
    key: "rental",
    label: "Rental",
    note: "All-inclusive rideshare rental? Log ONLY the fixed weekly payment and fuel. Do NOT log insurance or servicing separately — they're already inside the fee and would double-count.",
  },
  {
    key: "rent_to_buy",
    label: "Rent-to-buy",
    note: "Contract-dependent: hire-purchase is treated like ownership, lease-with-option like a lease. Check your contract — the app can't tell which from a dropdown.",
  },
] as const;

export const CATEGORIES = [
  { key: "fuel", label: "Fuel", icon: "flame-outline", apportioned: true },
  { key: "tolls", label: "Tolls", icon: "cash-outline", apportioned: false },
  { key: "vehicle", label: "Vehicle", icon: "construct-outline", apportioned: true },
  { key: "phone", label: "Phone", icon: "phone-portrait-outline", apportioned: false },
  { key: "other", label: "Other", icon: "ellipsis-horizontal-outline", apportioned: false },
] as const;

export const TAX_TREATMENTS = [
  { key: "inclusive", label: "GST incl.", desc: "Carries GST at 10% (fuel, tolls, servicing, fares)" },
  { key: "free", label: "GST-free", desc: "Zero-rated — bank fees, most insurance" },
  { key: "exempt", label: "Exempt", desc: "Input-taxed, no credit claimable" },
  { key: "out_of_scope", label: "No GST", desc: "Overseas subscriptions, out of scope" },
] as const;

export const FREQUENCIES = [
  { key: "weekly", label: "Weekly" },
  { key: "fortnightly", label: "Fortnightly" },
  { key: "monthly", label: "Monthly" },
] as const;

// Trip purpose taxonomy — journey recorded first, classified second.
export const TRIP_TYPES = [
  { key: "business", label: "Business", color: "profit" },
  { key: "mixed", label: "Mixed", color: "warm" },
  { key: "personal", label: "Private", color: "dim" },
] as const;

export const BUSINESS_PURPOSES = [
  { key: "collect", label: "Collecting an order" },
  { key: "deliver", label: "Delivering an order" },
  { key: "between_jobs", label: "Between delivery jobs" },
  { key: "other_business", label: "Other business travel" },
] as const;

export const PRIVATE_PURPOSES = [
  { key: "home", label: "Going home" },
  { key: "shopping", label: "Shopping" },
  { key: "appointment", label: "Personal appointment" },
  { key: "personal_other", label: "Personal travel" },
] as const;

export const FUEL_TYPES = [
  { key: "petrol", label: "Petrol" },
  { key: "diesel", label: "Diesel" },
  { key: "hybrid", label: "Hybrid" },
  { key: "electric", label: "Electric" },
  { key: "lpg", label: "LPG" },
] as const;

export const PERIODS = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "Quarter" },
  { key: "year", label: "Year" },
] as const;

export const ATO_LINK = "https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/income-and-deductions-for-business/in-detail/gig-economy-and-the-sharing-economy";

// Country flags (ISO 3166 alpha-2 as used by flagcdn; UK -> gb). 3:2 aspect.
const FLAG_CC: Record<string, string> = { AU: "au", US: "us", UK: "gb", CA: "ca" };
export function flagUrl(code: string, w: 40 | 80 | 160 = 80): string {
  const cc = FLAG_CC[code] || "au";
  return `https://flagcdn.com/w${w}/${cc}.png`;
}
