# AP invoice three-way match

A zero-dependency ESM library that reconciles a debit invoice against its purchase order and net goods receipts. Run it in Node.js 20+ or in a browser. [Interactive GitHub Pages demo](https://shihaowei49-cloud.github.io/ap-invoice-three-way-match-cli/)

## Match a partial delivery

```js
import { matchInvoice } from './src/index.js';

const result = matchInvoice({
  purchaseOrder: { id: 'PO-1', vendorId: 'SUP-42', currency: 'USD', freightCents: 500,
    lines: [{ lineId: '10', sku: 'WIDGET', quantity: 100, unitCents: 1250 }] },
  receipts: [{ id: 'GR-1', purchaseOrderId: 'PO-1', lines: [{ lineId: '10', quantity: 60 }] }],
  history: [{ vendorId: 'SUP-42', invoiceNumber: 'INV-1', purchaseOrderId: 'PO-1',
    lines: [{ lineId: '10', quantity: 40 }] }],
  invoice: { purchaseOrderId: 'PO-1', vendorId: 'SUP-42', currency: 'USD',
    invoiceNumber: 'INV-2', freightCents: 505,
    lines: [{ sku: 'WIDGET', quantity: 20, unitCents: 1252 }] },
  tolerances: {
    price: { absoluteCents: 2, basisPoints: 20 },
    freight: { absoluteCents: 5, basisPoints: 100 },
  },
});

console.log(result.status, result.quantities[0].backorder, result.totalCents);
// auto_approve 40 25545
```

### Input and output

| Field | Contract |
| --- | --- |
| `purchaseOrder` | `id`, `vendorId`, `currency`, and lines with a unique `lineId`, `sku`, positive whole `quantity`, and `unitCents`. Use optional `freightCents` and `taxCents` for the expected share on this bill. |
| `receipts` | Optional array of receipt documents with a unique `id`, the matching `purchaseOrderId`, and `lines: [{ lineId, quantity }]`. Post returns as negative quantities. Net receipt quantities must be nonnegative. |
| `history` | Optional posted invoice snapshot. Include `vendorId` and `invoiceNumber` across relevant POs for duplicate detection. For every posted bill on the current PO, include `purchaseOrderId` and `lines: [{ lineId, quantity }]` with net billed quantities. |
| `invoice` | `purchaseOrderId`, `vendorId`, `invoiceNumber`, `currency`, and lines with `sku`, positive whole `quantity`, and `unitCents`. Include `lineId` when the SKU appears on multiple PO lines. Freight and tax default to zero. |
| `tolerances` | Optional `price`, `freight`, and `tax` objects with `absoluteCents`, `basisPoints`, or both. A missing policy requires an exact match. When both limits are provided, both must pass. |
| Result | Routing `status` and machine-readable `issues`. A matched-scope bill also returns `lines`, PO `quantities`, freight and tax `headers`, `subtotalCents`, and `totalCents`. |

Normalize quantities to the PO unit of measure before matching. The matcher uses exact, case-sensitive vendor IDs, PO IDs, line IDs, currencies, and SKUs after trimming surrounding whitespace. It trims and uppercases invoice numbers for vendor-scoped comparison. Money is a safe integer in cents. Products and tolerance comparisons use exact integer arithmetic. Overflows and malformed source records throw.

For each PO line the invoice references, the current bill and prior billed quantity must fit both the order and the net receipts. Partial receipts can clear a smaller bill while the remaining PO quantity stays on backorder. The money checks compare each invoice line to the PO unit price and check freight and tax independently. Price deviations use their absolute magnitude in both directions. Relative limits compare that magnitude with a percentage of the expected amount, with an expected amount of zero allowing only zero under a basis-point gate.

### Routing precedence

1. `reject_duplicate` for an invoice number already posted for that vendor.
2. `hold_qty_variance` for scope or line-reference problems, an over-bill against the PO, or an over-bill against receipts.
3. `hold_price_variance` for unit-price, freight, or tax outside policy.
4. `auto_approve` when all checks pass.

Matching is a pure calculation against the supplied snapshot. When persisting approvals, enforce vendor and invoice identity uniqueness and reserve the available quantity atomically with posting.

## Work locally

Run `node --test` from this checkout. To process a JSON file from a shell without installing a package, import the module from Node and pass the parsed input.

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; import { matchInvoice } from "./src/index.js"; console.log(JSON.stringify(matchInvoice(JSON.parse(readFileSync(0, "utf8"))), null, 2))' < invoice-case.json
```

To preview the demo, run `python3 -m http.server --bind 127.0.0.1 --directory docs` and visit `http://127.0.0.1:8000/`. Copy `src/index.js` to `docs/lib.js` when the source changes before publishing the `docs/` directory.

Related tools include [ThreeWayMatchPack](https://threewaymatch.shihaoeth.site/?utm_source=github_oss&utm_medium=repo_pages&utm_campaign=quality_wave_7) and [StatementPack](https://statementpack.shihaoeth.site/?utm_source=github_oss&utm_medium=repo_pages&utm_campaign=quality_wave_7).

[MIT license](LICENSE)
