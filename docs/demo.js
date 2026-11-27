import { matchInvoice } from './lib.js';

const form = document.querySelector('#match-form');
const source = document.querySelector('#case');
const routing = document.querySelector('#routing');
const invoiceTotal = document.querySelector('#invoice-total');
const issues = document.querySelector('#issues');
const quantities = document.querySelector('#quantities');
const prices = document.querySelector('#prices');
const error = document.querySelector('#error');

function fixture(example) {
  const scope = { vendorId: 'SUP-42', currency: 'USD' };
  const purchaseOrderId = 'PO-1';
  const receipt = (id, quantity) => ({ id, purchaseOrderId, lines: [{ lineId: '10', quantity }] });
  const receipts = [receipt('GR-1', 60), receipt('RET-1', -10)];
  const history = [{
    vendorId: scope.vendorId, invoiceNumber: 'INV-001', purchaseOrderId,
    lines: [{ lineId: '10', quantity: 40 }],
  }];
  if (example === 'approve' || example === 'price') receipts.push(receipt('GR-2', 5));
  if (example === 'duplicate') history.push({ vendorId: scope.vendorId, invoiceNumber: 'INV-209' });

  return {
    purchaseOrder: {
      ...scope, id: purchaseOrderId, freightCents: 500, taxCents: 800,
      lines: [{ lineId: '10', sku: 'WIDGET', quantity: 100, unitCents: 1250 }],
    },
    receipts, history,
    invoice: {
      ...scope, purchaseOrderId, invoiceNumber: 'INV-209', freightCents: 505, taxCents: 808,
      lines: [
        { sku: 'WIDGET', quantity: 8, unitCents: 1250 },
        { lineId: '10', sku: 'WIDGET', quantity: 7, unitCents: example === 'price' ? 1253 : 1252 },
      ],
    },
    tolerances: {
      price: { absoluteCents: 2, basisPoints: 20 },
      freight: { absoluteCents: 5, basisPoints: 100 },
      tax: { absoluteCents: 8, basisPoints: 100 },
    },
  };
}

function item(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}

function renderRows(target, rows) {
  target.replaceChildren(...rows.map((values) => {
    const row = document.createElement('tr');
    row.append(...values.map((value) => item('td', value)));
    return row;
  }));
}

function describeIssue({ code, lineIndex, lineId, sku }) {
  const suffix = [
    lineIndex === undefined ? null : 'invoice line ' + (lineIndex + 1),
    lineId === null || lineId === undefined ? null : 'PO line ' + lineId,
    sku === undefined ? null : 'SKU ' + sku,
  ].filter(Boolean);
  return code.replaceAll('_', ' ') + (suffix.length ? ' (' + suffix.join(', ') + ')' : '');
}

function moneyRow(label, check) {
  return [label, check.expectedCents, check.actualCents, check.varianceCents, check.passed ? 'Pass' : 'Hold'];
}

function runMatch() {
  try {
    const result = matchInvoice(JSON.parse(source.value));
    routing.textContent = result.status;
    routing.dataset.status = result.status;
    invoiceTotal.textContent = result.totalCents === undefined
      ? ''
      : 'Invoice total · ' + result.totalCents.toLocaleString('en-US') + ' cents (' + result.currency + ')';
    issues.replaceChildren(...(result.issues.length ? result.issues.map(describeIssue) : ['None'])
      .map((text) => item('li', text)));
    renderRows(quantities, (result.quantities ?? []).map((row) => [
      row.lineId + ' · ' + row.sku, row.ordered, row.received, row.backorder, row.previouslyBilled,
      row.availableToBill, row.invoiceQuantity, row.overOrdered, row.overReceived,
    ]));
    const rows = (result.lines ?? []).map((line) => {
      const label = 'Line ' + (line.lineIndex + 1) + ' · ' + line.sku;
      return line.price ? moneyRow(label, line.price) : [label, '—', line.unitCents, '—', 'Unmatched'];
    });
    if (result.headers) rows.push(moneyRow('Freight', result.headers.freight), moneyRow('Tax', result.headers.tax));
    renderRows(prices, rows);
    error.hidden = true;
    error.textContent = '';
  } catch (exception) {
    routing.textContent = '';
    delete routing.dataset.status;
    invoiceTotal.textContent = '';
    issues.replaceChildren();
    quantities.replaceChildren();
    prices.replaceChildren();
    error.textContent = exception.message;
    error.hidden = false;
  }
}

for (const button of document.querySelectorAll('.examples button')) {
  button.addEventListener('click', () => {
    source.value = JSON.stringify(fixture(button.value), null, 2);
    runMatch();
  });
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  runMatch();
});
source.value = JSON.stringify(fixture('partial'), null, 2);
runMatch();
