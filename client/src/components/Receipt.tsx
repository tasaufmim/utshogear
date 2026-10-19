import React, { useEffect, useRef } from 'react';
import { fmtTaka } from '../api';

/**
 * 80mm thermal receipt — renders inside a modal and prints on its own via
 * `@page { size: 80mm auto }`, so the same component serves checkout,
 * reprint-from-history and Ctrl+P.
 */
export function Receipt({
  sale,
  settings,
  onDone,
  autoPrint = false,
  mode = 'checkout',
}: {
  sale: any;
  settings: any;
  onDone: () => void;
  autoPrint?: boolean;
  mode?: 'checkout' | 'reprint';
}) {
  const printed = useRef(false);

  useEffect(() => {
    if (autoPrint && !printed.current) {
      printed.current = true;
      const t = setTimeout(() => window.print(), 450);
      return () => clearTimeout(t);
    }
  }, [autoPrint]);

  if (!sale) return null;

  const shop = settings ?? {};
  const width = shop.receiptPrinter?.paperWidth === '58mm' ? '58mm' : '80mm';

  const when = sale.createdAt
    ? new Date(sale.createdAt).toLocaleString('en-GB', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';

  const lineDiscTotal =
    sale.lines?.reduce((s: number, l: any) => s + (l.lineDiscountCents || 0), 0) ?? 0;

  return (
    <div className="modal-back no-print-hide" style={{ background: 'rgba(15,23,42,.6)' }}>
      <style>{`
        @page receipt { size: ${width} auto; margin: 0; }
        @media print {
          body * { visibility: hidden !important; }
          .receipt-print, .receipt-print * { visibility: visible !important; }
          .receipt-print {
            position: absolute; left: 0; top: 0;
            width: ${width}; padding: 3mm 3mm 6mm;
            background: #fff; box-shadow: none !important; border: none !important;
            max-height: none !important; overflow: visible !important;
            font-size: 11px !important; line-height: 1.35 !important;
          }
          .modal-back { position: static !important; background: none !important; padding: 0 !important; }
        }
      `}</style>

      <div
        className="receipt-print"
        style={{
          width,
          background: '#fff',
          color: '#000',
          fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          fontSize: 11.5,
          lineHeight: 1.4,
          padding: '4mm 3.5mm 6mm',
          borderRadius: 8,
          boxShadow: 'var(--shadow-lg)',
          maxHeight: '86vh',
          overflowY: 'auto',
        }}
      >
        {/* header */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.4 }}>
            {shop.shopName || 'UTSHO GEAR'}
          </div>
          {shop.address && <div style={{ fontSize: 10 }}>{shop.address}</div>}
          {shop.phone && <div style={{ fontSize: 10 }}>Phone: {shop.phone}</div>}
          <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
            <span>Receipt: {sale.receiptNo}</span>
            <span>{when}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5 }}>
            <span>Sold by: {sale.salesmanName}</span>
            <span>{sale.status === 'voided' ? '*** VOIDED ***' : 'SALES RECEIPT'}</span>
          </div>
          {sale.customerName && sale.customerName !== 'Walk-in' && (
            <div style={{ fontSize: 10.5, textAlign: 'left' }}>
              Customer: {sale.customerName} {sale.customerPhone ? `· ${sale.customerPhone}` : ''}
            </div>
          )}
          <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />
        </div>

        {/* lines */}
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {sale.lines?.map((l: any, i: number) => (
              <tr key={i} style={{ verticalAlign: 'top' }}>
                <td style={{ padding: '1.5px 0' }}>
                  <div style={{ fontWeight: 700 }}>{l.name}{l.size ? ` (${l.size})` : ''}</div>
                  <div style={{ fontSize: 10 }}>
                    {l.qty} × {fmtTaka(l.unitPrice, false)}
                    {l.lineDiscountCents > 0 && (
                      <span> − disc {fmtTaka(l.lineDiscountCents, false)}</span>
                    )}
                    {l.warrantyDays > 0 && <span> · warranty {l.warrantyDays}d</span>}
                  </div>
                </td>
                <td style={{ padding: '1.5px 0', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700 }}>
                  {fmtTaka(l.lineTotal, false)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />

        {/* totals */}
        <Row label="Subtotal" value={fmtTaka(sale.subtotalCents, false)} />
        {lineDiscTotal > 0 && <Row label="Line discounts" value={`-${fmtTaka(lineDiscTotal, false)}`} />}
        {sale.orderDiscountCents > 0 && (
          <Row
            label={`Order discount${sale.orderDiscountType === 'pct' ? ' (%)' : ''}`}
            value={`-${fmtTaka(sale.orderDiscountCents, false)}`}
          />
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontWeight: 800,
            fontSize: 15,
            margin: '3px 0',
          }}
        >
          <span>TOTAL</span>
          <span>৳{fmtTaka(sale.totalCents, false)}</span>
        </div>

        <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />
        <Row label={`Paid (${sale.payment?.method})`} value={fmtTaka(sale.payment?.paidCents ?? 0, false)} />
        {(sale.payment?.changeCents ?? 0) > 0 && (
          <Row label="Change" value={fmtTaka(sale.payment.changeCents, false)} />
        )}
        {(sale.payment?.dueCents ?? 0) > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 800, color: '#b00' }}>
            <span>DUE (credit)</span>
            <span>৳{fmtTaka(sale.payment.dueCents, false)}</span>
          </div>
        )}

        {/* footer */}
        <div style={{ borderTop: '1px dashed #000', margin: '6px 0 4px' }} />
        <div style={{ textAlign: 'center', fontSize: 10 }}>
          <div style={{ fontWeight: 700 }}>{shop.footerNote || 'Thank you — ride safe!'}</div>
          <div style={{ marginTop: 2 }}>
            Keep this receipt for warranty & returns. Items returnable within{' '}
            {shop.returnWindowDays ?? 7} days with receipt.
          </div>
          {sale.note && <div style={{ marginTop: 2 }}>Note: {sale.note}</div>}
          <div style={{ marginTop: 4, fontSize: 9, letterSpacing: 1 }}>
            {sale.receiptNo}
          </div>
        </div>
      </div>

      {/* actions (never printed) */}
      <div className="row no-print" style={{ justifyContent: 'center', gap: 10, marginTop: 14 }}>
        <button className="btn primary lg" onClick={() => window.print()}>
          🖨 Print receipt
        </button>
        <button className="btn lg" onClick={onDone}>
          {mode === 'checkout' ? 'New sale (F2)' : 'Close'}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
