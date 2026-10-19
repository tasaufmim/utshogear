import React from 'react';

export function Placeholder({ title, phase }: { title: string; phase: string }) {
  return (
    <div className="card">
      <div className="empty">
        <div className="big">🚧</div>
        <div style={{ fontWeight: 700, color: 'var(--text-2)', fontSize: 16 }}>{title}</div>
        <div className="dim" style={{ marginTop: 6 }}>
          {phase} of the build plan — coming next.
        </div>
      </div>
    </div>
  );
}
