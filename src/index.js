/*
MIT License

Copyright (c) 2026 shihaowei49-cloud contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

const MAX_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new RangeError(label + ' must be a safe integer of at least ' + min);
  }
  return value;
}

function exactNumber(value, label) {
  if (value < -MAX_INTEGER || value > MAX_INTEGER) {
    throw new RangeError(label + ' exceeds the safe integer range');
  }
  return Number(value);
}

function key(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(label + ' is required');
  return value.trim();
}

function list(value, label) {
  if (!Array.isArray(value)) throw new TypeError(label + ' must be an array');
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new TypeError(label + ' is missing an item at index ' + index);
  }
  return value;
}

function positive(value) {
  return value > 0n ? value : 0n;
}

function tolerance({ absoluteCents, basisPoints } = {}) {
  if (absoluteCents === undefined && basisPoints === undefined) {
    return { absolute: 0n, bps: null };
  }
  return {
    absolute: absoluteCents === undefined ? null : BigInt(integer(absoluteCents, 'absoluteCents')),
    bps: basisPoints === undefined ? null : BigInt(integer(basisPoints, 'basisPoints')),
  };
}

function compare(actualCents, expectedCents, { absolute, bps }) {
  const delta = BigInt(actualCents) - BigInt(expectedCents);
  const magnitude = delta < 0n ? -delta : delta;
  const withinAbsolute = absolute === null || magnitude <= absolute;
  const withinBasisPoints = bps === null || magnitude * 10_000n <= BigInt(expectedCents) * bps;
  return {
    actualCents, expectedCents, varianceCents: Number(delta), withinAbsolute, withinBasisPoints,
    passed: withinAbsolute && withinBasisPoints,
  };
}

function documentIdentity(document) {
  return {
    vendorId: key(document.vendorId, 'vendorId'),
    invoiceNumber: key(document.invoiceNumber, 'invoiceNumber').toUpperCase(),
  };
}

function requireOrderLine(orderLines, reference, context) {
  const lineId = key(reference.lineId, context + '.lineId');
  const item = orderLines.get(lineId);
  if (!item) throw new RangeError(context + ' references unknown PO line ' + lineId);
  return item;
}

export function matchInvoice({ purchaseOrder, receipts = [], invoice, history = [], tolerances = {} }) {
  const identity = documentIdentity(invoice);
  const posted = list(history, 'history').map((prior) => ({ invoice: prior, identity: documentIdentity(prior) }));
  if (posted.some(({ identity: prior }) => prior.vendorId === identity.vendorId
    && prior.invoiceNumber === identity.invoiceNumber)) {
    return { status: 'reject_duplicate', ...identity, issues: [{ code: 'duplicate_invoice' }] };
  }

  const orderId = key(purchaseOrder.id, 'purchaseOrder.id');
  const vendorId = key(purchaseOrder.vendorId, 'purchaseOrder.vendorId');
  const currency = key(purchaseOrder.currency, 'purchaseOrder.currency');
  const issues = [];
  if (key(invoice.purchaseOrderId, 'invoice.purchaseOrderId') !== orderId) issues.push({ code: 'po_mismatch' });
  if (identity.vendorId !== vendorId) issues.push({ code: 'vendor_mismatch' });
  if (key(invoice.currency, 'invoice.currency') !== currency) issues.push({ code: 'currency_mismatch' });
  if (issues.length) return { status: 'hold_qty_variance', ...identity, issues };

  const priceTolerance = tolerance(tolerances.price);
  const orderLines = new Map();
  const skuLines = new Map();
  for (const line of list(purchaseOrder.lines, 'purchaseOrder.lines')) {
    const lineId = key(line.lineId, 'purchaseOrder.lines[].lineId');
    const sku = key(line.sku, 'purchaseOrder.lines[].sku');
    const ordered = BigInt(integer(line.quantity, 'PO quantity', 1));
    const unitCents = integer(line.unitCents, 'PO unitCents');
    if (orderLines.has(lineId)) throw new RangeError('Duplicate PO line ' + lineId);
    const item = { lineId, sku, ordered, unitCents, received: 0n, prior: 0n, billed: 0n };
    orderLines.set(lineId, item);

    const matches = skuLines.get(sku) ?? [];
    matches.push(item);
    skuLines.set(sku, matches);
  }
  if (!orderLines.size) throw new RangeError('Purchase order must contain at least one line');

  const receiptIds = new Set();
  for (const receipt of list(receipts, 'receipts')) {
    const receiptId = key(receipt.id, 'receipt.id');
    if (receiptIds.has(receiptId)) throw new RangeError('Duplicate receipt ' + receiptId);
    receiptIds.add(receiptId);
    if (key(receipt.purchaseOrderId, 'receipt.purchaseOrderId') !== orderId) {
      throw new RangeError('Receipt belongs to a different PO: ' + receiptId);
    }
    for (const line of list(receipt.lines, 'receipt.lines')) {
      const item = requireOrderLine(orderLines, line, 'Receipt');
      item.received += BigInt(integer(line.quantity, 'receipt quantity', -Number.MAX_SAFE_INTEGER));
    }
  }
  for (const item of orderLines.values()) {
    if (item.received < 0n) throw new RangeError('Net received quantity is negative for PO line ' + item.lineId);
  }

  const priorNumbers = new Set();
  for (const { invoice: prior, identity: priorIdentity } of posted) {
    if (priorIdentity.vendorId !== vendorId || prior.purchaseOrderId === undefined) continue;
    if (key(prior.purchaseOrderId, 'history.purchaseOrderId') !== orderId) continue;
    if (priorNumbers.has(priorIdentity.invoiceNumber)) throw new RangeError('Duplicate posted invoice in PO history');
    priorNumbers.add(priorIdentity.invoiceNumber);
    for (const line of list(prior.lines, 'history[].lines')) {
      const item = requireOrderLine(orderLines, line, 'Posted invoice');
      item.prior += BigInt(integer(line.quantity, 'posted billed quantity'));
    }
  }

  if (!Array.isArray(invoice.lines) || !invoice.lines.length) {
    throw new RangeError('Invoice must contain at least one line');
  }
  let subtotal = 0n;
  let quantityHold = false;
  let priceHold = false;

  const lines = list(invoice.lines, 'invoice.lines').map((line, lineIndex) => {
    const sku = key(line.sku, 'invoice.lines[].sku');
    const quantity = integer(line.quantity, 'invoice quantity', 1);
    const unitCents = integer(line.unitCents, 'invoice unitCents');
    const lineTotal = BigInt(quantity) * BigInt(unitCents);
    subtotal += lineTotal;
    const explicitLineId = line.lineId === undefined ? null : key(line.lineId, 'invoice.lines[].lineId');
    const skuMatches = skuLines.get(sku) ?? [];
    const item = explicitLineId === null
      ? (skuMatches.length === 1 ? skuMatches[0] : undefined)
      : orderLines.get(explicitLineId);
    const detail = { lineIndex, lineId: explicitLineId, sku, quantity, unitCents, totalCents: exactNumber(lineTotal, 'Line total') };

    if (!item || item.sku !== sku) {
      quantityHold = true;
      const code = item ? 'sku_mismatch' : explicitLineId === null && skuMatches.length > 1 ? 'ambiguous_sku' : 'unknown_po_line';
      issues.push({ code, lineIndex, lineId: explicitLineId, sku });
      return { ...detail, price: null };
    }

    item.billed += BigInt(quantity);
    const price = compare(unitCents, item.unitCents, priceTolerance);
    if (!price.passed) {
      priceHold = true;
      issues.push({ code: 'unit_price_variance', lineIndex, lineId: item.lineId });
    }
    return { ...detail, lineId: item.lineId, price };
  });

  const quantities = Array.from(orderLines.values(), ({ lineId, sku, ordered, received, prior, billed }) => {
    const totalBilled = prior + billed;
    const overOrdered = positive(totalBilled - ordered);
    const overReceived = positive(totalBilled - received);
    if (billed > 0n && (overOrdered > 0n || overReceived > 0n)) {
      quantityHold = true;
      if (overOrdered > 0n) issues.push({ code: 'over_ordered', lineId });
      if (overReceived > 0n) issues.push({ code: 'over_received', lineId });
    }
    return {
      lineId, sku, ordered: Number(ordered), received: exactNumber(received, 'Received quantity'),
      previouslyBilled: exactNumber(prior, 'Previously billed quantity'),
      invoiceQuantity: exactNumber(billed, 'Invoice quantity'),
      backorder: Number(positive(ordered - received)),
      availableToBill: Number(positive((ordered < received ? ordered : received) - prior)),
      overOrdered: exactNumber(overOrdered, 'Quantity over ordered'),
      overReceived: exactNumber(overReceived, 'Quantity over received'),
    };
  });

  const headers = {};
  let total = subtotal;
  for (const kind of ['freight', 'tax']) {
    const field = kind + 'Cents';
    const actual = integer(invoice[field] === undefined ? 0 : invoice[field], 'invoice.' + field);
    const expected = integer(purchaseOrder[field] === undefined ? 0 : purchaseOrder[field], 'purchaseOrder.' + field);
    headers[kind] = compare(actual, expected, tolerance(tolerances[kind]));
    total += BigInt(actual);
    if (!headers[kind].passed) {
      priceHold = true;
      issues.push({ code: kind + '_variance' });
    }
  }

  let status = 'auto_approve';
  if (quantityHold) status = 'hold_qty_variance';
  else if (priceHold) status = 'hold_price_variance';

  return {
    status, ...identity, purchaseOrderId: orderId, currency, issues, lines, quantities, headers,
    subtotalCents: exactNumber(subtotal, 'Invoice subtotal'),
    totalCents: exactNumber(total, 'Invoice total'),
  };
}
