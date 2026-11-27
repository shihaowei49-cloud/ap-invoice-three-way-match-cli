import assert from 'node:assert/strict';
import test from 'node:test';
import { matchInvoice } from '../src/index.js';

const purchaseOrder = {
  id: 'PO-1', vendorId: 'SUP-42', currency: 'USD', freightCents: 500, taxCents: 800,
  lines: [{ lineId: '10', sku: 'WIDGET', quantity: 100, unitCents: 1_250 }],
};

function receipt(id, quantity) {
  return { id, purchaseOrderId: 'PO-1', lines: [{ lineId: '10', quantity }] };
}

const invoice = {
  vendorId: 'SUP-42', invoiceNumber: 'inv-209', purchaseOrderId: 'PO-1', currency: 'USD',
  freightCents: 505, taxCents: 808,
  lines: [
    { sku: 'WIDGET', quantity: 8, unitCents: 1_250 },
    { lineId: '10', sku: 'WIDGET', quantity: 7, unitCents: 1_252 },
  ],
};

const history = [{
  vendorId: 'SUP-42', invoiceNumber: 'INV-001', purchaseOrderId: 'PO-1', lines: [{ lineId: '10', quantity: 40 }],
}];

const tolerances = {
  price: { absoluteCents: 2, basisPoints: 20 },
  freight: { absoluteCents: 5, basisPoints: 100 },
  tax: { absoluteCents: 8, basisPoints: 100 },
};

const receipts = [receipt('GR-1', 60), receipt('RET-1', -10)];
const base = { purchaseOrder, invoice, receipts, history, tolerances };
const cleared = { ...base, receipts: [...receipts, receipt('GR-2', 5)] };

test('splits invoice lines across a single quantity budget and nets receipt returns', () => {
  const result = matchInvoice(base);
  assert.equal(result.status, 'hold_qty_variance');
  assert.deepEqual(result.quantities, [{
    lineId: '10', sku: 'WIDGET', ordered: 100, received: 50, previouslyBilled: 40,
    invoiceQuantity: 15, backorder: 50, availableToBill: 10, overOrdered: 0, overReceived: 5,
  }]);
  assert.deepEqual(result.issues, [{ code: 'over_received', lineId: '10' }]);
});

test('approves exactly the net quantity available and the inclusive price and header limits', () => {
  const result = matchInvoice(cleared);
  assert.equal(result.status, 'auto_approve');
  assert.equal(result.lines[0].lineId, '10');
  assert.equal(result.lines[1].price.varianceCents, 2);
  assert.equal(result.headers.freight.varianceCents, 5);
  assert.equal(result.headers.tax.varianceCents, 8);
  assert.equal(result.subtotalCents, 18_764);
  assert.equal(result.totalCents, 20_077);
});

test('checks both configured gates and does not net a higher price against a cheaper line', () => {
  const changed = { ...invoice, lines: [
    { ...invoice.lines[0], unitCents: 1_248 },
    { ...invoice.lines[1], unitCents: 1_253 },
  ] };
  const result = matchInvoice({ ...cleared, invoice: changed, tolerances: {
    ...tolerances, price: { absoluteCents: 3, basisPoints: 20 },
  } });
  assert.equal(result.status, 'hold_price_variance');
  assert.deepEqual(result.lines.map(({ price }) => [price.withinAbsolute, price.withinBasisPoints]),
    [[true, true], [true, false]]);
});

test('reports header exceptions separately and supports a standalone absolute tolerance', () => {
  const changed = { ...invoice, freightCents: 506, taxCents: 791 };
  const result = matchInvoice({ ...cleared, invoice: changed });
  assert.equal(result.status, 'hold_price_variance');
  assert.deepEqual(result.issues.map(({ code }) => code), ['freight_variance', 'tax_variance']);
  assert.equal(result.headers.tax.varianceCents, -9);
  assert.equal(matchInvoice({ ...cleared, invoice: changed, tolerances: {
    ...tolerances, freight: { absoluteCents: 6 }, tax: { absoluteCents: 9 },
  } }).status, 'auto_approve');
});

test('a percentage-only gate with a zero baseline allows exact zero only', () => {
  const changed = { ...cleared, purchaseOrder: { ...purchaseOrder, freightCents: 0 },
    invoice: { ...invoice, freightCents: 1 }, tolerances: { ...tolerances, freight: { basisPoints: 100 } } };
  assert.equal(matchInvoice(changed).headers.freight.passed, false);
  assert.equal(matchInvoice({ ...changed, invoice: { ...changed.invoice, freightCents: 0 } }).headers.freight.passed, true);
});

test('defaults all missing tolerances to exact matches', () => {
  const result = matchInvoice({ ...cleared, tolerances: {} });
  assert.equal(result.status, 'hold_price_variance');
  assert.deepEqual(result.issues.map(({ code }) => code), ['unit_price_variance', 'freight_variance', 'tax_variance']);
});

