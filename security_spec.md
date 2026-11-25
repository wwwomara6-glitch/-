# Zero-Trust Security Specification — Blaugrana Perfumes

## 1. Hardened Data Invariants (All 13 Paths)
1. **Exclusive Admin Identity**: Only `request.auth != null && request.auth.token.email_verified == true && request.auth.token.email == "wwwomara6@gmail.com"` holds `isAdmin()` privileges.
2. **Zero Public Writes**: No unauthenticated or non-admin user can perform ANY `create`, `update`, or `delete` on any Firestore collection. This completely blocks browser price tampering, loyalty stamp forgery, status shortcutting, and direct Firestore quota-exhaustion spam.
3. **Zero Public PII or Sensitive Metadata Reads**:
   - `/orders`, `/orderTrackings`, `/customRequests`, `/loyaltyLookups`, `/promoCodes`, `/notifications`, `/counters`, `/backups`, and `/admins` allow **ZERO public reads (`get` or `list`)**.
   - Customers NEVER query unsalted phone hashes in `/loyaltyLookups`, NEVER query `/promoCodes` directly (so `ownerName` and `timesUsed` are never leaked), and NEVER use derivable tracking keys (`trackingToken` is a cryptographically random 256-bit hex string verified through the trusted backend/Worker).
4. **Authoritative Pricing, Promo & Loyalty Recalculation**:
   - Browser-submitted cart totals, discounts, delivery fees, and `4+1` loyalty rewards are NEVER trusted. Orders, promo validations, loyalty lookups, and custom requests flow through the trusted server/Cloudflare Worker endpoint (with rate-limiting and Turnstile anti-spam), which recomputes all amounts from authoritative Firestore records before writing.
5. **Minimal Public Catalog Exposure**:
   - Visitors can only `get` `/test/connection`, `/catalog_meta/public`, `/catalog_chunks/chunk_N`, and single `/products/{productId}` records (zero `list` on `/products` to prevent 229-read scraping).

## 2. Adversarial Test Matrix (Verified in Firebase Firestore Emulator)
Every unauthorized read/write returns `PERMISSION_DENIED` across three identities:
- **Visitor (Unauthenticated)**
- **Unauthorized Signed-in User (`attacker@gmail.com`, verified)**
- **Spoofed Unverified Email (`wwwomara6@gmail.com`, `email_verified: false`)**
And authorized Admin operations for **Owner Admin (`wwwomara6@gmail.com`, `email_verified: true`)** succeed (`ALLOWED`).