test('checks the ordered quantity independently of an over-receipt', () => {
  const result = matchInvoice({
    ...base, receipts: [receipt('GR', 110)],
    history: [{ ...history[0], lines: [{ lineId: '10', quantity: 90 }] }],
  });
  assert.equal(result.status, 'hold_qty_variance');
  assert.equal(result.quantities[0].overOrdered, 5);
  assert.equal(result.quantities[0].overReceived, 0);
  assert.equal(result.quantities[0].backorder, 0);
});

test('prior invoices on different POs and vendors consume no current quantity', () => {
  const result = matchInvoice({ ...cleared, history: [...history,
    { ...history[0], purchaseOrderId: 'PO-2' },
    { ...history[0], vendorId: 'SUP-7', invoiceNumber: 'INV-209' },
  ] });
  assert.equal(result.status, 'auto_approve');
  assert.equal(result.quantities[0].previouslyBilled, 40);
});

test('rejects vendor-scoped duplicates before evaluating business variances', () => {
  const result = matchInvoice({ ...base, history: [...history,
    { vendorId: 'SUP-42', invoiceNumber: ' INV-209 ', purchaseOrderId: 'OTHER' },
  ] });
  assert.deepEqual(result, { status: 'reject_duplicate', vendorId: 'SUP-42',
    invoiceNumber: 'INV-209', issues: [{ code: 'duplicate_invoice' }] });
});

test('holds document scope mismatches and preserves price issues on quantity holds', () => {
  assert.deepEqual(matchInvoice({ ...base, invoice: {
    ...invoice, currency: 'CAD', vendorId: 'SUP-7', purchaseOrderId: 'PO-2',
  } }).issues.map(({ code }) => code), ['po_mismatch', 'vendor_mismatch', 'currency_mismatch']);
  const result = matchInvoice({ ...base, invoice: { ...invoice, freightCents: 900 } });
  assert.equal(result.status, 'hold_qty_variance');
  assert.deepEqual(result.issues.map(({ code }) => code), ['over_received', 'freight_variance']);
});

test('holds unknown lines, SKU mismatches, and ambiguous SKU-only references', () => {
  const result = matchInvoice({ ...cleared, purchaseOrder: { ...purchaseOrder,
    lines: [...purchaseOrder.lines, { ...purchaseOrder.lines[0], lineId: '20' }],
  }, invoice: { ...invoice, lines: [
    invoice.lines[0], { ...invoice.lines[1], lineId: 'missing' }, { ...invoice.lines[1], sku: 'OTHER' },
  ] } });
  assert.equal(result.status, 'hold_qty_variance');
  assert.deepEqual(result.issues.map(({ code }) => code), ['ambiguous_sku', 'unknown_po_line', 'sku_mismatch']);
});

test('validates receipt IDs, PO identity, net returns, and historical references', () => {
  assert.throws(() => matchInvoice({ ...base, receipts: [...receipts, receipts[0]] }), /Duplicate receipt/);
  assert.throws(() => matchInvoice({ ...base, receipts: [
    { ...receipt('GR', 100), purchaseOrderId: 'WRONG' },
  ] }), /different PO/);
  assert.throws(() => matchInvoice({ ...base, receipts: [receipt('RET', -1)] }), /negative/);
  assert.throws(() => matchInvoice({ ...base, history: [
    { ...history[0], lines: [{ lineId: 'WRONG', quantity: 40 }] },
  ] }), /unknown PO line/);
  assert.throws(() => matchInvoice({ ...base, history: [...history, history[0]] }), /Duplicate posted invoice/);
  assert.throws(() => matchInvoice({ ...base, history: [{ ...history[0], lines: '' }] }), /must be an array/);
  assert.throws(() => matchInvoice({ ...base, receipts: [{ ...receipts[0], lines: '' }] }), /must be an array/);
  assert.throws(() => matchInvoice({ ...base, invoice: { ...invoice, taxCents: null } }), /safe integer/);
});

test('rejects sparse invoice lines', () => {
  assert.throws(() => matchInvoice({ ...base, invoice: { ...invoice, lines: Array(1) } }), TypeError);
});

test('rejects fractional or unsafe cent totals while preserving exact large safe cents', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const order = { ...purchaseOrder, freightCents: 0, taxCents: 0,
    lines: [{ ...purchaseOrder.lines[0], unitCents: max }] };
  const bill = { ...invoice, freightCents: 0, taxCents: 0, lines: [{ sku: 'WIDGET', quantity: 1, unitCents: max }] };
  assert.equal(matchInvoice({ ...cleared, purchaseOrder: order, invoice: bill }).totalCents, max);
  assert.throws(() => matchInvoice({ ...cleared, purchaseOrder: order, invoice: {
    ...bill, lines: [{ ...bill.lines[0], quantity: 2 }],
  } }), /safe integer range/);
  assert.throws(() => matchInvoice({ ...cleared, invoice: {
    ...bill, lines: [{ ...bill.lines[0], unitCents: 0.5 }],
  } }), /safe integer/);
});
